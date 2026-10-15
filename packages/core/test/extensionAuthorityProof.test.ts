import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { request } from 'node:http';
import knex from 'knex';
import { canonicalFleetJson, EXTENSION_AUTHORITY_CONTRACT, EXTENSION_AUTHORITY_PATH, EXTENSION_AUTHORITY_SCHEMA, EXTENSION_AUTHORITY_LIMITS,
  extensionAuthorityRequestSchema, extensionAuthorityResponseSchema,
  FLEET_EXTENSION_CONTRACT, FLEET_EXTENSION_SCOPE, QUALIFIED_EXTENSION_PIN } from '@propr/shared';
import { up } from '../src/db/migrations/20261015070000_extension_authority_epoch.js';
import { FleetExtensionPlane } from '../src/fleet/extensions.js';
import { FleetDataPlane } from '../src/fleet/dataPlane.js';
import { ExtensionProfileStore } from '../src/extensions/extensionProfileStore.js';
import { ExtensionAuthorityProofPlane, extensionAuthorityPin } from '../src/fleet/extensionAuthorityProof.js';
import { InstanceStorageService } from '../src/storage/service.js';
import { StorageLifecycle } from '../src/storage/lifecycle.js';
import { listenFleetData, refusePublicFleetData } from '../../api/fleetDataListener.js';
import { verifyProof, valid } from '../../../docs/contracts/extension-authority-v1/verifier.mjs';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = 'SENTINEL-TRANSPORT-SECRET-NEVER-IN-PROOF';
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-proof-'));
  let db = knex({ client: 'better-sqlite3', connection: { filename: path.join(root, 'db.sqlite') }, useNullAsDefault: true });
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await db.destroy(); await fs.rm(root, { recursive: true, force: true }); });
  await db.schema.createTable('instance_members', tb => { tb.text('github_user_id').primary(); tb.text('role'); tb.text('source'); });
  await db.schema.createTable('extension_instance_identity', tb => { tb.integer('id').primary(); tb.text('instance_id'); });
  await db('extension_instance_identity').insert({ id: 1, instance_id: randomUUID() });
  await up(db);
  await db('instance_members').insert({ github_user_id: '100', role: 'admin', source: 'local' });
  const control = path.join(root, 'fleet'); await fs.mkdir(control, { mode: 0o700 });
  const authority = { hostedInstanceId: 'synthetic', placementGeneration: 'placement-1', scope: 'hosted_customer_data', secretSha256: hash(secret) };
  await fs.writeFile(path.join(control, 'authority.json'), JSON.stringify(authority), { mode: 0o600 });
  const writeKey = async () => {
    const key = generateKeyPairSync('ed25519');
    await fs.writeFile(path.join(control, 'native-authority-key.pem'), key.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  };
  await writeKey();
  const storage = new InstanceStorageService({ lifecycle: new StorageLifecycle(path.join(root, 'storage')), clonesRoot: root, roots: [], hasPendingTasks: async () => false });
  await storage.initialize();
  let hook: (() => Promise<void>) | undefined;
  const fleet = new FleetDataPlane(storage, control, () => secret, async id => {
    await hook?.();
    const row = await db('instance_members').where({ github_user_id: String(id) }).first();
    return { role: row?.role, source: row?.source, permissions: row?.role === 'admin' ? ['instance.manage_settings'] : [] };
  });
  await fleet.initialize();
  let extensions = new FleetExtensionPlane(fleet, new ExtensionProfileStore(db));
  let plane = new ExtensionAuthorityProofPlane(extensions);
  t.after(() => { extensions.shutdown(); plane.shutdown(); });
  const runtime = await fleet.runtime();
  const base = { contract: EXTENSION_AUTHORITY_CONTRACT, contractPin: extensionAuthorityPin,
    extension: { contract: FLEET_EXTENSION_CONTRACT, contractPin: QUALIFIED_EXTENSION_PIN, scope: FLEET_EXTENSION_SCOPE,
      hostedInstanceId: runtime.hostedInstanceId, storageInstanceId: runtime.storageInstanceId, runtimeGeneration: runtime.runtimeGeneration,
      storageGeneration: runtime.storageGeneration, placementGeneration: runtime.placementGeneration, githubActorId: 100,
      action: 'profile.list', requestDigest: hash(canonicalFleetJson({ action: 'profile.list' })), operationId: randomUUID() },
    extensionInstanceId: await extensions.store.instanceId(), workDigest: hash('OPAQUE-ORIGINAL-WORK'), acquisitionOperationId: null,
    phase: 'request', challenge: randomBytes(32).toString('hex'), authorityEpoch: null,
    issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 30 };
  const fresh = (changes = {}) => ({ ...structuredClone(base), challenge: randomBytes(32).toString('hex'), ...changes });
  const raw = (r: any) => canonicalFleetJson({ request: r, mac: createHmac('sha256', secret).update(canonicalFleetJson(r)).digest('hex') });
  const invoke = (r: any) => plane.invoke(raw(r));
  const epoch = async () => String((await db('native_authority_epoch').first()).epoch);
  return { cleanup, root, control, authority, storage, fleet, get db() { return db; }, get extensions() { return extensions; }, get plane() { return plane; }, base, fresh, raw, invoke, epoch, writeKey,
    hook: (h?: () => Promise<void>) => { hook = h; },
    restart: async () => { extensions.shutdown(); plane.shutdown(); await db.destroy(); db = knex({ client: 'better-sqlite3', connection: { filename: path.join(root, 'db.sqlite') }, useNullAsDefault: true }); extensions = new FleetExtensionPlane(fleet, new ExtensionProfileStore(db)); plane = new ExtensionAuthorityProofPlane(extensions); },
    record: async (r: any, state = 'completed') => { const record = { assertion: r.extension, operationId: r.extension.operationId, state }; await fleet.files.create(`extension-operation-${r.extension.operationId}.json`, { ...record, recordDigest: hash(canonicalFleetJson(record)) }); },
  };
}
test('durable local admin: four phases, exact reciprocal verifier, replay and sentinel protection', async t => {
  const f = await fixture(t); const r = f.fresh(); const pin = f.plane.verificationKey();
  const response = await f.invoke(r); const consumed = new Set();
  assert.equal(verifyProof(response, r, pin, Date.now(), consumed).source, 'local');
  assert.throws(() => verifyProof(response, r, pin, Date.now(), consumed), /unavailable/);
  await assert.rejects(f.invoke(r), /unavailable/);
  const epoch = response.statement.authorityEpoch;
  await f.invoke(f.fresh({ phase: 'dispatch', authorityEpoch: epoch }));
  await assert.rejects(f.invoke(f.fresh({ phase: 'dispatch', authorityEpoch: epoch })), /unavailable/);
  await f.record(r);
  for (const phase of ['status', 'completion']) {
    const next = f.fresh({ phase, authorityEpoch: epoch });
    verifyProof(await f.invoke(next), next, pin, Date.now(), new Set());
  }
  await assert.rejects(f.invoke(f.fresh({ phase: 'completion', authorityEpoch: epoch })), /unavailable/);
  const serialized = JSON.stringify(response);
  for (const sentinel of [secret, 'PRIVATE KEY', 'OPAQUE-ORIGINAL-WORK', 'SENTINEL-CUSTOMER']) assert.ok(!serialized.includes(sentinel));
  assert.equal(response.statement.connectAuthorityVerified, false);
});
test('rejects absent, unrelated, member, managed and revoked durable actors', async t => {
  for (const row of [null, { role: 'member', source: 'local' }, { role: 'admin', source: 'managed' }]) {
    const f = await fixture(t);
    await f.db('instance_members').delete();
    if (row) await f.db('instance_members').insert({ github_user_id: '100', ...row });
    await assert.rejects(f.invoke(f.fresh()), /unavailable/);
    await assert.rejects(f.invoke(f.fresh({ extension: { ...f.base.extension, githubActorId: 200 } })), /unavailable/);
  }
});
test('epochs cover grants, role/source changes, deletion/regrant ABA, rollback and restart', async t => {
  const f = await fixture(t); const response = await f.invoke(f.fresh());
  let previous = Number(await f.epoch());
  for (const change of [{ role: 'member' }, { role: 'admin' }, { source: 'managed' }, { source: 'local' }]) {
    await f.db('instance_members').update(change); assert.equal(Number(await f.epoch()), ++previous);
  }
  await assert.rejects(f.db.transaction(async trx => { await trx('instance_members').delete(); throw Error('rollback'); }));
  assert.equal(Number(await f.epoch()), previous);
  await f.db('instance_members').delete(); assert.equal(Number(await f.epoch()), ++previous);
  await f.db('instance_members').insert({ github_user_id: '100', role: 'admin', source: 'local' }); assert.equal(Number(await f.epoch()), ++previous);
  await assert.rejects(f.invoke(f.fresh({ phase: 'dispatch', authorityEpoch: response.statement.authorityEpoch })), /unavailable/);
  await f.restart(); assert.equal(Number(await f.epoch()), previous);
  await assert.rejects(f.invoke(f.fresh()), /unavailable/); // Durable operation commitment survives.
  await f.invoke(f.fresh({ extension: { ...f.base.extension, operationId: randomUUID() } }));
});
test('every identity/generation and commitment substitution refuses', async t => {
  const f = await fixture(t); const initial = await f.invoke(f.fresh()); const epoch = initial.statement.authorityEpoch;
  for (const field of ['hostedInstanceId', 'placementGeneration', 'storageInstanceId', 'runtimeGeneration', 'storageGeneration', 'operationId', 'requestDigest', 'action', 'githubActorId', 'contractPin']) {
    const value = field === 'action' ? 'catalog.list' : field === 'githubActorId' ? 200 : field.includes('Digest') || field === 'contractPin' ? 'b'.repeat(64) : randomUUID();
    await assert.rejects(f.invoke(f.fresh({ phase: 'dispatch', authorityEpoch: epoch, extension: { ...f.base.extension, [field]: value } })), /unavailable/, field);
  }
  for (const changes of [{ workDigest: 'c'.repeat(64) }, { acquisitionOperationId: randomUUID() }, { extensionInstanceId: randomUUID() }, { authorityEpoch: '999' }, { contractPin: 'a'.repeat(64) }]) {
    await assert.rejects(f.invoke(f.fresh({ phase: 'dispatch', authorityEpoch: epoch, ...changes })), /unavailable/);
  }
});
test('authority and generation loss across awaited authorization, ABA and clock boundaries', async t => {
  for (const kind of ['delete', 'aba', 'identity', 'placement', 'expiry']) {
    const f = await fixture(t); let done = false;
    const realNow = Date.now; const now = realNow();
    f.hook(async () => {
      if (done) return; done = true;
      if (kind === 'delete' || kind === 'aba') await f.db('instance_members').delete();
      if (kind === 'aba') await f.db('instance_members').insert({ github_user_id: '100', role: 'admin', source: 'local' });
      if (kind === 'identity') await f.db('extension_instance_identity').update({ instance_id: randomUUID() });
      if (kind === 'placement') await fs.writeFile(path.join(f.control, 'authority.json'), JSON.stringify({ ...f.authority, placementGeneration: 'replaced' }));
      if (kind === 'expiry') Date.now = () => now + 31_000;
    });
    try { await assert.rejects(f.invoke(f.fresh()), /unavailable/, kind); } finally { Date.now = realNow; }
  }
  const f = await fixture(t); const realNow = Date.now; const r = f.fresh();
  try {
    Date.now = () => r.issuedAt * 1000 - 1; await assert.rejects(f.invoke(r), /unavailable/);
    Date.now = () => r.expiresAt * 1000; await assert.rejects(f.invoke(r), /unavailable/);
    Date.now = () => r.expiresAt * 1000 - 1; await f.invoke(r);
  } finally { Date.now = realNow; }
});
test('ambiguous native tombstone forbids dispatch; fenced result forbids completion', async t => {
  for (const phase of ['dispatch', 'completion']) {
    const f = await fixture(t); const r = f.fresh(); const epoch = (await f.invoke(r)).statement.authorityEpoch;
    if (phase === 'completion') await f.invoke(f.fresh({ phase: 'dispatch', authorityEpoch: epoch }));
    await f.record(r, 'fenced');
    await assert.rejects(f.invoke(f.fresh({ phase, authorityEpoch: epoch })), /unavailable/);
    if (phase === 'completion') await f.invoke(f.fresh({ phase: 'status', authorityEpoch: epoch }));
  }
});
test('independent key pin, rotation, missing key, strict inputs and cross-phase challenge replay', async t => {
  const f = await fixture(t); const r = f.fresh(); const pin = f.plane.verificationKey(); const reply = await f.invoke(r);
  await f.writeKey(); const replacement = f.plane.verificationKey();
  assert.throws(() => verifyProof(reply, r, replacement, Date.now(), new Set()), /unavailable/);
  assert.throws(() => verifyProof(reply, r, '', Date.now(), new Set()), /unavailable/);
  assert.throws(() => verifyProof({ ...reply, signature: 'a'.repeat(86) }, r, pin, Date.now(), new Set()), /unavailable/);
  await assert.rejects(f.invoke({ ...r, phase: 'dispatch', authorityEpoch: reply.statement.authorityEpoch }), /unavailable/);
  const next = f.fresh({ phase: 'dispatch', authorityEpoch: reply.statement.authorityEpoch }); const signed = await f.invoke(next);
  assert.throws(() => verifyProof(signed, next, pin, Date.now(), new Set()), /unavailable/);
  verifyProof(signed, next, replacement, Date.now(), new Set());
  for (const input of ['{}', '{', f.raw({ ...r, profile: 'SENTINEL-CUSTOMER' }), f.raw({ ...r, role: 'admin' }), f.raw(r) + ' ', 'a'.repeat(8193)]) await assert.rejects(f.plane.invoke(input), /^Error: extension_authority_unavailable$/);
  await fs.unlink(path.join(f.control, 'native-authority-key.pem'));
  await assert.rejects(f.invoke(f.fresh()), /unavailable/);
});
test('real private Unix listener and explicit public/tunnel refusal', async t => {
  const f = await fixture(t); const listener = await listenFleetData(f.fleet, f.extensions); f.cleanup.push(() => listener.shutdown());
  const send = (raw: string, url: string = EXTENSION_AUTHORITY_PATH) => new Promise<any>((resolve, reject) => {
    const req = request({ socketPath: listener.address()!, path: url, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => {
        if (url === EXTENSION_AUTHORITY_PATH && res.statusCode === 200) assert.equal(body, canonicalFleetJson(JSON.parse(body)));
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
      });
    }); req.on('error', reject); req.end(raw);
  });
  const r = f.fresh(); const result = await send(f.raw(r)); assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
  verifyProof(result.body, r, f.plane.verificationKey(), Date.now(), new Set());
  assert.deepEqual((await send(f.raw(r))).body, { error: 'extension_authority_unavailable' });
  // Exercise actual immutable native dispatch and its real operation journal,
  // then obtain status/completion evidence through the separate Unix path.
  const nativeRequest = { action: 'catalog.list' };
  const work = f.fresh({ extension: { ...r.extension, operationId: randomUUID(), action: nativeRequest.action,
    requestDigest: hash(canonicalFleetJson(nativeRequest)) } });
  const accepted = await send(f.raw(work)); assert.equal(accepted.status, 200);
  const epoch = accepted.body.statement.authorityEpoch;
  const phase = (name: string) => ({ ...work, phase: name, authorityEpoch: epoch, challenge: randomBytes(32).toString('hex') });
  assert.equal((await send(f.raw(phase('dispatch')))).status, 200);
  const assertion = { ...work.extension, issuedAt: work.issuedAt, expiresAt: work.expiresAt, nonce: randomBytes(32).toString('hex') };
  const native = await send(canonicalFleetJson({ assertion, request: nativeRequest,
    mac: createHmac('sha256', secret).update(canonicalFleetJson(assertion)).digest('hex') }), '/extensions/v1/invoke');
  assert.equal(native.status, 200); assert.equal(native.body.state, 'completed');
  for (const name of ['status', 'completion']) {
    const expected = phase(name); const proof = await send(f.raw(expected)); assert.equal(proof.status, 200);
    verifyProof(proof.body, expected, f.plane.verificationKey(), Date.now(), new Set());
  }
  let status; let body; let cache;
  const res: any = { set: (_: string, value: string) => { cache = value; return res; }, status: (value: number) => { status = value; return res; }, json: (value: unknown) => { body = value; } };
  refusePublicFleetData({ path: EXTENSION_AUTHORITY_PATH } as any, res, () => assert.fail('public route escaped'));
  assert.equal(status, 404); assert.equal(cache, 'no-store'); assert.deepEqual(body, { error: 'extension_authority_unavailable' });
});
test('published exact schema, source pins, checksums and reciprocal canonical fixture', async () => {
  const root = 'docs/contracts/extension-authority-v1/';
  assert.equal(await fs.readFile(root + 'schema.json', 'utf8'), EXTENSION_AUTHORITY_SCHEMA);
  for (const line of (await fs.readFile(root + 'SHA256SUMS', 'utf8')).trim().split('\n')) {
    const [checksum, name] = line.split('  '); assert.equal(hash(await fs.readFile(root + name, 'utf8')), checksum, name);
  }
  const fixture = JSON.parse(await fs.readFile(root + 'fixtures.json', 'utf8'));
  verifyProof(fixture.response, fixture.request, fixture.publicKeyPin, fixture.nowMs, new Set());
  for (const phase of fixture.phases) {
    const envelope = JSON.parse(phase.requestCanonical);
    assert.equal(canonicalFleetJson(envelope), phase.requestCanonical);
    assert.equal(createHmac('sha256', fixture.testSecret).update(canonicalFleetJson(envelope.request)).digest('hex'), envelope.mac);
    verifyProof(JSON.parse(phase.responseCanonical), envelope.request, fixture.publicKeyPin, fixture.nowMs, new Set());
  }
  const pins = JSON.parse(await fs.readFile(root + 'source-pins.json', 'utf8'));
  for (const [file, checksum] of Object.entries(pins)) assert.equal(hash(await fs.readFile(file, 'utf8')), checksum, file);
});
test('concurrent duplicate challenge admits exactly one response and restart retains replay fence', async t => {
  const f = await fixture(t); const r = f.fresh();
  const results = await Promise.allSettled([f.invoke(r), f.invoke(r)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await f.restart();
  await assert.rejects(f.invoke(f.fresh({ challenge: r.challenge, extension: { ...r.extension, operationId: randomUUID() } })), /unavailable/);
});
test('completion refuses authority loss or substitution after its awaited pre-check', async t => {
  for (const kind of ['revoke', 'aba', 'extension', 'runtime', 'storage', 'placement', 'key']) {
    const f = await fixture(t); const r = f.fresh(); const epoch = (await f.invoke(r)).statement.authorityEpoch;
    await f.invoke(f.fresh({ phase: 'dispatch', authorityEpoch: epoch })); await f.record(r);
    const original = f.fleet.extensionAuthority.bind(f.fleet);
    f.fleet.extensionAuthority = async a => {
      const secret = await original(a);
      if (kind === 'revoke' || kind === 'aba') await f.db('instance_members').delete();
      if (kind === 'aba') await f.db('instance_members').insert({ github_user_id: '100', role: 'admin', source: 'local' });
      if (kind === 'extension') await f.db('extension_instance_identity').update({ instance_id: randomUUID() });
      if (kind === 'runtime') (f.storage as any).generation = randomUUID();
      if (kind === 'storage') await fs.writeFile(path.join(f.root, 'storage', 'instance.json'), JSON.stringify(randomUUID()));
      if (kind === 'placement') await fs.writeFile(path.join(f.control, 'authority.json'), JSON.stringify({ ...f.authority, placementGeneration: 'replacement' }));
      if (kind === 'key') await f.writeKey();
      return secret;
    };
    await assert.rejects(f.invoke(f.fresh({ phase: 'completion', authorityEpoch: epoch })), /unavailable/, kind);
    assert.equal(JSON.parse((await f.fleet.files.read(`extension-operation-${r.extension.operationId}.json`)).trim()).state, 'completed');
  }
});
test('native-only unauthenticated transport and current permission denial fail closed', async t => {
  const f = await fixture(t); const envelope = JSON.parse(f.raw(f.fresh())); envelope.mac = '0'.repeat(64);
  await assert.rejects(f.plane.invoke(canonicalFleetJson(envelope)), /unavailable/);
  f.fleet.extensionAuthority = async () => { throw Error('SENTINEL-PERMISSION-DENIED'); };
  await assert.rejects(f.invoke(f.fresh()), /^Error: extension_authority_unavailable$/);
});
test('acquisition proof binds a completed recipient operation and refuses substitution', async t => {
  const f = await fixture(t); const acquisition = randomUUID();
  const acquireRequest = f.fresh({ extension: { ...f.base.extension, operationId: acquisition, action: 'recipient.issue' } });
  await f.record(acquireRequest);
  const r = f.fresh({ acquisitionOperationId: acquisition }); const epoch = (await f.invoke(r)).statement.authorityEpoch;
  await assert.rejects(f.invoke({ ...r, phase: 'dispatch', authorityEpoch: epoch, challenge: randomBytes(32).toString('hex'), acquisitionOperationId: randomUUID() }), /unavailable/);
  await f.invoke({ ...r, phase: 'dispatch', authorityEpoch: epoch, challenge: randomBytes(32).toString('hex') });
});
test('proof emission holds writer barrier with FULL durability and restores pool policy', async t => {
  const f = await fixture(t);
  const conn = await f.db.client.acquireConnection(); conn.pragma('synchronous = NORMAL'); await f.db.client.releaseConnection(conn);
  let delivered = false;
  await f.plane.invoke(f.raw(f.fresh()), () => {
    delivered = true;
    assert.equal(conn.pragma('synchronous', { simple: true }), 2);
    assert.equal(conn.inTransaction, true);
  });
  assert.equal(delivered, true);
  assert.equal(conn.pragma('synchronous', { simple: true }), 1);
  assert.equal(conn.inTransaction, false);
});
test('configured native reset generation fencing also refuses authority proof', async t => {
  const f = await fixture(t);
  const { ResetGenerationFence, configuredResetFence } = await import('../src/fleet/resetFence.js');
  const root = path.join(f.root, 'reset'); await fs.mkdir(root, { mode: 0o700 });
  const identity = { generation: 1, stateScope: 'initial', runtimeId: randomUUID(), storageId: randomUUID() };
  const fence = new ResetGenerationFence(root); fence.provision(identity);
  await fs.writeFile(path.join(root, 'process-identity.json'), JSON.stringify(identity), { mode: 0o600 });
  const old = process.env.PROPR_FLEET_RESET_RUNTIME_ROOT;
  process.env.PROPR_FLEET_RESET_RUNTIME_ROOT = root;
  try {
    await f.invoke(f.fresh());
    const resetOperationId = randomUUID();
    fence.seal({ resetOperationId, resetRequestDigest: 'a'.repeat(64), resetAction: 'instance.reset', instanceId: 'synthetic',
      runtimeBuildDigest: 'b'.repeat(64), predecessor: identity,
      successor: { generation: 2, stateScope: `reset:${resetOperationId}`, runtimeId: randomUUID(), storageId: randomUUID() } });
    await assert.rejects(f.invoke(f.fresh({ extension: { ...f.base.extension, operationId: randomUUID() } })), /unavailable/);
  } finally {
    configuredResetFence()?.fence.close(); fence.close();
    if (old === undefined) delete process.env.PROPR_FLEET_RESET_RUNTIME_ROOT; else process.env.PROPR_FLEET_RESET_RUNTIME_ROOT = old;
  }
});

test('every published UUID field agrees with native schemas and signed proof verification', async () => {
  const bundle = JSON.parse(EXTENSION_AUTHORITY_SCHEMA);
  const fixture = JSON.parse(await fs.readFile('docs/contracts/extension-authority-v1/fixtures.json', 'utf8'));
  const paths: string[][] = [];
  const visit = (schema: any, path: string[] = []) => {
    if (schema.format === 'uuid') { assert.equal(typeof schema.pattern, 'string'); paths.push(path); }
    for (const [key, child] of Object.entries(schema.properties ?? {})) visit(child, [...path, key]);
    for (const child of schema.anyOf ?? []) visit(child, path);
  };
  visit(bundle.envelope.properties.request);
  assert.ok(paths.some(path => path.join('.') === 'extension.operationId'));
  assert.ok(paths.some(path => path.join('.') === 'extensionInstanceId'));
  assert.ok(paths.some(path => path.join('.') === 'acquisitionOperationId'));
  const key = generateKeyPairSync('ed25519');
  const pin = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const cases: Array<[string, boolean]> = [
    ['00000000-0000-0000-0000-000000000000', true],
    ['ffffffff-ffff-ffff-ffff-ffffffffffff', true],
    ['FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', false],
    ...Array.from({ length: 8 }, (_, i): [string, boolean] => [`12345678-abcd-${i + 1}123-8123-123456789abc`, true]),
    ['12345678-ABCD-4123-B123-123456789ABC', true],
    ['12345678-abcd-0123-8123-123456789abc', false],
    ['12345678-abcd-9123-8123-123456789abc', false],
    ['12345678-abcd-4123-7123-123456789abc', false],
    ['00000000-0000-0000-0000-000000000001', false],
    ['ffffffff-ffff-ffff-ffff-fffffffffffe', false],
    ['12345678-abcd-4123-8123-123456789abg', false],
    ['12345678abcd41238123123456789abc', false],
    ['', false],
  ];
  for (const path of paths) for (const [value, accepted] of cases) {
    const request = structuredClone(fixture.request);
    let parent = request;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)!] = value;
    const statement = { ...fixture.response.statement, request, requestCommitment: hash(canonicalFleetJson(request)) };
    const response = { statement, signature: sign(null, Buffer.from(canonicalFleetJson(statement)), key.privateKey).toString('base64url') };
    const label = `${path.join('.')}=${value}`;
    assert.equal(extensionAuthorityRequestSchema.safeParse(request).success, accepted, label);
    assert.equal(extensionAuthorityResponseSchema.safeParse(response).success, accepted, label);
    assert.equal(valid(bundle.envelope.properties.request, request), accepted, label);
    assert.equal(valid(bundle.response, response), accepted, label);
    const consumed = new Set();
    if (accepted) {
      assert.deepEqual(verifyProof(response, request, pin, fixture.nowMs, consumed), statement, label);
      assert.ok(consumed.has(request.challenge));
    } else {
      assert.throws(() => verifyProof(response, request, pin, fixture.nowMs, consumed), /unavailable/, label);
      assert.equal(consumed.size, 0);
    }
  }
});
test('native sentinel operation IDs produce verifiable proofs', async t => {
  const f = await fixture(t);
  for (const operationId of ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
    const r = f.fresh({ extension: { ...f.base.extension, operationId } });
    verifyProof(await f.invoke(r), r, f.plane.verificationKey(), Date.now(), new Set());
  }
});
test('challenge ledger admits its last slot and refuses further admissions at capacity after restart', async t => {
  const f = await fixture(t);
  // Seed historical tombstones in one transaction without changing the production cap.
  await f.db.raw(`WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n < ?)
    INSERT INTO extension_authority_challenges(challenge) SELECT printf('%064x', n) FROM entries`, [EXTENSION_AUTHORITY_LIMITS.challenges - 1]);
  const r = f.fresh(); const reply = await f.invoke(r);
  verifyProof(reply, r, f.plane.verificationKey(), Date.now(), new Set());
  const count = async (table: string) => Number((await f.db(table).count('* as n').first())!.n);
  assert.equal(await count('extension_authority_challenges'), EXTENSION_AUTHORITY_LIMITS.challenges);
  for (const restart of [false, true]) {
    if (restart) await f.restart();
    const next = f.fresh({ extension: { ...r.extension, operationId: randomUUID() } });
    await assert.rejects(f.invoke(next), /unavailable/);
    await assert.rejects(f.invoke(f.fresh({ phase: 'dispatch', authorityEpoch: reply.statement.authorityEpoch })), /unavailable/);
    assert.equal(await count('extension_authority_challenges'), EXTENSION_AUTHORITY_LIMITS.challenges);
    assert.equal(await count('extension_authority_operations'), 1);
    assert.equal(await f.db('extension_authority_challenges').where({ challenge: next.challenge }).first(), undefined);
    assert.equal((await f.db('extension_authority_operations').where({ operation_id: r.extension.operationId }).first()).dispatched, 0);
    assert.ok(await f.db('extension_authority_challenges').where({ challenge: r.challenge }).first());
  }
});
test('operation ledger admits its last slot, retains refusals across restart, and permits admitted phases', async t => {
  const f = await fixture(t);
  await f.db.raw(`WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n < ?)
    INSERT INTO extension_authority_operations(operation_id, commitment, epoch, dispatched, completed)
    SELECT printf('00000000-0000-4000-8000-%012x', n), ?, ?, 1, 1 FROM entries`,
  [EXTENSION_AUTHORITY_LIMITS.operations - 1, 'a'.repeat(64), await f.epoch()]);
  const r = f.fresh(); const reply = await f.invoke(r); const epoch = reply.statement.authorityEpoch;
  verifyProof(reply, r, f.plane.verificationKey(), Date.now(), new Set());
  const count = async () => Number((await f.db('extension_authority_operations').count('* as n').first())!.n);
  assert.equal(await count(), EXTENSION_AUTHORITY_LIMITS.operations);
  const refused: string[] = [];
  for (const restart of [false, true]) {
    if (restart) await f.restart();
    const next = f.fresh({ extension: { ...r.extension, operationId: randomUUID() } });
    await assert.rejects(f.invoke(next), /unavailable/);
    refused.push(next.challenge);
    assert.equal(await count(), EXTENSION_AUTHORITY_LIMITS.operations);
    assert.equal(await f.db('extension_authority_operations').where({ operation_id: next.extension.operationId }).first(), undefined);
    // The independent challenge transaction remains durable even when operation admission fails.
    for (const challenge of refused) assert.ok(await f.db('extension_authority_challenges').where({ challenge }).first());
  }
  for (const phase of ['dispatch', 'status', 'completion']) {
    if (phase === 'status') await f.record(r);
    const next = f.fresh({ phase, authorityEpoch: epoch });
    verifyProof(await f.invoke(next), next, f.plane.verificationKey(), Date.now(), new Set());
  }
  assert.equal(await count(), EXTENSION_AUTHORITY_LIMITS.operations);
  assert.equal((await f.db('extension_authority_operations').where({ operation_id: r.extension.operationId }).first()).completed, 1);
  await f.restart();
  await assert.rejects(f.invoke(f.fresh({ extension: { ...r.extension, operationId: randomUUID() } })), /unavailable/);
  assert.equal(await count(), EXTENSION_AUTHORITY_LIMITS.operations);
});

test('commit and delivery faults preserve exactly the durable admissions across restart', async t => {
  for (const phase of ['request', 'dispatch', 'status', 'completion']) {
    for (const fault of ['challenge-before', 'challenge-after', 'phase-before', 'phase-after', 'delivery-throw', 'delivery-lost']) {
      await t.test(`${phase}: ${fault}`, async t => {
        const f = await fixture(t);
        const epoch = await f.epoch();
        if (phase !== 'request') await f.invoke(f.fresh());
        if (phase === 'status' || phase === 'completion') {
          await f.invoke(f.fresh({ phase: 'dispatch', authorityEpoch: epoch }));
          await f.record(f.base);
        }
        const r = f.fresh({ phase, authorityEpoch: phase === 'request' ? null : epoch });
        const prior = await f.db('extension_authority_operations').first();
        const conn = await f.db.client.acquireConnection();
        conn.pragma('synchronous = NORMAL');
        await f.db.client.releaseConnection(conn);
        const exec = conn.exec.bind(conn);
        let commits = 0; let injected = false; let deliveries = 0;
        const target = fault.startsWith('challenge-') ? 1 : fault.startsWith('phase-') ? 2 : 0;
        const mock = t.mock.method(conn, 'exec', (sql: string) => {
          if (sql === 'COMMIT' && ++commits === target) {
            injected = true;
            // Cover both a definite uncommitted failure and a commit whose
            // durable success was not reported back to its caller.
            if (fault.endsWith('-after')) exec(sql);
            throw Error('injected commit failure');
          }
          return exec(sql);
        });
        try {
          const result = f.plane.invoke(f.raw(r), () => {
            deliveries++;
            assert.equal(conn.inTransaction, true);
            assert.equal(conn.pragma('synchronous', { simple: true }), 2);
            if (fault === 'delivery-throw') throw Error('injected socket write failure');
            // A successful socket write is not evidence that a peer received it.
            // Deliberately discard the reply in the delivery-lost case.
          });
          if (fault === 'delivery-lost') await result;
          else await assert.rejects(result, /^Error: extension_authority_unavailable$/);
          assert.equal(injected, target !== 0);
          assert.equal(deliveries, target === 0 ? 1 : 0);
          assert.equal(conn.inTransaction, false);
          assert.equal(conn.pragma('synchronous', { simple: true }), 1);
        } finally { mock.mock.restore(); }
        const challengeCommitted = fault !== 'challenge-before';
        const phaseCommitted = fault === 'phase-after' || fault.startsWith('delivery-');
        for (const restart of [false, true]) {
          if (restart) await f.restart();
          assert.equal(Boolean(await f.db('extension_authority_challenges').where({ challenge: r.challenge }).first()), challengeCommitted);
          const operation = await f.db('extension_authority_operations').first();
          if (!phaseCommitted) assert.deepEqual(operation, prior);
          else {
            assert.equal(operation.epoch, epoch);
            assert.equal(operation.dispatched, phase === 'request' ? 0 : 1);
            assert.equal(operation.completed, phase === 'completion' ? 1 : 0);
          }
        }
        if (challengeCommitted) await assert.rejects(f.invoke(r), /unavailable/);
        else await f.invoke(r); // A rolled-back challenge was never admitted.
        const retry = f.fresh({ phase, authorityEpoch: r.authorityEpoch });
        if ((phaseCommitted || !challengeCommitted) && phase !== 'status') {
          await assert.rejects(f.invoke(retry), /unavailable/);
        } else {
          verifyProof(await f.invoke(retry), retry, f.plane.verificationKey(), Date.now(), new Set());
        }
      });
    }
  }
});
