import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configuredExportSecrets, DatabaseExportLockError, DatabaseExports } from '../src/storage/databaseExport.js';
import { isExportSecretName } from '../src/storage/databaseExportWorker.js';
import { recoverExpiredExportLocks } from '../src/storage/databaseExportLease.js';
const SQLite = createRequire(import.meta.url)('better-sqlite3');
const allow = async () => {};
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'database-export-'));
  const source = path.join(root, 'customer.sqlite');
  const db = new SQLite(source);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE customer(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE encrypted_credentials(value TEXT);
    CREATE TABLE extension_profile_revisions(profile_id TEXT, revision INTEGER, snapshot TEXT, secrets_encrypted TEXT);
    CREATE TABLE extension_skill_bundles(id TEXT, descriptor TEXT, files_json TEXT);
    CREATE TABLE extension_instance_identity(id INTEGER, instance_id TEXT);
    CREATE TABLE extension_run_grants(token_hash TEXT);
    CREATE TABLE task_submissions(id TEXT, payload TEXT, extension_authorization TEXT);
    CREATE TABLE system_configs(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE knex_migrations(id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO knex_migrations VALUES(1, 'customer-schema-v1');
    PRAGMA user_version=7;`);
  db.prepare('INSERT INTO customer(body) VALUES(?)').run('customer content survives');
  db.prepare('INSERT INTO encrypted_credentials VALUES(?)').run('encrypted-customer-canary');
  db.prepare('INSERT INTO extension_profile_revisions VALUES(?,?,?,?)').run('extension-profile', 1, JSON.stringify({ name: 'Documentation', mcpServers: [{ kind: 'catalog', name: 'documentation', catalogId: 'local-docs', digest: 'a'.repeat(64), tools: ['lookup'], capability: 'read' }], secrets: { documentation: { configured: true, fields: ['API_KEY'] } } }), 'encrypted-extension-custody-canary');
  db.prepare('INSERT INTO extension_skill_bundles VALUES(?,?,?)').run('skill', JSON.stringify({ digest: 'immutable-skill-digest' }), JSON.stringify([{ path: 'SKILL.md', content: 'validated-asset' }]));
  db.prepare('INSERT INTO extension_instance_identity VALUES(?,?)').run(1, 'extension-instance');
  db.prepare('INSERT INTO task_submissions VALUES(?,?,?)').run('submission', JSON.stringify({ extensionAllowWrite: true }), 'previous-extension-submission-authority-canary');
  db.prepare('INSERT INTO extension_run_grants VALUES(?)').run('previous-execution-lease-canary');
  db.prepare('INSERT INTO system_configs VALUES(?,?)').run('agents', JSON.stringify([{ id: 'agent', alias: 'My agent', configPath: '/provider-home-canary', envVars: { API_KEY: 'operator-env-canary' } }]));
  db.prepare('INSERT INTO system_configs VALUES(?,?)').run('operator_extension_catalog', JSON.stringify({ executable: '/usr/bin/env', args: ['CATALOG_ARGUMENT_SENTINEL', '/opt/propr/CATALOG_PATH_SENTINEL'], secretEnv: { API_KEY: 'OPERATOR_DOCS_KEY' } }));
  db.prepare('INSERT INTO system_configs VALUES(?,?)').run('fleet_control_secret', JSON.stringify('fleet-secret-canary'));
  db.prepare('INSERT INTO system_configs VALUES(?,?)').run('settings', JSON.stringify({ worker_concurrency: 2 }));
  await fs.writeFile(path.join(root, '.env'), 'env-file-canary');
  await fs.mkdir(path.join(root, 'provider-home'));
  await fs.writeFile(path.join(root, 'provider-home', 'auth.json'), 'provider-file-canary');
  const exports = new DatabaseExports(source, path.join(root, 'exports'));
  let job: Awaited<ReturnType<typeof exports.start>> | undefined;
  const start = async (authority = allow) => job = await exports.start('instance', 'admin', authority);
  t.after(async () => {
    if (job) await exports.cancel('instance', exports.generation, job.operationId, 'admin', allow).catch(() => {});
    db.close(); await fs.rm(root, { recursive: true, force: true });
  });
  return { root, source, db, exports, start };
}
async function settled(exports: DatabaseExports, id: string, authority = allow) {
  // Allow the worker's 60-second execution deadline plus time to publish its
  // terminal state on a busy CI runner. Date is mocked by the expiry tests.
  const deadline = performance.now() + 65_000;
  while (performance.now() < deadline) {
    const status = await exports.status('instance', exports.generation, id, 'admin', authority);
    if (status.state !== 'running') return status;
    await delay(10);
  }
  throw new Error('Export did not settle within 65 seconds');
}

test('real WAL writer: coherent restorable customer database, integrity, metadata and DB-only privacy', async t => {
  const f = await fixture(t);
  // Public/path configuration may legitimately occur in customer records.
  for (const [name, value] of Object.entries({ WEB_PUSH_VAPID_PUBLIC_KEY: 'encrypted-customer-canary', HOST_GH_PRIVATE_KEY: 'customer content survives' })) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const writer = setInterval(() => f.db.transaction(() => {
    f.db.prepare('INSERT INTO customer(body) VALUES(?)').run('concurrent customer');
    f.db.prepare('INSERT INTO customer(body) VALUES(?)').run('paired customer');
  })(), 2);
  t.after(() => clearInterval(writer));
  const job = await f.start();
  assert.equal(job.state, 'running');
  assert.ok((await fs.stat(f.source + '-wal')).size > 0);
  const ready = await settled(f.exports, job.operationId);
  clearInterval(writer);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.schemaVersion, 7); assert.equal(ready.migration, 'customer-schema-v1');
  const download = await f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow);
  try {
    const data = await download.file.readFile();
    assert.equal(data.length, ready.sizeBytes);
    assert.equal(createHash('sha256').update(data).digest('hex'), ready.sha256);
    for (const canary of ['operator-env-canary', 'fleet-secret-canary', 'provider-home-canary', 'env-file-canary', 'provider-file-canary', 'encrypted-extension-custody-canary', 'previous-extension-submission-authority-canary', 'API_KEY', 'OPERATOR_DOCS_KEY', '/usr/bin/env', 'CATALOG_ARGUMENT_SENTINEL', '/opt/propr/CATALOG_PATH_SENTINEL']) assert.equal(data.includes(Buffer.from(canary)), false, canary);
    const imported = path.join(f.root, 'restored.sqlite'); await fs.writeFile(imported, data);
    const db = new SQLite(imported);
    try {
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(db.prepare('SELECT body FROM customer WHERE id=1').get().body, 'customer content survives');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer').get().n % 2, 1);
      assert.equal(db.prepare('SELECT value FROM encrypted_credentials').get().value, 'encrypted-customer-canary');
      assert.equal(db.prepare('SELECT secrets_encrypted FROM extension_profile_revisions').get().secrets_encrypted, '');
      assert.deepEqual(JSON.parse(db.prepare('SELECT snapshot FROM extension_profile_revisions').get().snapshot).secrets.documentation, { count: 1, configured: true });
      assert.equal(db.prepare('SELECT extension_authorization FROM task_submissions').get().extension_authorization, null);
      assert.equal(db.prepare('SELECT instance_id FROM extension_instance_identity').get().instance_id, 'extension-instance');
      assert.equal(JSON.parse(db.prepare('SELECT descriptor FROM extension_skill_bundles').get().descriptor).digest, 'immutable-skill-digest');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM extension_run_grants').get().n, 0);
      assert.equal(data.includes(Buffer.from('previous-execution-lease-canary')), false);
      assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM system_configs WHERE key='agents'").get().value), [{ id: 'agent', alias: 'My agent' }]);
      db.prepare('INSERT INTO customer(body) VALUES(?)').run('restored write');
    } finally { db.close(); }
    await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
  } finally { await download.file.close(); await download.dispose(); }
});

test('actor, instance, generation, opaque ID, concurrent admission, restart and revocation boundaries', async t => {
  const f = await fixture(t); const job = await f.start();
  await assert.rejects(f.start());
  for (const [instance, generation, id, actor] of [
    ['other', f.exports.generation, job.operationId, 'admin'], ['instance', 'old', job.operationId, 'admin'],
    ['instance', f.exports.generation, '../database.sqlite', 'admin'], ['instance', f.exports.generation, job.operationId, 'other'],
  ]) await assert.rejects(f.exports.status(instance, generation, id, actor, allow));
  const restarted = new DatabaseExports(f.source, path.join(f.root, 'exports'));
  await assert.rejects(restarted.status('instance', f.exports.generation, job.operationId, 'admin', allow));
  await assert.rejects(restarted.start('instance', 'admin', allow));
  await settled(f.exports, job.operationId);
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', async () => { throw Error('demoted'); }));
  await assert.rejects(f.exports.status('instance', f.exports.generation, job.operationId, 'admin', async () => { throw Error('revoked'); }));
  assert.equal((await fs.readdir(path.join(f.root, 'exports'))).length, 0);
});

test('revocation during execution fails the job and never produces a downloadable artifact', async t => {
  const f = await fixture(t); let calls = 0;
  const job = await f.start(async () => { if (++calls >= 3) throw Error('revoked'); });
  const result = await settled(f.exports, job.operationId);
  assert.equal(result.state, 'failed');
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
});

for (const kind of ['symlink', 'hardlink', 'fifo', 'sidecar', 'ancestor'] as const) test(`refuses ${kind} source paths`, async t => {
  const f = await fixture(t);
  let target = f.source;
  if (kind === 'symlink') { target = path.join(f.root, 'link'); await fs.symlink(f.source, target); }
  if (kind === 'hardlink') await fs.link(f.source, path.join(f.root, 'link'));
  if (kind === 'fifo') {
    target = path.join(f.root, 'fifo');
    const { execFileSync } = await import('node:child_process'); execFileSync('mkfifo', [target]);
  }
  if (kind === 'sidecar') { await fs.unlink(f.source + '-shm'); await fs.symlink(path.join(f.root, '.env'), f.source + '-shm'); }
  if (kind === 'ancestor') { await fs.symlink(f.root, path.join(f.root, 'alias')); target = path.join(f.root, 'alias', 'customer.sqlite'); }
  const exports = new DatabaseExports(target, path.join(f.root, 'private'));
  await assert.rejects(exports.start('instance', 'admin', allow));
});

test('ancestor replacement after admission is refused, cancellation releases admission', async t => {
  const f = await fixture(t); let calls = 0;
  const job = await f.start(async () => {
    if (++calls === 2) {
      await fs.rename(f.source, f.source + '.original');
      await fs.copyFile(f.source + '.original', f.source);
    }
  });
  assert.equal((await settled(f.exports, job.operationId)).state, 'failed');
  await f.exports.cancel('instance', f.exports.generation, job.operationId, 'admin', allow);
  assert.equal((await fs.readdir(path.join(f.root, 'exports'))).length, 0);
});

test('ENOSPC admission fails before creating an export job', async t => {
  const f = await fixture(t);
  t.mock.method(fs, 'statfs', async () => ({ bavail: 0, bsize: 4096 }));
  await assert.rejects(f.start(), /Insufficient export space/);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'exports')), []);
});

test('download refuses hardlinked output and expired jobs', async t => {
  const f = await fixture(t); const job = await f.start(); await settled(f.exports, job.operationId);
  const snapshot = (await fs.readdir(path.join(f.root, 'exports'))).find(name => name.startsWith('snapshot-'))!;
  const file = path.join(f.root, 'exports', snapshot, 'database.sqlite');
  await fs.link(file, path.join(f.root, 'linked-export'));
  // Cleanup refuses the hardlinked snapshot (retained for an operator); the job is still consumed.
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
  // A retry of the consumed redemption is a definitive 410, never a retryable 503.
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow), (error: Error & { status?: number }) => error.status === 410);
  await fs.unlink(path.join(f.root, 'linked-export'));
});

test('redemption distinguishes a consumed export (410) from one not yet ready (409, retained)', async t => {
  const f = await fixture(t);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  // Hold the worker before it starts: the job stays running until released.
  const job = await f.start(async () => { if (++calls === 2) await gate; });
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow), (error: Error & { status?: number }) => error.status === 409);
  release();
  assert.equal((await settled(f.exports, job.operationId)).state, 'ready');
  const download = await f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow);
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow), (error: Error & { status?: number }) => error.status === 410);
  await download.file.close(); await download.dispose();
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow), (error: Error & { status?: number }) => error.status === 410);
});

test('expiry denies status and redemption even before the cleanup timer runs', async t => {
  const f = await fixture(t); const job = await f.start(); await settled(f.exports, job.operationId);
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.timers.setTime(now + 5 * 60_000 + 1);
  await assert.rejects(f.exports.status('instance', f.exports.generation, job.operationId, 'admin', allow));
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
  t.mock.timers.reset();
});

test('expired artifacts of a proven-dead process are reaped; a new generation can export', async t => {
  const f = await fixture(t);
  const root = path.join(f.root, 'exports'); await fs.mkdir(path.join(root, 'active'), { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const directory = await fs.mkdtemp(path.join(root, 'snapshot-'));
  await fs.writeFile(path.join(directory, 'database.sqlite'), 'expired private canary');
  await fs.writeFile(path.join(root, 'active', 'owner.json'), JSON.stringify({ pid: 2147483647, pidNamespace: await fs.readlink('/proc/self/ns/pid'), expiresAt: Date.now() - 1, directory: path.basename(directory) }), { mode: 0o600 });
  const job = await f.start(); assert.equal((await settled(f.exports, job.operationId)).state, 'ready');
  await assert.rejects(fs.stat(directory));
});

const DEAD_PID = 2147483647;
const GRACE = 60_000;
type OwnerFixture = { pid?: unknown; pidNamespace?: unknown; expiresAt?: unknown; legacy?: boolean; raw?: string; mode?: number; extraFile?: boolean };
/** Writes a lock left by another process: a current lease or a pre-upgrade `active` lock. */
async function staleLock(root: string, fixture: OwnerFixture) {
  const exportsRoot = path.join(root, 'exports');
  await fs.mkdir(exportsRoot, { recursive: true, mode: 0o700 }); await fs.chmod(exportsRoot, 0o700);
  const token = randomUUID().replace(/-/g, '');
  const lock = path.join(exportsRoot, fixture.legacy ? 'active' : `lease-${token}`);
  const snapshot = fixture.legacy ? await fs.mkdtemp(path.join(exportsRoot, 'snapshot-')) : path.join(exportsRoot, `snapshot-${token}`);
  if (!fixture.legacy) await fs.mkdir(snapshot, { mode: 0o700 });
  await fs.writeFile(path.join(snapshot, 'database.sqlite'), 'expired private canary', { mode: 0o600 });
  if (fixture.extraFile) await fs.writeFile(path.join(snapshot, 'unexpected.txt'), 'operator evidence');
  await fs.mkdir(lock, { mode: 0o700 });
  const owner = { token: fixture.legacy ? undefined : token, pid: 'pid' in fixture ? fixture.pid : DEAD_PID,
    pidNamespace: 'pidNamespace' in fixture ? fixture.pidNamespace : await fs.readlink('/proc/self/ns/pid'),
    expiresAt: 'expiresAt' in fixture ? fixture.expiresAt : Date.now() - 1, directory: path.basename(snapshot) };
  await fs.writeFile(path.join(lock, 'owner.json'), fixture.raw ?? JSON.stringify(owner), { mode: fixture.mode ?? 0o600 });
  return { lock, snapshot, exportsRoot };
}
const recovered = async (lock: { lock: string; snapshot: string }) => {
  await assert.rejects(fs.stat(lock.lock)); await assert.rejects(fs.stat(lock.snapshot));
};
const retained = async (lock: { lock: string; snapshot: string }) => {
  assert.equal(await fs.readFile(path.join(lock.snapshot, 'database.sqlite'), 'utf8'), 'expired private canary');
  assert.ok((await fs.stat(path.join(lock.lock, 'owner.json'))).isFile());
};

for (const legacy of [false, true]) {
  const kind = legacy ? 'pre-upgrade' : 'current';
  test(`${kind} lock: Linux same-namespace dead owner is recovered at expiry`, async t => {
    const f = await fixture(t); const lock = await staleLock(f.root, { legacy });
    const job = await f.start(); assert.equal((await settled(f.exports, job.operationId)).state, 'ready');
    await recovered(lock);
  });
  for (const [owner, pidNamespace] of [['different PID namespace', 'pid:[4026531836]'], ['non-Linux runtime', null]] as const) {
    test(`${kind} lock: expired ${owner} owner is recovered after the grace period, with a specific state before it`, async t => {
      const f = await fixture(t);
      // A live PID here may be an unrelated process in another namespace: liveness is unprovable.
      const early = await staleLock(f.root, { legacy, pidNamespace, pid: process.pid, expiresAt: Date.now() - 1 });
      let failure: unknown;
      await assert.rejects(f.start(), error => { failure = error; return error instanceof DatabaseExportLockError && /can be recovered after/.test(error.message); });
      assert.equal((failure as DatabaseExportLockError).status, 409);
      assert.equal(String((failure as Error).message).includes(f.root), false);
      await retained(early);
      await fs.writeFile(path.join(early.lock, 'owner.json'), JSON.stringify({ ...JSON.parse(await fs.readFile(path.join(early.lock, 'owner.json'), 'utf8')), expiresAt: Date.now() - GRACE - 1 }), { mode: 0o600 });
      const job = await f.start(); assert.equal((await settled(f.exports, job.operationId)).state, 'ready');
      await recovered(early);
    });
  }
  test(`${kind} lock: an expired owner whose same-namespace PID is alive waits for the grace period`, async t => {
    const f = await fixture(t); const lock = await staleLock(f.root, { legacy, pid: process.pid });
    await assert.rejects(f.start(), /can be recovered after/); await retained(lock);
  });
  test(`${kind} lock: a live unexpired owner is never stolen, even if its PID is unprovable`, async t => {
    const f = await fixture(t);
    for (const pidNamespace of [null, 'pid:[4026531836]', await fs.readlink('/proc/self/ns/pid')]) {
      const lock = await staleLock(f.root, { legacy, pidNamespace, expiresAt: Date.now() + 60_000 });
      await assert.rejects(f.start(), error => error instanceof DatabaseExportLockError && /in progress/.test(error.message));
      await retained(lock);
      await fs.rm(lock.lock, { recursive: true }); await fs.rm(lock.snapshot, { recursive: true });
    }
  });
}

for (const [name, owner] of Object.entries({
  'malformed JSON': { raw: '{"pid":' }, 'null owner': { raw: 'null' }, 'invalid PID': { pid: -1 }, 'string PID': { pid: '1' },
  'non-finite expiry': { expiresAt: 'soon' }, 'group-readable owner': { mode: 0o640 },
  'unexpected snapshot files': { extraFile: true, expiresAt: Date.now() - GRACE - 1, pidNamespace: null },
} satisfies Record<string, OwnerFixture>)) {
  test(`unsafe or malformed expired lock fails closed with an actionable state: ${name}`, async t => {
    const f = await fixture(t); const lock = await staleLock(f.root, owner);
    await assert.rejects(f.start(), error => error instanceof DatabaseExportLockError && /cannot be recovered automatically/.test(error.message) && !error.message.includes(f.root));
    assert.equal(await fs.readFile(path.join(lock.snapshot, 'database.sqlite'), 'utf8'), 'expired private canary');
    if (owner.extraFile) assert.equal(await fs.readFile(path.join(lock.snapshot, 'unexpected.txt'), 'utf8'), 'operator evidence');
    else await retained(lock);
  });
}

test('expired lock recovery never follows a symlinked owner file or snapshot', async t => {
  const f = await fixture(t); const lock = await staleLock(f.root, {});
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'database.sqlite'), 'caller-controlled');
  await fs.rm(lock.snapshot, { recursive: true }); await fs.symlink(outside, lock.snapshot);
  await assert.rejects(f.start(), DatabaseExportLockError);
  assert.equal(await fs.readFile(path.join(outside, 'database.sqlite'), 'utf8'), 'caller-controlled');
  const other = await staleLock(f.root, { legacy: true });
  await fs.rm(path.join(other.lock, 'owner.json')); await fs.symlink(path.join(outside, 'database.sqlite'), path.join(other.lock, 'owner.json'));
  await assert.rejects(new DatabaseExports(f.source, path.join(f.root, 'exports')).start('instance', 'admin', allow), DatabaseExportLockError);
  assert.equal(await fs.readFile(path.join(outside, 'database.sqlite'), 'utf8'), 'caller-controlled');
});

test('concurrent recovery of one expired lock admits at most one export and never deletes a live snapshot', async t => {
  const f = await fixture(t);
  for (let round = 0; round < 5; round++) {
    const lock = await staleLock(f.root, { pidNamespace: null, expiresAt: Date.now() - GRACE - 1 });
    const contenders = Array.from({ length: 6 }, () => new DatabaseExports(f.source, path.join(f.root, 'exports')));
    const results = await Promise.allSettled(contenders.map(exports => exports.start('instance', 'admin', allow)));
    const admitted = results.flatMap((result, index) => result.status === 'fulfilled' ? [{ exports: contenders[index], job: result.value }] : []);
    assert.ok(admitted.length <= 1, `round ${round}: ${admitted.length} admitted`);
    for (const result of results) if (result.status === 'rejected') assert.ok(result.reason instanceof DatabaseExportLockError, String(result.reason));
    let winner = admitted[0];
    if (!winner) {
      // Every contender may observe another's fresh lease and back off; a retry is then admitted.
      const exports = new DatabaseExports(f.source, path.join(f.root, 'exports'));
      winner = { exports, job: await exports.start('instance', 'admin', allow) };
    }
    await recovered(lock);
    // A late contender cannot steal the admitted, live job or erase its snapshot.
    await assert.rejects(new DatabaseExports(f.source, path.join(f.root, 'exports')).start('instance', 'admin', allow), /in progress/);
    const ready = await settled(winner.exports, winner.job.operationId);
    assert.equal(ready.state, 'ready');
    const download = await winner.exports.redeem('instance', winner.exports.generation, winner.job.operationId, 'admin', allow);
    try { assert.equal((await download.file.readFile()).length, ready.sizeBytes); }
    finally { await download.file.close(); await download.dispose(); }
    assert.deepEqual(await fs.readdir(path.join(f.root, 'exports')), []);
  }
});

test('a still-running expired owner releasing its lock concurrently with recovery is safe', async t => {
  const f = await fixture(t);
  const owner = new DatabaseExports(f.source, path.join(f.root, 'exports'));
  const job = await owner.start('instance', 'admin', allow);
  await settled(owner, job.operationId);
  const lease = (await fs.readdir(path.join(f.root, 'exports'))).find(name => name.startsWith('lease-'))!;
  const ownerFile = path.join(f.root, 'exports', lease, 'owner.json');
  // Simulate the original worker finishing late after its lease expired in another namespace.
  await fs.writeFile(ownerFile, JSON.stringify({ ...JSON.parse(await fs.readFile(ownerFile, 'utf8')), pidNamespace: null, expiresAt: Date.now() - GRACE - 1 }), { mode: 0o600 });
  const recoverer = new DatabaseExports(f.source, path.join(f.root, 'exports'));
  const [next] = await Promise.all([recoverer.start('instance', 'admin', allow), owner.cancel('instance', owner.generation, job.operationId, 'admin', allow).catch(() => undefined)]);
  assert.equal((await settled(recoverer, next.operationId)).state, 'ready');
  await recoverer.cancel('instance', recoverer.generation, next.operationId, 'admin', allow);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'exports')), []);
});

test('an expired in-memory job does not permanently block its own process', async t => {
  const f = await fixture(t); const job = await f.start(); await settled(f.exports, job.operationId);
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.timers.setTime(now + 5 * 60_000 + 1);
  await assert.rejects(f.exports.status('instance', f.exports.generation, job.operationId, 'admin', allow), (error: Error & { status?: number }) => error.status === 410);
  const next = await f.exports.start('instance', 'admin', allow);
  t.mock.timers.reset();
  assert.equal((await settled(f.exports, next.operationId)).state, 'ready');
  await f.exports.cancel('instance', f.exports.generation, next.operationId, 'admin', allow);
});

test('concurrent starts after an in-memory expiry: the in-process guard admits only one before any await', async t => {
  const f = await fixture(t); const job = await f.start(); await settled(f.exports, job.operationId);
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.timers.setTime(now + 5 * 60_000 + 1);
  let loserAuthorized = 0;
  const [first, second] = await Promise.allSettled([
    f.exports.start('instance', 'admin', allow),
    f.exports.start('instance', 'admin', async () => { loserAuthorized++; }),
  ]);
  t.mock.timers.reset();
  assert.equal(first.status, 'fulfilled');
  assert.ok(second.status === 'rejected' && second.reason instanceof DatabaseExportLockError && /in progress/.test(second.reason.message));
  // Refused by the in-process guard, never reaching authorization or on-disk admission.
  assert.equal(loserAuthorized, 0);
  const next = (first as PromiseFulfilledResult<Awaited<ReturnType<typeof f.exports.start>>>).value;
  assert.equal((await settled(f.exports, next.operationId)).state, 'ready');
  await f.exports.cancel('instance', f.exports.generation, next.operationId, 'admin', allow);
});

test('background recovery takes no lease when nothing is stale, so it never contends with a start', async t => {
  const f = await fixture(t);
  const root = path.join(f.root, 'exports');
  // Missing root and empty root: nothing to recover, nothing created.
  await recoverExpiredExportLocks(root);
  await assert.rejects(fs.stat(root));
  await fs.mkdir(root, { mode: 0o700 });
  for (let round = 0; round < 20; round++) {
    const exports = new DatabaseExports(f.source, root);
    const [job] = await Promise.all([exports.start('instance', 'admin', allow), recoverExpiredExportLocks(root)]);
    // With a live lease present the probe also backs off instead of failing busy.
    await recoverExpiredExportLocks(root);
    assert.equal((await settled(exports, job.operationId)).state, 'ready');
    await exports.cancel('instance', exports.generation, job.operationId, 'admin', allow);
    assert.deepEqual(await fs.readdir(root), []);
  }
  // A stale lock is still recovered.
  const lock = await staleLock(f.root, {});
  await recoverExpiredExportLocks(root);
  await recovered(lock);
  assert.deepEqual(await fs.readdir(root), []);
});

test('historical customer content containing a configured Fleet control secret is never downloadable', async t => {
  const f = await fixture(t);
  const previous = process.env.PROPR_FLEET_CONTROL_SECRET;
  process.env.PROPR_FLEET_CONTROL_SECRET = 'fleet-control-historical-log-canary';
  t.after(() => { if (previous === undefined) delete process.env.PROPR_FLEET_CONTROL_SECRET; else process.env.PROPR_FLEET_CONTROL_SECRET = previous; });
  f.db.prepare('INSERT INTO customer(body) VALUES(?)').run('historical log: ' + process.env.PROPR_FLEET_CONTROL_SECRET);
  const job = await f.start(); assert.equal((await settled(f.exports, job.operationId)).state, 'failed');
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
});

test('cancelling an in-flight export removes its private files and permits another export', async t => {
  const f = await fixture(t); const job = await f.start();
  await f.exports.cancel('instance', f.exports.generation, job.operationId, 'admin', allow);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'exports')), []);
  const next = await f.start(); assert.equal((await settled(f.exports, next.operationId)).state, 'ready');
});

test('swapping a database ancestor during execution refuses the snapshot and retains source data', async t => {
  const f = await fixture(t); let checks = 0;
  const moved = f.root + '-moved';
  try {
    const job = await f.start(async () => {
      if (++checks === 2) { await fs.rename(f.root, moved); await fs.mkdir(f.root); }
    });
    assert.equal((await settled(f.exports, job.operationId)).state, 'failed');
    await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
    await assert.rejects(f.exports.cancel('instance', f.exports.generation, job.operationId, 'admin', allow));
  } finally {
    await fs.rmdir(f.root); await fs.rename(moved, f.root);
  }
  assert.equal(f.db.prepare('SELECT body FROM customer WHERE id=1').get().body, 'customer content survives');
});

test('execution deadline terminates a worker and leaves no downloadable partial snapshot', async t => {
  const f = await fixture(t);
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => schedule(callback, ms === 60_000 ? 1 : ms, ...args));
  const job = await f.start(); assert.equal((await settled(f.exports, job.operationId)).state, 'failed');
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
});


test('configured secret policy covers provider families and excludes public keys and paths', () => {
  const names = [
    'GH_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'GH_TOKEN', 'MISTRAL_API_KEY',
    'REDIS_PASSWORD', 'WEB_PUSH_VAPID_PRIVATE_KEY', 'PROPR_FLEET_SECRET',
    'PROPR_FLEET_CONTROL_SECRET', 'PROPR_CREDENTIAL_ENCRYPTION_KEY',
    'PROVIDER_CREDENTIALS', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    'NEW_PROVIDER_APIKEY', 'providerApiKey', 'SESSION_SECRET', 'SYSTEM_TASK_SECRET',
    'PROPR_GH_RELAY_TOKEN', 'GH_CLIENT_SECRET', 'GH_OAUTH_CLIENT_SECRET',
  ];
  const env = Object.fromEntries(names.map(name => [name, `synthetic-${name}`]));
  assert.deepEqual(configuredExportSecrets(env), Object.values(env));
  assert.deepEqual(configuredExportSecrets({
    GH_PRIVATE_KEY_PATH: '/keys/app.pem', HOST_GH_PRIVATE_KEY: '/keys/app.pem',
    GOOGLE_APPLICATION_CREDENTIALS_FILE: '/keys/provider.json',
    PROPR_MANAGED_CREDENTIALS_DIR: '/credentials',
    WEB_PUSH_VAPID_PUBLIC_KEY: 'public-value', PROVIDER_PUBLICKEY: 'public-value',
    HOME: '/home/customer', EMPTY_SECRET: '', MISSING_SECRET: undefined,
  }), []);
  assert.deepEqual(configuredExportSecrets({ A_SECRET: ' padded secret ', B_TOKEN: ' padded secret ' }), [' padded secret ']);
});

for (const name of ['GH_WEBHOOK_SECRET', 'MISTRAL_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN',
  'REDIS_PASSWORD', 'WEB_PUSH_VAPID_PRIVATE_KEY', 'PROPR_FLEET_SECRET', 'PROVIDER_CREDENTIALS']) {
  test(`historical table rejects process-global ${name} absent from current agents without disclosure`, async t => {
    const f = await fixture(t);
    const canary = `historical-export-canary-3018-${name}`;
    const previous = process.env[name];
    process.env[name] = canary;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    const logs: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
    }
    // Worker stdout/stderr are forwarded to the parent streams, bypassing its console.
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      t.mock.method(stream, 'write', (...args: Parameters<typeof stream.write>) => {
        logs.push([String(args[0])]);
        return write(...args);
      });
    }
    f.db.exec('CREATE TABLE historical_provider_events(id INTEGER PRIMARY KEY, payload TEXT)');
    f.db.prepare('INSERT INTO historical_provider_events(payload) VALUES(?)').run('retired agent log: ' + canary);
    const job = await f.start();
    const result = await settled(f.exports, job.operationId);
    assert.equal(result.state, 'failed');
    let failure = '';
    await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow), error => {
      failure = String(error); return /Export not ready for download/.test(failure) && (error as { status?: number }).status === 409;
    });
    // Await worker termination and cleanup, not just the failed state transition.
    await f.exports.cancel('instance', f.exports.generation, job.operationId, 'admin', allow);
    assert.equal(JSON.stringify({ job, result, failure, logs }).includes(canary), false);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'exports')), []);
    assert.equal(f.db.prepare('SELECT payload FROM historical_provider_events').get().payload, 'retired agent log: ' + canary);
  });
}

test('current agent credential family is removed and historical copies fail closed', async t => {
  const f = await fixture(t);
  const canary = 'current-agent-credential-history-canary';
  f.db.prepare("UPDATE system_configs SET value=? WHERE key='agents'").run(JSON.stringify([
    { id: 'agent', envVars: { PROVIDER_CREDENTIAL: canary } },
  ]));
  f.db.prepare('INSERT INTO customer(body) VALUES(?)').run(canary);
  const job = await f.start();
  assert.equal((await settled(f.exports, job.operationId)).state, 'failed');
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
});


test('token tuning names are configuration while credential families remain secrets', () => {
  for (const name of [
    'MAX_THINKING_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'MAX_TOKENS',
    'TOKEN_LIMIT', 'TOKENS_COUNT', 'THINKING_TOKEN_BUDGET', 'maxThinkingTokens',
    'provider-token-limit',
  ]) {
    assert.equal(isExportSecretName(name), false, name);
    // A long, nonnumeric value must not mask a name-policy regression.
    assert.deepEqual(configuredExportSecrets({ [name]: 'unlimited-tuning-value' }), [], name);
  }
  for (const name of ['GITHUB_TOKEN', 'PROVIDER_TOKENS', 'MAX_PROVIDER_API_KEY']) {
    assert.equal(isExportSecretName(name), true, name);
  }
  for (const value of ['', 'short', '1234567', 'true', '   FALSE   ', '        ']) {
    assert.deepEqual(configuredExportSecrets({ PROVIDER_TOKEN: value }), [], JSON.stringify(value));
  }
  for (const name of ['REDIS_PASSWORD', 'WEBHOOK_SECRET', 'PROVIDER_API_KEY', 'AWS_ACCESS_KEY_ID', 'PROVIDER_TOKEN', 'NUMERIC_TOKEN']) {
    for (const value of ['12345678', '123456789012', '00000000', '9'.repeat(400), '1.234567e8', 'aB3dE6gH']) {
      assert.deepEqual(configuredExportSecrets({ [name]: value }), [value], name);
    }
  }
});

for (const source of ['process', 'agent', 'both']) {
  test(`export stays ready with token tuning and short/boolean values from ${source}`, async t => {
    const f = await fixture(t);
    const envVars = {
      MAX_THINKING_TOKENS: '10000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
      MAX_TOKENS: 'unlimited-tuning-value', TOKEN_COUNT: 'configured-count-value',
      SHORT_TOKEN: 'short', SHORT_NUMERIC_TOKEN: '1234567', BOOLEAN_TOKEN: '   FALSE   ',
    };
    if (source !== 'agent') {
      for (const [name, value] of Object.entries(envVars)) {
        const previous = process.env[name]; process.env[name] = value;
        t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
      }
    }
    if (source !== 'process') {
      f.db.prepare("UPDATE system_configs SET value=? WHERE key='agents'").run(JSON.stringify([
        { id: 'agent', envVars: { ...envVars, API_KEY: 'operator-env-canary' } },
      ]));
    }
    const body = 'customer token settings: ' + Object.values(envVars).join(', ');
    f.db.prepare('INSERT INTO customer(body) VALUES(?)').run(body);
    f.db.exec('CREATE TABLE customer_payloads(value BLOB)');
    // Exercise the raw UTF-16 scans as well as logical text/UTF-8 matching.
    f.db.prepare('INSERT INTO customer_payloads VALUES(?)').run(Buffer.from(body, 'utf16le'));
    f.db.prepare('INSERT INTO customer_payloads VALUES(?)').run(Buffer.from(body, 'utf16le').swap16());
    const job = await f.start();
    assert.equal((await settled(f.exports, job.operationId)).state, 'ready');
    const download = await f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow);
    try {
      const data = await download.file.readFile();
      assert.equal(data.includes(Buffer.from(body)), true);
      assert.equal(data.includes(Buffer.from(body, 'utf16le')), true);
      assert.equal(data.includes(Buffer.from(body, 'utf16le').swap16()), true);
      assert.equal(data.includes(Buffer.from('operator-env-canary')), false);
    } finally { await download.file.close(); await download.dispose(); }
  });
}

for (const source of ['process', 'agent']) {
  for (const [name, canary] of Object.entries({
    REDIS_PASSWORD: '12345678', WEBHOOK_SECRET: '123456789012',
    PROVIDER_API_KEY: '234567890123', AWS_ACCESS_KEY_ID: '345678901234',
    PROVIDER_TOKEN: '456789012345', NUMERIC_TOKEN: '567890123456',
  })) {
    for (const encoding of ['text', 'utf8', 'utf16le', 'utf16be']) {
      test(`numeric ${name} from ${source} fails closed in historical ${encoding} rows`, async t => {
        const f = await fixture(t);
        if (source === 'process') {
          const previous = process.env[name]; process.env[name] = canary;
          t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
        } else {
          f.db.prepare("UPDATE system_configs SET value=? WHERE key='agents'").run(JSON.stringify([
            { id: 'agent', envVars: { [name]: canary } },
          ]));
        }
        const body = 'historical customer log: ' + canary;
        let payload: string | Buffer = body;
        if (encoding !== 'text') payload = Buffer.from(body, encoding === 'utf8' ? 'utf8' : 'utf16le');
        if (encoding === 'utf16be') (payload as Buffer).swap16();
        f.db.exec('CREATE TABLE historical_customer_events(payload)');
        f.db.prepare('INSERT INTO historical_customer_events VALUES(?)').run(payload);
        const job = await f.start();
        const result = await settled(f.exports, job.operationId);
        assert.equal(result.state, 'failed');
        await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
        await f.exports.cancel('instance', f.exports.generation, job.operationId, 'admin', allow);
        assert.deepEqual(await fs.readdir(path.join(f.root, 'exports')), []);
        assert.equal(JSON.stringify({ job, result }).includes(canary), false);
        assert.deepEqual(f.db.prepare('SELECT payload FROM historical_customer_events').get().payload, payload);
      });
    }
  }
}
