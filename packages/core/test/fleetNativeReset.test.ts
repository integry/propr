import test from 'node:test';
import ts from 'typescript';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configuredNativeReset } from '../src/fleet/configuredReset.js';
import { startFleetResetRecovery } from '../../api/fleetResetRecovery.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { canonicalFleetJson, FLEET_RESET_CATEGORIES, FLEET_RESET_CONTRACT, FLEET_RESET_AUDIENCE, type FleetResetBinding } from '@propr/shared';
import { NativeResetRuntime } from '../src/fleet/nativeReset.js';
import { ResetGenerationFence, openResetDatabase, watchResetGeneration } from '../src/fleet/resetFence.js';
import { ResetQueueAdapter, ResetAuthorityAdapter, type ResetExternalBoundary, type ResetObservation } from '../src/fleet/resetAdapters.js';
import { FleetResetProofPlane, resetHash, resetContractPin, resetRequestMac, verifyResetReceipt } from '../src/fleet/resetProof.js';
import { listenFleetData } from '../../api/fleetDataListener.js';
import type { FleetDataPlane } from '../src/fleet/dataPlane.js';
import { verifyReceipt } from '../../../docs/contracts/fleet-reset-v1/verify.mjs';

async function fixture(t: any, checkpoint?: (phase: string) => Promise<void>, localWorkers = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-reset-'));
  const tenantRoot = path.join(root, 'tenant'); const controlRoot = path.join(root, 'control');
  await fs.mkdir(tenantRoot, { mode: 0o700 }); await fs.mkdir(controlRoot, { mode: 0o700 });
  const binding: FleetResetBinding = { resetOperationId: randomUUID(), resetRequestDigest: 'a'.repeat(64), resetAction: 'instance.reset', instanceId: 'disposable',
    runtimeBuildDigest: 'b'.repeat(64), predecessor: { generation: 2, stateScope: 'initial', storageId: randomUUID(), runtimeId: randomUUID() },
    successor: { generation: 3, stateScope: '', storageId: randomUUID(), runtimeId: randomUUID() } };
  binding.successor.stateScope = `reset:${binding.resetOperationId}`;
  const fence = new ResetGenerationFence(controlRoot); fence.provision(binding.predecessor);
  for (const category of FLEET_RESET_CATEGORIES) {
    await fs.mkdir(path.join(tenantRoot, category), { mode: 0o700 });
    await fs.writeFile(path.join(tenantRoot, category, 'private'), `private-${category}`);
  }
  const db = openResetDatabase(path.join(tenantRoot, 'database', 'propr.sqlite'));
  db.exec("CREATE TABLE customer(value TEXT); INSERT INTO customer VALUES ('private');");
  // Real disposable SQLite transport for the external queue/session/tunnel
  // service. Production adapters own all sequencing; only their network/native
  // clients are injected. Observations derive from persisted remote state.
  const remote = openResetDatabase(path.join(root, 'external.sqlite'));
  remote.exec('CREATE TABLE service(name TEXT PRIMARY KEY, binding TEXT, revision INTEGER, remaining INTEGER, connections INTEGER);');
  for (const name of ['queue', 'sessions', 'tunnel_bootstrap']) remote.prepare('INSERT INTO service VALUES (?, NULL, 0, 3, 1)').run(name);
  const calls: string[] = []; let missing = false; let drift = false;
  const boundary = (name: string): ResetExternalBoundary => ({
    async revoke(b) {
      calls.push(`revoke:${name}`);
      remote.prepare('UPDATE service SET binding=?, revision=revision+1, remaining=0, connections=0 WHERE name=?').run(canonicalFleetJson(b), name);
    },
    async observe(b) {
      if (missing) return;
      if (drift) remote.prepare('UPDATE service SET revision=revision+1 WHERE name=?').run(name);
      const row = remote.prepare('SELECT * FROM service WHERE name=?').get(name);
      if (row.binding !== canonicalFleetJson(b) || row.remaining || row.connections) return;
      return { binding: JSON.parse(row.binding), revision: `${name}:${row.revision}`, refused: true, remaining: row.remaining, connections: row.connections } as ResetObservation;
    },
  });
  const queue = new ResetQueueAdapter(fence, localWorkers ? [{ pause: async () => { calls.push('worker:pause'); }, close: async () => { calls.push('worker:close'); } }] : [],
    [{ pause: async () => { calls.push('queue:pause'); }, drain: async delayed => { assert.equal(delayed, true); calls.push('queue:drain'); }, close: async () => { calls.push('queue:close'); } }],
    [{ quit: async () => { calls.push('redis:quit'); } }], boundary('queue'), 1_000);
  const sessions = new ResetAuthorityAdapter('sessions', fence, [{ close: async () => { calls.push('sessions:close'); } }], boundary('sessions'));
  const tunnel = new ResetAuthorityAdapter('tunnel_bootstrap', fence, [{ close: async () => { calls.push('tunnel:close'); } }], boundary('tunnel_bootstrap'));
  const credentials = {
    provider: sessions.issue(binding.predecessor, 'provider'), app: sessions.issue(binding.predecessor, 'app'),
    tunnel: tunnel.issue(binding.predecessor, 'tunnel'), bootstrap: tunnel.issue(binding.predecessor, 'bootstrap'),
  };
  let closed = false;
  const resources = { close: async () => { db.close(); closed = true; }, observeClosed: async () => closed };
  const options = { tenantRoot, controlRoot, binding, adapters: [queue, sessions, tunnel], resources, checkpoint };
  const native = new NativeResetRuntime(options); await native.initialize();
  const secret = 'DISPOSABLE-RESET-SECRET-DO-NOT-USE-LIVE';
  await fs.writeFile(path.join(controlRoot, 'authority.json'), JSON.stringify({ contract: FLEET_RESET_CONTRACT, contractPin: resetContractPin, audience: FLEET_RESET_AUDIENCE, binding, secretSha256: resetHash(secret), enabled: true }), { mode: 0o600 });
  const plane = new FleetResetProofPlane(controlRoot, () => secret, undefined, native); await plane.initialize();
  const make = (action: 'reset.prove' | 'reset.receipt' = 'reset.prove', b = binding) => {
    const now = Math.floor(Date.now() / 1000);
    const assertion = { contract: FLEET_RESET_CONTRACT, contractPin: resetContractPin, audience: FLEET_RESET_AUDIENCE, binding: b, action, requestId: randomUUID(), nonce: randomBytes(32).toString('hex'), issuedAt: now, expiresAt: now + 30 };
    return canonicalFleetJson({ assertion, mac: resetRequestMac(assertion, secret) });
  };
  const data = { files: plane.files, runtime: async () => ({ runtimeGeneration: binding.predecessor.runtimeId }) } as unknown as FleetDataPlane;
  const listener = await listenFleetData(data, undefined, plane);
  const invoke = async (body: string) => new Promise<any>((resolve, reject) => {
    const req = request({ socketPath: listener.address()!, path: '/reset/v1/invoke', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let bytes = ''; res.on('data', chunk => { bytes += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(bytes) }));
    }); req.on('error', reject); req.end(body);
  });
  t.after(async () => { await listener.shutdown(); native.close(); fence.close(); if (!closed) db.close(); remote.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, tenantRoot, controlRoot, binding, fence, native, options, plane, sessions, tunnel, credentials, make, invoke, calls, secret,
    stopListener: listener.shutdown, missing: () => { missing = true; }, drift: () => { drift = true; }, remote };
}

test('native reset through real Unix listener erases real SQLite/files, closes resources and boots isolated successor', async t => {
  const f = await fixture(t); const raw = f.make(); const result = await f.invoke(raw);
  assert.equal(result.status, 200);
  const receipt = verifyResetReceipt(result.body, raw, f.secret);
  assert.equal(receipt.evidence.state, 'complete');
  verifyReceipt(result.body, raw, f.secret, resetContractPin, f.binding, Math.floor(Date.now() / 1000));
  assert.deepEqual(await fs.readdir(f.tenantRoot), ['successor']);
  assert.throws(() => f.fence.write(f.binding.predecessor, () => assert.fail('old writer ran')));
  await assert.rejects(f.fence.use(f.binding.predecessor, 'delayed-queued-result', async () => assert.fail('old job ran')));
  assert.equal(f.sessions.accepts(f.binding.predecessor, 'provider', f.credentials.provider), false);
  assert.equal(f.sessions.accepts(f.binding.predecessor, 'app', f.credentials.app), false);
  assert.equal(f.tunnel.accepts(f.binding.predecessor, 'tunnel', f.credentials.tunnel), false);
  assert.equal(f.tunnel.accepts(f.binding.predecessor, 'bootstrap', f.credentials.bootstrap), false);
  assert.deepEqual(f.calls.slice(0, 6), ['queue:pause', 'worker:pause', 'worker:close', 'queue:drain', 'queue:close', 'redis:quit']);
  const before = [...f.calls];
  for (let i = 0; i < 3; i++) {
    const read = f.make('reset.receipt'); const observed = await f.invoke(read);
    assert.equal(verifyResetReceipt(observed.body, read, f.secret).evidenceDigest, receipt.evidenceDigest);
  }
  assert.deepEqual(f.calls, before);
  assert.equal((await f.invoke(raw)).status, 403);
  const restart = new NativeResetRuntime(f.options); await restart.initialize();
  assert.equal((await restart.reconcile(f.binding)).state, 'complete'); restart.close();
  const bootstrap = await f.native.bootstrapSuccessor(f.binding);
  const successor = new ResetGenerationFence(path.join(f.controlRoot, 'successor-control'));
  assert.equal(successor.accepts(f.binding.successor, 'bootstrap', bootstrap), true);
  assert.equal(successor.accepts(f.binding.predecessor, 'bootstrap', f.credentials.bootstrap), false);
  await assert.rejects(successor.use(f.binding.predecessor, 'future-on-boot', async () => assert.fail()));
  successor.close();
  await assert.rejects(f.native.bootstrapSuccessor(f.binding));
});

const effects = ['fence', 'stop-queue', 'stop-sessions', 'stop-tunnel_bootstrap', 'close-resources', ...FLEET_RESET_CATEGORIES.map(c => `erase-${c}`), 'successor'];
for (const phase of ['operation:intent', ...effects.flatMap(e => ['intent', 'effect', 'complete'].map(s => `${e}:${s}`)), 'first-proof', 'second-proof']) {
  test(`interruption ${phase} never repeats uncertain effects and survives restart`, async t => {
    const f = await fixture(t, async current => { if (current === phase) throw new Error('simulated power loss'); });
    const result = await f.invoke(f.make()); assert.equal(result.status, 200);
    const before = [...f.calls];
    const restart = new NativeResetRuntime({ ...f.options, checkpoint: undefined }); await restart.initialize();
    try { await restart.reconcile(f.binding); } catch { /* incomplete effects remain recovery_required */ }
    restart.close();
    const read = await f.invoke(f.make('reset.receipt'));
    assert.deepEqual(f.calls, before);
    if (!['successor:effect', 'successor:complete', 'first-proof', 'second-proof'].includes(phase)) assert.equal(read.body.receipt.evidence.state, 'recovery_required');
    if (read.body.receipt.evidence.state === 'recovery_required') await assert.rejects(f.native.bootstrapSuccessor(f.binding));
  });
}

test('unknown private leftovers and symlinked state are not deleted or certified', async t => {
  for (const kind of ['unknown', 'symlink']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'unknown') await fs.writeFile(path.join(f.tenantRoot, 'forgotten-credentials'), 'private');
    else await fs.symlink(f.root, path.join(f.tenantRoot, 'configuration', 'escape'));
    const result = await f.invoke(f.make()); assert.equal(result.body.receipt.evidence.state, 'recovery_required');
    assert.ok(await fs.stat(path.join(f.tenantRoot, 'configuration')));
  });
});

test('missing external proof, changing revisions, stale scope and active writers fail closed', async t => {
  for (const scenario of ['missing', 'drift', 'writer', 'stale']) await t.test(scenario, async t => {
    const f = await fixture(t);
    let release = () => {};
    if (scenario === 'missing') f.missing();
    if (scenario === 'drift') f.drift();
    if (scenario === 'writer') release = f.fence.acquire(f.binding.predecessor, 'provider-child');
    const result = await f.invoke(scenario === 'stale' ? f.make('reset.prove', { ...f.binding, predecessor: { ...f.binding.predecessor, stateScope: 'stale' } }) : f.make());
    if (scenario === 'stale') assert.equal(result.status, 403); else assert.equal(result.body.receipt.evidence.state, 'recovery_required');
    release();
  });
});

test('competing reset admissions dispatch each destructive effect once', async t => {
  const f = await fixture(t);
  const values = await Promise.all([f.invoke(f.make()), f.invoke(f.make())]);
  assert.deepEqual(values.map(v => v.status).sort(), [200, 403]);
  assert.equal(f.calls.filter(c => c === 'revoke:queue').length, 1);
});

test('late private files after first proof defeat second stable terminal proof', async t => {
  let tenant = '';
  const f = await fixture(t, async phase => { if (phase === 'second-proof') await fs.writeFile(path.join(tenant, 'late-result'), 'private'); }); tenant = f.tenantRoot;
  const result = await f.invoke(f.make()); assert.equal(result.body.receipt.evidence.state, 'recovery_required');
});


test('graceful participant replacement releases leases only after shared closure succeeds', async t => {
  const f = await fixture(t);
  const managed = { fence: f.fence, identity: f.binding.predecessor };
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const close = watchResetGeneration(async () => { calls++; await pending; }, managed);
  const first = close();
  assert.equal(close(), first);
  assert.equal(f.fence.idle(), false);
  finish(); await first;
  assert.equal(calls, 1);
  assert.equal(f.fence.idle(), true);
  const restarted = new ResetGenerationFence(f.controlRoot, 'existing');
  try {
    const replacement = watchResetGeneration(async () => {}, { fence: restarted, identity: f.binding.predecessor });
    await replacement();
    assert.equal(restarted.idle(), true);
  } finally { restarted.close(); }
  assert.equal((await f.invoke(f.make())).body.receipt.evidence.state, 'complete');
});

test('failed participant closure retains the lease across concurrent and later shutdown requests', async t => {
  const f = await fixture(t);
  let calls = 0;
  const close = watchResetGeneration(async () => { calls++; throw new Error('closure failed'); },
    { fence: f.fence, identity: f.binding.predecessor });
  const first = close();
  assert.equal(close(), first);
  await assert.rejects(first);
  await assert.rejects(close());
  assert.equal(calls, 1);
  assert.equal(f.fence.idle(), false);
  assert.equal((await f.invoke(f.make())).body.receipt.evidence.state, 'recovery_required');
  assert.equal(f.fence.effect('erase-database'), undefined);
});

test('queue quiescence without local worker handles waits for managed closure after external revocation', async t => {
  const f = await fixture(t, undefined, false);
  let closed = false;
  const close = watchResetGeneration(async () => {
    assert.ok(f.calls.includes('revoke:queue'));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.fence.idle(), false);
    closed = true;
  }, { fence: f.fence, identity: f.binding.predecessor });
  const result = await f.invoke(f.make());
  await close();
  assert.equal(closed, true);
  assert.equal(result.body.receipt.evidence.state, 'complete');
  assert.equal((await f.invoke(f.make('reset.receipt'))).body.receipt.evidence.state, 'complete');
});

test('successor control loss or corruption refuses receipts and bootstrap without provisioning', async t => {
  for (const scenario of ['missing-file', 'missing-table', 'missing-row', 'wrong-identity', 'wrong-fence', 'corrupt-file']) {
    await t.test(scenario, async t => {
      const f = await fixture(t);
      assert.equal((await f.invoke(f.make())).body.receipt.evidence.state, 'complete');
      const file = path.join(f.controlRoot, 'successor-control', 'generation.sqlite');
      if (scenario === 'missing-file') await fs.unlink(file);
      else if (scenario === 'corrupt-file') await fs.writeFile(file, 'not sqlite');
      else {
        const db = openResetDatabase(file);
        try {
          if (scenario === 'missing-table') db.exec('DROP TABLE identity');
          if (scenario === 'missing-row') db.exec('DELETE FROM identity');
          if (scenario === 'wrong-identity') db.prepare('UPDATE identity SET identity=?').run(canonicalFleetJson(f.binding.predecessor));
          if (scenario === 'wrong-fence') db.prepare('UPDATE identity SET fence=?').run('{}');
        } finally { db.close(); }
      }
      const before = scenario === 'missing-file' ? undefined : await fs.readFile(file);
      const result = await f.invoke(f.make('reset.receipt'));
      assert.equal(result.body.receipt.evidence.state, 'recovery_required');
      assert.equal(result.body.receipt.evidence.bootstrapAllowed, false);
      await assert.rejects(f.native.bootstrapSuccessor(f.binding));
      if (before) assert.deepEqual(await fs.readFile(file), before);
      else await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    });
  }
});

test('successor control proof accepts exact staged and activated identities', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke(f.make())).body.receipt.evidence.state, 'complete');
  await f.native.bootstrapSuccessor(f.binding);
  assert.equal((await f.invoke(f.make('reset.receipt'))).body.receipt.evidence.state, 'complete');
});

// Provision only disposable fixtures; startup itself must never create authority.
async function provisionConfigured(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const env = {
    PROPR_FLEET_RESET_RUNTIME_ROOT: f.controlRoot,
    PROPR_FLEET_RESET_SERVICE_SECRET: 'DISPOSABLE-SERVICE-SECRET-DO-NOT-USE-LIVE',
    PROPR_FLEET_RESET_SECRET: f.secret,
    DB_FILENAME: path.join(f.tenantRoot, 'database', 'propr.sqlite'),
    GIT_CLONES_BASE_PATH: path.join(f.tenantRoot, 'repositories_worktrees_caches', 'clones'),
    GIT_WORKTREES_BASE_PATH: path.join(f.tenantRoot, 'repositories_worktrees_caches', 'worktrees'),
    HOME: path.join(f.tenantRoot, 'provider_sessions'),
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const provision = { binding: f.binding, tenantRoot: f.tenantRoot,
    services: { queue: 'https://queue.invalid', sessions: 'https://sessions.invalid', tunnel_bootstrap: 'https://tunnel.invalid' } };
  await fs.writeFile(path.join(f.controlRoot, 'native.json'), JSON.stringify(provision), { mode: 0o600 });
  return provision;
}

async function treeSnapshot(root: string): Promise<unknown> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => [entry.name,
    entry.isDirectory() ? await treeSnapshot(path.join(root, entry.name)) : await fs.readFile(path.join(root, entry.name))]));
}

test('configured native reset is disabled without provisioning and creates nothing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unprovisioned-reset-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await configuredNativeReset(path.join(root, 'missing')), undefined);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(await configuredNativeReset(root), undefined);
  assert.deepEqual(await fs.readdir(root), []);
  const previous = process.env.PROPR_FLEET_RESET_RUNTIME_ROOT;
  t.after(() => { if (previous === undefined) delete process.env.PROPR_FLEET_RESET_RUNTIME_ROOT; else process.env.PROPR_FLEET_RESET_RUNTIME_ROOT = previous; });
  delete process.env.PROPR_FLEET_RESET_RUNTIME_ROOT;
  await assert.rejects(startFleetResetRecovery(), /fleet_reset_unavailable/);
  process.env.PROPR_FLEET_RESET_RUNTIME_ROOT = root;
  await assert.rejects(startFleetResetRecovery(), /fleet_reset_unavailable/);
  assert.deepEqual(await fs.readdir(root), []);
});

for (const scenario of ['valid', 'malformed-json', 'malformed-binding', 'mismatched-binding', 'missing-authority',
  'missing-runtime-root', 'wrong-runtime-root', 'DB_FILENAME', 'GIT_CLONES_BASE_PATH', 'GIT_WORKTREES_BASE_PATH', 'HOME',
  'missing-service-secret', 'short-service-secret', 'overlapping-root']) {
  test(`configured native reset validates provisioning: ${scenario}`, async t => {
    const f = await fixture(t); const provision = await provisionConfigured(t, f);
    const file = path.join(f.controlRoot, 'native.json');
    if (scenario === 'malformed-json') await fs.writeFile(file, '{');
    if (scenario === 'malformed-binding') await fs.writeFile(file, JSON.stringify({ ...provision, binding: {} }));
    if (scenario === 'mismatched-binding') await fs.writeFile(file, JSON.stringify({ ...provision, binding: { ...f.binding, runtimeBuildDigest: 'c'.repeat(64) } }));
    if (scenario === 'missing-authority') await fs.unlink(path.join(f.controlRoot, 'authority.json'));
    if (scenario === 'missing-runtime-root') delete process.env.PROPR_FLEET_RESET_RUNTIME_ROOT;
    if (scenario === 'wrong-runtime-root') process.env.PROPR_FLEET_RESET_RUNTIME_ROOT = f.tenantRoot;
    if (['DB_FILENAME', 'GIT_CLONES_BASE_PATH', 'GIT_WORKTREES_BASE_PATH', 'HOME'].includes(scenario)) process.env[scenario] = f.root;
    if (scenario === 'missing-service-secret') delete process.env.PROPR_FLEET_RESET_SERVICE_SECRET;
    if (scenario === 'short-service-secret') process.env.PROPR_FLEET_RESET_SERVICE_SECRET = 'short';
    if (scenario === 'overlapping-root') {
      await fs.writeFile(file, JSON.stringify({ ...provision, tenantRoot: f.controlRoot }));
      process.env.DB_FILENAME = path.join(f.controlRoot, 'database', 'propr.sqlite');
      process.env.GIT_CLONES_BASE_PATH = path.join(f.controlRoot, 'repositories_worktrees_caches', 'clones');
      process.env.GIT_WORKTREES_BASE_PATH = path.join(f.controlRoot, 'repositories_worktrees_caches', 'worktrees');
      process.env.HOME = path.join(f.controlRoot, 'provider_sessions');
    }
    const before = await treeSnapshot(f.tenantRoot);
    const authority = await fs.readFile(path.join(f.controlRoot, 'authority.json')).catch(() => undefined);
    const configuration = await fs.readFile(file);
    if (scenario === 'valid') {
      const native = await configuredNativeReset(f.controlRoot); assert.ok(native); await native.initialize(); native.close();
    } else {
      await assert.rejects(configuredNativeReset(f.controlRoot));
      await assert.rejects(startFleetResetRecovery());
    }
    assert.deepEqual(await fs.readFile(file), configuration);
    assert.deepEqual(await treeSnapshot(f.tenantRoot), before);
    assert.deepEqual(await fs.readFile(path.join(f.controlRoot, 'authority.json')).catch(() => undefined), authority);
  });
}

for (const scenario of ['unstarted', 'terminal', 'interrupted', 'missing-successor', 'corrupt-successor', 'wrong-reset-secret']) {
  test(`configured recovery is receipt-only: ${scenario}`, async t => {
    const f = await fixture(t, scenario === 'interrupted' ? async phase => {
      if (phase === 'close-resources:intent') throw new Error('power loss');
    } : undefined);
    if (scenario !== 'unstarted') {
      const result = await f.invoke(f.make());
      assert.equal(result.body.receipt.evidence.state, scenario === 'interrupted' ? 'recovery_required' : 'complete');
    }
    await provisionConfigured(t, f);
    await f.stopListener();
    const successor = path.join(f.controlRoot, 'successor-control', 'generation.sqlite');
    if (scenario === 'missing-successor') await fs.unlink(successor);
    if (scenario === 'corrupt-successor') await fs.writeFile(successor, 'corrupt');
    const controlBefore = await fs.readFile(successor).catch(() => undefined);
    const tenantBefore = await treeSnapshot(f.tenantRoot); const callsBefore = [...f.calls];
    const observations: string[] = [];
    // Inject only the external HTTP boundary; persisted remote service state and
    // all startup, adapters, reconciliation, SQLite and Unix I/O stay real.
    t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
      const parts = input.pathname.split('/'); const action = parts.pop(); const name = parts.pop()!;
      assert.equal(action, 'observe'); observations.push(name);
      assert.equal(init.headers && (init.headers as Record<string, string>).authorization, `Bearer ${process.env.PROPR_FLEET_RESET_SERVICE_SECRET}`);
      assert.deepEqual(JSON.parse(init.body as string), { binding: f.binding });
      const row = f.remote.prepare('SELECT * FROM service WHERE name=?').get(name);
      return new Response(JSON.stringify({ binding: JSON.parse(row.binding), revision: `${name}:${row.revision}`,
        refused: true, remaining: row.remaining, connections: row.connections }));
    });
    if (scenario === 'wrong-reset-secret') {
      process.env.PROPR_FLEET_RESET_SECRET = 'WRONG-DISPOSABLE-SECRET-DO-NOT-USE-LIVE';
      await assert.rejects(startFleetResetRecovery());
    } else {
      const recovery = await startFleetResetRecovery(); t.after(() => recovery.shutdown());
      const invoke = (body: string) => new Promise<any>((resolve, reject) => {
        const req = request({ socketPath: recovery.address()!, path: '/reset/v1/invoke', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
          let bytes = ''; res.on('data', chunk => { bytes += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(bytes) }));
        }); req.on('error', reject); req.end(body);
      });
      assert.equal((await invoke(f.make('reset.prove'))).status, 403);
      if (scenario === 'unstarted') {
        assert.equal(f.fence.effect('operation'), undefined);
        await assert.rejects(fs.stat(path.join(f.controlRoot, `proof-${f.binding.resetOperationId}.json`)), { code: 'ENOENT' });
      }
      for (let i = 0; i < 2; i++) {
        const raw = f.make('reset.receipt'); const response = await invoke(raw);
        assert.equal(response.status, 200);
        const receipt = verifyResetReceipt(response.body, raw, f.secret);
        assert.equal(receipt.evidence.state, scenario === 'terminal' ? 'complete' : 'recovery_required');
        assert.equal(receipt.evidence.bootstrapAllowed, scenario === 'terminal');
      }
      if (scenario === 'terminal') assert.ok(observations.length >= 12);
      await recovery.shutdown();
    }
    assert.deepEqual(f.calls, callsBefore);
    assert.deepEqual(await treeSnapshot(f.tenantRoot), tenantBefore);
    assert.deepEqual(await fs.readFile(successor).catch(() => undefined), controlBefore);
  });
}

for (const participant of ['worker', 'daemon']) for (const failure of [false, true]) {
  test(`${participant} production shutdown shares reset/signal/caller closure and ${failure ? 'retains' : 'releases'} its lease`, async t => {
    const f = await fixture(t);
    const source = await fs.readFile(path.resolve(`src/${participant}.ts`), 'utf8');
    const tree = ts.createSourceFile(`${participant}.ts`, source, ts.ScriptTarget.Latest, true);
    let block: ts.Block | undefined; let start = -1;
    const visit = (node: ts.Node) => {
      if (ts.isBlock(node)) {
        const index = node.statements.findIndex(statement => ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(d => d.name.getText(tree) === 'close' &&
            d.initializer && ts.isCallExpression(d.initializer) && d.initializer.expression.getText(tree) === 'watchResetGeneration'));
        if (index >= 0) { assert.equal(block, undefined); block = node; start = index; }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree); assert.ok(block);
    // Compile the actual production closure AND signal registrations, with only
    // external resource handles injected. No copied/synthetic shutdown helper.
    const statements = block!.statements.slice(start);
    if (participant === 'worker') assert.ok(statements.some(s => ts.isReturnStatement(s) &&
      s.expression && ts.isObjectLiteralExpression(s.expression) && s.expression.properties.some(p =>
        ts.isShorthandPropertyAssignment(p) && p.name.text === 'close')));
    const code = ts.transpile(statements.map(s => s.getText(tree)).join('\n'));
    const calls: string[] = []; const signals = new Map<string, () => unknown>();
    let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
    const gate = participant === 'worker' ? 'usageTipsRunner.close' : 'stopAgentRunSweeps';
    const operation = (name: string) => async () => {
      calls.push(name);
      if (name === gate) { await pending; if (failure) throw new Error('disposable closure failure'); }
    };
    const scope: Record<string, unknown> = {
      watchResetGeneration: (close: () => Promise<void>) => watchResetGeneration(close, { fence: f.fence, identity: f.binding.predecessor }),
      clearInterval: () => {}, logger: { info: () => {} },
      process: { on: (signal: string, callback: () => unknown) => signals.set(signal, callback), exit: () => calls.push('exit') },
      workerId: 'disposable-worker',
    };
    for (const name of ['heartbeatInterval', 'intervalId', 'configReloadInterval', 'draftContextSweepInterval',
      'pushRescueSweepInterval', 'ultrafixResumeSweepInterval', 'epicMergeProgressRetryInterval', 'mergeConflictSweepInterval']) scope[name] = 1;
    const handles = participant === 'worker'
      ? ['agentImageWatchdog.close', 'usageTipsRunner.close', 'taskStateRecovery.close', 'worker.close', 'egressProxySweeper.close',
        'attachedTaskStateFinalizers.close', 'runtimeBuildWorker.close', 'agentImagePreparationWorker.close',
        'agentImagePreparationQueue.close', 'heartbeatRedis.srem', 'heartbeatRedis.hdel', 'subscriberRedis.quit', 'heartbeatRedis.quit']
      : ['routingService.stop', 'routingStatusPublisher.stop', 'subscriberRedis.quit', 'heartbeatRedis.quit', 'redisClient.quit'];
    for (const name of handles) {
      const [object, method] = name.split('.');
      const resource = (scope[object] ??= {}) as Record<string, unknown>; resource[method] = operation(name);
    }
    for (const name of ['closeStateManager', 'closeAgentImageBuildLock', 'stopManagedDiagnostics', 'stopAgentRunSweeps', 'shutdownQueue']) scope[name] = operation(name);
    const result = new Function(...Object.keys(scope), `${code}\nreturn close;`)(...Object.values(scope));
    const close: () => Promise<void> = participant === 'worker' ? result.close : result;
    assert.deepEqual([...signals.keys()].sort(), ['SIGINT', 'SIGTERM']);
    assert.equal(f.fence.idle(), false);
    // Let the real 100ms generation watcher initiate closure first.
    f.fence.seal(f.binding);
    const deadline = Date.now() + 2000;
    while (!calls.includes(gate) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(calls.includes(gate));
    const first = close(); assert.equal(close(), first);
    assert.equal(f.fence.idle(), false);
    // Success also exercises both installed signal handlers. A failure uses the
    // public close promise so the daemon's void signal handler cannot create an
    // intentional unhandled rejection in the test runner.
    const signalResults = failure ? [] : [...signals.values()].map(callback => callback());
    finish();
    if (failure) {
      await assert.rejects(first, /disposable closure failure/);
      await assert.rejects(close(), /disposable closure failure/);
      assert.equal(f.fence.idle(), false);
    } else {
      await first; await Promise.all(signalResults);
      assert.equal(f.fence.idle(), true);
      for (const name of handles) assert.equal(calls.filter(call => call === name).length, 1, name);
      assert.equal(calls.filter(call => call === 'exit').length, 2);
    }
    assert.equal(calls.filter(call => call === gate).length, 1);
  });
}


test('recovery cold start never loads application services or opens customer SQLite', async t => {
  const f = await fixture(t); await provisionConfigured(t, f);
  await f.stopListener();
  const before = await treeSnapshot(f.tenantRoot);
  // A fresh process prevents already-cached modules from hiding startup effects.
  // The load tripwires fail even if application initialization swallows errors.
  const script = `
    import assert from 'node:assert/strict';
    import Module, { registerHooks } from 'node:module';
    import path from 'node:path';
    const forbidden = [];
    const opened = [];
    const original = Module._load;
    Module._load = function(name, ...args) {
      const value = original.call(this, name, ...args);
      if (name !== 'better-sqlite3') return value;
      return new Proxy(value, { construct(target, args) {
        opened.push(path.resolve(args[0]));
        assert.ok(!path.resolve(args[0]).startsWith(process.env.TEST_TENANT_ROOT + path.sep), 'customer SQLite opened');
        return Reflect.construct(target, args);
      }});
    };
    registerHooks({ load(url, context, next) {
      if (/\\/(?:bullmq|ioredis|redis|knex|express-session)\\//.test(url) ||
          /\\/(?:server|worker|daemon)\\.(?:ts|js)$/.test(url) ||
          /\\/(?:db\\/connection|queue\\/taskQueue)\\.(?:ts|js)$/.test(url)) {
        forbidden.push(url); throw new Error('application service imported: ' + url);
      }
      return next(url, context);
    }});
    const { startFleetResetRecovery } = await import('./packages/api/fleetResetRecovery.ts');
    const listener = await startFleetResetRecovery();
    assert.ok(listener.address());
    await listener.shutdown();
    assert.deepEqual(forbidden, []);
    assert.ok(opened.length > 0, 'real control SQLite must be opened');
    assert.ok(opened.every(file => file.startsWith(process.env.PROPR_FLEET_RESET_RUNTIME_ROOT + path.sep)));
  `;
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { cwd: process.cwd(), env: { ...process.env, TEST_TENANT_ROOT: f.tenantRoot }, timeout: 30_000 });
  assert.deepEqual(await treeSnapshot(f.tenantRoot), before);
});

test('configured reset owns both fence handles and closes the adapter handle on construction failure', async t => {
  const f = await fixture(t); const provision = await provisionConfigured(t, f);
  const closed: ResetGenerationFence[] = [];
  const original = ResetGenerationFence.prototype.close;
  t.mock.method(ResetGenerationFence.prototype, 'close', function(this: ResetGenerationFence) {
    closed.push(this); return original.call(this);
  });
  for (let i = 0; i < 3; i++) {
    const native = (await configuredNativeReset(f.controlRoot))!;
    const before = closed.length;
    native.close();
    assert.equal(closed.length - before, 2);
    assert.notEqual(closed[before], closed[before + 1]);
    for (const fence of closed.slice(before)) assert.throws(() => fence.idle());
  }
  await fs.writeFile(path.join(f.controlRoot, 'native.json'), JSON.stringify({ ...provision, tenantRoot: f.controlRoot }));
  process.env.DB_FILENAME = path.join(f.controlRoot, 'database', 'propr.sqlite');
  process.env.GIT_CLONES_BASE_PATH = path.join(f.controlRoot, 'repositories_worktrees_caches', 'clones');
  process.env.GIT_WORKTREES_BASE_PATH = path.join(f.controlRoot, 'repositories_worktrees_caches', 'worktrees');
  process.env.HOME = path.join(f.controlRoot, 'provider_sessions');
  const before = closed.length;
  await assert.rejects(configuredNativeReset(f.controlRoot));
  assert.equal(closed.length - before, 1);
});

test('configured reset cannot acknowledge a failed local resource shutdown', async t => {
  const f = await fixture(t); await provisionConfigured(t, f);
  const failure = new Error('socket/session shutdown failed');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    binding: f.binding, revision: 'closed', refused: true, remaining: 0, connections: 0,
  })));
  const before = await treeSnapshot(f.tenantRoot);
  const native = (await configuredNativeReset(f.controlRoot, {
    queues: [], connections: [], sessions: [], close: async () => { throw failure; },
  }))!;
  t.after(() => native.close());
  const resources = (native as any).options.resources;
  assert.equal(await resources.observeClosed(), false);
  await native.initialize();
  await assert.rejects(native.execute(f.binding), error => error === failure);
  assert.equal(await resources.observeClosed(), false);
  assert.equal(native.fence.effect('close-resources')?.result, null);
  assert.equal(native.fence.effect('erase-database'), undefined);
  assert.deepEqual(await treeSnapshot(f.tenantRoot), before);
});

test('recovery startup failure and listener shutdown release both owned control handles', async t => {
  const f = await fixture(t); await provisionConfigured(t, f); await f.stopListener();
  const closed: ResetGenerationFence[] = [];
  const original = ResetGenerationFence.prototype.close;
  t.mock.method(ResetGenerationFence.prototype, 'close', function(this: ResetGenerationFence) {
    closed.push(this); return original.call(this);
  });
  process.env.PROPR_FLEET_RESET_SECRET = 'wrong-reset-secret';
  await assert.rejects(startFleetResetRecovery());
  assert.equal(closed.length, 2);
  process.env.PROPR_FLEET_RESET_SECRET = f.secret;
  const recovery = await startFleetResetRecovery();
  await recovery.shutdown();
  assert.equal(closed.length, 4);
  assert.equal(new Set(closed).size, 4);
  for (const fence of closed) assert.throws(() => fence.idle());
});
