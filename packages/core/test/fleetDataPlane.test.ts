import test from 'node:test';
import ts from 'typescript';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalFleetJson, type FleetDataRequest, type FleetActorDataAssertion as FleetDataAssertion, type FleetActorDataResult as FleetDataResult, type StorageCleanupPreview, type StorageCleanupResult, FLEET_DATA_SCHEMA } from '@propr/shared';
import { FleetDataPlane } from '../src/fleet/dataPlane.js';
import { contractPin, digest, parseEnvelope } from '../src/fleet/contract.js';
import { InstanceStorageService } from '../src/storage/service.js';
import { StorageLifecycle } from '../src/storage/lifecycle.js';
import { auditRepository, repositoryIdentity, repositoryMetadataFingerprint } from '../src/storage/repositorySafety.js';
import { listenFleetData, startConfiguredFleetData } from '../../api/fleetDataListener.js';
const SQLite = createRequire(import.meta.url)('better-sqlite3');
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fleet Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Fleet Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });

async function fixture(t: test.TestContext, repository = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-'));
  const control = path.join(root, 'fleet-data-control'); await fs.mkdir(control, { mode: 0o700 });
  let secret = 'fleet-secret-canary-'.repeat(3);
  const authority = { hostedInstanceId: 'hosted-tenant-a', placementGeneration: 'placement-7', scope: 'hosted_customer_data', secretSha256: createHash('sha256').update(secret).digest('hex') };
  const writeAuthority = async () => fs.writeFile(path.join(control, 'authority.json'), JSON.stringify(authority), { mode: 0o600 });
  await writeAuthority();
  const source = path.join(root, 'db.sqlite');
  const db = new SQLite(source); db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE customer(id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE encrypted_credentials(value TEXT); CREATE TABLE system_configs(key TEXT, value TEXT); CREATE TABLE knex_migrations(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO knex_migrations VALUES(1,'fleet-test-v1'); PRAGMA user_version=9;`);
  db.prepare('INSERT INTO customer(body) VALUES(?)').run('customer sentinel');
  db.prepare('INSERT INTO encrypted_credentials VALUES(?)').run('ciphertext sentinel');
  db.prepare('INSERT INTO system_configs VALUES(?,?)').run('fleet_control_secret', secret);
  db.prepare('INSERT INTO system_configs VALUES(?,?)').run('agents', JSON.stringify([{ id: 'a', envVars: { API_KEY: 'private-env-canary' }, configPath: '/provider-home-canary' }]));
  const clones = path.join(root, 'clones'); await fs.mkdir(clones);
  const native = path.join(root, 'storage-control');
  const lifecycle = new StorageLifecycle(native);
  let pending = false;
  let afterProof: (() => Promise<void>) | undefined;
  const remote = path.join(root, 'remote.git');
  const options = { databaseFile: source, lifecycle, clonesRoot: clones, roots: [], hasPendingTasks: async () => pending,
    auditRepository: async (directory: string, identity: Parameters<typeof auditRepository>[1], _remote: string, opts: Parameters<typeof auditRepository>[3]) => {
      const result = await auditRepository(directory, identity, `file://${remote}`, { ...opts, allowTestFileRemote: true });
      await afterProof?.(); return result;
    } };
  const storage = new InstanceStorageService(options);
  await storage.initialize();
  const id = createHash('sha256').update('owner/repo').digest('hex');
  const clone = path.join(clones, 'owner', 'repo');
  if (repository) {
    await git(root, 'init', '--bare', remote);
    await fs.mkdir(path.dirname(clone)); await git(root, 'clone', remote, clone);
    await fs.writeFile(path.join(clone, 'published'), 'refetchable sentinel');
    await git(clone, 'add', '.'); await git(clone, 'commit', '-m', 'published'); await git(clone, 'push', 'origin', 'HEAD');
    await fs.mkdir(path.join(native, 'repositories'));
    await fs.writeFile(path.join(native, 'repositories', `${id}.json`), JSON.stringify({ id, owner: 'owner', name: 'repo', identity: await repositoryIdentity(clone), metadataFingerprint: await repositoryMetadataFingerprint(clone) }));
  }
  const members = new Map<number, { role: string; permissions: string[]; source: string }>([
    [100, { role: 'admin', permissions: ['instance.manage_settings'], source: 'local' }],
    [101, { role: 'admin', permissions: ['instance.manage_settings'], source: 'managed' }],
    [200, { role: 'member', permissions: [], source: 'local' }],
  ]);
  const authorizeActor = async (id: number) => members.get(id) ?? { role: 'member', permissions: [], source: 'implicit' };
  const plane = new FleetDataPlane(storage, control, () => secret, authorizeActor); await plane.initialize();
  const runtime = await plane.runtime();
  const sign = (r: FleetDataRequest, patch: Partial<FleetDataAssertion> = {}) => {
    const assertion = { ...runtime, githubActorId: 100, action: r.action, requestDigest: digest(r), operationId: randomUUID(), nonce: randomBytes(32).toString('hex'), issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 60, ...patch };
    return canonicalFleetJson({ assertion, request: r, mac: createHmac('sha256', secret).update(canonicalFleetJson(assertion)).digest('hex') });
  };
  const invoke = (r: FleetDataRequest) => plane.invoke(sign(r));
  const server = await listenFleetData(plane);
  const socketPath = server.address() as string;
  const http = (raw: string) => new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = request({ socketPath, path: '/v1/invoke', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      const parts: Buffer[] = []; res.on('data', chunk => parts.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(parts) })); res.on('error', reject);
    }); req.on('error', reject); req.end(raw);
  });
  t.after(async () => {
    await server.shutdown().catch(() => undefined);
    // Cancel native staging regardless of whether Fleet authority was revoked by the test.
    const entries = await fs.readdir(control).catch(() => []);
    for (const entry of entries.filter(name => name.startsWith('operation-'))) {
      try {
        const op = JSON.parse((await fs.readFile(path.join(control, entry), 'utf8')).trimEnd().split('\n').at(-1)!);
        if (op.nativeExport) await storage.exports!.cancel(runtime.storageInstanceId, storage.exports!.generation, op.nativeExport.operationId, String(op.githubActorId), async () => {});
      } catch { /* consumed or deliberately substituted */ }
    }
    db.close(); await fs.rm(root, { recursive: true, force: true });
  });
  return { root, control, source, native, storage, plane, sign, invoke, runtime, db, http, server, secret, authority, writeAuthority, clone, remote, id, members, authorizeActor,
    pending: () => { pending = true; }, rotate: () => { secret = 'rotated-secret-canary-'.repeat(3); },
    afterProof: (callback: () => Promise<void>) => { afterProof = callback; },
    restart: async () => { const next = new FleetDataPlane(new InstanceStorageService(options), control, () => secret, authorizeActor); await next.initialize(); return next; } };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  for (let i = 0; i < 200; i++) {
    const result = (await f.invoke({ action: 'operation.status', targetOperationId: id })).result as FleetDataResult;
    if (result.state !== 'running') return result;
    await delay(20);
  }
  throw new Error('Export did not settle');
}

// Signal only after stream admission has reached the real lock acquisition.
function streamWaiting(t: test.TestContext, plane: FleetDataPlane, count = 1) {
  const internals = plane as unknown as { acquireTarget: (id: string, action: FleetDataRequest['action']) => Promise<void> };
  const acquire = internals.acquireTarget.bind(plane);
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(internals, 'acquireTarget', (id: string, action: FleetDataRequest['action']) => {
    const pending = acquire(id, action);
    if (action === 'artifact.stream' && --count === 0) entered();
    return pending;
  });
  return waiting;
}

test('private Unix contract runs real WAL export, streams once, preserves ciphertext and excludes secrets', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.server.address(), 'string');
  assert.equal((await fs.stat(f.server.address() as string)).mode & 0o777, 0o600);
  const writer = setInterval(() => f.db.transaction(() => {
    f.db.prepare('INSERT INTO customer(body) VALUES(?)').run('paired a');
    f.db.prepare('INSERT INTO customer(body) VALUES(?)').run('paired b');
  })(), 2);
  t.after(() => clearInterval(writer));
  const start = await f.http(f.sign({ action: 'database.export' }));
  assert.equal(start.status, 200);
  const operation = JSON.parse(start.body.toString());
  const status = await ready(f, operation.operationId); assert.equal(status.state, 'completed');
  const responses = await Promise.all([0, 1].map(() => f.http(f.sign({ action: 'artifact.stream', targetOperationId: operation.operationId }))));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 403]);
  const response = responses.find(response => response.status === 200)!;
  clearInterval(writer);
  assert.equal(response.status, 200);
  const meta = status.result as { sizeBytes: number; sha256: string; schemaVersion: number; migration: string };
  assert.equal(response.body.length, meta.sizeBytes);
  assert.equal(createHash('sha256').update(response.body).digest('hex'), meta.sha256);
  assert.equal(meta.schemaVersion, 9); assert.equal(meta.migration, 'fleet-test-v1');
  for (const secret of [f.secret, 'private-env-canary', '/provider-home-canary']) assert.ok(!response.body.includes(Buffer.from(secret)));
  const output = path.join(f.root, 'download.sqlite'); await fs.writeFile(output, response.body);
  const restored = new SQLite(output);
  try {
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(restored.pragma('foreign_key_check'), []);
    assert.equal(restored.prepare('SELECT value FROM encrypted_credentials').get().value, 'ciphertext sentinel');
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM customer WHERE body = ?').get('paired a').n, restored.prepare('SELECT COUNT(*) AS n FROM customer WHERE body = ?').get('paired b').n);
  } finally { restored.close(); }
  assert.equal((await f.http(f.sign({ action: 'artifact.stream', targetOperationId: operation.operationId }))).status, 403);
});

test('real Git inventory and confirmation remove only the refetchable cache; Fleet audit is exact', async t => {
  const f = await fixture(t, true);
  const list = await f.invoke({ action: 'repositories.list' }); assert.equal(list.state, 'completed');
  const preview = await f.invoke({ action: 'repositories.cleanup.preview' });
  const confirmation = (preview.result as StorageCleanupPreview).confirmation;
  const execute = { action: 'repositories.cleanup.execute' as const, previewOperationId: preview.operationId, confirmation };
  const result = await f.invoke(execute);
  assert.deepEqual((result.result as StorageCleanupResult).deleted, [f.id]);
  await assert.rejects(fs.stat(f.clone));
  await assert.rejects(f.invoke(execute));
  await git(f.root, 'clone', f.remote, f.clone);
  assert.equal(await fs.readFile(path.join(f.clone, 'published'), 'utf8'), 'refetchable sentinel');
  const audit = (await fs.readFile(path.join(f.native, 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(audit.length); assert.ok(audit.every(record => record.actor === '100'));
  assert.ok(!JSON.stringify(result).includes(f.root));
});

for (const protection of ['active', 'dirty', 'unpublished', 'changed', 'revoked-after-proof'] as const) {
  test(`internal cleanup preserves ${protection} work`, async t => {
    const f = await fixture(t, true);
    const preview = await f.invoke({ action: 'repositories.cleanup.preview' });
    if (protection === 'active') f.pending();
    if (protection === 'dirty' || protection === 'changed') await fs.writeFile(path.join(f.clone, 'private'), 'private sentinel');
    if (protection === 'unpublished') {
      await fs.writeFile(path.join(f.clone, 'private'), 'private sentinel'); await git(f.clone, 'add', '.'); await git(f.clone, 'commit', '-m', 'unpublished');
    }
    if (protection === 'revoked-after-proof') f.afterProof(async () => { f.authority.placementGeneration = 'placement-8'; await f.writeAuthority(); });
    const run = f.invoke({ action: 'repositories.cleanup.execute', previewOperationId: preview.operationId, confirmation: (preview.result as StorageCleanupPreview).confirmation });
    if (protection === 'revoked-after-proof') await assert.rejects(run);
    else assert.deepEqual(((await run).result as StorageCleanupResult).deleted, []);
    assert.ok((await fs.stat(f.clone)).isDirectory());
  });
}

test('strict signed binding matrix refuses other tenant/generation/scope/action/digest/id, tamper, expiry and raw credentials', async t => {
  const f = await fixture(t);
  const r = { action: 'repositories.list' as const };
  const patches = [ { hostedInstanceId: 'other' }, { storageInstanceId: randomUUID() }, { runtimeGeneration: randomUUID() }, { storageGeneration: randomUUID() }, { placementGeneration: 'other' },
    { scope: 'other' }, { action: 'database.export' }, { requestDigest: '0'.repeat(64) }, { contractPin: '0'.repeat(64) }, { operationId: '/tmp/path' },
    { issuedAt: 1, expiresAt: 61 }, { issuedAt: Math.floor(Date.now() / 1000) + 100 }, { expiresAt: Math.floor(Date.now() / 1000) + 600 } ];
  for (const patch of patches) assert.equal((await f.http(f.sign(r, patch as Partial<FleetDataAssertion>))).status, 403);
  const good = f.sign(r);
  const value = JSON.parse(good); value.assertion.operationId = randomUUID();
  assert.equal((await f.http(canonicalFleetJson(value))).status, 403);
  for (const raw of [f.secret, '{}', '{"user":{"id":"instance-admin"}}', good.replace('"action":', '"extra":true,"action":'), good.replace('"mac":', '"mac":"duplicate","mac":')]) {
    const response = await f.http(raw); assert.equal(response.status, 403); assert.equal(response.body.toString(), '{"error":"fleet_data_unavailable"}');
  }
  for (const extra of [{ path: '/etc/passwd' }, { sql: 'SELECT *' }, { force: true }, { categories: ['task_history'] }, { url: 'https://example.invalid' }]) {
    assert.equal((await f.http(f.sign({ ...r, ...extra }))).status, 403);
  }
  assert.equal((await f.http(good)).status, 200);
  assert.equal((await f.http(good)).status, 403);
  assert.equal((await f.http(f.sign(r, { operationId: JSON.parse(good).assertion.operationId }))).status, 403);
  assert.equal((await f.http(f.sign(r, { nonce: JSON.parse(good).assertion.nonce }))).status, 403);
});

test('concurrent identical requests dispatch once and lost replies are read through a fresh status grant', async t => {
  const f = await fixture(t); const raw = f.sign({ action: 'repositories.list' });
  const results = await Promise.all([f.http(raw), f.http(raw)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 403]);
  const id = JSON.parse(raw).assertion.operationId;
  const status = await f.invoke({ action: 'operation.status', targetOperationId: id });
  assert.equal((status.result as FleetDataResult).state, 'completed');
});

test('rotation, missing authority and native identity changes revoke status and artifact authority', async t => {
  const f = await fixture(t);
  const op = await f.invoke({ action: 'repositories.list' });
  const raw = f.sign({ action: 'operation.status', targetOperationId: op.operationId });
  f.rotate(); assert.equal((await f.http(raw)).status, 403);
  await fs.unlink(path.join(f.control, 'authority.json'));
  assert.equal((await f.http(raw)).status, 403);
});

test('restart fails undispatched records, fences ambiguous work, refuses old grants and cross-generation status', async t => {
  const f = await fixture(t);
  const raw = f.sign({ action: 'repositories.list' });
  const admitted = await (f.plane as any).admit(raw);
  const ambiguous = await (f.plane as any).admit(f.sign({ action: 'database.export' }));
  await (f.plane as any).save(ambiguous.op, 'dispatched');
  const next = await f.restart();
  for (const [id, state] of [[admitted.op.operationId, 'failed'], [ambiguous.op.operationId, 'fenced']]) {
    const stored = JSON.parse((await fs.readFile(path.join(f.control, `operation-${id}.jsonl`), 'utf8')).trimEnd().split('\n').at(-1)!);
    assert.equal(stored.state, state);
  }
  await assert.rejects(next.invoke(raw));
  await assert.rejects(f.invoke({ action: 'repositories.list' }));
  const runtime = await next.runtime();
  await assert.rejects(next.invoke(f.sign({ action: 'operation.status', targetOperationId: admitted.op.operationId }, { runtimeGeneration: runtime.runtimeGeneration })));
});

for (const attack of ['symlink', 'hardlink', 'fifo', 'ancestor', 'native-identity'] as const) {
  test(`fails closed on ${attack} substitution`, async t => {
    const f = await fixture(t);
    const raw = f.sign({ action: 'repositories.list' });
    const authority = path.join(f.control, 'authority.json');
    if (attack === 'ancestor') {
      await fs.rename(f.control, `${f.control}-old`); await fs.mkdir(f.control, { mode: 0o700 });
      await fs.copyFile(path.join(`${f.control}-old`, 'authority.json'), authority);
    } else if (attack === 'native-identity') {
      await fs.writeFile(path.join(f.native, 'instance.json'), JSON.stringify(randomUUID()));
    } else {
      await fs.rename(authority, path.join(f.root, 'original'));
      if (attack === 'symlink') await fs.symlink(path.join(f.root, 'original'), authority);
      if (attack === 'hardlink') await fs.link(path.join(f.root, 'original'), authority);
      if (attack === 'fifo') await exec('mkfifo', ['-m', '600', authority]);
    }
    if (attack === 'ancestor') await assert.rejects(f.plane.invoke(raw));
    else assert.equal((await f.http(raw)).status, 403);
  });
}

test('canonical contract fixtures pin exact schema, digest, assertion MAC and UTF-8 bytes', async () => {
  const directory = path.resolve('docs/contracts/fleet-data-v2');
  const fixture = JSON.parse(await fs.readFile(path.join(directory, 'fixtures.json'), 'utf8'));
  assert.equal(fixture.contractPin, contractPin);
  for (const item of fixture.requests) {
    const envelope = parseEnvelope(item.canonical);
    assert.equal(createHash('sha256').update(item.canonical).digest('hex'), item.sha256);
    assert.equal(createHmac('sha256', fixture.testSecret).update(canonicalFleetJson(envelope.assertion)).digest('hex'), envelope.mac);
  }
});

test('signed requests are refused on customer TCP listener and forwarded tunnel ingress', async t => {
  const f = await fixture(t);
  const { default: express } = await import('express');
  const { refusePublicFleetData } = await import('../../api/fleetDataListener.js');
  const { createServer } = await import('node:http');
  const app = express(); app.use(refusePublicFleetData);
  const customer = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => customer.once('listening', resolve));
  const port = (customer.address() as import('node:net').AddressInfo).port;
  const tunnel = createServer((req, res) => {
    const forward = request({ hostname: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, response => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res);
    }); req.pipe(forward);
  });
  tunnel.listen(0, '127.0.0.1'); await new Promise<void>(resolve => tunnel.once('listening', resolve));
  t.after(async () => { await Promise.all([customer, tunnel].map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
  const raw = f.sign({ action: 'repositories.list' });
  for (const server of [customer, tunnel]) {
    for (const route of ['/v1/invoke', '/extensions/v1/invoke']) {
      const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}${route}`;
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Role': 'admin', 'X-Forwarded-For': '127.0.0.1', Authorization: `Bearer ${f.secret}` }, body: raw });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: route === '/extensions/v1/invoke' ? 'fleet_extensions_unavailable' : 'fleet_data_unavailable' });
    }
  }
  // Refusal on TCP never consumed this grant. Only the private listener can.
  assert.equal((await f.http(raw)).status, 200);
  const source = await fs.readFile(path.resolve('packages/api/server.ts'), 'utf8');
  assert.match(source, /app\.use\(refusePublicFleetData\)/);
});

test('foreign confirmation, cross-tenant status and artifact grants are refused', async t => {
  const f = await fixture(t);
  const native = await f.storage.preview(f.runtime.storageInstanceId, ['repository_caches'], 'fleet');
  const list = await f.invoke({ action: 'repositories.list' });
  await assert.rejects(f.invoke({ action: 'repositories.cleanup.execute', previewOperationId: list.operationId, confirmation: native.confirmation }));
  const exportOp = await f.invoke({ action: 'database.export' });
  await ready(f, exportOp.operationId);
  for (const action of ['operation.status', 'artifact.stream', 'operation.cancel'] as const) {
    assert.equal((await f.http(f.sign({ action, targetOperationId: exportOp.operationId }, { hostedInstanceId: 'foreign-tenant' }))).status, 403);
  }
  f.authority.placementGeneration = 'moved'; await f.writeAuthority();
  assert.equal((await f.http(f.sign({ action: 'artifact.stream', targetOperationId: exportOp.operationId }))).status, 403);
});

test('consumer failure consumes redemption and fences result; native staging is deleted after outcome', async t => {
  const f = await fixture(t);
  const op = await f.invoke({ action: 'database.export' }); await ready(f, op.operationId);
  // Hold the completion watcher while it checks an already-completed export.
  // Streaming must wait for that metadata check before claiming redemption.
  let releaseWatcher!: () => void;
  let watcherEntered!: () => void;
  const held = new Promise<void>(resolve => { releaseWatcher = resolve; });
  const entered = new Promise<void>(resolve => { watcherEntered = resolve; });
  t.after(releaseWatcher);
  const read = f.plane.files.read.bind(f.plane.files);
  t.mock.method(f.plane.files, 'read', async (name: string) => {
    const value = await read(name);
    if (name === `operation-${op.operationId}.jsonl`) { watcherEntered(); await held; }
    return value;
  });
  const watcher = (f.plane as any).watchExport(op.operationId);
  await entered;
  const waiting = streamWaiting(t, f.plane);
  let sawBytes = false;
  const transfer = assert.rejects(f.plane.stream(f.sign({ action: 'artifact.stream', targetOperationId: op.operationId }), async download => {
    const buffer = Buffer.alloc(32); await download.file.read(buffer, 0, 32, 0); sawBytes = true;
    throw new Error('consumer-disconnected-canary');
  }));
  await waiting;
  assert.equal(sawBytes, false);
  releaseWatcher();
  await transfer;
  await watcher;
  assert.ok(sawBytes);
  const status = await f.invoke({ action: 'operation.status', targetOperationId: op.operationId });
  assert.equal((status.result as FleetDataResult).state, 'fenced');
  assert.ok(!JSON.stringify(status).includes('consumer-disconnected-canary'));
  assert.equal((await f.http(f.sign({ action: 'artifact.stream', targetOperationId: op.operationId }))).status, 403);
  assert.ok(!(await fs.readdir(path.join(f.native, 'exports'))).some(name => name.startsWith('snapshot-')));
});

test('fresh streams wait for a status owner and exactly one redeems after release', async t => {
  const f = await fixture(t);
  const op = await f.invoke({ action: 'database.export' }); await ready(f, op.operationId);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<void>(resolve => { entered = resolve; });
  t.after(release);
  const read = f.plane.files.read.bind(f.plane.files);
  let block = true, statusOwnsTarget = false;
  const internals = f.plane as unknown as { acquireTarget: (id: string, action: FleetDataRequest['action']) => Promise<void> };
  const acquire = internals.acquireTarget.bind(f.plane);
  t.mock.method(internals, 'acquireTarget', async (id: string, action: FleetDataRequest['action']) => {
    await acquire(id, action);
    if (action === 'operation.status') statusOwnsTarget = true;
  });
  t.mock.method(f.plane.files, 'read', async (name: string) => {
    const value = await read(name);
    if (statusOwnsTarget && block && name === `operation-${op.operationId}.jsonl`) {
      block = false; entered(); await held;
    }
    return value;
  });
  const status = f.invoke({ action: 'operation.status', targetOperationId: op.operationId });
  await locked;
  const waiting = streamWaiting(t, f.plane, 2);
  const redeem = t.mock.method(f.storage.exports!, 'redeem');
  let consumers = 0, bytes = 0;
  const grants = [0, 1].map(() => f.sign({ action: 'artifact.stream', targetOperationId: op.operationId }));
  const transfers = Promise.allSettled(grants.map(raw => f.plane.stream(raw, async (download, authorize) => {
    consumers++;
    await authorize();
    const buffer = Buffer.alloc(32);
    const result = await download.file.read(buffer, 0, buffer.length, 0);
    await authorize(); bytes += result.bytesRead;
  })));
  await waiting;
  assert.equal(consumers, 0); assert.equal(redeem.mock.callCount(), 0);
  release(); await status;
  const results = await transfers;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(consumers, 1); assert.equal(redeem.mock.callCount(), 1); assert.equal(bytes, 32);
  for (const raw of grants) await assert.rejects(f.plane.stream(raw, async () => assert.fail('replay')));
  assert.equal(redeem.mock.callCount(), 1);
  const final = await f.invoke({ action: 'operation.status', targetOperationId: op.operationId });
  assert.equal((final.result as FleetDataResult).state, 'consumed');
  assert.ok(!(await fs.readdir(path.join(f.native, 'exports'))).some(name => name.startsWith('snapshot-')));
});

test('target-lock timeout never redeems and does not release the status owner', async t => {
  const f = await fixture(t);
  const op = await f.invoke({ action: 'database.export' }); await ready(f, op.operationId);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<void>(resolve => { entered = resolve; });
  t.after(release);
  const read = f.plane.files.read.bind(f.plane.files);
  let block = true, statusOwnsTarget = false;
  const internals = f.plane as unknown as { acquireTarget: (id: string, action: FleetDataRequest['action']) => Promise<void> };
  const acquire = internals.acquireTarget.bind(f.plane);
  t.mock.method(internals, 'acquireTarget', async (id: string, action: FleetDataRequest['action']) => {
    await acquire(id, action);
    if (action === 'operation.status') statusOwnsTarget = true;
  });
  t.mock.method(f.plane.files, 'read', async (name: string) => {
    const value = await read(name);
    if (statusOwnsTarget && block && name === `operation-${op.operationId}.jsonl`) {
      block = false; entered(); await held;
    }
    return value;
  });
  const status = f.invoke({ action: 'operation.status', targetOperationId: op.operationId });
  await locked;
  const redeem = t.mock.method(f.storage.exports!, 'redeem');
  const raw = f.sign({ action: 'artifact.stream', targetOperationId: op.operationId });
  await assert.rejects(f.plane.stream(raw, async () => assert.fail('timed-out consumer')));
  await assert.rejects(f.plane.stream(raw, async () => assert.fail('replay')));
  // A second fresh grant must still time out: the first waiter cannot unlock its owner.
  await assert.rejects(f.plane.stream(f.sign({ action: 'artifact.stream', targetOperationId: op.operationId }), async () => assert.fail('owner was released')));
  assert.equal(redeem.mock.callCount(), 0);
  const streamRecord = JSON.parse((await read(`operation-${JSON.parse(raw).assertion.operationId}.jsonl`)).trimEnd().split('\n').at(-1)!);
  assert.equal(streamRecord.state, 'failed');
  const targetRecord = JSON.parse((await read(`operation-${op.operationId}.jsonl`)).trimEnd().split('\n').at(-1)!);
  assert.equal(targetRecord.state, 'completed');
  release(); await status;
  await f.invoke({ action: 'operation.cancel', targetOperationId: op.operationId });
  assert.ok(!(await fs.readdir(path.join(f.native, 'exports'))).some(name => name.startsWith('snapshot-')));
});

test('parallel stream times out behind a consumer; actor revocation fences and cleans staging', async t => {
  const f = await fixture(t);
  const op = await f.invoke({ action: 'database.export' }); await ready(f, op.operationId);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const consuming = new Promise<void>(resolve => { entered = resolve; });
  t.after(release);
  const redeem = t.mock.method(f.storage.exports!, 'redeem');
  let bytes = 0;
  const raw = f.sign({ action: 'artifact.stream', targetOperationId: op.operationId });
  const first = assert.rejects(f.plane.stream(raw, async (download, authorize) => {
    entered(); await held;
    await authorize();
    const result = await download.file.read(Buffer.alloc(32), 0, 32, 0);
    await authorize(); bytes += result.bytesRead;
  }));
  await consuming;
  const parallel = f.sign({ action: 'artifact.stream', targetOperationId: op.operationId });
  await assert.rejects(f.plane.stream(parallel, async () => assert.fail('parallel consumer')));
  await assert.rejects(f.plane.stream(parallel, async () => assert.fail('parallel replay')));
  assert.equal(redeem.mock.callCount(), 1);
  assert.ok((await fs.readdir(path.join(f.native, 'exports'))).some(name => name.startsWith('snapshot-')));
  f.members.delete(100); release(); await first;
  assert.equal(bytes, 0);
  await assert.rejects(f.plane.stream(raw, async () => assert.fail('revoked replay')));
  assert.equal(redeem.mock.callCount(), 1);
  const record = JSON.parse((await f.plane.files.read(`operation-${op.operationId}.jsonl`)).trimEnd().split('\n').at(-1)!);
  assert.equal(record.state, 'fenced');
  assert.ok(!(await fs.readdir(path.join(f.native, 'exports'))).some(name => name.startsWith('snapshot-')));
  // Restore authorization only to prove the terminal fence still prevents redemption.
  f.members.set(100, { role: 'admin', permissions: ['instance.manage_settings'], source: 'local' });
  await assert.rejects(f.plane.stream(f.sign({ action: 'artifact.stream', targetOperationId: op.operationId }), async () => assert.fail('fenced consumer')));
  assert.equal(redeem.mock.callCount(), 1);
});

test('concurrent cleanup execution has only one durable confirmation claim', async t => {
  const f = await fixture(t, true);
  const preview = await f.invoke({ action: 'repositories.cleanup.preview' });
  const r = { action: 'repositories.cleanup.execute' as const, previewOperationId: preview.operationId, confirmation: (preview.result as StorageCleanupPreview).confirmation };
  const results = await Promise.allSettled([f.invoke(r), f.invoke(r), f.invoke(r)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const claims = (await fs.readdir(f.control)).filter(name => name.startsWith('confirmation-'));
  assert.equal(claims.length, 1);
});

test('dispatch persistence failure is a definite failed result and invokes no native work', async t => {
  const f = await fixture(t);
  let calls = 0;
  t.mock.method(f.storage, 'inventory', async () => { calls++; throw new Error('should never run'); });
  const append = f.plane.files.append.bind(f.plane.files);
  let first = true;
  t.mock.method(f.plane.files, 'append', async (name: string, value: unknown) => {
    if (first) { first = false; throw new Error('disk full'); }
    return append(name, value);
  });
  const raw = f.sign({ action: 'repositories.list' });
  await assert.rejects(f.plane.invoke(raw));
  assert.equal(calls, 0);
  const id = JSON.parse(raw).assertion.operationId;
  const record = JSON.parse((await fs.readFile(path.join(f.control, `operation-${id}.jsonl`), 'utf8')).trimEnd().split('\n').at(-1)!);
  assert.equal(record.state, 'failed');
});

test('cancellation is signed, generation bound and invalidates pending export/preview', async t => {
  const f = await fixture(t);
  const op = await f.invoke({ action: 'database.export' });
  const cancelled = await f.invoke({ action: 'operation.cancel', targetOperationId: op.operationId });
  assert.deepEqual(cancelled.result, { cancelled: true });
  assert.equal((await f.http(f.sign({ action: 'artifact.stream', targetOperationId: op.operationId }))).status, 403);
  const preview = await f.invoke({ action: 'repositories.cleanup.preview' });
  await f.invoke({ action: 'operation.cancel', targetOperationId: preview.operationId });
  await assert.rejects(f.invoke({ action: 'repositories.cleanup.execute', previewOperationId: preview.operationId, confirmation: (preview.result as StorageCleanupPreview).confirmation }));
});

test('export terminal outbox is persisted without a status request', async t => {
  const f = await fixture(t);
  const op = await f.invoke({ action: 'database.export' });
  let state = op.state;
  for (let i = 0; i < 200 && state === 'running'; i++) {
    await delay(20);
    const record = JSON.parse((await fs.readFile(path.join(f.control, `operation-${op.operationId}.jsonl`), 'utf8')).trimEnd().split('\n').at(-1)!);
    state = record.state;
  }
  assert.equal(state, 'completed');
});

test('torn or corrupted ledger refuses result release and replay', async t => {
  const f = await fixture(t);
  for (const torn of [true, false]) {
    const raw = f.sign({ action: 'repositories.list' }); const op = await f.plane.invoke(raw);
    const name = path.join(f.control, `operation-${op.operationId}.jsonl`);
    const bytes = await fs.readFile(name, 'utf8');
    await fs.writeFile(name, torn ? bytes.slice(0, -1) : bytes.replace('completed', 'cancelled'));
    await assert.rejects(f.invoke({ action: 'operation.status', targetOperationId: op.operationId }));
    await assert.rejects(f.plane.invoke(raw));
  }
});

test('oversized inventory persists a bounded failure, readable by status before and after restart', async t => {
  const f = await fixture(t);
  t.mock.method(f.storage, 'inventory', async () => ({ repositories: [{ name: 'x'.repeat(40_000) }] }));
  const raw = f.sign({ action: 'repositories.list' });
  const id = JSON.parse(raw).assertion.operationId;
  assert.equal((await f.http(raw)).status, 403);
  const status = async (plane: FleetDataPlane) => {
    const result = await plane.invoke(f.sign({ action: 'operation.status', targetOperationId: id }));
    assert.equal((result.result as FleetDataResult).state, 'failed');
    assert.equal((result.result as FleetDataResult).result, undefined);
  };
  await status(f.plane);
  // Process-local plane recovery with the same native generation supports status.
  const next = new FleetDataPlane(f.storage, f.control, () => f.secret, f.authorizeActor); await next.initialize();
  await status(next);
  const ledger = await fs.readFile(path.join(f.control, `operation-${id}.jsonl`), 'utf8');
  assert.ok(Buffer.byteLength(ledger) < 5000);
  assert.equal(JSON.parse(ledger.trimEnd().split('\n').at(-1)!).state, 'failed');
  await f.restart(); // A new native runtime must preserve the durable terminal failure.
  assert.equal(await fs.readFile(path.join(f.control, `operation-${id}.jsonl`), 'utf8'), ledger);
});

for (const revoke of [false, true]) {
  test(`96 MiB transport uses bounded buffers and repeated fencing: revoke=${revoke}`, async t => {
    const f = await fixture(t);
    const op = await f.invoke({ action: 'database.export' }); await ready(f, op.operationId);
    const size = 96 * 1024 ** 2;
    const large = path.join(f.root, 'large-artifact');
    const file = await fs.open(large, 'w'); await file.truncate(size); await file.close();
    const redeem = f.storage.exports!.redeem.bind(f.storage.exports!);
    let maxBuffered = 0, produced = 0, received = 0, maxAhead = 0;
    t.mock.method(f.storage.exports!, 'redeem', async (...args: Parameters<typeof redeem>) => {
      const download = await redeem(...args); await download.file.close();
      const largeFile = await fs.open(large, 'r');
      const read = largeFile.read.bind(largeFile);
      t.mock.method(largeFile, 'read', async (...args: any[]) => {
        const result = await (read as any)(...args);
        assert.ok(result.bytesRead <= 64 * 1024);
        produced += result.bytesRead;
        maxAhead = Math.max(maxAhead, produced - received);
        return result;
      });
      return { ...download, file: largeFile, status: { ...download.status, sizeBytes: size } };
    });
    const stream = f.plane.stream.bind(f.plane);
    let validations = 0;
    t.mock.method(f.plane, 'stream', (raw: string, consume: Parameters<typeof stream>[1]) => stream(raw, (download, authorize) => consume(download, async () => {
      validations++;
      if (revoke && validations === 6) { f.authority.placementGeneration = 'revoked'; await f.writeAuthority(); }
      await authorize();
    })));
    const transferStarted = performance.now();
    const transfer = new Promise<void>((resolve, reject) => {
      const req = request({ socketPath: f.server.address() as string, path: '/v1/invoke', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
        assert.equal(res.statusCode, 200);
        // Force backpressure without collecting the artifact in memory.
        res.pause(); setTimeout(() => res.resume(), 600);
        res.on('data', chunk => { received += chunk.length; maxBuffered = Math.max(maxBuffered, res.readableLength); });
        res.on('end', resolve); res.on('error', reject);
      });
      req.on('error', reject); req.end(f.sign({ action: 'artifact.stream', targetOperationId: op.operationId }));
    });
    if (revoke) { await assert.rejects(transfer); assert.ok(received < size); }
    else { await transfer; assert.equal(received, size); }
    assert.ok(validations >= 6, `validations=${validations}`);
    // Two checks per 64 KiB read plus the initial/final checks, and a fence
    // every 250 ms even while backpressured. Slow CI adds legitimate fences.
    const timedFences = Math.ceil((performance.now() - transferStarted) / 250);
    assert.ok(validations <= 2 * Math.ceil(size / (64 * 1024)) + 2 + timedFences, `bounded validation count=${validations}`);
    assert.ok(maxBuffered <= 256 * 1024, `buffered=${maxBuffered}`);
    assert.ok(maxAhead <= 2 * 1024 ** 2, `producer lead=${maxAhead}`);
    await f.server.shutdown();
    const record = JSON.parse((await fs.readFile(path.join(f.control, `operation-${op.operationId}.jsonl`), 'utf8')).trimEnd().split('\n').at(-1)!);
    assert.equal(record.state, revoke ? 'fenced' : 'consumed');
  });
}

test('transfer deadline scales to the export cap with a finite throughput budget', async () => {
  const { fleetTransferDeadline } = await import('../../api/fleetDataListener.js');
  assert.equal(fleetTransferDeadline(96 * 1024 ** 2), 54_000);
  assert.equal(fleetTransferDeadline(512 * 1024 ** 2), 158_000);
  assert.equal(fleetTransferDeadline(1024 ** 3), 158_000);
});

test('shutdown closes admissions, drains work, removes the socket and permits restart', async t => {
  const f = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const inventory = f.storage.inventory.bind(f.storage);
  t.mock.method(f.storage, 'inventory', async () => { entered(); await blocked; return inventory(); });
  const response = f.http(f.sign({ action: 'repositories.list' })).catch(() => undefined);
  await started;
  const socket = f.server.address() as string;
  let stopped = false;
  const shutdown = f.server.shutdown().then(() => { stopped = true; });
  await delay(25); assert.equal(stopped, false);
  await assert.rejects(fs.lstat(socket), { code: 'ENOENT' });
  await assert.rejects(f.http(f.sign({ action: 'repositories.list' })));
  release(); await shutdown; await response;
  await f.server.shutdown();
  const next = await f.restart();
  const listener = await listenFleetData(next);
  await listener.shutdown();
  assert.equal((await fs.readdir(f.control)).filter(name => name.endsWith('.sock')).length, 0);
  const serverSource = await fs.readFile(path.resolve('packages/api/server.ts'), 'utf8');
  assert.ok(serverSource.indexOf('await (await fleetDataListener)?.shutdown()') < serverSource.indexOf('await closeResources(shutdownTasks)'));
});

for (const substitution of ['file', 'symlink', 'socket', 'root'] as const) {
  test(`shutdown preserves substituted ${substitution}`, async t => {
    const f = await fixture(t);
    const socket = f.server.address() as string;
    if (substitution === 'root') {
      await fs.rename(f.control, `${f.control}-old`); await fs.mkdir(f.control, { mode: 0o700 });
      await fs.writeFile(socket, 'replacement');
    } else {
      await fs.unlink(socket);
      if (substitution === 'file') await fs.writeFile(socket, 'replacement');
      else if (substitution === 'socket') await exec(process.execPath, ['-e', `process.umask(0o077);require('net').createServer().listen(process.argv[1],()=>process.exit(0));`, socket]);
      else await fs.symlink(f.source, socket);
    }
    await assert.rejects(f.server.shutdown());
    const stat = await fs.lstat(socket);
    assert.ok(substitution === 'symlink' ? stat.isSymbolicLink() : substitution === 'socket' ? stat.isSocket() : stat.isFile());
  });
}

test('configured startup rejects a live overlapping listener and succeeds after it exits', async t => {
  const f = await fixture(t);
  const previousDataDir = process.env.DATA_DIR;
  const previousSecret = process.env.PROPR_FLEET_CONTROL_SECRET;
  process.env.DATA_DIR = f.root;
  process.env.PROPR_FLEET_CONTROL_SECRET = f.secret;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousSecret === undefined) delete process.env.PROPR_FLEET_CONTROL_SECRET;
    else process.env.PROPR_FLEET_CONTROL_SECRET = previousSecret;
  });
  const oldSocket = f.server.address()!;
  const oldIdentity = await fs.lstat(oldSocket);
  const next = await f.restart();
  const nextRuntime = await next.runtime();
  assert.notEqual(nextRuntime.runtimeGeneration, f.runtime.runtimeGeneration);
  let nativeCloses = 0;
  const ownedNative = { close: () => { nativeCloses++; } } as unknown as Parameters<typeof startConfiguredFleetData>[3];
  await assert.rejects(startConfiguredFleetData(next.storage, f.authorizeActor, undefined, ownedNative), /Fleet listener already active/);
  assert.equal(nativeCloses, 1, 'failed configured startup releases the native runtime');
  const preserved = await fs.lstat(oldSocket);
  assert.equal(preserved.dev, oldIdentity.dev);
  assert.equal(preserved.ino, oldIdentity.ino);
  assert.deepEqual((await fs.readdir(f.control)).filter(name => name.endsWith('.sock')), [path.basename(oldSocket)]);
  // The old listener still accepts connections, but its generation is fenced.
  assert.equal((await f.http(f.sign({ action: 'repositories.list' }))).status, 403);
  await f.server.shutdown();
  const listener = await startConfiguredFleetData(next.storage, f.authorizeActor, undefined, ownedNative);
  assert.ok(listener);
  t.after(() => listener.shutdown());
  assert.notEqual(listener.address(), oldSocket);
  assert.deepEqual((await fs.readdir(f.control)).filter(name => name.endsWith('.sock')), [path.basename(listener.address()!)]);
  const response = await new Promise<number>((resolve, reject) => {
    const req = request({ socketPath: listener.address()!, path: '/v1/invoke', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end(f.sign({ action: 'repositories.list' }, nextRuntime));
  });
  assert.equal(response, 200);
  await listener.shutdown();
  assert.equal(nativeCloses, 2, 'configured listener shutdown releases the native runtime');

  // Production must propagate that rejection before opening readiness/customer HTTP.
  const source = await fs.readFile(path.resolve('packages/api/server.ts'), 'utf8');
  // Execute the actual startup expression with capability sentinels. This catches
  // dropped awaits, accidental exposure and reset construction in demo mode.
  const tree = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  let startup: ts.BinaryExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.left.getText(tree) === 'fleetDataListener' &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken) startup = node;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(startup);
  const code = ts.transpile(`return ${startup!.right.getText(tree)};`);
  const native = Object.freeze({ capability: 'private-reset' });
  const storage = {}; const database = {}; const profiles = {};
  const run = (demoMode: boolean, configured: unknown, failure?: Error) => {
    const calls: string[] = [];
    const execute = new Function('demoMode', 'configuredNativeReset', 'path', 'storageControlRoot',
      'taskQueue', 'runtimeBuildQueue', 'redisClient', 'startConfiguredFleetData', 'storageService',
      'resolveDurableInstanceAuthorization', 'ExtensionProfileStore', 'db', code);
    const result = execute(demoMode, async (root: string, resources: any) => {
      calls.push('native');
      assert.equal(root, '/private/fleet-reset-control');
      assert.equal(typeof resources.close, 'function');
      await Promise.resolve();
      if (failure) throw failure;
      return configured;
    }, path, () => '/private/storage-control', {}, {}, {},
    (actualStorage: unknown, authorize: Function, store: unknown, reset: unknown) => {
      calls.push('listener'); assert.equal(actualStorage, storage);
      assert.equal(authorize(123, database), 'authorized');
      assert.equal(store, profiles); assert.equal(reset, configured);
      return 'listener';
    }, storage, (actor: string, db: unknown) => {
      assert.equal(actor, '123'); assert.equal(db, database); return 'authorized';
    }, function (db: unknown) { assert.equal(db, database); return profiles; }, database);
    return { result, calls };
  };
  for (const configured of [native, undefined]) {
    const runResult = run(false, configured);
    assert.equal(await runResult.result, 'listener');
    assert.deepEqual(runResult.calls, ['native', 'listener']);
  }
  const demo = run(true, native); assert.equal(await demo.result, undefined); assert.deepEqual(demo.calls, []);
  const failure = new Error('invalid provisioning'); const failed = run(false, native, failure);
  await assert.rejects(failed.result, error => error === failure); assert.deepEqual(failed.calls, ['native']);
  // The local capability has exactly one consumer, the private listener.
  assert.equal((source.match(/\bnativeReset\b/g) ?? []).length, 2);
  const setup = source.indexOf('    setupRoutes();');
  const gate = source.indexOf('try { await fleetDataListener; }', setup);
  assert.ok(gate > setup && gate < source.indexOf('httpServer.listen(PORT'));
  assert.match(source.slice(gate), /Configured Fleet data listener failed to start; refusing API readiness/);
  assert.match(source.slice(gate), /console.error\('Failed to start server:', error\);\s+process.exit\(1\)/);
});

test('restart removes crashed stale sockets but refuses live or unsafe entries', async t => {
  const f = await fixture(t); await f.server.shutdown();
  const socket = path.join(f.control, `data-${randomUUID()}.sock`);
  // A process exit bypasses close(), leaving a real stale Unix socket.
  await exec(process.execPath, ['-e', `const fs=require('fs'); const s=require('net').createServer(); s.listen(process.argv[1],()=>{fs.chmodSync(process.argv[1],0o600);process.exit(0)});`, socket]);
  assert.ok((await fs.lstat(socket)).isSocket());
  const listener = await listenFleetData(f.plane);
  await assert.rejects(fs.lstat(socket), { code: 'ENOENT' });
  await assert.rejects(listenFleetData(f.plane));
  await listener.shutdown();
  await fs.writeFile(socket, 'preserve', { mode: 0o600 });
  await assert.rejects(listenFleetData(f.plane));
  assert.equal(await fs.readFile(socket, 'utf8'), 'preserve');
});

test('v1 native grants and actorless or nonnumeric v2 grants fail closed', async t => {
  const f = await fixture(t);
  const legacy = JSON.parse(await fs.readFile('docs/contracts/fleet-data-v1/fixtures.json', 'utf8'));
  assert.equal(createHash('sha256').update(FLEET_DATA_SCHEMA).digest('hex'), legacy.contractPin);
  for (const item of legacy.requests) {
    const envelope = JSON.parse(item.canonical);
    Object.assign(envelope.assertion, f.runtime, { contract: 'propr.fleet-data.v1', contractPin: legacy.contractPin,
      issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 60, operationId: randomUUID(), nonce: randomBytes(32).toString('hex') });
    delete envelope.assertion.storageGeneration;
    envelope.mac = createHmac('sha256', f.secret).update(canonicalFleetJson(envelope.assertion)).digest('hex');
    assert.equal((await f.http(canonicalFleetJson(envelope))).status, 403);
  }
  for (const actor of [undefined, '100', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await f.http(f.sign({ action: 'repositories.list' }, { githubActorId: actor as number }))).status, 403);
  }
  const omitted = JSON.parse(f.sign({ action: 'repositories.list' }));
  delete omitted.assertion.githubActorId;
  omitted.mac = createHmac('sha256', f.secret).update(canonicalFleetJson(omitted.assertion)).digest('hex');
  assert.equal((await f.http(canonicalFleetJson(omitted))).status, 403);
  const actorless = new FleetDataPlane(f.storage, f.control, () => f.secret);
  await assert.rejects(actorless.invoke(f.sign({ action: 'repositories.list' })));
});

test('current exact durable admin is required independently of Fleet authority', async t => {
  const f = await fixture(t);
  for (const authorization of [
    { role: 'member', permissions: [], source: 'local' },
    { role: 'admin', permissions: [], source: 'local' },
    { role: 'admin', permissions: ['instance.manage_settings'], source: 'bootstrap' },
    { role: 'admin', permissions: ['instance.manage_settings'], source: 'implicit' },
  ]) {
    f.members.set(100, authorization);
    for (const action of ['database.export', 'repositories.list', 'repositories.cleanup.preview'] as const) {
      assert.equal((await f.http(f.sign({ action }))).status, 403);
    }
  }
  f.members.delete(100);
  assert.equal((await f.http(f.sign({ action: 'repositories.list' }))).status, 403);
  assert.equal((await f.http(f.sign({ action: 'repositories.list' }, { githubActorId: 999 }))).status, 403);
  assert.equal((await f.http(f.sign({ action: 'repositories.list' }, { githubActorId: 101 }))).status, 200);
});

test('durable operations refuse another admin for status, cancellation, confirmation and stream', async t => {
  const f = await fixture(t, true);
  const preview = await f.invoke({ action: 'repositories.cleanup.preview' });
  const exported = await f.invoke({ action: 'database.export' }); await ready(f, exported.operationId);
  const requests: FleetDataRequest[] = [
    { action: 'operation.status', targetOperationId: exported.operationId },
    { action: 'operation.cancel', targetOperationId: exported.operationId },
    { action: 'artifact.stream', targetOperationId: exported.operationId },
    { action: 'operation.cancel', targetOperationId: preview.operationId },
    { action: 'repositories.cleanup.execute', previewOperationId: preview.operationId, confirmation: (preview.result as StorageCleanupPreview).confirmation },
  ];
  for (const request of requests) assert.equal((await f.http(f.sign(request, { githubActorId: 101 }))).status, 403);
  const substituted = JSON.parse(f.sign({ action: 'repositories.list' }));
  substituted.assertion.githubActorId = 101;
  assert.equal((await f.http(canonicalFleetJson(substituted))).status, 403);
  f.members.delete(100);
  for (const request of requests) assert.equal((await f.http(f.sign(request))).status, 403);
  assert.ok((await fs.stat(f.clone)).isDirectory());
});

test('revocation after durable dispatch stops native export before it starts', async t => {
  const f = await fixture(t);
  const append = f.plane.files.append.bind(f.plane.files);
  let calls = 0;
  t.mock.method(f.storage.exports!, 'start', async () => { calls++; throw new Error(); });
  t.mock.method(f.plane.files, 'append', async (name: string, record: any) => {
    await append(name, record);
    if (record.state === 'dispatched') f.members.delete(100);
  });
  await assert.rejects(f.invoke({ action: 'database.export' }));
  assert.equal(calls, 0);
});

for (const phase of ['preview', 'execute'] as const) {
  test(`admin revocation during cleanup ${phase} proof prevents disclosure or mutation`, async t => {
    const f = await fixture(t, true);
    let preview: FleetDataResult | undefined;
    if (phase === 'execute') preview = await f.invoke({ action: 'repositories.cleanup.preview' });
    f.afterProof(async () => { f.members.delete(100); });
    if (phase === 'preview') await assert.rejects(f.invoke({ action: 'repositories.cleanup.preview' }));
    else await assert.rejects(f.invoke({ action: 'repositories.cleanup.execute', previewOperationId: preview!.operationId,
      confirmation: (preview!.result as StorageCleanupPreview).confirmation }));
    assert.ok((await fs.stat(f.clone)).isDirectory());
  });
}

test('revocation during artifact read releases no bytes from that read', async t => {
  const f = await fixture(t);
  const op = await f.invoke({ action: 'database.export' }); await ready(f, op.operationId);
  const redeem = f.storage.exports!.redeem.bind(f.storage.exports!);
  let reads = 0;
  t.mock.method(f.storage.exports!, 'redeem', async (...args: Parameters<typeof redeem>) => {
    const download = await redeem(...args);
    const read = download.file.read.bind(download.file);
    t.mock.method(download.file, 'read', async (...args: any[]) => {
      const result = await (read as any)(...args); reads++; f.members.delete(100); return result;
    });
    return download;
  });
  let received = 0;
  await assert.rejects(new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: f.server.address()!, path: '/v1/invoke', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      res.on('data', chunk => { received += chunk.length; }); res.on('end', resolve); res.on('error', reject);
    });
    req.on('error', reject); req.end(f.sign({ action: 'artifact.stream', targetOperationId: op.operationId }));
  }));
  assert.equal(reads, 1); assert.equal(received, 0);
});

test('migration retains actorless v1 journals as recovery evidence without authorizing follow-ups', async t => {
  const f = await fixture(t);
  const admitted = await (f.plane as any).admit(f.sign({ action: 'database.export' }));
  const legacy = { ...admitted.op, contract: 'propr.fleet-data.v1', state: 'dispatched' };
  delete legacy.githubActorId; delete legacy.binding.storageGeneration;
  await fs.writeFile(path.join(f.control, `operation-${legacy.operationId}.jsonl`), JSON.stringify({ ...legacy, recordDigest: digest(legacy) }) + '\n', { mode: 0o600 });
  const next = await f.restart();
  const raw = await fs.readFile(path.join(f.control, `operation-${legacy.operationId}.jsonl`), 'utf8');
  const record = JSON.parse(raw.trimEnd().split('\n').at(-1)!);
  assert.equal(record.contract, 'propr.fleet-data.v1'); assert.equal(record.state, 'fenced');
  const runtime = await next.runtime();
  for (const action of ['operation.status', 'operation.cancel', 'artifact.stream'] as const) {
    const request = f.sign({ action, targetOperationId: legacy.operationId }, runtime);
    if (action === 'artifact.stream') await assert.rejects(next.stream(request, async () => { assert.fail('legacy stream must never dispatch'); }));
    else await assert.rejects(next.invoke(request));
  }
});
