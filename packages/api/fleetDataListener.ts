import type { RequestHandler } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { Transform } from 'node:stream';
import { connect, type Socket, type Server as UnixServer } from 'node:net';
import { spawn } from 'node:child_process';
import type { Stats } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { FleetDataPlane } from '../core/src/fleet/dataPlane.js';
import { parseEnvelope } from '../core/src/fleet/contract.js';
import type { InstanceStorageService } from '../core/src/storage/service.js';
import { storageControlRoot } from '../core/src/storage/lifecycle.js';

const MAX_ARTIFACT_BYTES = 512 * 1024 ** 2;
const REVALIDATE_BYTES = 4 * 1024 ** 2;
const REVALIDATE_MS = 250;
/** 4 MiB/s minimum supported throughput, plus 30s scheduling/backpressure slack.
 * Hard capped at 158s for 512 MiB; authority expiry remains an independent fence. */
export const fleetTransferDeadline = (size: number) => Math.min(158_000, 30_000 + Math.ceil(size / (4 * 1024 ** 2) * 1000));
export interface FleetDataListener { address(): string | null; shutdown(): Promise<void> }

async function unlinkSocket(plane: FleetDataPlane, socket: string, expected: Pick<Stats, 'dev' | 'ino'>) {
  await plane.files.check();
  const current = await fs.lstat(socket).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!current) return;
  if (!current.isSocket() || current.dev !== expected.dev || current.ino !== expected.ino || current.uid !== process.getuid?.()) throw new Error('Fleet socket changed');
  await fs.unlink(socket);
}

async function removeStaleSockets(plane: FleetDataPlane) {
  await plane.files.check();
  for (const name of await fs.readdir(plane.files.root)) {
    if (!/^data-[0-9a-f-]{36}\.sock$/.test(name)) continue;
    const socket = path.join(plane.files.root, name);
    const stat = await fs.lstat(socket);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Unsafe Fleet socket');
    // Only ECONNREFUSED proves a stale endpoint. Never remove a live listener.
    const stale = await new Promise<boolean>((resolve, reject) => {
      const probe = connect(socket);
      probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Fleet socket probe timed out')); });
      probe.once('connect', () => { probe.destroy(); resolve(false); });
      probe.once('error', error => {
        if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(true);
        else reject(error);
      });
    });
    if (!stale) throw new Error('Fleet listener already active');
    await unlinkSocket(plane, socket, stat);
  }
}

/** Receive an already-bound Unix descriptor. The receiving libuv handle has no
 * bind pathname, so close() cannot blindly unlink a substituted filesystem entry.
 * The short-lived binder exits without close(); all unlinking belongs to us.
 * Use Node's documented --eval invocation with an IPC stdio channel for send().
 * Fixed Node code, no shell and no externally supplied command or path. */
async function bindUnix(socket: string): Promise<{ server: UnixServer; identity: Pick<Stats, 'dev' | 'ino'> }> {
  const code = `process.umask(0o177);
    const server = require('node:net').createServer();
    server.listen(process.argv[1], () => {
      const { dev, ino } = require('node:fs').lstatSync(process.argv[1]);
      process.send({ dev, ino }, server, { keepOpen: true }, error => process.exit(error ? 1 : 0));
    });`;
  return new Promise((resolve, reject) => {
    const binder = spawn(process.execPath, ['--eval', code, '--', socket], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let handle: UnixServer | undefined;
    let identity: Pick<Stats, 'dev' | 'ino'> | undefined;
    const timeout = setTimeout(() => { binder.kill('SIGKILL'); }, 5000);
    binder.on('message', (message, received) => {
      if (message && typeof message === 'object' && 'dev' in message && 'ino' in message && typeof message.dev === 'number' && typeof message.ino === 'number') {
        handle = received as UnixServer; identity = { dev: message.dev, ino: message.ino };
      }
    });
    binder.once('error', error => { clearTimeout(timeout); reject(error); });
    binder.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0 && handle && identity) resolve({ server: handle, identity });
      else { handle?.close(); reject(new Error('Fleet Unix bind failed')); }
    });
  });
}

/** Explicit refusal on the customer listener, also used by tunnel ingress. */
export const refusePublicFleetData: RequestHandler = (req, res, next) => {
  if (req.path !== '/v1/invoke') { next(); return; }
  res.set('Cache-Control', 'no-store').status(404).json({ error: 'fleet_data_unavailable' });
};

/** Separate Unix listener only. Never mount this handler on Express or the tunnel. */
export async function listenFleetData(plane: FleetDataPlane): Promise<FleetDataListener> {
  const runtime = await plane.runtime();
  const socket = path.join(plane.files.root, `data-${runtime.runtimeGeneration}.sock`);
  await removeStaleSockets(plane);
  const active = new Set<Promise<void>>();
  let stopping = false;
  const server = createServer((req, res) => {
    if (stopping) { res.destroy(); return; }
    const work = handle(req, res);
    active.add(work);
    void work.finally(() => active.delete(work));
  });
  const handle = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    let timer: NodeJS.Timeout | undefined;
    try {
      if (req.method !== 'POST' || req.url !== '/v1/invoke' || req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) throw new Error();
      const parts: Buffer[] = []; let length = 0;
      timer = setTimeout(() => req.destroy(), 5000);
      for await (const part of req) {
        const bytes = Buffer.from(part); length += bytes.length;
        if (length > 8192) throw new Error();
        parts.push(bytes);
      }
      clearTimeout(timer);
      const raw = Buffer.concat(parts).toString('utf8');
      if (parseEnvelope(raw).request.action === 'artifact.stream') {
        await plane.stream(raw, async (download, authorize) => {
          await authorize();
          const size = download.status.sizeBytes!;
          res.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Length': size, 'X-Content-Type-Options': 'nosniff' });
          let sent = 0, checkedBytes = 0;
          let checkedAt = performance.now();
          let checking: Promise<void> | undefined;
          const controller = new AbortController();
          const check = () => checking ??= authorize().then(() => {
            checkedBytes = sent; checkedAt = performance.now();
          }).finally(() => { checking = undefined; });
          // Check even while the reader is stalled, and serialize all validations.
          const fence = setInterval(() => { void check().catch(() => controller.abort()); }, REVALIDATE_MS);
          const deadline = setTimeout(() => controller.abort(), fleetTransferDeadline(size));
          const bounded = new Transform({ highWaterMark: 64 * 1024, transform(chunk, _encoding, callback) {
            sent += chunk.length;
            if (sent > size || sent > MAX_ARTIFACT_BYTES) { callback(new Error()); return; }
            if (checking || sent - checkedBytes >= REVALIDATE_BYTES || performance.now() - checkedAt >= REVALIDATE_MS) {
              void check().then(() => callback(null, chunk), () => callback(new Error()));
            } else callback(null, chunk);
          } });
          try {
            await pipeline(download.file.createReadStream({ highWaterMark: 64 * 1024 }), bounded, res, { signal: controller.signal });
          } finally {
            clearInterval(fence); clearTimeout(deadline);
            await checking?.catch(() => undefined);
          }
          if (sent !== size) throw new Error();
        });
      } else {
        const result = await plane.invoke(raw);
        const body = JSON.stringify(result);
        if (Buffer.byteLength(body) > 32768) throw new Error();
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body);
      }
    } catch {
      if (res.headersSent) res.destroy();
      else { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"fleet_data_unavailable"}'); }
    } finally { clearTimeout(timer); }
  };
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 16;
  server.maxConnections = 8;
  await plane.files.check();
  const { server: bound, identity: socketStat } = await bindUnix(socket);
  // The received Unix server owns admissions; HTTP owns request/connection state.
  bound.maxConnections = 8;
  const connections = new Set<Socket>();
  bound.on('connection', connection => {
    connections.add(connection);
    connection.once('close', () => connections.delete(connection));
    server.emit('connection', connection);
  });
  // Initialize HTTP timeout/connection tracking for the delegated listener.
  server.emit('listening');
  let shutdown: Promise<void> | undefined;
  const close = () => shutdown ??= (async () => {
    stopping = true;
    // Unlink only our captured inode in the unchanged private management root.
    // The transferred descriptor has no libuv bind pathname to auto-unlink.
    let cleanupError: unknown;
    try { await unlinkSocket(plane, socket, socketStat); } catch (error) { cleanupError = error; }
    await new Promise<void>(resolve => {
      bound.close(() => resolve());
      for (const connection of connections) connection.destroy();
      server.close();
    });
    await Promise.allSettled([...active]);
    if (cleanupError) throw cleanupError;
  })();
  try {
    await plane.files.check();
    const current = await fs.lstat(socket);
    if (!current.isSocket() || current.dev !== socketStat.dev || current.ino !== socketStat.ino || current.uid !== process.getuid?.() || (current.mode & 0o077)) throw new Error('Fleet socket changed');
  }
  catch (error) { await close().catch(() => undefined); throw error; }
  return { address: () => bound.listening ? socket : null, shutdown: close };
}

/** Provisioning is Fleet's job. Missing authority does not create or enable controls. */
export async function startConfiguredFleetData(storage: InstanceStorageService): Promise<FleetDataListener | undefined> {
  const root = path.join(path.dirname(storageControlRoot()), 'fleet-data-control');
  try { await fs.lstat(path.join(root, 'authority.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const plane = new FleetDataPlane(storage, root);
  await plane.initialize();
  return listenFleetData(plane);
}
