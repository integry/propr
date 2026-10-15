import { ExtensionAuthorityV2Plane } from '../core/src/fleet/extensionAuthorityV2.js';
import { EXTENSION_AUTHORITY_V2_PATH, EXTENSION_AUTHORITY_V2_LIMITS } from '@propr/shared';
import { ExtensionAuthorityProofPlane } from '../core/src/fleet/extensionAuthorityProof.js';
import { canonicalFleetJson, EXTENSION_AUTHORITY_PATH } from '@propr/shared';
import type { NativeResetRuntime } from '../core/src/fleet/nativeReset.js';
import { FLEET_EXTENSION_LIMITS, FLEET_RESET_PATH, FLEET_RESET_LIMITS } from '@propr/shared';
import { FleetResetProofPlane } from '../core/src/fleet/resetProof.js';
import { FleetExtensionPlane } from '../core/src/fleet/extensions.js';
import type { ExtensionProfileStore } from '../core/src/extensions/extensionProfileStore.js';
import type { RequestHandler } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { connect, type Socket, type Server as UnixServer } from 'node:net';
import { spawn } from 'node:child_process';
import type { Stats } from 'node:fs';
import { FleetDataPlane, type FleetActorAuthorization } from '../core/src/fleet/dataPlane.js';
import { parseEnvelope } from '../core/src/fleet/contract.js';
import type { InstanceStorageService } from '../core/src/storage/service.js';
import { storageControlRoot } from '../core/src/storage/lifecycle.js';

const MAX_ARTIFACT_BYTES = 512 * 1024 ** 2;
const REVALIDATE_MS = 250;
/** 4 MiB/s minimum supported throughput, plus 30s scheduling/backpressure slack.
 * Hard capped at 158s for 512 MiB; authority expiry remains an independent fence. */
export const fleetTransferDeadline = (size: number) => Math.min(158_000, 30_000 + Math.ceil(size / (4 * 1024 ** 2) * 1000));
export interface FleetDataListener { address(): string | null; shutdown(): Promise<void> }

async function unlinkSocket(plane: Pick<FleetDataPlane, 'files'>, socket: string, expected: Pick<Stats, 'dev' | 'ino'>) {
  await plane.files.check();
  const current = await fs.lstat(socket).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!current) return;
  if (!current.isSocket() || current.dev !== expected.dev || current.ino !== expected.ino || current.uid !== process.getuid?.()) throw new Error('Fleet socket changed');
  await fs.unlink(socket);
}

async function removeStaleSockets(plane: Pick<FleetDataPlane, 'files'>) {
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
  if (req.path !== '/v1/invoke' && req.path !== '/extensions/v1/invoke' && req.path !== FLEET_RESET_PATH && req.path !== EXTENSION_AUTHORITY_PATH && req.path !== EXTENSION_AUTHORITY_V2_PATH) { next(); return; }
  res.set('Cache-Control', 'no-store').status(404).json({ error: (req.path === EXTENSION_AUTHORITY_PATH || req.path === EXTENSION_AUTHORITY_V2_PATH) ? 'extension_authority_unavailable' : req.path === FLEET_RESET_PATH ? 'fleet_reset_unavailable' : req.path === '/extensions/v1/invoke' ? 'fleet_extensions_unavailable' : 'fleet_data_unavailable' });
};

function requestByteLimit(url: string | undefined) {
  return url === EXTENSION_AUTHORITY_V2_PATH ? EXTENSION_AUTHORITY_V2_LIMITS.requestBytes
    : url === '/extensions/v1/invoke' ? FLEET_EXTENSION_LIMITS.requestBytes : 8192;
}

function refusalCode(url: string | undefined) {
  return (url === EXTENSION_AUTHORITY_PATH || url === EXTENSION_AUTHORITY_V2_PATH) ? 'extension_authority_unavailable'
    : url === FLEET_RESET_PATH ? 'fleet_reset_unavailable'
      : url === '/extensions/v1/invoke' ? 'fleet_extensions_unavailable' : 'fleet_data_unavailable';
}

async function readRequestBytes(req: import('node:http').IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []; let length = 0;
  for await (const part of req) {
    const bytes = Buffer.from(part); length += bytes.length;
    if (length > requestByteLimit(req.url)) throw new Error();
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

function decodeRequestBytes(url: string | undefined, bytes: Buffer): string {
  return url === EXTENSION_AUTHORITY_V2_PATH
    ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) : bytes.toString('utf8');
}

/** Separate Unix listener only. Never mount this handler on Express or the tunnel. */
interface FleetListenerPlane {
  files: FleetDataPlane['files'];
  runtime(): Promise<{ runtimeGeneration: string }>;
  invoke?: FleetDataPlane['invoke'];
  stream?: FleetDataPlane['stream'];
}
export async function listenFleetData(plane: FleetListenerPlane, extensions?: FleetExtensionPlane, reset?: FleetResetProofPlane): Promise<FleetDataListener> {
  const dualProof = extensions ? new ExtensionAuthorityV2Plane(extensions) : undefined;
  const proof = extensions ? new ExtensionAuthorityProofPlane(extensions) : undefined;
  const runtime = await plane.runtime();
  const socket = path.join(plane.files.root, `data-${runtime.runtimeGeneration}.sock`);
  await removeStaleSockets(plane);
  const active = new Set<Promise<void>>();
  let stopping = false;
  const isSupportedPath = (url: string | undefined) =>
    Boolean(plane.invoke && plane.stream && url === '/v1/invoke') || Boolean(extensions && url === '/extensions/v1/invoke') || Boolean(reset && url === FLEET_RESET_PATH) || Boolean(proof && url === EXTENSION_AUTHORITY_PATH) || Boolean(dualProof && url === EXTENSION_AUTHORITY_V2_PATH);
  const server = createServer((req, res) => {
    if (stopping) { res.destroy(); return; }
    const work = handle(req, res);
    active.add(work);
    void work.finally(() => active.delete(work));
  });
  const handle = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    // A post-commit stream error only closes this connection. Never log its
    // diagnostic or turn it into rollback/retry of the authority operation.
    if (req.url === EXTENSION_AUTHORITY_V2_PATH) res.on('error', () => res.destroy());
    res.setHeader('Cache-Control', 'no-store');
    let timer: NodeJS.Timeout | undefined;
    try {
      if (req.method !== 'POST' || !isSupportedPath(req.url) || req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) throw new Error();
      timer = setTimeout(() => req.destroy(), 5000);
      const bytes = await readRequestBytes(req);
      clearTimeout(timer);
      const raw = decodeRequestBytes(req.url, bytes);
      if (req.url === EXTENSION_AUTHORITY_V2_PATH) {
        await dualProof!.invokeDelivery(raw, response => {
          if (res.destroyed || stopping) return;
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(canonicalFleetJson(response));
        });
      } else if (req.url === EXTENSION_AUTHORITY_PATH) {
        await proof!.invoke(raw, response => {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(canonicalFleetJson(response));
        });
      } else if (req.url === FLEET_RESET_PATH) {
        const body = JSON.stringify(await reset!.invoke(raw));
        if (Buffer.byteLength(body) > FLEET_RESET_LIMITS.responseBytes) throw new Error();
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body);
      } else if (req.url === '/extensions/v1/invoke') {
        const body = JSON.stringify(await extensions!.invoke(raw));
        if (Buffer.byteLength(body) > FLEET_EXTENSION_LIMITS.responseBytes) throw new Error();
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body);
      } else if (parseEnvelope(raw).request.action === 'artifact.stream') {
        await plane.stream!(raw, async (download, authorize) => {
          await authorize();
          const size = download.status.sizeBytes!;
          res.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Length': size, 'X-Content-Type-Options': 'nosniff' });
          let sent = 0;
          const controller = new AbortController();
          const fence = setInterval(() => { void authorize().catch(() => controller.abort()); }, REVALIDATE_MS);
          const deadline = setTimeout(() => controller.abort(), fleetTransferDeadline(size));
          try {
            const buffer = Buffer.alloc(64 * 1024);
            while (sent < size) {
              if (controller.signal.aborted || res.destroyed) throw new Error();
              // Check before each file read AND again before releasing those bytes.
              await authorize();
              const { bytesRead } = await download.file.read(buffer, 0, Math.min(buffer.length, size - sent), sent);
              if (!bytesRead || sent + bytesRead > MAX_ARTIFACT_BYTES) throw new Error();
              await authorize();
              if (controller.signal.aborted || res.destroyed) throw new Error();
              const chunk = Buffer.from(buffer.subarray(0, bytesRead));
              sent += bytesRead;
              if (!res.write(chunk)) {
                await new Promise<void>((resolve, reject) => {
                  const done = (error?: Error) => {
                    res.off('drain', drain); res.off('close', closed);
                    controller.signal.removeEventListener('abort', aborted);
                    if (error) reject(error);
                    else resolve();
                  };
                  const drain = () => done();
                  const closed = () => done(new Error());
                  const aborted = () => done(new Error());
                  res.once('drain', drain); res.once('close', closed);
                  controller.signal.addEventListener('abort', aborted, { once: true });
                  if (res.destroyed || controller.signal.aborted) closed();
                });
              }
            }
            await authorize();
            res.end();
          } finally { clearInterval(fence); clearTimeout(deadline); }
          if (sent !== size) throw new Error();
        });
      } else {
        const result = await plane.invoke!(raw);
        const body = JSON.stringify(result);
        if (Buffer.byteLength(body) > 32768) throw new Error();
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body);
      }
    } catch {
      if (res.headersSent) res.destroy();
      else { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: refusalCode(req.url) })); }
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
    stopping = true; dualProof?.shutdown(); proof?.shutdown(); extensions?.shutdown(); reset?.shutdown();
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
export async function startConfiguredFleetData(storage: InstanceStorageService, authorizeActor: FleetActorAuthorization, store?: ExtensionProfileStore, nativeReset?: NativeResetRuntime): Promise<FleetDataListener | undefined> {
  try {
    const listener = await openConfiguredFleetData(storage, authorizeActor, store, nativeReset);
    if (!listener) { nativeReset?.close(); return; }
    return { address: listener.address, shutdown: async () => {
      try { await listener.shutdown(); } finally { nativeReset?.close(); }
    } };
  } catch (error) { nativeReset?.close(); throw error; }
}

async function openConfiguredFleetData(storage: InstanceStorageService, authorizeActor: FleetActorAuthorization, store?: ExtensionProfileStore, nativeReset?: NativeResetRuntime): Promise<FleetDataListener | undefined> {
  const root = path.join(path.dirname(storageControlRoot()), 'fleet-data-control');
  try { await fs.lstat(path.join(root, 'authority.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const plane = new FleetDataPlane(storage, root, undefined, authorizeActor);
  await plane.initialize();
  // Reset uses separately provisioned authority and a dedicated secret. It is
  // absent by default; the export/extension secret cannot authorize reset.
  const resetRoot = path.join(path.dirname(root), 'fleet-reset-control');
  try { await fs.lstat(path.join(resetRoot, 'authority.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return listenFleetData(plane, store ? new FleetExtensionPlane(plane, store) : undefined);
  }
  const reset = new FleetResetProofPlane(resetRoot, undefined, undefined, nativeReset);
  try { await reset.initialize(); }
  catch { throw new Error('Configured Fleet reset authority unavailable'); }
  return listenFleetData(plane, store ? new FleetExtensionPlane(plane, store) : undefined, reset);
}

/** Restart entry point that does not open customer SQLite, queues, sessions or
 * on-boot tasks. It can observe an interrupted reset even when Core admission is
 * permanently fenced. Fleet chooses when to replace the application process. */
export async function listenFleetResetRecovery(root: string, native: NativeResetRuntime): Promise<FleetDataListener> {
  const reset = new FleetResetProofPlane(root, undefined, undefined, native, true);
  await reset.initialize();
  const authority = JSON.parse(await reset.files.read('authority.json'));
  return listenFleetData({ files: reset.files, runtime: async () => ({ runtimeGeneration: authority.binding.predecessor.runtimeId }) }, undefined, reset);
}
