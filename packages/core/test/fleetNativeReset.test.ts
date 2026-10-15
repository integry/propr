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
import { HttpResetBoundary, ResetQueueAdapter, ResetAuthorityAdapter, type ResetExternalBoundary, type ResetObservation } from '../src/fleet/resetAdapters.js';
import { FleetResetProofPlane, resetHash, resetContractPin, resetRequestMac, verifyResetReceipt } from '../src/fleet/resetProof.js';
import { listenFleetData } from '../../api/fleetDataListener.js';
import type { FleetDataPlane } from '../src/fleet/dataPlane.js';
import { verifyReceipt } from '../../../docs/contracts/fleet-reset-v1/verify.mjs';

async function fixture(t: any, checkpoint?: (phase: string) => Promise<void>, localWorkers = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-reset-'));
  const tenantRoot = path.join(root, 'tenant'); const controlRoot = path.join(root, 'fleet-reset-control');
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

for (const adapter of ['queue', 'sessions', 'tunnel_bootstrap']) {
  for (const interrupted of [false, true]) {
    test(`stable revision advance after stop refuses ${adapter} proof (interrupted: ${interrupted})`, async t => {
      const f = await fixture(t, async phase => {
        if (phase === `stop-${adapter}:complete`) {
          f.remote.prepare('UPDATE service SET revision=revision+1 WHERE name=?').run(adapter);
        }
        if (interrupted && phase === 'successor:effect') throw new Error('lost successor acknowledgement');
      });
      const result = await f.invoke(f.make());
      assert.equal(result.body.receipt.evidence.state, 'recovery_required');
      assert.equal(JSON.parse(f.fence.effect(`stop-${adapter}`)!.result!).revision, `${adapter}:1`);
      assert.equal(f.fence.effect('operation')!.result, null);
      const before = [...f.calls];
      const restart = new NativeResetRuntime({ ...f.options, checkpoint: undefined });
      await restart.initialize();
      try {
        await assert.rejects(restart.reconcile(f.binding));
        await assert.rejects(restart.bootstrapSuccessor(f.binding));
      } finally { restart.close(); }
      assert.equal((await f.invoke(f.make('reset.receipt'))).body.receipt.evidence.state, 'recovery_required');
      assert.equal(f.fence.effect('operation')!.result, null);
      // Validate all completed results before repairing even a missing successor acknowledgement.
      if (interrupted) assert.equal(f.fence.effect('successor')!.result, null);
      assert.equal(f.fence.effect('bootstrap'), undefined);
      assert.deepEqual(f.calls, before);
    });
  }
}

for (const name of effects) {
  test(`staged reconciliation rejects mismatched completed ${name} result`, async t => {
    const f = await fixture(t);
    await f.native.execute(f.binding);
    const db = openResetDatabase(path.join(f.controlRoot, 'generation.sqlite'), 'existing');
    try { db.prepare('UPDATE effects SET result=? WHERE name=?').run('{}', name); }
    finally { db.close(); }
    await assert.rejects(f.native.reconcile(f.binding));
    await assert.rejects(f.native.bootstrapSuccessor(f.binding));
  });
}

test('interrupted staged recovery fills only missing acknowledgements and preserves activated receipts', async t => {
  const f = await fixture(t, async phase => {
    if (phase === 'successor:effect') throw new Error('lost acknowledgement');
  });
  await assert.rejects(f.native.execute(f.binding));
  assert.equal(f.fence.effect('successor')!.result, null);
  assert.equal(f.fence.effect('operation')!.result, null);
  const before = [...f.calls];
  const restart = new NativeResetRuntime({ ...f.options, checkpoint: undefined });
  await restart.initialize();
  try {
    const completed = await restart.reconcile(f.binding);
    assert.equal(completed.state, 'complete');
    await restart.bootstrapSuccessor(f.binding);
    assert.deepEqual(await restart.reconcile(f.binding), completed);
    assert.equal(f.fence.effect('bootstrap')!.result, null);
  } finally { restart.close(); }
  assert.deepEqual(f.calls, before);
});

for (const intent of ['missing', 'corrupt', 'wrong-binding', 'extra-field']) {
  test(`active successor without exact bootstrap intent refuses receipts: ${intent}`, async t => {
    const f = await fixture(t);
    await f.native.execute(f.binding);
    const operation = f.fence.effect('operation')!.result;
    if (intent !== 'missing') {
      f.fence.intent('bootstrap', intent === 'wrong-binding'
        ? { binding: { ...f.binding, resetOperationId: randomUUID() } }
        : { binding: f.binding, extra: true });
      if (intent === 'corrupt') {
        const db = openResetDatabase(path.join(f.controlRoot, 'generation.sqlite'), 'existing');
        try { db.prepare("UPDATE effects SET intent=? WHERE name='bootstrap'").run('{'); }
        finally { db.close(); }
      }
    }
    const control = new ResetGenerationFence(path.join(f.controlRoot, 'successor-control'), 'existing');
    try { control.activateSuccessor(f.binding); } finally { control.close(); }
    await assert.rejects(f.native.reconcile(f.binding));
    await assert.rejects(f.native.bootstrapSuccessor(f.binding));
    assert.equal((await f.invoke(f.make('reset.receipt'))).body.receipt.evidence.state, 'recovery_required');
    assert.equal(f.fence.effect('operation')!.result, operation);
    if (intent === 'missing') assert.equal(f.fence.effect('bootstrap'), undefined);
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
          /\\/(?:db\\/connection|queue\\/taskQueue|utils\\/logger|extensions\\/extensionProfileStore)\\.(?:ts|js)$/.test(url)) {
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
  // A file-backed module avoids passing --input-type to tsx's loader workers.
  // Keep it in the working directory so the script's relative imports resolve.
  const entry = path.join(process.cwd(), `.native-reset-cold-start-${randomUUID()}.mjs`);
  t.after(() => fs.rm(entry, { force: true }));
  await fs.writeFile(entry, script);
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--experimental-test-module-mocks', entry],
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


for (const action of ['observe', 'revoke'] as const) {
  test(`HTTP reset ${action} enforces byte limit while streaming and cancels overflow`, async t => {
    const f = await fixture(t);
    for (const singleChunk of [false, true]) {
      let reads = 0; let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) { reads++; controller.enqueue(Buffer.alloc(singleChunk ? 16385 : 4096, 32)); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const boundary = new HttpResetBoundary('https://fixture.invalid', () => 'disposable', 'queue',
        (async () => new Response(stream)) as typeof fetch);
      await assert.rejects(boundary[action](f.binding), /fleet_reset_unavailable/);
      assert.equal(cancelled, true);
      assert.equal(reads, singleChunk ? 1 : 5);
      assert.equal(stream.locked, false);
    }
  });
}

test('HTTP reset accepts an exact-limit UTF-8 response split across chunks and rejects broken streams', async t => {
  const f = await fixture(t);
  const observation = { binding: f.binding, revision: 'queue:1', refused: true, remaining: 0, connections: 0, extra: 'é' };
  const json = Buffer.from(JSON.stringify(observation));
  const bytes = Buffer.concat([json, Buffer.alloc(16384 - json.length, 32)]);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) controller.close();
    else controller.enqueue(bytes.subarray(offset, ++offset));
  } });
  const boundary = new HttpResetBoundary('https://fixture.invalid', () => 'disposable', 'queue',
    (async () => new Response(stream)) as typeof fetch);
  assert.deepEqual(await boundary.observe(f.binding), observation);
  assert.equal(stream.locked, false);
  const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('broken transport')); } });
  const failure = new HttpResetBoundary('https://fixture.invalid', () => 'disposable', 'queue',
    (async () => new Response(broken)) as typeof fetch);
  await assert.rejects(failure.observe(f.binding), /broken transport/);
  assert.equal(broken.locked, false);
});

// Deterministic coverage on unprivileged runners: simulate only the kernel's
// mount ID observation, leaving inventory, descriptor traversal and I/O real.
for (const category of FLEET_RESET_CATEGORIES) for (const nested of [false, true]) {
  test(`mount boundary preflight preserves all categories: ${category} ${nested ? 'descendant' : 'root'}`, async t => {
    const f = await fixture(t);
    const target = path.join(f.tenantRoot, category, ...(nested ? ['private'] : []));
    const before = await treeSnapshot(f.tenantRoot);
    const readFile = fs.readFile;
    t.mock.method(fs, 'readFile', async function(file: any, ...args: any[]) {
      const value = await (readFile as any)(file, ...args);
      const fd = /^\/proc\/self\/fdinfo\/(\d+)$/.exec(String(file))?.[1];
      if (fd && await fs.readlink(`/proc/self/fd/${fd}`) === target) return String(value).replace(/^mnt_id:.*$/m, 'mnt_id:\t999999999');
      return value;
    });
    await assert.rejects(f.native.execute(f.binding), /fleet_reset_unavailable/);
    assert.deepEqual(await treeSnapshot(f.tenantRoot), before);
    assert.equal(f.fence.effect('erase-database'), undefined);
  });
}

test('mount introduced after erase intent is refused before deleting category contents', async t => {
  let mounted = false;
  const f = await fixture(t, async phase => { if (phase === 'erase-database:intent') mounted = true; });
  const before = await treeSnapshot(f.tenantRoot);
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async function(file: any, ...args: any[]) {
    const value = await (readFile as any)(file, ...args);
    const fd = /^\/proc\/self\/fdinfo\/(\d+)$/.exec(String(file))?.[1];
    if (mounted && fd && await fs.readlink(`/proc/self/fd/${fd}`) === path.join(f.tenantRoot, 'database')) {
      return String(value).replace(/^mnt_id:.*$/m, 'mnt_id:\t999999999');
    }
    return value;
  });
  await assert.rejects(f.native.execute(f.binding), /fleet_reset_unavailable/);
  assert.equal(f.fence.effect('erase-database')?.result, null);
  assert.deepEqual(await treeSnapshot(f.tenantRoot), before);
});

// Run on Linux CI with CAP_SYS_ADMIN in an isolated mount namespace:
// PROPR_TEST_REQUIRE_MOUNTS=1 unshare --mount --propagation private node --import tsx --test --test-name-pattern='real mounted' packages/core/test/fleetNativeReset.test.ts
for (const kind of ['tmpfs', 'bind-root', 'bind-directory', 'bind-file']) {
  test(`real mounted ${kind} retains external contents before any deletion`, async t => {
    const f = await fixture(t);
    const external = path.join(f.root, 'external'); await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'retained'), 'external retained data');
    const category = path.join(f.tenantRoot, 'repositories_worktrees_caches');
    const target = kind === 'bind-directory' ? path.join(category, 'nested') : kind === 'bind-file' ? path.join(category, 'private') : category;
    if (kind === 'bind-directory') await fs.mkdir(target);
    const run = promisify(execFile);
    try {
      await run('mount', kind === 'tmpfs' ? ['-t', 'tmpfs', 'tmpfs', target] : ['--bind', kind === 'bind-file' ? path.join(external, 'retained') : external, target]);
    } catch (error) {
      if (process.env.PROPR_TEST_REQUIRE_MOUNTS === '1' || !/permission denied|operation not permitted|must be superuser|ENOENT/i.test(String(error))) throw error;
      t.skip('requires Linux mount capability; set PROPR_TEST_REQUIRE_MOUNTS=1 in privileged integration CI'); return;
    }
    try {
      if (kind === 'tmpfs') await fs.writeFile(path.join(target, 'retained'), 'external retained data');
      const before = await treeSnapshot(f.tenantRoot);
      await assert.rejects(f.native.execute(f.binding), /fleet_reset_unavailable/);
      assert.deepEqual(await treeSnapshot(f.tenantRoot), before);
      assert.equal(await fs.readFile(kind === 'bind-file' ? target : path.join(target, 'retained'), 'utf8'), 'external retained data');
      assert.equal(f.fence.effect('erase-database'), undefined);
    } finally { await run('umount', [target]); }
    assert.equal(await fs.readFile(path.join(external, 'retained'), 'utf8'), 'external retained data');
  });
}

test('staged successor boots the actual API, migrates and loads empty application configuration in a fresh process', async t => {
  const f = await fixture(t);
  const completed = (await f.invoke(f.make())).body.receipt.evidence;
  assert.equal(completed.state, 'complete');
  await f.native.bootstrapSuccessor(f.binding);
  const successor = path.join(f.tenantRoot, 'successor');
  const control = path.join(f.controlRoot, 'successor-control');
  // Fleet's replacement launcher supplies process identity after activation.
  await fs.writeFile(path.join(control, 'process-identity.json'), canonicalFleetJson(f.binding.successor), { mode: 0o600 });
  const before = openResetDatabase(path.join(successor, 'propr.sqlite'), 'readonly');
  try { assert.deepEqual(before.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [{ name: 'reset_identity' }]); }
  finally { before.close(); }
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    const binding = JSON.parse(process.env.TEST_RESET_BINDING);
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const log = console.log;
    console.log = (...args) => {
      log(...args);
      if (args.join(' ').includes('Dashboard API server running at')) ready();
    };
    await import('./packages/api/server.ts');
    await started;
    const { db, closeConnection, loadMonitoredReposStrict, getConfig } = await import('@propr/core');
    assert.equal(db.client.config.connection.filename, process.env.DB_FILENAME);
    assert.deepEqual(await loadMonitoredReposStrict(), []);
    assert.deepEqual(await getConfig('repos_to_monitor', []), []);
    assert.deepEqual(JSON.parse(await fs.readFile(process.env.TEST_SUCCESSOR_CONFIG, 'utf8')), {});
    assert.ok((await db('knex_migrations').count('* as count'))[0].count > 0);
    assert.deepEqual(await db('reset_identity').select('identity'), [{ identity: process.env.TEST_SUCCESSOR_IDENTITY }]);
    // These are the durable inputs to task, plan, goal and reindex recovery.
    // A schema-only SQLite check cannot establish that migrations leave them empty.
    for (const table of ['tasks', 'task_history', 'task_drafts', 'plan_issues', 'goals', 'goal_inputs',
      'goal_checkpoints', 'task_submissions', 'repositories', 'github_user_grants', 'visual_preview_oauth_credentials']) {
      assert.equal((await db(table).count('* as count'))[0].count, 0, table);
    }
    const { configuredResetFence } = await import('./packages/core/src/fleet/resetFence.ts');
    const managed = configuredResetFence();
    assert.deepEqual(managed.identity, binding.successor);
    await assert.rejects(managed.fence.use(binding.predecessor, 'future-on-boot', async () => assert.fail('predecessor work executed')));
    // The next boot has no pending migration replay either.
    assert.deepEqual((await db.migrate.list())[1], []);
    await closeConnection();
    console.log('SUCCESSOR_APPLICATION_BOOT_VERIFIED');
    process.exit(0);
  `;
  // Use the API's existing in-memory demo infrastructure: real server startup,
  // routes, SQLite and migrations, without Redis/Docker/provider services. Demo
  // skips execution processors; the durable work inputs are asserted above.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PROPR_FLEET_') || key.startsWith('GITHUB_')) delete env[key];
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), timeout: 180_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    env: { ...env, NODE_ENV: 'production', PROPR_DEMO_MODE: 'true', MCP_ENABLED: 'false',
      PROPR_MIGRATIONS_PREAPPLIED: '', PROPR_API_DISABLE_AUTOSTART: '', DASHBOARD_API_PORT: '0',
      DASHBOARD_API_HOST: '127.0.0.1', FRONTEND_URL: 'http://localhost:3000',
      SESSION_SECRET: 'disposable-successor-session-secret-long-enough-123456789',
      HOME: successor, DATA_DIR: successor, DB_FILENAME: path.join(successor, 'propr.sqlite'),
      PROPR_FLEET_RESET_RUNTIME_ROOT: control, TEST_RESET_BINDING: JSON.stringify(f.binding),
      TEST_SUCCESSOR_CONFIG: path.join(successor, 'config.json'), TEST_SUCCESSOR_IDENTITY: canonicalFleetJson(f.binding.successor) },
  }).catch(error => { throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`); });
  assert.match(result.stdout, /SUCCESSOR_APPLICATION_BOOT_VERIFIED/);
  await fs.writeFile(path.join(successor, 'config.json'), JSON.stringify({ configured: true }));
  await fs.writeFile(path.join(successor, 'application-data'), 'legitimate successor writes');
  const receipt = (await f.invoke(f.make('reset.receipt'))).body.receipt;
  assert.equal(receipt.evidence.state, 'complete');
  assert.equal(receipt.evidence.observationDigest, completed.observationDigest);
  const restarted = new NativeResetRuntime(f.options); await restarted.initialize();
  try { assert.deepEqual(await restarted.reconcile(f.binding), completed); }
  finally { restarted.close(); }
  await f.stopListener();
  await provisionConfigured(t, f);
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    const parts = url.pathname.split('/'); assert.equal(parts.pop(), 'observe');
    const name = parts.pop()!;
    const row = f.remote.prepare('SELECT * FROM service WHERE name=?').get(name);
    return new Response(JSON.stringify({ binding: JSON.parse(row.binding), revision: `${name}:${row.revision}`,
      refused: true, remaining: row.remaining, connections: row.connections }));
  });
  const recovery = await startFleetResetRecovery();
  try {
    const raw = f.make('reset.receipt');
    const response = await new Promise<any>((resolve, reject) => {
      const req = request({ socketPath: recovery.address()!, path: '/reset/v1/invoke', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
        let bytes = ''; res.on('data', chunk => { bytes += chunk; });
        res.on('end', () => resolve(JSON.parse(bytes)));
      }); req.on('error', reject); req.end(raw);
    });
    assert.deepEqual(verifyResetReceipt(response, raw, f.secret).evidence, completed);
  } finally { await recovery.shutdown(); }
});

for (const kind of ['root', 'parent', 'file']) {
  test(`deletion rechecks the pinned ${kind} mount after inventory awaits`, async t => {
    const f = await fixture(t);
    const root = path.join(f.tenantRoot, 'database');
    const directory = path.join(root, 'zz-nested'); await fs.mkdir(directory);
    const file = path.join(directory, 'retained'); await fs.writeFile(file, 'retained');
    const target = kind === 'root' ? root : kind === 'parent' ? directory : file;
    const before = await treeSnapshot(root);
    const readFile = fs.readFile; let observations = 0;
    t.mock.method(fs, 'readFile', async function(name: any, ...args: any[]) {
      const value = await (readFile as any)(name, ...args);
      const fd = /^\/proc\/self\/fdinfo\/(\d+)$/.exec(String(name))?.[1];
      if (fd && await fs.readlink(`/proc/self/fd/${fd}`) === target && ++observations > 3) {
        return String(value).replace(/^mnt_id:.*$/m, 'mnt_id:\t999999999');
      }
      return value;
    });
    await assert.rejects(f.native.execute(f.binding), /fleet_reset_unavailable/);
    assert.equal(observations, 4);
    assert.equal(f.fence.effect('erase-database')?.result, null);
    assert.deepEqual(await treeSnapshot(root), before);
  });
}

test('unavailable mount identity fails closed before deletion', async t => {
  const f = await fixture(t); const before = await treeSnapshot(f.tenantRoot);
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async function(name: any, ...args: any[]) {
    if (String(name).startsWith('/proc/self/fdinfo/')) return 'ino: 1\n';
    return (readFile as any)(name, ...args);
  });
  await assert.rejects(f.native.execute(f.binding), /fleet_reset_unavailable/);
  assert.equal(f.fence.effect('erase-database'), undefined);
  assert.deepEqual(await treeSnapshot(f.tenantRoot), before);
});

test('configured storage leases cover admission, detached descendants and final claim cleanup before native erasure', { timeout: 15_000 }, async t => {
  const { StorageLifecycle } = await import('../src/storage/lifecycle.js');
  const { configuredResetFence } = await import('../src/fleet/resetFence.js');
  const f = await fixture(t);
  await fs.writeFile(path.join(f.controlRoot, 'process-identity.json'), canonicalFleetJson(f.binding.predecessor), { mode: 0o600 });
  const previous = process.env.PROPR_FLEET_RESET_RUNTIME_ROOT;
  process.env.PROPR_FLEET_RESET_RUNTIME_ROOT = f.controlRoot;
  const managed = configuredResetFence()!;
  t.after(() => {
    managed.fence.close();
    if (previous === undefined) delete process.env.PROPR_FLEET_RESET_RUNTIME_ROOT;
    else process.env.PROPR_FLEET_RESET_RUNTIME_ROOT = previous;
  });
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const lifecycle = new StorageLifecycle(path.join(f.tenantRoot, 'repositories_worktrees_caches', 'lifecycle'));
  const admission = deferred();
  const initialize = lifecycle.initialize.bind(lifecycle);
  const initializing = t.mock.method(lifecycle, 'initialize', async () => {
    assert.equal(f.fence.idle(), false, 'admission filesystem work owns a lease');
    await admission.promise;
    await initialize();
  });
  const admitted = lifecycle.use(async () => {});
  assert.equal(f.fence.idle(), false);
  admission.resolve(); await admitted; initializing.mock.restore();
  assert.equal(f.fence.idle(), true);
  await assert.rejects(lifecycle.use(async () => { throw new Error('callback failed'); }), /callback failed/);
  assert.equal(f.fence.idle(), true);
  assert.equal(await lifecycle.busy(), false);

  const write = deferred(); const fail = deferred();
  let child!: Promise<unknown>; let grandchild!: Promise<unknown>;
  const outcome = (promise: Promise<void>) => promise.then(() => undefined, error => error);
  await lifecycle.use(async () => {
    child = outcome(lifecycle.use(async () => {
      grandchild = outcome(lifecycle.use(async () => {
        await write.promise;
        await assert.rejects(lifecycle.use(async () => assert.fail('late admission executed')), /fleet_reset_unavailable/);
        await fs.writeFile(path.join(f.tenantRoot, 'repositories_worktrees_caches', 'late-write'), 'predecessor');
      }));
      await fail.promise;
      throw new Error('nested failed');
    }));
  });
  assert.equal(await lifecycle.busy(), true);
  assert.equal(f.fence.idle(), false, 'returning parent must not release descendant leases');
  const reset = f.native.execute(f.binding);
  // Observe reset reaching the production queue drain, with storage still held.
  while (!f.calls.includes('revoke:queue')) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.fence.effect('erase-database'), undefined);
  assert.equal(f.fence.idle(), false);
  fail.resolve(); assert.match(String(await child), /nested failed/);
  assert.equal(f.fence.idle(), false, 'failed child must not release grandchild lease');

  const cleanup = deferred(); const gateEntered = deferred();
  const gate = lifecycle.exclusive(async () => { gateEntered.resolve(); await cleanup.promise; });
  await gateEntered.promise;
  const cleanupStarted = deferred();
  const exclusive = lifecycle.exclusive.bind(lifecycle);
  t.mock.method(lifecycle, 'exclusive', (...args: Parameters<typeof lifecycle.exclusive>) => {
    cleanupStarted.resolve();
    return exclusive(...args);
  });
  write.resolve();
  // The final release decrements users before waiting for the real filesystem gate.
  await cleanupStarted.promise;
  assert.equal(await lifecycle.busy(), true);
  assert.equal(f.fence.idle(), false, 'claim cleanup must retain its reset lease across awaits');
  assert.equal(f.fence.effect('erase-database'), undefined);
  cleanup.resolve(); await gate;
  assert.match(String(await grandchild), /fleet_reset_unavailable/);
  assert.equal((await reset).state, 'complete');
  assert.equal(f.fence.idle(), true);
  await assert.rejects(fs.stat(lifecycle.root), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.tenantRoot, 'repositories_worktrees_caches', 'late-write')), { code: 'ENOENT' });
});

test('indexed deletion inventory handles repeated ancestor basenames in separate branches', async t => {
  const f = await fixture(t);
  for (const branch of ['left', 'right']) {
    const directory = path.join(f.tenantRoot, 'repositories_worktrees_caches', branch, 'shared', 'nested');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'private'), branch);
  }
  assert.equal((await f.native.execute(f.binding)).state, 'complete');
  await assert.rejects(fs.stat(path.join(f.tenantRoot, 'repositories_worktrees_caches')), { code: 'ENOENT' });
});

test('storage admission waiting on a gate retains its lease and refuses its callback after sealing', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.controlRoot, 'process-identity.json'), canonicalFleetJson(f.binding.predecessor), { mode: 0o600 });
  // Isolate the process-global configured fence from other fixture identities.
  const script = `
    import assert from 'node:assert/strict';
    import { StorageLifecycle } from './packages/core/src/storage/lifecycle.ts';
    import { configuredResetFence } from './packages/core/src/fleet/resetFence.ts';
    const { fence } = configuredResetFence();
    const lifecycle = new StorageLifecycle(process.env.TEST_STORAGE_ROOT);
    let work;
    await lifecycle.exclusive(async () => {
      let entered;
      const waiting = new Promise(resolve => { entered = resolve; });
      const exclusive = lifecycle.exclusive.bind(lifecycle);
      lifecycle.exclusive = (...args) => { entered(); return exclusive(...args); };
      work = assert.rejects(lifecycle.use(async () => assert.fail('sealed callback executed')), /fleet_reset_unavailable/);
      await waiting;
      assert.equal(await lifecycle.busy(), true);
      fence.seal(JSON.parse(process.env.TEST_RESET_BINDING));
      assert.equal(fence.idle(), false);
    });
    await work;
    assert.equal(await lifecycle.busy(), false);
    assert.equal(fence.idle(), true);
    fence.close();
  `;
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    timeout: 15_000, env: { ...process.env, PROPR_FLEET_RESET_RUNTIME_ROOT: f.controlRoot,
      TEST_STORAGE_ROOT: path.join(f.tenantRoot, 'repositories_worktrees_caches', 'lifecycle'), TEST_RESET_BINDING: JSON.stringify(f.binding) },
  });
});

for (const scenario of ['intent-only', 'lost-response', 'awaited-activation', 'second-observation-activation', 'second-observation-activation-with-predecessor', 'awaited-activation-invalid-external']) {
  test(`terminal receipts use durable activation: ${scenario}`, async t => {
    const f = await fixture(t);
    const completedReceipt = (await f.invoke(f.make())).body.receipt;
    const completed = completedReceipt.evidence;
    const activate = async () => {
      f.fence.intent('bootstrap', { binding: f.binding });
      if (scenario !== 'intent-only') {
        const control = new ResetGenerationFence(path.join(f.controlRoot, 'successor-control'), 'existing');
        try { control.activateSuccessor(f.binding); } finally { control.close(); }
      }
      const db = openResetDatabase(path.join(f.tenantRoot, 'successor', 'propr.sqlite'), 'existing');
      try { db.exec('CREATE TABLE customer(value TEXT); INSERT INTO customer VALUES (\'new\');'); } finally { db.close(); }
    };
    if (scenario.includes('activation')) {
      const adapter = f.options.adapters[0]; const observe = adapter.observe.bind(adapter);
      let remaining = scenario.startsWith('second-observation') ? 2 : 1;
      adapter.observe = async binding => {
        const result = await observe(binding);
        if (--remaining === 0) {
          await activate();
          if (scenario.endsWith('with-predecessor')) await fs.mkdir(path.join(f.tenantRoot, 'database'));
        }
        return scenario === 'awaited-activation-invalid-external' ? undefined : result;
      };
    } else await activate();
    if (scenario === 'lost-response') {
      assert.equal(f.fence.effect('bootstrap')!.result, null);
      const restart = new NativeResetRuntime(f.options); await restart.initialize();
      try { assert.deepEqual(await restart.reconcile(f.binding), completed); } finally { restart.close(); }
      for (let i = 0; i < 2; i++) {
        assert.equal((await f.invoke(f.make('reset.receipt'))).body.receipt.evidenceDigest, completedReceipt.evidenceDigest);
      }
    }
    const receipt = (await f.invoke(f.make('reset.receipt'))).body.receipt;
    assert.equal(receipt.evidence.state, ['intent-only', 'awaited-activation-invalid-external', 'second-observation-activation-with-predecessor'].includes(scenario) ? 'recovery_required' : 'complete');
    if (!['intent-only', 'awaited-activation-invalid-external', 'second-observation-activation-with-predecessor'].includes(scenario)) assert.equal(receipt.evidence.observationDigest, completed.observationDigest);
    await assert.rejects(f.native.bootstrapSuccessor(f.binding));
  });
}

for (const tamper of ['identity-file', 'database-identity', 'database-replaced', 'control-identity', 'control-fence', 'control-replaced', 'control-missing', 'predecessor-identity', 'predecessor-data', 'external', 'incomplete-effect', 'incomplete-operation']) {
  test(`activated successor receipt fails closed on ${tamper}`, async t => {
    const f = await fixture(t);
    assert.equal((await f.invoke(f.make())).body.receipt.evidence.state, 'complete'); await f.native.bootstrapSuccessor(f.binding);
    const successor = path.join(f.tenantRoot, 'successor');
    const control = path.join(f.controlRoot, 'successor-control', 'generation.sqlite');
    const mutate = (file: string, sql: string) => { const db = openResetDatabase(file, 'existing'); try { db.exec(sql); } finally { db.close(); } };
    const replace = async (file: string) => { await fs.copyFile(file, file + '.replacement'); await fs.rename(file + '.replacement', file); };
    switch (tamper) {
      case 'identity-file': await fs.writeFile(path.join(successor, 'identity.json'), '{}'); break;
      case 'database-identity': mutate(path.join(successor, 'propr.sqlite'), 'DELETE FROM reset_identity'); break;
      case 'database-replaced': await replace(path.join(successor, 'propr.sqlite')); break;
      case 'control-identity': mutate(control, "UPDATE identity SET identity='{}'"); break;
      case 'control-fence': mutate(control, "UPDATE identity SET fence='{}'"); break;
      case 'control-replaced': await replace(control); break;
      case 'control-missing': await fs.unlink(control); break;
      case 'predecessor-identity': mutate(path.join(f.controlRoot, 'generation.sqlite'), "UPDATE identity SET identity='{}'"); break;
      case 'predecessor-data': await fs.mkdir(path.join(f.tenantRoot, 'database')); break;
      case 'external': f.drift(); break;
      case 'incomplete-effect': mutate(path.join(f.controlRoot, 'generation.sqlite'), "UPDATE effects SET result=NULL WHERE name='erase-database'"); break;
      case 'incomplete-operation': mutate(path.join(f.controlRoot, 'generation.sqlite'), "UPDATE effects SET result=NULL WHERE name='operation'"); break;
    }
    assert.equal((await f.invoke(f.make('reset.receipt'))).body.receipt.evidence.state, 'recovery_required');
  });
}

for (const preapplied of [false, true]) {
  test(`assembled non-demo API reset drains startup leases and resources (launcher migrations: ${preapplied})`, async t => {
    const f = await fixture(t);
    await f.stopListener();
    await f.options.resources.close();
    await fs.writeFile(path.join(f.controlRoot, 'process-identity.json'), canonicalFleetJson(f.binding.predecessor), { mode: 0o600 });
    await fs.writeFile(path.join(f.controlRoot, 'native.json'), JSON.stringify({ binding: f.binding, tenantRoot: f.tenantRoot,
      services: { queue: 'https://queue.invalid', sessions: 'https://sessions.invalid', tunnel_bootstrap: 'https://tunnel.invalid' } }), { mode: 0o600 });
    const dataControl = path.join(f.root, 'fleet-data-control');
    await fs.mkdir(dataControl, { mode: 0o700 });
    await fs.writeFile(path.join(dataControl, 'authority.json'), JSON.stringify({ hostedInstanceId: 'disposable', placementGeneration: 'test', scope: 'hosted_customer_data', secretSha256: resetHash(f.secret) }), { mode: 0o600 });
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import { mock } from 'node:test';
      import { EventEmitter } from 'node:events';
      import { request } from 'node:http';
      const calls = [];
      class Redis extends EventEmitter {
        isOpen = false; status = 'ready';
        constructor() { super(); }
        async connect() { this.isOpen = true; }
        duplicate() { return new Redis(); }
        async quit() { calls.push('redis:quit'); this.isOpen = false; }
        destroy() { calls.push('browser:closed'); this.isOpen = false; }
        disconnect() { this.isOpen = false; }
        async subscribe() {} async unsubscribe() {} async psubscribe() {} async punsubscribe() {}
        async get() { return null; } async set() { return 'OK'; }
        async hgetall() { return {}; } async hget() { return null; }
        async smembers() { return []; } async scan() { return ['0', []]; }
        async keys() { return []; } async publish() { return 0; }
        async del() { return 0; } async eval() { return 0; }
      }
      class Queue extends EventEmitter {
        constructor(name, opts) { super(); this.name = name; this.opts = opts; }
        async setGlobalConcurrency() {}
        async pause() { calls.push(this.name + ':pause'); }
        async drain(delayed) { assert.equal(delayed, true); calls.push(this.name + ':drain'); }
        async close() { calls.push(this.name + ':close'); }
        async getJobs() { return []; } async getJobCounts() { return {}; }
        async getWaitingCount() { return 0; } async getCompletedCount() { return 0; }
        async getFailedCount() { return 0; } async getDelayedCount() { return 0; }
      }
      await mock.module('ioredis/built/Redis.js', { namedExports: { default: Redis } });
      const bull = await import('bullmq');
      await mock.module('bullmq', { namedExports: { ...bull, Queue, QueueEvents: Queue } });
      await mock.module('redis', { namedExports: { createClient: () => new Redis() } });

      // Only the provisioned external service transport is replaced. Native
      // adapters, the API resource closures, listener and SQLite remain real.
      const binding = JSON.parse(process.env.TEST_RESET_BINDING);
      const revoked = new Set();
      globalThis.fetch = async (url, options) => {
        const parsed = new URL(url);
        assert.ok(['queue.invalid', 'sessions.invalid', 'tunnel.invalid'].includes(parsed.hostname), String(url));
        assert.deepEqual(JSON.parse(options.body).binding, binding);
        const [, , , service, action] = parsed.pathname.split('/');
        if (action === 'revoke') { revoked.add(service); calls.push('revoke:' + service); }
        assert.ok(revoked.has(service));
        return new Response(JSON.stringify({ binding, revision: service + ':1', refused: true, remaining: 0, connections: 0 }));
      };
      let releaseSocket, enteredSocket;
      const gate = new Promise(resolve => { releaseSocket = resolve; });
      const entered = new Promise(resolve => { enteredSocket = resolve; });
      const { Server } = await import('socket.io');
      const close = Server.prototype.close;
      Server.prototype.close = function(callback) {
        calls.push('socket:closing'); enteredSocket();
        gate.then(() => close.call(this, error => { calls.push('socket:closed'); callback(error); }));
        return this;
      };
      const core = await import('@propr/core');
      const destroy = core.db.client.destroy.bind(core.db.client);
      core.db.client.destroy = async () => { calls.push('database:closing'); await destroy(); calls.push('database:closed'); };
      let ready;
      const started = new Promise(resolve => { ready = resolve; });
      const log = console.log;
      console.log = (...args) => { log(...args); if (args.join(' ').includes('Dashboard API server running at')) ready(); };
      await import('./packages/api/server.ts');
      await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('API startup timed out')), 30_000))]);
      const { configuredResetFence, openResetDatabase } = await import('./packages/core/src/fleet/resetFence.ts');
      const managed = configuredResetFence();
      const controlDb = openResetDatabase(process.env.PROPR_FLEET_RESET_RUNTIME_ROOT + '/generation.sqlite', 'readonly');
      const leases = () => controlDb.prepare('SELECT * FROM leases').all();
      assert.deepEqual(leases(), [], 'startup must not leak database-query leases');
      assert.ok((await core.db('knex_migrations').count('* as count'))[0].count > 0);
      // Exercise schema, raw, error and nested transaction paths through Knex.
      await core.db.schema.hasTable('system_configs');
      await core.db.transaction(async trx => { await trx.raw('SELECT 1'); await trx.transaction(async nested => nested.raw('SELECT 2')); });
      await assert.rejects(core.db.raw('SELECT * FROM missing_disposable_table'));
      const streamRows = query => new Promise((resolve, reject) => {
        const stream = query.stream(); stream.on('error', reject); stream.on('end', resolve); stream.resume();
      });
      await streamRows(core.db('customer').select('*'));
      await assert.rejects(streamRows(core.db('missing_disposable_table').select('*')));
      assert.deepEqual(leases(), []);
      // A held driver response must retain its own lease, even when another
      // query settles. The original driver and retry implementation still run.
      const client = core.db.client;
      const query = client._query;
      let releaseQuery, enteredQuery, heldConnection;
      const held = new Promise(resolve => { releaseQuery = resolve; });
      const admitted = new Promise(resolve => { enteredQuery = resolve; });
      client._query = async function(connection, obj) {
        const result = await query.call(this, connection, obj);
        if (obj.sql === 'SELECT 987654') { heldConnection = connection; enteredQuery(); await held; }
        return result;
      };
      const active = core.db.raw('SELECT 987654').then(() => undefined);
      await admitted;
      assert.equal(leases().filter(row => row.kind === 'database-query').length, 1);
      await client.query(heldConnection, { sql: 'SELECT 123456' });
      await assert.rejects(client.query(heldConnection, { sql: 'SELECT * FROM missing_disposable_table' }));
      assert.equal(leases().filter(row => row.kind === 'database-query').length, 1, 'other completions cannot release active query');
      releaseQuery(); await active; client._query = query;
      assert.deepEqual(leases(), []);
      const socketPath = process.env.TEST_DATA_CONTROL + '/' + (await fs.readdir(process.env.TEST_DATA_CONTROL)).find(name => name.endsWith('.sock'));
      const invoke = body => new Promise((resolve, reject) => {
        const req = request({ socketPath, path: '/reset/v1/invoke', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
          let bytes = ''; res.on('data', chunk => { bytes += chunk; }); res.on('end', () => resolve(JSON.parse(bytes)));
        }); req.on('error', reject); req.end(body);
      });
      const payload = JSON.parse(process.env.TEST_RESET_REQUEST);
      payload.assertion.issuedAt = Math.floor(Date.now() / 1000); payload.assertion.expiresAt = payload.assertion.issuedAt + 30;
      const { resetRequestMac } = await import('./packages/core/src/fleet/resetProof.ts');
      payload.mac = resetRequestMac(payload.assertion, process.env.PROPR_FLEET_RESET_SECRET);
      const pending = invoke(JSON.stringify(payload));
      await Promise.race([entered, pending.then(result => { throw new Error('reset ended before Socket.IO close: ' + JSON.stringify(result)); }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Socket.IO close not reached: ' + calls.join(','))), 40_000))]);
      // Hold long enough to cross background polling / asynchronous close turns.
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.ok(!calls.includes('database:closing'));
      await fs.stat(process.env.DB_FILENAME);
      const live = openResetDatabase(process.env.DB_FILENAME, 'readonly');
      assert.equal(live.prepare('SELECT count(*) AS n FROM customer').get().n, 1); live.close();
      assert.throws(() => managed.fence.assert(binding.predecessor));
      await assert.rejects(core.db.raw('SELECT 1'), /fleet_reset_unavailable/);
      await assert.rejects(streamRows(core.db('customer').select('*')), /fleet_reset_unavailable/);
      releaseSocket();
      const response = await pending;
      assert.equal(response.receipt.evidence.state, 'complete', JSON.stringify(response));
      const index = name => { assert.ok(calls.includes(name), name + ': ' + calls.join(',')); return calls.indexOf(name); };
      for (const name of ['github-issue-processor', 'agent-runtime-build']) {
        assert.ok(index(name + ':pause') < index(name + ':drain'));
        assert.ok(index(name + ':drain') < index(name + ':close'));
        assert.ok(index(name + ':close') < index('socket:closing'));
      }
      assert.ok(index('socket:closed') < index('browser:closed'));
      assert.ok(index('browser:closed') < index('database:closing'));
      assert.ok(index('database:closing') < index('database:closed'));
      await assert.rejects(fs.stat(process.env.DB_FILENAME), { code: 'ENOENT' });
      assert.deepEqual(await fs.readdir(process.env.TEST_TENANT_ROOT), ['successor']);
      const successor = openResetDatabase(process.env.TEST_TENANT_ROOT + '/successor/propr.sqlite', 'readonly');
      assert.deepEqual(successor.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [{ name: 'reset_identity' }]);
      successor.close(); controlDb.close();
      console.log('ASSEMBLED_RESET_VERIFIED'); process.exit(0);
    `;
    // Workers inherit the same disposable transport injection before importing
    // Core. No Redis connection in any API thread can escape to a real service.
    const preload = path.join(process.cwd(), `.native-reset-transports-${randomUUID()}.mjs`);
    t.after(() => fs.rm(preload, { force: true }));
    const split = script.indexOf('      // Only the provisioned');
    await fs.writeFile(preload, script.slice(0, split) + '\nglobalThis.resetTestCalls = calls;\n');
    const applicationScript = `import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import { request } from 'node:http'; const calls = globalThis.resetTestCalls;\n` + script.slice(split);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('PROPR_FLEET_') || key.startsWith('GITHUB_') || key.startsWith('GH_') || key.startsWith('REDIS_')) delete env[key];
    const childOptions = {
      cwd: process.cwd(), timeout: 180_000, killSignal: 'SIGKILL' as const, maxBuffer: 4 * 1024 * 1024,
      env: { ...env, NODE_ENV: 'production', PROPR_DEMO_MODE: 'false', MCP_ENABLED: 'false', PROPR_ADMIN_USERS: 'disposable',
        PROPR_MIGRATIONS_PREAPPLIED: preapplied ? '1' : '', PROPR_API_DISABLE_AUTOSTART: '', DASHBOARD_API_PORT: '0', DASHBOARD_API_HOST: '127.0.0.1',
        FRONTEND_URL: 'http://localhost:3000', SESSION_SECRET: 'disposable-session-secret-long-enough-123456789',
        PROPR_GH_RELAY_URL: 'https://github-relay.invalid', PROPR_GH_RELAY_TOKEN: 'disposable', GH_OAUTH_CLIENT_ID: 'disposable', GH_OAUTH_CLIENT_SECRET: 'disposable', GH_OAUTH_CALLBACK_URL: 'http://localhost/callback',
        DOCKER_HOST: 'tcp://127.0.0.1:9', REDIS_HOST: '127.0.0.1', REDIS_PORT: '9', REDIS_URL: 'redis://127.0.0.1:9', DASHBOARD_OUTCOME_PROJECTION: 'legacy',
        HOME: path.join(f.tenantRoot, 'provider_sessions'), DATA_DIR: f.root, DB_FILENAME: path.join(f.tenantRoot, 'database', 'propr.sqlite'),
        GIT_CLONES_BASE_PATH: path.join(f.tenantRoot, 'repositories_worktrees_caches', 'clones'), GIT_WORKTREES_BASE_PATH: path.join(f.tenantRoot, 'repositories_worktrees_caches', 'worktrees'),
        PROPR_FLEET_RESET_RUNTIME_ROOT: f.controlRoot, PROPR_FLEET_RESET_SECRET: f.secret, PROPR_FLEET_CONTROL_SECRET: f.secret,
        PROPR_FLEET_RESET_SERVICE_SECRET: 'disposable-external-service-secret-long-enough',
        TEST_RESET_BINDING: JSON.stringify(f.binding), TEST_RESET_REQUEST: f.make(), TEST_DATA_CONTROL: dataControl, TEST_TENANT_ROOT: f.tenantRoot },
    };
    const args = ['--experimental-test-module-mocks', '--import', 'tsx', '--import', preload, '--input-type=module', '-e'];
    const run = (source: string, options = childOptions) => promisify(execFile)(process.execPath, [...args, source], options)
      .catch(error => { throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`); });
    if (preapplied) {
      await run(`const { runMigrations, closeConnection } = await import('@propr/core'); await runMigrations(); await closeConnection(); process.exit(0);`,
        { ...childOptions, env: { ...childOptions.env, PROPR_MIGRATIONS_PREAPPLIED: '' } });
    }
    const result = await run(applicationScript);
    assert.match(result.stdout, /ASSEMBLED_RESET_VERIFIED/);
  });
}


test('activation cannot manufacture an initial completed erasure proof', async t => {
  const f = await fixture(t, async phase => {
    if (phase !== 'first-proof') return;
    const control = new ResetGenerationFence(path.join(f.controlRoot, 'successor-control'), 'existing');
    try { control.activateSuccessor(f.binding); } finally { control.close(); }
  });
  assert.equal((await f.invoke(f.make())).body.receipt.evidence.state, 'recovery_required');
  assert.equal(f.fence.effect('operation')!.result, null);
  assert.equal((await f.invoke(f.make('reset.receipt'))).body.receipt.evidence.state, 'recovery_required');
});
