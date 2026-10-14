import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { canonicalFleetJson as canonical } from '../../shared/src/fleetData.js';
import { FLEET_RESET_CONTRACT as contract, FLEET_RESET_AUDIENCE as audience, FLEET_RESET_CATEGORIES, FLEET_RESET_SCHEMA, fleetResetSignedReceiptSchema, type FleetResetAssertion } from '../../shared/src/fleetReset.js';
import { FleetResetProofPlane, resetContractPin as contractPin, resetHash, resetRequestMac, verifyResetReceipt } from '../src/fleet/resetProof.js';
import { listenFleetData, refusePublicFleetData, startConfiguredFleetData } from '../../api/fleetDataListener.js';
import type { FleetDataPlane } from '../src/fleet/dataPlane.js';
import { InstanceStorageService } from '../src/storage/service.js';
import { StorageLifecycle } from '../src/storage/lifecycle.js';
import { verifyReceipt, verifyRequest } from '../../../docs/contracts/fleet-reset-v1/verify.mjs';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-reset-'));
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await fs.rm(root, { recursive: true, force: true }); });
  let secret: string | undefined = 'PRIVATE-RESET-TEST-KEY-NEVER-LOG-THIS-VALUE';
  let now = 1791892800;
  const binding = { resetOperationId: randomUUID(), resetRequestDigest: 'a'.repeat(64), resetAction: 'instance.reset' as const,
    instanceId: 'test-instance', predecessor: { generation: 4, stateScope: 'initial', runtimeId: randomUUID(), storageId: randomUUID() },
    successor: { generation: 5, stateScope: '', runtimeId: randomUUID(), storageId: randomUUID() }, runtimeBuildDigest: 'b'.repeat(64) };
  binding.successor.stateScope = `reset:${binding.resetOperationId}`;
  const authority = { contract, contractPin, audience, binding, secretSha256: resetHash(secret), enabled: true };
  const writeAuthority = () => fs.writeFile(path.join(root, 'authority.json'), JSON.stringify(authority), { mode: 0o600 });
  await writeAuthority();
  const plane = new FleetResetProofPlane(root, () => secret, () => now); await plane.initialize();
  const make = (action: FleetResetAssertion['action'] = 'reset.prove', overrides: Partial<FleetResetAssertion> = {}, signingKey = secret!) => {
    const assertion: FleetResetAssertion = { contract, contractPin, audience, binding, action, requestId: randomUUID(), nonce: randomBytes(32).toString('hex'), issuedAt: now, expiresAt: now + 30, ...overrides };
    return canonical({ assertion, mac: resetRequestMac(assertion, signingKey) });
  };
  return { root, plane, binding, authority, make, writeAuthority, defer: (cleanup: () => Promise<void>) => cleanups.push(cleanup), secret: secret!, now: () => now, advance: (n: number) => { now += n; }, setSecret: (value?: string) => { secret = value; } };
}

test('fixed contract, dedicated authentication, canonical bytes, expiry and pins fail closed', async t => {
  const f = await fixture(t);
  for (const overrides of [
    { contractPin: '0'.repeat(64) }, { audience: 'fleet-data' }, { action: 'shell.execute' },
    { issuedAt: f.now() + 1 }, { expiresAt: f.now() }, { expiresAt: f.now() + 31 },
    { binding: { ...f.binding, instanceId: 'another' } },
    { binding: { ...f.binding, resetRequestDigest: 'c'.repeat(64) } },
    { binding: { ...f.binding, runtimeBuildDigest: 'd'.repeat(64) } },
    { binding: { ...f.binding, predecessor: { ...f.binding.predecessor, stateScope: 'stale' } } },
    { binding: { ...f.binding, successor: { ...f.binding.successor, generation: 6 } } },
    { binding: { ...f.binding, successor: { ...f.binding.successor, runtimeId: f.binding.predecessor.runtimeId } } },
    { binding: { ...f.binding, successor: { ...f.binding.successor, storageId: f.binding.predecessor.storageId } } },
  ]) await assert.rejects(f.plane.invoke(f.make('reset.prove', overrides as any)), /^Error: fleet_reset_unavailable$/);
  const raw = f.make();
  for (const invalid of [raw + '\n', '{"assertion":null,' + raw.slice(1), canonical({ ...JSON.parse(raw), command: 'delete' }), 'x'.repeat(8193), f.make('reset.prove', {}, 'WRONG-EXPORT-OR-CUSTOMER-KEY-NOT-RESET')]) {
    await assert.rejects(f.plane.invoke(invalid), /^Error: fleet_reset_unavailable$/);
  }
  f.setSecret(); await assert.rejects(f.plane.invoke(raw));
  assert.equal((await fs.readdir(f.root)).length, 1, 'auth failures must not consume journal capacity');
});

test('durable refusal, replay and fresh repeatable recovery reads never authorize bootstrap', async t => {
  const f = await fixture(t); const raw = f.make();
  const result = await f.plane.invoke(raw);
  const receipt = verifyResetReceipt(result, raw, f.secret, f.now());
  assert.equal(receipt.evidence.state, 'recovery_required'); assert.equal(receipt.evidence.bootstrapAllowed, false);
  assert.deepEqual(Object.keys(receipt.evidence.categories).sort(), [...FLEET_RESET_CATEGORIES].sort());
  verifyReceipt(result, raw, f.secret, contractPin, f.binding, f.now());
  await assert.rejects(f.plane.invoke(raw)); await assert.rejects(f.plane.invoke(f.make()));
  const newPlane = new FleetResetProofPlane(f.root, () => f.secret, f.now); await newPlane.initialize();
  for (let i = 0; i < 3; i++) {
    const read = f.make('reset.receipt'); const observed = await newPlane.invoke(read);
    const recovered = verifyResetReceipt(observed, read, f.secret, f.now());
    assert.equal(recovered.evidenceDigest, receipt.evidenceDigest); assert.equal(recovered.proofRequestId, receipt.proofRequestId);
    await assert.rejects(newPlane.invoke(read));
  }
  assert.throws(() => verifyResetReceipt(result, f.make('reset.receipt'), f.secret, f.now()));
  f.advance(30); assert.throws(() => verifyResetReceipt(result, raw, f.secret, f.now()));
  const journal = (await Promise.all((await fs.readdir(f.root)).map(name => fs.readFile(path.join(f.root, name), 'utf8')))).join();
  assert.ok(!journal.includes(f.secret)); assert.ok(!JSON.stringify(result).includes(f.secret));
});

test('all categories reject omitted, partial and forged complete evidence, even with a valid MAC', async t => {
  const f = await fixture(t); const raw = f.make(); const original = await f.plane.invoke(raw);
  for (const category of FLEET_RESET_CATEGORIES) for (const status of [undefined, 'erased', 'partial', 'failed']) {
    const result = structuredClone(original);
    if (status === undefined) delete (result.receipt.evidence.categories as any)[category];
    else (result.receipt.evidence.categories as any)[category] = status;
    result.receipt.evidenceDigest = resetHash(canonical(result.receipt.evidence));
    result.mac = createHmac('sha256', f.secret).update(`${contract}.receipt\n`).update(canonical(result.receipt)).digest('hex');
    assert.equal(fleetResetSignedReceiptSchema.safeParse(result).success, false);
    assert.throws(() => verifyResetReceipt(result, raw, f.secret, f.now()));
    assert.throws(() => verifyReceipt(result, raw, f.secret, contractPin, f.binding, f.now()));
  }
  for (const flag of ['predecessorFenced', 'successorIsolated', 'bootstrapAllowed']) {
    const result = structuredClone(original); (result.receipt.evidence as any)[flag] = true;
    assert.throws(() => verifyResetReceipt(result, raw, f.secret, f.now()));
  }
});

test('concurrent proof admission is exclusive and receipt readers observe durable evidence', async t => {
  const f = await fixture(t);
  const second = new FleetResetProofPlane(f.root, () => f.secret, f.now); await second.initialize();
  const results = await Promise.allSettled([f.plane.invoke(f.make()), second.invoke(f.make())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const receipts = await Promise.all(Array.from({ length: 8 }, () => f.plane.invoke(f.make('reset.receipt'))));
  assert.equal(new Set(receipts.map(r => r.receipt.evidenceDigest)).size, 1);
  assert.ok(receipts.every(r => r.receipt.evidence.bootstrapAllowed === false));
});

test('missing/torn/substituted proof stays recovery-required; observed authority ABA permanently fences process', async t => {
  const f = await fixture(t);
  assert.equal((await f.plane.invoke(f.make('reset.receipt'))).receipt.evidence.reason, 'interrupted_or_corrupt');
  await f.plane.invoke(f.make());
  await fs.writeFile(path.join(f.root, `proof-${f.binding.resetOperationId}.json`), '{');
  assert.equal((await f.plane.invoke(f.make('reset.receipt'))).receipt.evidence.reason, 'interrupted_or_corrupt');
  await assert.rejects(f.plane.invoke(f.make()));
  const original = await fs.readFile(path.join(f.root, 'authority.json'));
  f.authority.binding.predecessor.generation = 8;
  await f.writeAuthority(); await assert.rejects(f.plane.invoke(f.make('reset.receipt')));
  await fs.writeFile(path.join(f.root, 'authority.json'), original);
  await assert.rejects(f.plane.invoke(f.make('reset.receipt')));
});

test('pinned canonical fixture corpus and dependency-free reference verifier agree', async () => {
  const root = 'docs/contracts/fleet-reset-v1';
  assert.equal(await fs.readFile(`${root}/schema.json`, 'utf8'), FLEET_RESET_SCHEMA);
  for (const line of (await fs.readFile(`${root}/SHA256SUMS`, 'utf8')).trim().split('\n')) {
    const [hash, name] = line.split('  '); assert.equal(resetHash(await fs.readFile(`${root}/${name}`, 'utf8')), hash);
  }
  const corpus = JSON.parse(await fs.readFile(`${root}/fixtures.json`, 'utf8'));
  for (const f of corpus.fixtures) {
    assert.equal(resetHash(f.request), f.requestSha256); assert.equal(resetHash(f.response), f.responseSha256);
    verifyRequest(f.request, corpus.testSecret, contractPin, corpus.binding, corpus.now);
    verifyResetReceipt(JSON.parse(f.response), f.request, corpus.testSecret, corpus.now);
    verifyReceipt(JSON.parse(f.response), f.request, corpus.testSecret, contractPin, corpus.binding, corpus.now);
  }
});

function http(socketPath: string, body: string, url = '/reset/v1/invoke', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; cache: string | undefined; body: string }>((resolve, reject) => {
    const req = request({ socketPath, path: url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, cache: res.headers['cache-control'], body: data }));
    }); req.on('error', reject); req.end(body);
  });
}

test('real Unix HTTP listener enforces exact path/media/auth and never exposes secrets', async t => {
  const f = await fixture(t);
  // Only export-service dependencies are replaced; the reset plane, private
  // descriptor binder, HTTP parser, authentication and disk journals are real.
  const data = { files: f.plane.files, runtime: async () => ({ runtimeGeneration: randomUUID() }) } as unknown as FleetDataPlane;
  const listener = await listenFleetData(data, undefined, f.plane); f.defer(() => listener.shutdown());
  const socket = listener.address()!;
  const raw = f.make(); const ok = await http(socket, raw);
  assert.equal(ok.status, 200); assert.equal(ok.cache, 'no-store');
  verifyResetReceipt(JSON.parse(ok.body), raw, f.secret, f.now());
  for (const [body, url, headers] of [
    [raw, '/reset/v1/invoke', {}], [f.make(), '/reset/v1/invoke?command=delete', {}],
    [f.make(), '/reset/v1/invoke', { 'content-type': 'text/plain' }],
    [f.make(), '/reset/v1/invoke', { 'content-encoding': 'gzip' }],
    [f.make('reset.receipt', {}, 'WRONG-CUSTOMER-KEY-NOT-RESET-AUTHORITY'), '/reset/v1/invoke', { authorization: `Bearer ${f.secret}`, cookie: `session=${f.secret}` }],
  ] as const) {
    const response = await http(socket, body, url, headers);
    assert.equal(response.status, 403); assert.equal(response.cache, 'no-store');
    assert.ok(!response.body.includes(f.secret)); assert.ok(!response.body.includes(f.root));
  }
  let status = 0; let body: unknown;
  refusePublicFleetData({ path: '/reset/v1/invoke' } as any, { set: () => ({ status: (code: number) => { status = code; return { json: (value: unknown) => { body = value; } }; } }) } as any, () => assert.fail());
  assert.equal(status, 404); assert.deepEqual(body, { error: 'fleet_reset_unavailable' });
});

test('missing credentials, missing/mismatched pins and unsafe authority cannot initialize', async t => {
  const f = await fixture(t);
  for (const secret of [undefined, '', 'short', ` ${f.secret}`]) {
    await assert.rejects(new FleetResetProofPlane(f.root, () => secret, f.now).initialize());
  }
  for (const pin of [undefined, '0'.repeat(64)]) {
    await fs.writeFile(path.join(f.root, 'authority.json'), JSON.stringify({ ...f.authority, contractPin: pin }));
    await assert.rejects(new FleetResetProofPlane(f.root, () => f.secret, f.now).initialize());
  }
  await f.writeAuthority(); await fs.chmod(path.join(f.root, 'authority.json'), 0o644);
  await assert.rejects(new FleetResetProofPlane(f.root, () => f.secret, f.now).initialize());
});

test('credentials and expiry are rechecked after journal IO; errors reveal no private values', async t => {
  const f = await fixture(t);
  const original = f.plane.files.create.bind(f.plane.files);
  f.plane.files.create = async (name, value) => {
    await original(name, value);
    if (name.startsWith('proof-')) f.advance(30);
  };
  await assert.rejects(f.plane.invoke(f.make()), /^Error: fleet_reset_unavailable$/);
  const recovery = await f.plane.invoke(f.make('reset.receipt'));
  assert.equal(recovery.receipt.evidence.state, 'recovery_required');
  f.setSecret('ROTATED-RESET-CREDENTIAL-REQUIRES-NEW-AUTHORITY');
  await assert.rejects(f.plane.invoke(f.make('reset.receipt', {}, f.secret)), /^Error: fleet_reset_unavailable$/);
  f.setSecret(f.secret);
  f.plane.files.read = async () => { throw new Error(`PRIVATE ${f.secret} ${f.root}`); };
  await assert.rejects(f.plane.invoke(f.make('reset.receipt')), /^Error: fleet_reset_unavailable$/);
});

test('absent reset plane refuses the private action even with a valid reset grant', async t => {
  const f = await fixture(t);
  const data = { files: f.plane.files, runtime: async () => ({ runtimeGeneration: randomUUID() }) } as unknown as FleetDataPlane;
  const listener = await listenFleetData(data); f.defer(() => listener.shutdown());
  const response = await http(listener.address()!, f.make());
  assert.equal(response.status, 403); assert.equal(response.cache, 'no-store');
  assert.deepEqual(JSON.parse(response.body), { error: 'fleet_reset_unavailable' });
});

test('configured startup provisions reset only with valid dedicated authority and credentials', async t => {
  // Exercise the production provisioning branch, real storage identity, reset
  // plane and Unix listener. Cases run serially because startup reads process.env.
  for (const scenario of ['absent', 'valid', 'bad-pin', 'malformed', 'unsafe-mode', 'missing-secret', 'wrong-secret', 'export-secret'] as const) {
    await t.test(scenario, async t => {
      const f = await fixture(t);
      const dataDir = path.join(f.root, 'configured');
      const dataRoot = path.join(dataDir, 'fleet-data-control');
      const resetRoot = path.join(dataDir, 'fleet-reset-control');
      await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
      const exportSecret = 'SEPARATE-EXPORT-TEST-KEY-NOT-RESET-AUTHORITY';
      await fs.writeFile(path.join(dataRoot, 'authority.json'), JSON.stringify({
        hostedInstanceId: f.binding.instanceId, placementGeneration: 'placement-1',
        scope: 'hosted_customer_data', secretSha256: resetHash(exportSecret),
      }), { mode: 0o600 });
      if (scenario !== 'absent') {
        await fs.mkdir(resetRoot, { mode: 0o700 });
        await fs.writeFile(path.join(resetRoot, 'authority.json'), scenario === 'malformed' ? '{' : JSON.stringify({
          ...f.authority, ...(scenario === 'bad-pin' ? { contractPin: '0'.repeat(64) } : {}),
        }), { mode: scenario === 'unsafe-mode' ? 0o644 : 0o600 });
      }
      const environment = {
        DATA_DIR: dataDir,
        PROPR_FLEET_CONTROL_SECRET: exportSecret,
        PROPR_FLEET_RESET_SECRET: scenario === 'missing-secret' ? undefined
          : scenario === 'wrong-secret' ? 'WRONG-RESET-TEST-CREDENTIAL-AT-STARTUP'
          : scenario === 'export-secret' ? exportSecret : f.secret,
      };
      const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
      f.defer(async () => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const storage = new InstanceStorageService({
        lifecycle: new StorageLifecycle(path.join(dataDir, 'storage-control')),
        clonesRoot: path.join(dataDir, 'clones'), roots: [], hasPendingTasks: async () => false,
      });
      const start = () => startConfiguredFleetData(storage, async () => ({ role: 'admin', permissions: ['instance.manage_settings'], source: 'local' }));
      if (scenario !== 'absent' && scenario !== 'valid') {
        await assert.rejects(start(), /^Error: Configured Fleet reset authority unavailable$/);
        assert.equal((await fs.readdir(dataRoot)).some(name => name.endsWith('.sock')), false);
        assert.deepEqual(await fs.readdir(resetRoot), ['authority.json']);
        return;
      }
      const listener = await start();
      assert.ok(listener);
      f.defer(() => listener.shutdown());
      const now = Math.floor(Date.now() / 1000);
      const raw = f.make('reset.prove', { issuedAt: now, expiresAt: now + 30 });
      const response = await http(listener.address()!, raw);
      assert.equal(response.cache, 'no-store');
      if (scenario === 'absent') {
        assert.equal(response.status, 403);
        assert.deepEqual(JSON.parse(response.body), { error: 'fleet_reset_unavailable' });
        await assert.rejects(fs.lstat(resetRoot), { code: 'ENOENT' });
      } else {
        assert.equal(response.status, 200);
        const receipt = verifyResetReceipt(JSON.parse(response.body), raw, f.secret);
        assert.deepEqual(receipt.binding, f.binding);
        assert.equal(receipt.proofRequestId, JSON.parse(raw).assertion.requestId);
        assert.equal(receipt.evidence.bootstrapAllowed, false);
        assert.ok((await fs.readdir(resetRoot)).includes(`proof-${f.binding.resetOperationId}.json`));
        const denied = await http(listener.address()!, f.make('reset.receipt', { issuedAt: now, expiresAt: now + 30 }, exportSecret));
        assert.equal(denied.status, 403);
        assert.equal(denied.cache, 'no-store');
      }
      assert.ok(!response.body.includes(f.secret));
      assert.ok(!response.body.includes(exportSecret));
      await listener.shutdown();
      assert.equal((await fs.readdir(dataRoot)).some(name => name.endsWith('.sock')), false);
    });
  }
});
