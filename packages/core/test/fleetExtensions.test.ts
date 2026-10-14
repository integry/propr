import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { request as httpRequest } from 'node:http';
import knex from 'knex';
import { createHash, createHmac, randomBytes, randomUUID, ECDH } from 'node:crypto';
import { canonicalFleetJson, FLEET_EXTENSION_CONTRACT, FLEET_EXTENSION_SCOPE, FLEET_EXTENSION_SCHEMA, FLEET_EXTENSION_LIMITS, fleetExtensionEnvelopeSchema, fleetExtensionProfileInputSchema, fleetExtensionRecipientSchema, encryptFleetExtensionSecret, type FleetExtensionRequest, type FleetExtensionIntent, type FleetExtensionAssertion } from '@propr/shared';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grants } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { ExtensionProfileStore } from '../src/extensions/extensionProfileStore.js';
import { FleetDataPlane } from '../src/fleet/dataPlane.js';
import { InstanceStorageService } from '../src/storage/service.js';
import { StorageLifecycle } from '../src/storage/lifecycle.js';
import * as policy from '../src/extensions/endpointPolicy.js';

const sentinel = 'REMOTE_SENTINEL_WRITE_ONLY_MCP_DO_NOT_DISCLOSE';
let expectedToken = sentinel;
// Synthetic upstream replaces only HTTPS I/O, retaining real URL/DNS policy for saves and launch validation.
mock.module('../src/extensions/endpointPolicy.js', { namedExports: { ...policy, requestExtensionMcp: async (_url: string, _body: unknown, token: string) => { assert.equal(token, expectedToken); return { result: { maliciousEcho: token } }; } } });
const skill = Buffer.from('---\nname: synthetic-skill\ndescription: Immutable test skill\n---\nOnly a declaration.');
mock.module('../src/auth/githubAuth.js', { namedExports: { getGitHubInstallationToken: async () => 'synthetic', validateGithubIntakePrerequisites: () => {}, getAuthenticatedOctokit: async () => ({ request: async (route: string) => ({ data: route.includes('/git/commits/') ? { sha: 'a'.repeat(40), tree: { sha: 'b'.repeat(40) } } : route.includes('/git/trees/') ? { truncated: false, tree: [{ path: 'skills/demo/SKILL.md', type: 'blob', mode: '100644', sha: createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${skill.length}\0`), skill])).digest('hex'), size: skill.length }] } : { encoding: 'base64', content: skill.toString('base64') } }) }) } });
const { FleetExtensionPlane, extensionContractPin } = await import('../src/fleet/extensions.js');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const select = (p: any) => ({ instanceId: p.instanceId, profileId: p.profileId, revision: p.revision });
const input = { version: 1 as const, name: 'Remote tools', enabled: true, agentScope: [], repositoryScope: [], mcpServers: [{ kind: 'https' as const, name: 'docs', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read' as const, authentication: 'bearer' as const }], skillBundleIds: [] as string[] };
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-extension-')); let cleanup = async () => {};
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('config', tb => { tb.string('key').primary(); tb.text('value'); });
  await database.schema.createTable('instance_members', tb => { tb.string('github_user_id').primary(); tb.string('role'); tb.string('source'); });
  await database.schema.createTable('agent_definitions', tb => { tb.string('id').primary(); });
  await database('instance_members').insert([{ github_user_id: '100', role: 'admin', source: 'local' }, { github_user_id: '101', role: 'member', source: 'managed' }, { github_user_id: '200', role: 'admin', source: 'local' }]);
  await up(database); await grants(database);
  const storageRoot = path.join(root, 'storage'); const clones = path.join(root, 'clones'); await fs.mkdir(clones);
  const storage = new InstanceStorageService({ lifecycle: new StorageLifecycle(storageRoot), clonesRoot: clones, roots: [], hasPendingTasks: async () => false });
  await storage.initialize();
  const secret = 'PRIVATE-TEST-FLEET-AUTHORITY-ONLY-UNRELATED';
  const control = path.join(root, 'fleet'); await fs.mkdir(control, { mode: 0o700 });
  const authority = { hostedInstanceId: 'synthetic-instance', placementGeneration: 'placement-1', scope: 'hosted_customer_data', secretSha256: hash(secret) };
  await fs.writeFile(path.join(control, 'authority.json'), JSON.stringify(authority), { mode: 0o600 });
  let permission = true; let boundaryHook: ((db: typeof database) => Promise<void>) | undefined;
  const fleet = new FleetDataPlane(storage, control, () => secret, async (id, db = database) => {
    await boundaryHook?.(db);
    const row = await db('instance_members').where({ github_user_id: String(id) }).first();
    return { role: row?.role ?? 'member', source: row?.source ?? 'implicit', permissions: permission ? ['instance.manage_settings'] : [] };
  });
  await fleet.initialize();
  const store = new ExtensionProfileStore(database, { SYSTEM_TASK_SECRET: 'local-encrypted-custody-test-key' });
  let plane = new FleetExtensionPlane(fleet, store); t.after(async () => { await cleanup(); plane.shutdown(); await database.destroy(); await fs.rm(root, { recursive: true, force: true }); });
  const runtime = await fleet.runtime();
  const base = { hostedInstanceId: runtime.hostedInstanceId, storageInstanceId: runtime.storageInstanceId, runtimeGeneration: runtime.runtimeGeneration, storageGeneration: runtime.storageGeneration, placementGeneration: runtime.placementGeneration };
  const envelope = (request: FleetExtensionRequest, overrides: Partial<FleetExtensionAssertion> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const assertion = { ...base, contract: FLEET_EXTENSION_CONTRACT, contractPin: extensionContractPin, scope: FLEET_EXTENSION_SCOPE, githubActorId: 100, issuedAt: now, expiresAt: now + 60, action: request.action, requestDigest: hash(canonicalFleetJson(request)), operationId: randomUUID(), nonce: randomBytes(32).toString('hex'), ...overrides };
    return canonicalFleetJson({ assertion, request, mac: createHmac('sha256', secret).update(canonicalFleetJson(assertion)).digest('hex') });
  };
  let transport: ((raw: string) => Promise<any>) | undefined;
  const invoke = async (r: FleetExtensionRequest, overrides: Partial<FleetExtensionAssertion> = {}) => (await (transport ? transport(envelope(r, overrides)) : plane.invoke(envelope(r, overrides)))).result as any;
  const recipient = async (intent: FleetExtensionIntent, mutationOperationId = randomUUID(), overrides: Partial<FleetExtensionAssertion> = {}) => ({ operationId: mutationOperationId, recipient: await invoke({ action: 'recipient.issue', intent, mutationOperationId, server: 'docs', field: 'bearerToken' }, overrides) });
  const verificationKey = await plane.recipientVerificationKey();
  const encrypt = (recipient: any, token: string) => encryptFleetExtensionSecret(recipient, token, { verificationKey, expectedBinding: recipient.binding });
  return { verificationKey, encrypt, cleanup: (fn: () => Promise<void>) => { cleanup = fn; }, transport: (send: (raw: string) => Promise<any>) => { transport = send; }, database, store, fleet, storage, root, control, authority, secret, base, envelope, invoke, recipient, get plane() { return plane; }, restart: () => { plane.shutdown(); plane = new FleetExtensionPlane(fleet, store); }, permission: (p: boolean) => { permission = p; }, hook: (h?: (db: typeof database) => Promise<void>) => { boundaryHook = h; } };
}

test('pinned fixtures cover every operation, exact canonical bytes and checksum bundle; v2 unchanged', async () => {
  const root = 'docs/contracts/fleet-extensions-v1/';
  const schema = await fs.readFile(root + 'schema.json', 'utf8'); assert.equal(schema, FLEET_EXTENSION_SCHEMA); assert.equal(hash(schema), extensionContractPin);
  const fixtures = JSON.parse(await fs.readFile(root + 'fixtures.json', 'utf8'));
  assert.equal(fixtures.contractPin, extensionContractPin);
  assert.equal(fixtures.requests.length, 14);
  for (const fixture of fixtures.requests) {
    const parsed = fleetExtensionEnvelopeSchema.parse(JSON.parse(fixture.canonical));
    assert.equal(canonicalFleetJson(parsed), fixture.canonical); assert.equal(hash(fixture.canonical), fixture.sha256);
    assert.equal(hash(canonicalFleetJson(parsed.request)), parsed.assertion.requestDigest);
    assert.equal(createHmac('sha256', fixtures.testSecret).update(canonicalFleetJson(parsed.assertion)).digest('hex'), parsed.mac);
  }
  const recipient = fleetExtensionRecipientSchema.parse(JSON.parse(fixtures.recipient.canonical));
  assert.equal(canonicalFleetJson(recipient), fixtures.recipient.canonical); assert.equal(hash(fixtures.recipient.canonical), fixtures.recipient.sha256);
  const encrypted = await encryptFleetExtensionSecret(recipient, 'PUBLIC_SYNTHETIC_FIXTURE_TOKEN', { verificationKey: fixtures.recipient.verificationKey, expectedBinding: recipient.binding });
  assert.equal(Buffer.from(encrypted.ciphertext, 'base64url').length, 4112);
  for (const version of ['fleet-extensions-v1', 'fleet-data-v2']) for (const line of (await fs.readFile(`docs/contracts/${version}/SHA256SUMS`, 'utf8')).trim().split('\n')) {
    const [checksum, name] = line.split('  '); assert.equal(hash(await fs.readFile(`docs/contracts/${version}/${name}`, 'utf8')), checksum);
  }
});

test('private channel: browser encrypted create/rotation, all capabilities, exact revision synthetic run and custody', async t => {
  const f = await fixture(t);
  const { listenFleetData } = await import('../../api/fleetDataListener.js');
  const listener = await listenFleetData(f.fleet, f.plane); f.cleanup(() => listener.shutdown());
  f.transport(raw => new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: listener.address()!, path: '/extensions/v1/invoke', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const result = JSON.parse(Buffer.concat(chunks).toString()); if (res.statusCode === 200) resolve(result); else reject(new Error(result.error)); });
    }); req.on('error', reject); req.end(raw);
  }));
  const bundle = (await f.invoke({ action: 'skill.import', repository: 'synthetic/skills', commit: 'a'.repeat(40), directory: 'skills/demo' })).bundle;
  assert.equal((await f.invoke({ action: 'skill.list' })).bundles[0].digest, bundle.digest);
  const intent = { action: 'profile.create' as const, input: { ...input, skillBundleIds: [bundle.id] } };
  const acquired = await f.recipient(intent);
  const sealed = await f.encrypt(acquired.recipient, sentinel);
  const request = { ...intent, sealed: [sealed] };
  const raw = f.envelope(request, { operationId: acquired.operationId });
  const profile = await f.invoke(request, { operationId: acquired.operationId });
  assert.equal(profile.profile.secrets.docs.configured, true);
  await assert.rejects(f.plane.invoke(raw), /fleet_extensions_unavailable/);
  await assert.rejects(f.invoke(request), /fleet_extensions_unavailable/);
  assert.equal((await f.invoke({ action: 'operation.status', targetOperationId: acquired.operationId })).state, 'completed');
  const selection = select(profile.profile);
  assert.equal((await f.invoke({ action: 'profile.read', selection })).profile.profileId, selection.profileId);
  assert.equal((await f.invoke({ action: 'profile.list' })).profiles.length, 1);
  assert.equal((await f.invoke({ action: 'catalog.list' })).catalog.length, 0);
  assert.deepEqual((await f.invoke({ action: 'profile.validate', selection })).results, [{ name: 'docs', status: 'reachable' }]);
  const context = { runtime: 'claude' as const, agentAlias: 'claude-main', repositories: ['synthetic/skills'], allowWrite: false };
  assert.equal((await f.invoke({ action: 'selection.validate', selection, context })).valid, true);
  const selected = await f.store.assertLaunch('100', selection, context); const grant = await f.store.createGrant('100', selected, 'synthetic-run-selected');
  await f.store.activateGrant(grant, '100', selection);
  assert.equal((await f.store.grantSnapshot(grant)).snapshot.skillBundles[0].digest, bundle.digest);
  assert.equal((await f.database('extension_run_grants').where({ task_id: 'synthetic-run-unselected' })).length, 0);
  const rotate = { action: 'profile.update' as const, input: intent.input, selection };
  const next = await f.recipient(rotate); expectedToken = sentinel + '_ROTATED';
  const rotated = (await f.invoke({ ...rotate, sealed: [await f.encrypt(next.recipient, expectedToken)] }, { operationId: next.operationId })).profile;
  assert.equal(rotated.revision, 2); await assert.rejects(f.invoke({ action: 'selection.validate', selection, context }), /unavailable/);
  assert.equal((await f.invoke({ action: 'profile.history', profileId: selection.profileId })).revisions.length, 2);
  assert.equal((await f.invoke({ action: 'profile.validate', selection: select(rotated) })).results[0].status, 'reachable');
  const disabled = (await f.invoke({ action: 'profile.disable', selection: select(rotated) })).profile;
  await f.invoke({ action: 'profile.delete', selection: select(disabled) }); assert.equal((await f.invoke({ action: 'profile.list' })).profiles.length, 0);
  const retained = JSON.stringify(await f.database('extension_profile_revisions').select('*')) + (await Promise.all((await fs.readdir(f.control)).filter(n => !n.endsWith('.sock')).map(n => fs.readFile(path.join(f.control, n), 'utf8')))).join('');
  for (const forbidden of [sentinel, sentinel.slice(0, 15), hash(sentinel), Buffer.from(sentinel).toString('base64'), Buffer.from(sentinel).toString('hex')]) assert.ok(!retained.includes(forbidden));
  assert.equal(JSON.stringify(sealed).includes(sentinel), false); assert.equal(Buffer.from(sealed.ciphertext, 'base64url').length, 4112);
});

test('request digests bind raw whitespace names while native create/update normalize them', async t => {
  const f = await fixture(t);
  const create = { action: 'profile.create' as const, input: { ...input, name: 'Docs ', mcpServers: [] }, sealed: [] };
  const normalizedDigest = hash(canonicalFleetJson({ ...create, input: { ...create.input, name: 'Docs' } }));
  await assert.rejects(f.invoke(create, { requestDigest: normalizedDigest }), /unavailable/);
  assert.equal((await fs.readdir(f.control)).filter(n => n.startsWith('extension-')).length, 0);
  const profile = (await f.invoke(create)).profile;
  assert.equal(profile.name, 'Docs');
  const updated = (await f.invoke({ action: 'profile.update', selection: select(profile), input: { ...create.input, name: ' Updated docs ' }, sealed: [] })).profile;
  assert.equal(updated.name, 'Updated docs');
  assert.equal(updated.revision, 2);
});

test('recipient issuance and encrypted create/update bind raw intents before name normalization', async t => {
  const f = await fixture(t);
  const create = { action: 'profile.create' as const, input: { ...input, name: 'Docs ' } };
  const seal = async (intent: FleetExtensionIntent, acquired: Awaited<ReturnType<typeof f.recipient>>) => {
    const intentDigest = hash(canonicalFleetJson(intent));
    assert.equal(acquired.recipient.binding.intentDigest, intentDigest);
    const target = intent.action === 'profile.create' ? { kind: 'create', intentDigest } : { kind: 'revision', selection: intent.selection };
    assert.deepEqual(acquired.recipient.binding.target, target);
    return encryptFleetExtensionSecret(acquired.recipient, sentinel, {
      verificationKey: f.verificationKey,
      expectedBinding: { ...acquired.recipient.binding, intentDigest, target },
    });
  };
  const acquired = await f.recipient(create);
  const profile = (await f.invoke({ ...create, sealed: [await seal(create, acquired)] }, { operationId: acquired.operationId })).profile;
  assert.equal(profile.name, 'Docs');
  assert.equal(profile.secrets.docs.configured, true);
  const update = { action: 'profile.update' as const, input: { ...input, name: ' Updated docs ' }, selection: select(profile) };
  const next = await f.recipient(update);
  const updated = (await f.invoke({ ...update, sealed: [await seal(update, next)] }, { operationId: next.operationId })).profile;
  assert.equal(updated.name, 'Updated docs');
  assert.equal(updated.revision, 2);
  assert.equal(updated.secrets.docs.configured, true);

  // A different raw intent must fail even when it normalizes to the same native profile.
  for (const intent of [create, { ...update, selection: select(updated) }]) {
    const substituted = await f.recipient(intent);
    const sealed = await seal(intent, substituted);
    await assert.rejects(f.invoke({ ...intent, input: { ...intent.input, name: intent.input.name.trim() }, sealed: [sealed] }, { operationId: substituted.operationId }), /unavailable/);
    await assert.rejects(f.invoke({ ...intent, sealed: [sealed] }, { operationId: substituted.operationId }), /unavailable/);
    assert.equal((await f.invoke({ action: 'operation.status', targetOperationId: substituted.operationId })).state, 'fenced');
  }
  assert.equal((await f.store.list('100')).length, 1);
  assert.equal((await f.store.read('100', select(updated))).revision, 2);
});

test('nonadmins, bootstrap/implicit/managed identities, revocation, permission, actor and every audience generation fence', async t => {
  const f = await fixture(t);
  for (const githubActorId of [101, 300, 0, -1, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(f.invoke({ action: 'profile.list' }, { githubActorId }), /unavailable/);
  f.permission(false); await assert.rejects(f.invoke({ action: 'profile.list' }), /unavailable/); f.permission(true);
  for (const key of Object.keys(f.base)) {
    const changed = key === 'hostedInstanceId' || key === 'placementGeneration' ? 'other' : randomUUID();
    await assert.rejects(f.invoke({ action: 'profile.list' }, { [key]: changed }), /unavailable/);
  }
  const raw = f.envelope({ action: 'profile.list' }); const parsed = JSON.parse(raw);
  await assert.rejects(f.plane.invoke(JSON.stringify(parsed, null, 2)), /unavailable/);
  await assert.rejects(f.plane.invoke(raw.replace(extensionContractPin, '0'.repeat(64))), /unavailable/);
  const original = await f.recipient({ action: 'profile.create', input });
  await f.database('instance_members').where({ github_user_id: '100' }).update({ role: 'member' });
  await assert.rejects(f.invoke({ action: 'profile.create', input, sealed: [await f.encrypt(original.recipient, sentinel)] }, { operationId: original.operationId }), /unavailable/);
  assert.equal((await f.database('extension_profiles')).length, 0);
});

test('recipient expiry/restart, substitutions, concurrent claims, rotation races and lost replies are fail closed', async t => {
  const f = await fixture(t); const intent = { action: 'profile.create' as const, input };
  const acquired = await f.recipient(intent); const sealed = await f.encrypt(acquired.recipient, sentinel);
  await assert.rejects(f.invoke({ ...intent, sealed: [sealed] }, { operationId: acquired.operationId, githubActorId: 200 }), /unavailable/);
  await assert.rejects(f.invoke({ ...intent, sealed: [sealed] }, { operationId: acquired.operationId }), /unavailable/);
  const second = await f.recipient(intent);
  const altered = structuredClone(second.recipient); altered.binding.field = 'password';
  await assert.rejects(f.encrypt(altered, sentinel), /unavailable/);
  const third = await f.recipient(intent);
  const badCipher = await f.encrypt(third.recipient, sentinel); badCipher.ciphertext = (badCipher.ciphertext[0] === 'A' ? 'B' : 'A') + badCipher.ciphertext.slice(1);
  await assert.rejects(f.invoke({ ...intent, sealed: [badCipher] }, { operationId: third.operationId }), /unavailable/);
  for (const key of ['action', 'server', 'audience', 'expiresAt', 'intentDigest', 'mutationOperationId']) {
    const entry = await f.recipient(intent); const changed = structuredClone(entry.recipient); changed.binding[key] = 'substituted';
    await assert.rejects(f.encrypt(changed, sentinel), /unavailable/);
  }
  const changedProfile = await f.recipient(intent);
  await assert.rejects(f.invoke({ ...intent, input: { ...input, name: 'Different intent' }, sealed: [await f.encrypt(changedProfile.recipient, sentinel)] }, { operationId: changedProfile.operationId }), /unavailable/);
  // Allow slow CI issuance, then wait past the issued recipient's actual expiry.
  const expired = await f.recipient(intent, randomUUID(), { expiresAt: Math.floor(Date.now() / 1000) + 10 });
  const expiredCipher = await f.encrypt(expired.recipient, sentinel);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, expired.recipient.binding.expiresAt * 1000 - Date.now()) + 100));
  await assert.rejects(f.invoke({ ...intent, sealed: [expiredCipher] }, { operationId: expired.operationId }), /unavailable/);
  const restart = await f.recipient(intent); const restartCipher = await f.encrypt(restart.recipient, sentinel); f.restart();
  await assert.rejects(f.invoke({ ...intent, sealed: [restartCipher] }, { operationId: restart.operationId }), /unavailable/);
  const concurrent = await f.recipient(intent); const encrypted = await f.encrypt(concurrent.recipient, sentinel);
  const outcomes = await Promise.allSettled([f.invoke({ ...intent, sealed: [encrypted] }, { operationId: concurrent.operationId }), f.invoke({ ...intent, sealed: [encrypted] }, { operationId: concurrent.operationId })]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const profile = (outcomes.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value.profile;
  const update = { action: 'profile.update' as const, input, selection: select(profile) }; const race = await f.recipient(update);
  await f.store.save('100', input, {}, select(profile));
  await assert.rejects(f.invoke({ ...update, sealed: [await f.encrypt(race.recipient, sentinel)] }, { operationId: race.operationId }), /unavailable/);
  assert.equal((await f.store.history('100', profile.profileId)).length, 2);
});

test('durable revocation is checked at every create boundary including transaction mutation and completion', async t => {
  const baseline = await fixture(t); let checks = 0;
  baseline.hook(async () => { checks++; });
  await baseline.invoke({ action: 'profile.create', input, sealed: [] }); assert.ok(checks >= 8);
  for (let boundary = 1; boundary <= checks; boundary++) {
    const f = await fixture(t); let count = 0;
    f.hook(async db => { if (++count === boundary) await db('instance_members').where({ github_user_id: '100' }).update({ role: 'member' }); });
    await assert.rejects(f.invoke({ action: 'profile.create', input, sealed: [] }), /fleet_extensions_unavailable/);
  }
});

test('generation and placement ABA changes during authorization fence dispatch; status binds original actor', async t => {
  for (const key of ['hostedInstanceId', 'placementGeneration']) {
    const f = await fixture(t); let once = false;
    f.hook(async () => { if (!once) { once = true; await fs.writeFile(path.join(f.control, 'authority.json'), JSON.stringify({ ...f.authority, [key]: 'replacement' }), { mode: 0o600 }); } });
    await assert.rejects(f.invoke({ action: 'profile.create', input, sealed: [] }), /unavailable/);
    assert.equal((await f.database('extension_profiles')).length, 0);
    f.hook(); await fs.writeFile(path.join(f.control, 'authority.json'), JSON.stringify({ ...f.authority, placementGeneration: 'placement-ABA-new' }), { mode: 0o600 });
    await assert.rejects(f.invoke({ action: 'profile.list' }), /unavailable/);
  }
  const f = await fixture(t); const raw = f.envelope({ action: 'profile.list' }); const { assertion } = JSON.parse(raw);
  await f.plane.invoke(raw);
  await assert.rejects(f.invoke({ action: 'operation.status', targetOperationId: assertion.operationId }, { githubActorId: 200 }), /unavailable/);
  f.restart(); assert.equal((await f.invoke({ action: 'operation.status', targetOperationId: assertion.operationId })).state, 'completed');
});

test('recipient consumption and status revalidate live hosted/storage/runtime/placement generations', async t => {
  for (const boundary of ['consume', 'status']) for (const generation of ['hosted', 'storageIdentity', 'runtime', 'storage', 'placement', 'extensionIdentity']) {
    const f = await fixture(t); const intent = { action: 'profile.create' as const, input };
    const acquired = await f.recipient(intent); const encrypted = await f.encrypt(acquired.recipient, sentinel);
    if (generation === 'hosted' || generation === 'placement') await fs.writeFile(path.join(f.control, 'authority.json'), JSON.stringify({ ...f.authority, [generation === 'hosted' ? 'hostedInstanceId' : 'placementGeneration']: 'new-generation' }), { mode: 0o600 });
    if (generation === 'storageIdentity') await fs.writeFile(path.join(f.root, 'storage', 'instance.json'), JSON.stringify(randomUUID()), { mode: 0o600 });
    if (generation === 'runtime') { const original = f.storage.capabilities.bind(f.storage); const generationId = randomUUID(); mock.method(f.storage, 'capabilities', async () => ({ ...await original(), generation: generationId })); }
    if (generation === 'storage') Object.defineProperty(f.storage, 'generation', { value: randomUUID() });
    if (generation === 'extensionIdentity') await f.database('extension_instance_identity').where({ id: 1 }).update({ instance_id: randomUUID() });
    if (boundary === 'consume') {
      await assert.rejects(f.invoke({ ...intent, sealed: [encrypted] }, { operationId: acquired.operationId }), /unavailable/);
      assert.equal((await f.database('extension_profiles')).length, 0);
    } else if (generation !== 'extensionIdentity') {
      const acquisitionId = acquired.recipient.binding.assertion.operationId;
      await assert.rejects(f.invoke({ action: 'operation.status', targetOperationId: acquisitionId }), /unavailable/);
    }
  }
});

test('uncertain replies remain fenced, durable records never retain ciphertext, and restart refuses recipient reuse', async t => {
  const f = await fixture(t); const intent = { action: 'profile.create' as const, input }; const acquired = await f.recipient(intent);
  const sealed = await f.encrypt(acquired.recipient, sentinel);
  const original = f.fleet.files.append.bind(f.fleet.files);
  mock.method(f.fleet.files, 'append', async (name: string, value: unknown) => { if (name === `extension-operation-${acquired.operationId}.json`) throw new Error('Synthetic lost reply'); return original(name, value); });
  await assert.rejects(f.invoke({ ...intent, sealed: [sealed] }, { operationId: acquired.operationId }), /unavailable/);
  assert.equal((await f.database('extension_profiles')).length, 1);
  assert.equal((await f.invoke({ action: 'operation.status', targetOperationId: acquired.operationId })).state, 'fenced');
  const retained = (await Promise.all((await fs.readdir(f.control)).map(n => fs.readFile(path.join(f.control, n), 'utf8')))).join('');
  assert.ok(!retained.includes(sealed.ciphertext)); assert.ok(!retained.includes(sentinel));
  f.restart();
  await assert.rejects(f.invoke({ ...intent, sealed: [sealed] }, { operationId: acquired.operationId }), /unavailable/);
  assert.equal((await f.invoke({ action: 'operation.status', targetOperationId: acquired.operationId })).state, 'fenced');
});

test('browser authenticates Core key ownership and exact intended binding before disclosing ciphertext to a relay', async t => {
  const f = await fixture(t); const intent = { action: 'profile.create' as const, input };
  const first = await f.recipient(intent); const second = await f.recipient(intent);
  const substituted = { ...first.recipient, publicKey: second.recipient.publicKey };
  await assert.rejects(f.encrypt(substituted, sentinel), /unavailable/);
  await assert.rejects(encryptFleetExtensionSecret(first.recipient, sentinel, { verificationKey: f.verificationKey, expectedBinding: { ...first.recipient.binding, server: 'attacker' } }), /unavailable/);
  const another = await fixture(t);
  await assert.rejects(encryptFleetExtensionSecret(first.recipient, sentinel, { verificationKey: another.verificationKey, expectedBinding: first.recipient.binding }), /unavailable/);
  for (const token of ['x', 'x'.repeat(4096)]) assert.equal(Buffer.from((await f.encrypt(first.recipient, token)).ciphertext, 'base64url').length, 4112);
});

test('private listener completes worst-case schema-valid eight-field create/update within shared caps', async t => {
  const f = await fixture(t);
  const { listenFleetData } = await import('../../api/fleetDataListener.js');
  const listener = await listenFleetData(f.fleet, f.plane); f.cleanup(() => listener.shutdown());
  const send = (raw: string) => new Promise<any>((resolve, reject) => {
    const req = httpRequest({ socketPath: listener.address()!, path: '/extensions/v1/invoke', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const result = JSON.parse(Buffer.concat(chunks).toString()); res.statusCode === 200 ? resolve(result) : reject(new Error(result.error)); });
    }); req.on('error', reject); req.end(raw);
  });
  // Six-byte JSON escapes maximize arbitrary string fields, including URLs. Native
  // URL parsing permits these path characters; disable the profile to avoid I/O.
  const bundles = [];
  for (let i = 0; i < 8; i++) bundles.push(await f.store.importSkill('100', [{ path: 'SKILL.md', content: skill.toString('base64') }], { kind: 'github', repository: 'r'.repeat(99) + '/' + 'r'.repeat(100), commit: 'a'.repeat(40), directory: 'd'.repeat(240) }));
  const fullInput = {
    ...input, enabled: false, name: '\u0001'.repeat(100),
    agentScope: Array.from({ length: 64 }, (_, i) => String(i).padEnd(100, 'a')),
    repositoryScope: Array.from({ length: 64 }, (_, i) => String(i).padEnd(99, 'r') + '/' + 'r'.repeat(100)),
    mcpServers: Array.from({ length: 8 }, (_, i) => ({
      ...input.mcpServers[0], name: `docs${i}`.padEnd(48, 'a'),
      url: 'https://8.8.8.8/' + '\u0001'.repeat(2048 - 'https://8.8.8.8/'.length),
      tools: Array.from({ length: 64 }, (_, j) => String(j).padEnd(128, 't')),
    })), skillBundleIds: bundles.map(bundle => bundle.id),
  };
  assert.equal(fleetExtensionProfileInputSchema.safeParse(fullInput).success, true);
  assert.equal(fleetExtensionProfileInputSchema.safeParse({ ...fullInput, repositoryScope: ['r/'.padEnd(201, 'r')] }).success, false);
  let selection: ReturnType<typeof select> | undefined;
  for (const action of ['profile.create', 'profile.update'] as const) {
    const intent = action === 'profile.create' ? { action, input: fullInput } : { action, input: fullInput, selection: selection! };
    const operationId = randomUUID(); const sealed = [];
    for (const server of fullInput.mcpServers) {
      const recipient = await f.invoke({ action: 'recipient.issue', intent, mutationOperationId: operationId, server: server.name, field: 'bearerToken' });
      sealed.push(await f.encrypt(recipient, sentinel));
    }
    const raw = f.envelope({ ...intent, sealed }, { operationId });
    assert.ok(Buffer.byteLength(raw) > 150_953);
    assert.equal(fleetExtensionEnvelopeSchema.safeParse(JSON.parse(raw)).success, true);
    assert.ok(Buffer.byteLength(raw) <= FLEET_EXTENSION_LIMITS.requestBytes);
    const response = await send(raw);
    assert.equal(response.state, 'completed');
    assert.equal(response.operationId, operationId);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= FLEET_EXTENSION_LIMITS.responseBytes);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) > 32768);
    assert.equal((await f.invoke({ action: 'operation.status', targetOperationId: operationId })).state, 'completed');
    const profile = response.result.profile;
    for (const server of fullInput.mcpServers) assert.equal(profile.secrets[server.name].configured, true);
    selection = select(profile);
  }
  const oversized = 'x'.repeat(FLEET_EXTENSION_LIMITS.requestBytes + 1);
  await assert.rejects(f.plane.invoke(oversized), /fleet_extensions_unavailable/);
  await assert.rejects(send(oversized), /fleet_extensions_unavailable/);
});

test('oversized public bundle metadata rolls back create, update and disable before commit', async t => {
  const f = await fixture(t);
  // Native archive filenames are not schema-bounded. Such a stored descriptor
  // must not make an otherwise valid remote mutation fail after committing.
  const bundle = await f.store.importSkill('100', [{ path: 'SKILL.md', content: skill.toString('base64') }], { kind: 'archive', filename: '\u0001'.repeat(FLEET_EXTENSION_LIMITS.responseBytes) });
  const profile = await f.store.save('100', { ...input, skillBundleIds: [bundle.id] });
  for (const request of [
    { action: 'profile.create' as const, input: { ...input, skillBundleIds: [bundle.id] }, sealed: [] },
    { action: 'profile.update' as const, input: { ...input, skillBundleIds: [bundle.id] }, selection: select(profile), sealed: [] },
    { action: 'profile.disable' as const, selection: select(profile) },
  ]) {
    const operationId = randomUUID();
    await assert.rejects(f.invoke(request, { operationId }), /fleet_extensions_unavailable/);
    assert.equal((await f.database('extension_profiles')).length, 1);
    assert.equal((await f.database('extension_profiles').first()).revision, 1);
    assert.equal((await f.database('extension_profile_revisions')).length, 1);
    assert.equal((await f.invoke({ action: 'operation.status', targetOperationId: operationId })).state, 'fenced');
  }
});

test('extension reservations count restart tombstones and release only proven unused slots', async t => {
  const f = await fixture(t);
  const counts = () => ({ shared: (f.fleet as any).count, extension: (f.plane as any).slots });
  const raw = f.envelope({ action: 'profile.list' });
  await f.plane.invoke(raw); const after = counts();
  for (let i = 0; i < 3; i++) await assert.rejects(f.plane.invoke(raw), /unavailable/);
  assert.deepEqual(counts(), after);
  // A fresh nonce for an existing operation leaves only the new nonce tombstone.
  const operationId = JSON.parse(raw).assertion.operationId;
  await assert.rejects(f.invoke({ action: 'profile.list' }, { operationId }), /unavailable/);
  assert.deepEqual(counts(), { shared: after.shared + 1, extension: after.extension + 1 });
  const concurrent = f.envelope({ action: 'profile.list' });
  const results = await Promise.allSettled([f.plane.invoke(concurrent), f.plane.invoke(concurrent)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.deepEqual(counts(), { shared: after.shared + 3, extension: after.extension + 3 });
  const original = f.fleet.files.create.bind(f.fleet.files);
  const uncertain = mock.method(f.fleet.files, 'create', async (name: string, value: unknown) => {
    await original(name, value); throw new Error('Write outcome uncertain');
  });
  const beforeUncertain = counts();
  await assert.rejects(f.invoke({ action: 'profile.list' }), /unavailable/);
  assert.deepEqual(counts(), { shared: beforeUncertain.shared + 1, extension: beforeUncertain.extension + 1 });
  uncertain.mock.restore();
  f.restart();
  // Full data-plane restart re-counts the shared namespace, including extensions.
  const next = new FleetDataPlane(f.storage, f.control, () => f.secret, async () => ({ role: 'admin', source: 'local', permissions: ['instance.manage_settings'] }));
  await next.initialize();
  const entries = await fs.readdir(f.control);
  assert.equal((next as any).count, entries.length + 3);
  // Reserve up to the shared bound; another contract admission cannot exceed it.
  next.reserveExtensionEntries(16384 - (next as any).count);
  assert.throws(() => next.reserveExtensionEntries(1), /unavailable/);
  await f.plane.invoke(f.envelope({ action: 'profile.list' }));
  assert.equal((f.plane as any).slots, entries.filter(n => n.startsWith('extension-')).length + 2);
});

test('recipient issuance zeroes private buffers on signing, capacity and awaited shutdown failures', async t => {
  const f = await fixture(t); const intent = { action: 'profile.create' as const, input };
  const buffers: Buffer[] = [];
  const original = ECDH.prototype.getPrivateKey;
  const capture = mock.method(ECDH.prototype, 'getPrivateKey', function (this: ECDH) {
    const buffer = original.call(this) as Buffer; buffers.push(buffer); return buffer;
  });
  t.after(() => capture.mock.restore());
  const identity = mock.method(f.store, 'instanceId', async () => { throw new Error('Identity unavailable'); });
  await assert.rejects(f.recipient(intent), /unavailable/);
  assert.ok(buffers.at(-1)!.every(byte => byte === 0));
  identity.mock.restore();
  const completion = mock.method(f.fleet.files, 'append', async () => { throw new Error('Completion unavailable'); });
  await assert.rejects(f.recipient(intent), /unavailable/);
  assert.ok(buffers.at(-1)!.every(byte => byte === 0));
  assert.equal((f.plane as any).recipients.size, 0);
  completion.mock.restore();
  const signing = mock.method(f.plane as any, 'recipientSigningKey', async () => { throw new Error('Signing unavailable'); });
  await assert.rejects(f.recipient(intent), /unavailable/);
  assert.ok(buffers.at(-1)!.every(byte => byte === 0));
  signing.mock.restore();
  for (let i = 0; i < FLEET_EXTENSION_LIMITS.recipients; i++) await f.recipient(intent);
  await assert.rejects(f.recipient(intent), /unavailable/);
  assert.ok(buffers.at(-1)!.every(byte => byte === 0));
  f.restart();
  await f.recipient(intent);
  const lateCapacity = mock.method(f.plane as any, 'recipientSigningKey', async () => {
    const recipients = (f.plane as any).recipients as Map<string, unknown>;
    const existing = recipients.values().next().value;
    for (let i = recipients.size; i < FLEET_EXTENSION_LIMITS.recipients; i++) recipients.set(randomUUID(), existing);
    return signing.mock.original.call(f.plane);
  });
  await assert.rejects(f.recipient(intent), /unavailable/);
  assert.ok(buffers.at(-1)!.every(byte => byte === 0));
  lateCapacity.mock.restore();
  f.restart();
  const shutdown = mock.method(f.plane as any, 'recipientSigningKey', async () => { f.plane.shutdown(); return signing.mock.original.call(f.plane); });
  await assert.rejects(f.recipient(intent), /unavailable/);
  assert.ok(buffers.at(-1)!.every(byte => byte === 0));
  assert.equal((f.plane as any).recipients.size, 0);
  shutdown.mock.restore();
});
