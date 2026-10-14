import test from 'node:test';
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
    missing: () => { missing = true; }, drift: () => { drift = true; }, remote };
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
