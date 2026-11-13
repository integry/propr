import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extensionLibraryInputSchema, type ExtensionLibraryInput, type ExtensionLibraryServerInput, type ExtensionLibrarySkillInput } from '@propr/shared';
import { ExtensionLibraryStore, extensionTokenHash, libraryIdentity, type ExtensionGrantNetwork, type ExtensionLaunchContext, type PreparedExtensionLaunch } from '../src/extensions/extensionProfileStore.js';
import { extensionGatewayCall, redactExtensionOutput } from '../src/extensions/mcpGateway.js';
import { extensionEndpoint, resolveExtensionEndpoint, extensionPublicAddress } from '../src/extensions/endpointPolicy.js';
import { validateSkillFiles, readSkillArchive } from '../src/extensions/skillBundles.js';
import { unsealExtensionSecrets } from '../src/extensions/privateSecrets.js';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';

const secret = 'UNMISTAKABLE_EXTENSION_SENTINEL_DO_NOT_DISCLOSE';
const server = (extra: Partial<ExtensionLibraryServerInput> = {}): ExtensionLibraryServerInput => ({ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'bearer', repositories: [], agents: [], autoApply: true, ...extra } as ExtensionLibraryServerInput);
const skill = (bundleId: string, extra: Partial<ExtensionLibrarySkillInput> = {}): ExtensionLibrarySkillInput => ({ bundleId, enabled: true, repositories: [], agents: [], autoApply: true, ...extra });
const input = (servers: ExtensionLibraryServerInput[] = [server()], skills: ExtensionLibrarySkillInput[] = []): ExtensionLibraryInput => ({ version: 1, servers, skills });
const skillFiles = () => [{ path: 'SKILL.md', content: Buffer.from('---\nname: synthetic-skill\ndescription: A synthetic isolated skill\nrequirements: ["docs.lookup"]\n---\nRead the selected documentation.').toString('base64') }];
/** Launch context of a run that may use write servers; each grant still records its own write authority. */
const context: ExtensionLaunchContext = { agentAlias: 'claude-main', runtime: 'claude', repositories: ['team/repo'], allowWrite: true };
/** Run options asking for the library items that apply automatically. */
const automatic = (extra: { servers?: string[]; skills?: string[]; allowWrite?: boolean } = {}) => ({ autoApply: true, servers: [], skills: [], ...extra });
async function save(store: ExtensionLibraryStore, library: ExtensionLibraryInput, secrets: Record<string, string | null> = {}) {
  return store.saveLibrary('1', library, secrets, (await store.readLibrary('1')).revision);
}
const prepared = new Map<string, { launch: PreparedExtensionLaunch; context: ExtensionLaunchContext }>();
// eslint-disable-next-line max-params -- test helper mirrors the grant inputs
async function grant(store: ExtensionLibraryStore, taskId: string, network?: ExtensionGrantNetwork, allowWrite = false, launchContext = context) {
  const launch = await store.resolveLaunch(launchContext, false);
  const token = await store.createGrant(launch, taskId, network, allowWrite);
  prepared.set(token, { launch, context: launchContext });
  return token;
}
const activate = (store: ExtensionLibraryStore, token: string) => store.activateGrant(token, prepared.get(token)!.launch, prepared.get(token)!.context);
// eslint-disable-next-line max-params -- test helper mirrors the grant inputs
async function launch(store: ExtensionLibraryStore, taskId: string, network?: ExtensionGrantNetwork, allowWrite = false) {
  const token = await grant(store, taskId, network, allowWrite); await activate(store, token); return token;
}
async function fixture(t: TestContext) {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('config', t => { t.string('key').primary(); t.text('value'); });
  await database.schema.createTable('instance_members', t => { t.string('github_user_id').primary(); t.string('role'); });
  await database.schema.createTable('agent_definitions', t => { t.string('id').primary(); t.string('name'); });
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }, { github_user_id: '3', role: 'admin' }]);
  await up(database); await grantMigration(database); await libraryMigration(database);
  return { database, store: new ExtensionLibraryStore(database, { SYSTEM_TASK_SECRET: 'synthetic-private-custody-test-key' }) };
}

test('library save requires the expected revision and refuses malformed input without mutations', async t => {
  const { database, store } = await fixture(t);
  assert.equal((await store.readLibrary('1')).revision, 0);
  const library = await store.saveLibrary('1', input(), {}, 0);
  assert.equal(library.revision, 1);
  assert.deepEqual(await store.readLibrary('1'), library);
  const revisions = await database('extension_library_revisions').select('*');
  for (const expected of [undefined, -1, 1.5, '1', null, { revision: 1 }]) await assert.rejects(store.saveLibrary('1', input(), {}, expected as any), /Invalid expected library revision/);
  await assert.rejects(store.saveLibrary('1', input(), {}, 0), /revision changed/);
  for (const invalid of [{ ...input(), guard: 1 }, { ...input(), version: 2 }, input([server(), server()]), input([{ ...server(), command: 'sh' } as any])]) await assert.rejects(store.saveLibrary('1', invalid as any, {}, 1), /Invalid extension library/);
  assert.deepEqual(await database('extension_library_revisions').select('*'), revisions);
  assert.equal((await database('extension_library').first()).revision, 1);
});

test('native durable instance-admin library management, encrypted custody, revision fencing and immutable running grants without Connect', async t => {
  const { database, store } = await fixture(t);
  for (const actor of ['2', '4', 'bootstrap', '']) await assert.rejects(store.readLibrary(actor), /durable instance administrator/);
  const bundle = await store.importSkill('1', skillFiles(), { kind: 'archive', filename: 'synthetic.tar' });
  const library = await save(store, input([server()], [skill(bundle.id)]), { docs: secret });
  assert.deepEqual(library.secrets.docs, { fields: ['bearerToken'], configured: true });
  assert.equal(library.skillBundles[0].digest, bundle.digest);
  assert.ok(!JSON.stringify([await store.readLibrary('1'), await store.history('1')]).includes(secret));
  const encrypted = await database('extension_library_revisions').first();
  assert.ok(!JSON.stringify(encrypted).includes(secret));
  assert.throws(() => unsealExtensionSecrets(encrypted.secrets_encrypted, libraryIdentity(randomUUID(), 1), store.environment), /unavailable/);
  assert.throws(() => unsealExtensionSecrets(encrypted.secrets_encrypted, libraryIdentity(library.instanceId, 2), store.environment), /unavailable/);
  await assert.rejects(store.saveLibrary('2', input(), { docs: secret }, 1), /durable/);
  const pending = await grant(store, 'task-pending');
  await assert.rejects(store.grantSnapshot(pending), /exhausted/);
  await store.resolveLaunch(context);
  const token = await launch(store, 'task-running');
  const send = async (_url: string, body: unknown, supplied?: string) => {
    assert.equal(supplied, secret); const rpc = body as { id: number; method: string };
    return { jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'tools/list' ? { tools: [{ name: 'lookup' }, { name: 'delete_everything' }] } : { content: [{ type: 'text', text: `${secret} ${Buffer.from(secret).toString('base64')} Bearer ${secret}` }], authorization: secret } };
  };
  assert.deepEqual(await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, send), { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup' }] } });
  const result = await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lookup', arguments: {} } }, send);
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes(Buffer.from(secret).toString('base64')));
  await assert.rejects(extensionGatewayCall(store, token, 'unselected', { jsonrpc: '2.0', id: 3, method: 'ping' }, send), /capability/);
  await assert.rejects(extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_everything' } }, send), /tool unavailable/);
  await assert.rejects(extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 5, method: 'resources/read' }, send), /method/);
  const rotated = await store.replaceSecret('1', 'docs', 'NEW_UNMISTAKABLE_EXTENSION_SENTINEL', library.revision);
  assert.equal(rotated.revision, 2); assert.deepEqual(rotated.servers, library.servers);
  await assert.rejects(activate(store, pending), /changed/);
  await assert.rejects(store.saveLibrary('1', input(), {}, library.revision), /changed/);
  assert.equal((await store.grantSnapshot(token)).secrets.docs, secret);
  await store.setItemEnabled('1', { kind: 'server', name: 'docs' }, false);
  assert.deepEqual((await store.resolveLaunch(context)).set.servers, []);
  assert.equal((await store.grantSnapshot(token)).snapshot.revision, 1);
  await database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).delete();
  await assert.rejects(store.grantSnapshot(token), /expired/);
});

test('a save that drops a stored credential still refuses that credential in public fields', async t => {
  const { database, store } = await fixture(t);
  const stored = await save(store, input([server()]), { docs: secret });
  const other = server({ name: 'search', url: 'https://8.8.4.4/mcp', authentication: 'none' });
  const leaks: [string, ExtensionLibraryInput, Record<string, string | null>][] = [
    ['cleared', input([server({ tools: ['lookup', secret] })]), { docs: null }],
    ['removed with its server', input([{ ...other, tools: ['lookup', secret] } as ExtensionLibraryServerInput]), {}],
    ['withheld from a changed endpoint', input([server({ url: 'https://8.8.4.4/mcp', tools: ['lookup', secret] })]), {}],
    ['replaced', input([server({ tools: ['lookup', secret] })]), { docs: 'REPLACEMENT_EXTENSION_SENTINEL' }],
  ];
  for (const [label, library, replacements] of leaks) await assert.rejects(store.saveLibrary('1', library, replacements, stored.revision), /public library/, label);
  // A supplied replacement is checked even when another field carries it.
  await assert.rejects(store.saveLibrary('1', input([server(), { ...other, tools: ['lookup', 'NEW_SUPPLIED_SENTINEL'] } as ExtensionLibraryServerInput]), { docs: 'NEW_SUPPLIED_SENTINEL' }, stored.revision), /public library/);
  assert.equal((await store.readLibrary('1')).revision, stored.revision);
  assert.ok(!JSON.stringify([await store.history('1'), await database('extension_library_revisions').select('snapshot')]).includes(secret));
});

test('item limits, runtime, capability, public secrets and tenant substitution fail closed', async t => {
  const { database, store } = await fixture(t);
  await save(store, input([server({ agents: ['claude-main'], repositories: ['team/repo'] })]), { docs: secret });
  assert.equal((await store.resolveLaunch({ ...context, repositories: ['TEAM/REPO'] })).set.servers.length, 1);
  assert.equal((await store.resolveLaunch({ ...context, agentAlias: 'codex-other' })).set.servers.length, 0);
  assert.equal((await store.resolveLaunch({ ...context, repositories: ['other/repo'] })).set.servers.length, 0);
  await assert.rejects(store.resolveLaunch({ ...context, runtime: 'opencode' }), /Claude or Codex/);
  await save(store, input([server({ capability: 'write' })]), { docs: secret });
  assert.equal((await store.resolveLaunch({ ...context, allowWrite: false })).set.servers.length, 0);
  assert.equal((await store.resolveLaunch({ ...context, allowWrite: true })).set.servers.length, 1);
  await assert.rejects(save(store, input([server({ tools: ['lookup', secret] })]), { docs: secret }), /public library/);
  await assert.rejects(save(store, input([server()], [skill(randomUUID())]), { docs: secret }), /unavailable/);
  const moved = await save(store, input([server({ url: 'https://8.8.4.4/mcp' })]));
  assert.equal(moved.secrets.docs.configured, false);
  // Launch authority is the saved revision: no selecting administrator is needed.
  await database('instance_members').where({ github_user_id: '1' }).update({ role: 'member' });
  assert.equal((await store.resolveLaunch(context)).snapshot.revision, moved.revision);
  await assert.rejects(store.readLibrary('1'), /durable/);
  const { store: otherStore } = await fixture(t);
  assert.equal((await otherStore.resolveLaunch(context)).snapshot.revision, 0);
  assert.notEqual(await otherStore.instanceId(), await store.instanceId());
});

test('typed descriptors reject commands, host paths, mounts, credentials and unknown substitutions', () => {
  for (const addition of [{ hostPath: '/etc' }, { mounts: ['/var/run/docker.sock'] }, { command: 'curl example.com' }, { revision: 1 }]) assert.equal(extensionLibraryInputSchema.safeParse({ ...input(), ...addition }).success, false);
  for (const addition of [{ hostPath: '/etc' }, { mounts: ['/var/run/docker.sock'] }, { command: 'curl example.com' }, { env: { A: 'b' } }]) assert.equal(extensionLibraryInputSchema.safeParse(input([{ ...server(), ...addition } as any])).success, false);
  assert.equal(extensionLibraryInputSchema.safeParse(input([{ kind: 'stdio', name: 'shell', command: 'sh' } as any])).success, false);
  assert.equal(extensionLibraryInputSchema.safeParse(input([server(), server()])).success, false);
});

test('disabling and re-enabling keeps configuration, limits and the stored secret and is allowed while an automation adds the item', async t => {
  const { database, store } = await fixture(t);
  const bundle = await store.importSkill('1', skillFiles(), { kind: 'archive', filename: 'synthetic.tar' });
  const original = await save(store, input([server({ repositories: ['team/repo'], agents: ['claude-main'], autoApply: false }), server({ name: 'search', authentication: 'none' })], [skill(bundle.id, { autoApply: false })]), { docs: secret });
  await database('agent_definitions').insert({ id: 'automation-1', name: 'Nightly docs', extensions: JSON.stringify({ servers: ['docs'], skills: [bundle.id] }) });
  const off = await store.setItemEnabled('1', { kind: 'server', name: 'docs' }, false);
  assert.equal(off.revision, original.revision + 1);
  assert.deepEqual(off.servers[0], { ...original.servers[0], enabled: false });
  assert.deepEqual(off.servers[1], original.servers[1]);
  assert.deepEqual(off.secrets.docs, { fields: ['bearerToken'], configured: true });
  assert.equal((await store.validationTargets('1')).secrets.docs, secret);
  const skillOff = await store.setItemEnabled('1', { kind: 'skill', bundleId: bundle.id }, false);
  assert.equal(skillOff.skills[0].enabled, false);
  const explicit = await store.resolveLaunch({ ...context, additional: { servers: ['docs'], skills: [bundle.id] } });
  assert.deepEqual(explicit.set.servers.map(s => s.name), ['search']);
  assert.deepEqual(explicit.set.skipped.map(s => [s.name, s.reason]), [['docs', 'disabled'], [bundle.id, 'disabled']]);
  assert.equal((await store.setItemEnabled('1', { kind: 'skill', bundleId: bundle.id }, false)).revision, skillOff.revision, 'an unchanged toggle writes no revision');
  await store.setItemEnabled('1', { kind: 'skill', bundleId: bundle.id }, true);
  const on = await store.setItemEnabled('1', { kind: 'server', name: 'docs' }, true);
  assert.deepEqual(on.servers, original.servers); assert.deepEqual(on.skills, original.skills);
  assert.deepEqual(on.secrets.docs, { fields: ['bearerToken'], configured: true });
  assert.equal((await store.validationTargets('1')).secrets.docs, secret);
  assert.deepEqual((await store.resolveLaunch({ ...context, additional: { servers: ['docs'], skills: [bundle.id] } })).set.servers.map(s => s.name), ['docs', 'search']);
  // Removing or renaming an explicitly added item is refused, naming the automation.
  await assert.rejects(save(store, input([server({ name: 'search', authentication: 'none' })], [skill(bundle.id, { autoApply: false })])), /Nightly docs.*docs/);
  await assert.rejects(save(store, input([server({ name: 'docs-renamed' }), server({ name: 'search', authentication: 'none' })], [skill(bundle.id, { autoApply: false })])), /Nightly docs/);
  await assert.rejects(save(store, input([server({ repositories: ['team/repo'], agents: ['claude-main'], autoApply: false }), server({ name: 'search', authentication: 'none' })])), /Nightly docs/);
  // Removing an item no automation adds is allowed.
  assert.deepEqual((await save(store, input([server({ repositories: ['team/repo'], agents: ['claude-main'], autoApply: false })], [skill(bundle.id, { autoApply: false })]))).servers.map(s => s.name), ['docs']);
});

test('a server credential is stored once, write-only, and can be replaced or cleared per item', async t => {
  const { database, store } = await fixture(t);
  const library = await save(store, input([server(), server({ name: 'other', url: 'https://8.8.4.4/mcp' })]), { docs: secret, other: 'OTHER_UNMISTAKABLE_SENTINEL' });
  const row = await database('extension_library_revisions').where({ revision: library.revision }).first();
  assert.deepEqual(unsealExtensionSecrets(row.secrets_encrypted, libraryIdentity(library.instanceId, library.revision), store.environment), { docs: secret, other: 'OTHER_UNMISTAKABLE_SENTINEL' });
  for (const view of [library, await store.readLibrary('1'), await store.history('1')]) assert.ok(!JSON.stringify(view).includes(secret));
  await assert.rejects(store.replaceSecret('1', 'missing', secret), /unavailable/);
  await assert.rejects(store.replaceSecret('1', 'docs', 'bad secret with spaces'), /Invalid secret/);
  await assert.rejects(store.replaceSecret('1', 'docs', secret, 0), /revision changed/);
  const cleared = await store.replaceSecret('1', 'docs', null);
  assert.equal(cleared.secrets.docs.configured, false); assert.equal(cleared.secrets.other.configured, true);
  const next = await database('extension_library_revisions').where({ revision: cleared.revision }).first();
  assert.deepEqual(unsealExtensionSecrets(next.secrets_encrypted, libraryIdentity(library.instanceId, cleared.revision), store.environment), { other: 'OTHER_UNMISTAKABLE_SENTINEL' });
  await assert.rejects(store.saveLibrary('1', input(), { missing: secret }, cleared.revision), /Invalid secret replacement/);
});

test('non-administrators and stale administrator sessions are refused for every management call', async t => {
  const { database, store } = await fixture(t);
  await save(store, input([server({ authentication: 'none' })]));
  const bundle = await store.importSkill('1', skillFiles(), { kind: 'archive', filename: 'synthetic.tar' });
  const calls = (actor: string) => [
    () => store.readLibrary(actor), () => store.history(actor), () => store.listSkillBundles(actor), () => store.validationTargets(actor),
    () => store.saveLibrary(actor, input([server({ authentication: 'none' })]), {}, 1),
    () => store.setItemEnabled(actor, { kind: 'server', name: 'docs' }, false),
    () => store.replaceSecret(actor, 'docs', secret),
    () => store.importSkill(actor, skillFiles(), { kind: 'archive', filename: 'x.tar' }),
  ];
  for (const actor of ['2', '4', 'bootstrap', '']) for (const call of calls(actor)) await assert.rejects(call(), /durable instance administrator/);
  await database('instance_members').where({ github_user_id: '3' }).update({ role: 'member' });
  for (const call of calls('3')) await assert.rejects(call(), /durable instance administrator/);
  assert.equal((await store.readLibrary('1')).revision, 1);
  assert.equal((await store.listSkillBundles('1'))[0].id, bundle.id);
});

test('automation runs launch with auto-applied plus added items, report skipped ones, and launch plainly with neither', async t => {
  const { executeWithExtensions, currentExtensionLaunch } = await import('../src/extensions/extensionLaunch.js');
  const { agentTaskOptions } = await import('../../../src/jobs/agentRuns/agentTaskOptions.js');
  const { database, store } = await fixture(t);
  await database.schema.createTable('tasks', c => c.string('task_id').primary());
  await database.schema.createTable('task_history', c => { c.string('task_id'); c.string('state'); c.string('timestamp'); c.text('reason'); c.text('metadata'); });
  const config = { type: 'claude' as const, alias: 'claude-main', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: '/unused', supportedModels: ['synthetic'] };
  const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
  const options = (taskId: string, extensions: { servers: string[]; skills: string[] }) => agentTaskOptions({ runId: 'run', taskId, definition: { id: 'definition', ownerId: '1', extensions, repositories: ['team/repo'], capabilities: [] } as any, issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, prompt: 'Run phase', model: undefined, token: '', workspace: { worktreePath: '/unused', promptWorkspace: { repositoriesReadable: false } } as any });
  const run = async (taskId: string, extensions: { servers: string[]; skills: string[] }) => {
    await database('tasks').insert({ task_id: taskId });
    let names: string[] | undefined;
    await executeWithExtensions(config, options(taskId, extensions), async prepared => {
      if (currentExtensionLaunch()) await currentExtensionLaunch()!.beforeLaunch();
      names = prepared.toolPolicy?.mcpServers?.map(s => s.name);
      return result;
    }, store);
    const history = await database('task_history').where({ task_id: taskId });
    return { names, resolution: history.map(h => JSON.parse(h.metadata)).find(m => m.event === 'extensions.resolved') };
  };
  // An automation with neither auto-applied nor added items launches without extensions.
  assert.deepEqual(await run('neither', { servers: [], skills: [] }), { names: undefined, resolution: { event: 'extensions.resolved', libraryRevision: 0, servers: [], skills: [], skipped: [], omitted: [] } });
  await save(store, input([server({ name: 'auto', authentication: 'none' }), server({ name: 'added', authentication: 'none', autoApply: false }), server({ name: 'manual-only', authentication: 'none', autoApply: false })]));
  const both = await run('both', { servers: ['added'], skills: [] });
  assert.deepEqual(both.names, ['added', 'auto']);
  assert.deepEqual(both.resolution.servers, ['added', 'auto']);
  await store.setItemEnabled('1', { kind: 'server', name: 'added' }, false);
  const skipped = await run('skipped', { servers: ['added'], skills: [] });
  assert.deepEqual(skipped.names, ['auto']);
  assert.deepEqual(skipped.resolution.skipped, [{ kind: 'server', name: 'added', reason: 'disabled', source: 'additional' }]);
  // Explicit items in a goal-mode run are refused; auto-applied ones are simply not used there.
  await assert.rejects(executeWithExtensions(config, { ...options('goal', { servers: ['added'], skills: [] }), executionMode: 'goal' } as any, async () => result, store), /isolated task run/);
  assert.equal((await database('extension_run_grants')).length, 0);
});

test('HTTPS policy refuses private, metadata, mapped addresses and DNS rebinding', async () => {
  for (const url of ['http://example.com/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/mcp#token', 'https://example.com/mcp?token=secret', 'https://localhost/mcp', 'https://127.0.0.1/mcp', 'https://169.254.169.254/mcp', 'https://10.0.0.1/mcp', 'https://[::ffff:127.0.0.1]/mcp', 'https://[fc00::1]/mcp']) assert.throws(() => extensionEndpoint(url));
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '172.16.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2001:db8::1']) assert.equal(extensionPublicAddress(address), false, address);
  assert.equal(extensionPublicAddress('198.18.0.1'), true);
  assert.equal((await resolveExtensionEndpoint('https://tools.example.com/mcp', async () => [{ address: '198.18.0.1', family: 4 }])).address, '198.18.0.1');
  await assert.rejects(resolveExtensionEndpoint('https://tools.example.com/mcp', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]), /public/);
  let calls = 0; const lookup = async () => [{ address: ++calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  assert.equal((await resolveExtensionEndpoint('https://tools.example.com/mcp', lookup)).address, '8.8.8.8');
  await assert.rejects(resolveExtensionEndpoint('https://tools.example.com/mcp', lookup), /public/);
});

function tarEntry(name: string, body: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512); header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116); header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
  const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
const archive = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);
test('bounded immutable skill archives reject traversal, links, devices, duplicate/colliding paths and bombs', () => {
  const body = Buffer.from(skillFiles()[0].content, 'base64');
  assert.equal(readSkillArchive(archive(tarEntry('SKILL.md', body))).length, 1);
  assert.equal(readSkillArchive(gzipSync(archive(tarEntry('SKILL.md', body)))).length, 1);
  for (const name of ['../SKILL.md', '/SKILL.md', 'a/../../SKILL.md', 'a\\SKILL.md', 'C:/SKILL.md']) assert.throws(() => readSkillArchive(archive(tarEntry(name, body))));
  for (const type of ['1', '2', '3', '4', '6', 'x', 'L']) assert.throws(() => readSkillArchive(archive(tarEntry('SKILL.md', body, type))));
  assert.throws(() => readSkillArchive(archive(tarEntry('SKILL.md', body), tarEntry('skill.md', body))));
  assert.throws(() => readSkillArchive(archive(tarEntry('SKILL.md', body), tarEntry('Assets/', Buffer.alloc(0), '5'), tarEntry('assets/file.txt', Buffer.from('asset')))));
  assert.throws(() => readSkillArchive(archive(tarEntry('SKILL.md', body), tarEntry('SKILL.md', body))));
  assert.throws(() => readSkillArchive(gzipSync(Buffer.alloc(8 * 1024 * 1024))));
  assert.throws(() => validateSkillFiles([{ path: 'SKILL.md', content: Buffer.from('no frontmatter').toString('base64') }]));
  assert.throws(() => validateSkillFiles([{ path: 'asset.txt', content: Buffer.from('missing skill').toString('base64') }]));
  const files = skillFiles(); const before = validateSkillFiles(files).digest;
  assert.equal(validateSkillFiles([...files]).digest, before);
  assert.notEqual(validateSkillFiles([{ ...files[0], content: Buffer.from(body.toString() + '\nChanged').toString('base64') }]).digest, before);
});

test('selected skill appears only in its read-only run staging and all temporary state is cleaned', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-launch-')); const oldData = process.env.DATA_DIR; const oldTransport = process.env.PROPR_EGRESS_SOCKET_DIR;
  extensionTestResources(t).defer(async () => { if (oldTransport === undefined) delete process.env.PROPR_EGRESS_SOCKET_DIR; else process.env.PROPR_EGRESS_SOCKET_DIR = oldTransport; if (oldData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldData; await fs.rm(root, { recursive: true, force: true }); });
  process.env.DATA_DIR = root; process.env.PROPR_EGRESS_SOCKET_DIR = root;
  const { executeWithExtensions, currentExtensionLaunch } = await import('../src/extensions/extensionLaunch.js');
  extensionTestResources(t).defer(async () => { await (await import('../src/db/connection.js')).closeConnection(); });
  const { database, store } = await fixture(t);
  const bundle = await store.importSkill('1', skillFiles(), { kind: 'github', repository: 'team/repo', commit: 'a'.repeat(40), directory: 'skills/synthetic' });
  await save(store, input([server(), server({ name: 'docs-tools' })], [skill(bundle.id)]), { docs: secret, 'docs-tools': secret });
  const config = { type: 'claude' as const, alias: 'claude-main', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: root, supportedModels: ['synthetic'] };
  const options = { extensions: automatic(), taskId: 'selected-run', issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: root, prompt: 'A selected run', githubToken: '' };
  const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
  let staged = '';
  await executeWithExtensions(config, options, async prepared => {
    const launch = currentExtensionLaunch()!; assert.ok(launch);
    const { claudeToolPolicyArgs, codexToolPolicyArgs } = await import('../src/agents/agentToolPolicy.js');
    assert.doesNotThrow(() => claudeToolPolicyArgs(prepared.toolPolicy!));
    assert.doesNotThrow(() => codexToolPolicyArgs(prepared.toolPolicy!));
    assert.equal(prepared.toolPolicy!.mcpServers![1].name, 'docs-tools');
    assert.match(launch.mounts[1], /readonly,bind-recursive=disabled$/);
    staged = launch.mounts[1].match(/source=([^,]+)/)![1];
    assert.match(await fs.readFile(path.join(staged, bundle.id, 'SKILL.md'), 'utf8'), /synthetic-skill/);
    assert.match(prepared.prompt, /\/opt\/propr\/extensions/);
    assert.ok(!JSON.stringify(prepared.toolPolicy!.mcpServers!.map(({ bearerToken: _token, ...args }) => args)).includes(secret));
    const { extensionLaunchForDockerRun } = await import('../src/extensions/extensionLaunch.js');
    assert.equal(extensionLaunchForDockerRun('docker', ['run'], { taskId: options.taskId, extensionAgentLaunch: true }), launch);
    assert.equal(extensionLaunchForDockerRun('docker', ['run'], {}), undefined);
    assert.equal(extensionLaunchForDockerRun('docker', ['run'], { taskId: options.taskId }), undefined);
    assert.equal(extensionLaunchForDockerRun('docker', ['run'], { taskId: options.taskId, extensionAgentLaunch: true, costCapExempt: true }), undefined);
    assert.equal(extensionLaunchForDockerRun('docker', ['run'], { taskId: 'another-task', extensionAgentLaunch: true }), undefined);
    await launch.beforeLaunch();
    await launch.beforeLaunch();
    const token = prepared.toolPolicy!.mcpServers![0].bearerToken;
    await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup' } }, async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: secret }] } }));
    return result;
  }, store);
  await assert.rejects(fs.stat(staged), /ENOENT/);
  assert.equal((await database('extension_run_grants')).length, 0);
  await executeWithExtensions(config, { ...options, extensions: null }, async prepared => { assert.equal(currentExtensionLaunch(), undefined); assert.ok(!prepared.prompt.includes('/opt/propr/extensions')); return result; }, store);
  assert.ok(!JSON.stringify(redactExtensionOutput({ Authorization: secret, text: secret }, [secret])).includes(secret));
});

test('synthetic HTTPS MCP enforces TLS, pins the vetted address, refuses redirects and bounds/redacts responses', async t => {
  const https = (await import('node:https')).default;
  const { execFileSync } = await import('node:child_process');
  const { requestExtensionMcp } = await import('../src/extensions/endpointPolicy.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-https-'));
  extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=mcp.synthetic.example', '-addext', 'subjectAltName=DNS:mcp.synthetic.example'], { stdio: 'ignore' });
  const cert = await fs.readFile(path.join(root, 'cert.pem')); let redirect = false; let oversized = false; let authorizations = 0; let protocolError = false; let errorWire = '';
  const server = https.createServer({ key: await fs.readFile(path.join(root, 'key.pem')), cert }, async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`); authorizations++;
    if (redirect) { res.writeHead(307, { location: 'https://127.0.0.1/metadata' }).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    if (protocolError) {
      errorWire = '   ' + JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: secret, data: { secret } } }) + '\n';
      res.writeHead(200, { 'content-type': 'application/json' }).end(errorWire); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: oversized ? 'x'.repeat(1024 * 1024 + 1) : secret }] } }));
  });
  extensionTestResources(t).defer(() => new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as import('node:net').AddressInfo;
  const original = https.request;
  // Only the test transport maps the already-vetted public destination to the
  // synthetic TLS fixture. Production uses the checked lookup unchanged.
  t.mock.method(https, 'request', (url: URL, options: import('node:https').RequestOptions, callback: Parameters<typeof https.request>[2]) => {
    assert.equal(url.href, 'https://8.8.8.8/mcp');
    (options.lookup as Function)('8.8.8.8', {}, (error: unknown, address: string) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); });
    return original(`https://127.0.0.1:${port}/mcp`, { ...options, lookup: undefined, ca: cert, servername: 'mcp.synthetic.example' }, callback);
  });
  const { database, store } = await fixture(t);
  extensionTestResources(t).defer(() => t.mock.restoreAll());
  await save(store, input(), { docs: secret }); const token = await launch(store, 'https-selected');
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup' } };
  const output = await extensionGatewayCall(store, token, 'docs', body); assert.ok(!JSON.stringify(output).includes(secret)); assert.equal(authorizations, 1);
  await assert.rejects(extensionGatewayCall(store, 'x'.repeat(43), 'docs', body), /expired/); assert.equal(authorizations, 1);
  redirect = true; await assert.rejects(requestExtensionMcp('https://8.8.8.8/mcp', body, secret), /connection failed/); assert.equal(authorizations, 2);
  redirect = false; oversized = true; await assert.rejects(requestExtensionMcp('https://8.8.8.8/mcp', body, secret), /connection failed/);
  oversized = false;
  const before = (await database('extension_run_grants').first()).bytes;
  assert.equal(await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await database('extension_run_grants').first()).bytes, before);
  protocolError = true;
  assert.deepEqual(await extensionGatewayCall(store, token, 'docs', body), { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'MCP request failed' } });
  const charged = await database('extension_run_grants').first();
  assert.equal(charged.bytes, before + Buffer.byteLength(errorWire));
  assert.equal(charged.connections, 0);
});

test('concurrent edits, pending launch disable/removal/rotation/limits and exhausted grants refuse safely', async t => {
  const { database, store } = await fixture(t);
  await save(store, input(), { docs: secret });
  const raced = await Promise.allSettled([store.saveLibrary('1', input([server({ tools: ['a'] })]), {}, 1), store.saveLibrary('1', input([server({ tools: ['b'] })]), {}, 1)]);
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1); assert.equal(raced.filter(r => r.status === 'rejected').length, 1);
  for (const operation of ['disable', 'remove', 'rotate', 'limit']) {
    await save(store, input(), { docs: secret });
    const token = await grant(store, 'pending-' + operation);
    if (operation === 'disable') await store.setItemEnabled('1', { kind: 'server', name: 'docs' }, false);
    if (operation === 'remove') await save(store, input([]));
    if (operation === 'rotate') await store.replaceSecret('1', 'docs', 'ROTATED_UNMISTAKABLE_SENTINEL');
    if (operation === 'limit') await save(store, input([server({ repositories: ['other/repo'] })]));
    await assert.rejects(activate(store, token), /changed/, operation);
  }
  // Edits to items the run does not use, or additions, do not refuse it.
  await save(store, input(), { docs: secret });
  const unaffected = await grant(store, 'pending-unrelated');
  await save(store, input([server(), server({ name: 'other', authentication: 'none' })]));
  await activate(store, unaffected);
  const token = await launch(store, 'bounded-run');
  await database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).update({ calls: 256 });
  await assert.rejects(store.grantSnapshot(token), /exhausted/);
  await database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).update({ calls: 0, connections: 4 });
  await assert.rejects(store.grantSnapshot(token), /exhausted/);
  await database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).update({ connections: 0, bytes: 16 * 1024 * 1024 });
  await assert.rejects(store.grantSnapshot(token), /exhausted/);
});

test('extension credentials are redacted across every possible subprocess chunk split before retention', async () => {
  const { ExtensionStreamRedactor } = await import('../src/extensions/extensionOutput.js');
  for (const variant of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')]) {
    const source = `before ${variant} after\n`;
    for (let cut = 0; cut < source.length; cut++) {
      const redactor = new ExtensionStreamRedactor([secret]);
      const output = redactor.push(source.slice(0, cut)) + redactor.push(source.slice(cut)) + redactor.finish();
      assert.equal(output, 'before [REDACTED] after\n');
    }
  }
});

test('extension gateway reuses container MCP routing without accepting URL credentials', async () => {
  const { extensionGatewayBaseUrl } = await import('../src/extensions/extensionLaunch.js');
  assert.equal(extensionGatewayBaseUrl({}), 'http://api:4000/api/extensions/mcp');
  assert.equal(extensionGatewayBaseUrl({ PROPR_INTERNAL_API_URL: 'https://core.example.com/' }), 'https://core.example.com/api/extensions/mcp');
  assert.equal(extensionGatewayBaseUrl({ PROPR_AGENT_MCP_URL: 'https://core.example.com/prefix/api/mcp' }), 'https://core.example.com/prefix/api/extensions/mcp');
  assert.throws(() => extensionGatewayBaseUrl({ PROPR_AGENT_MCP_URL: 'https://user:sentinel@core.example.com/api/mcp' }), /credential-free/);
});

test('stored revision and credential substitutions cannot redirect a live grant to another revision', async t => {
  const { database, store } = await fixture(t);
  const first = await save(store, input(), { docs: secret });
  const token = await launch(store, 'bound-live-grant');
  const second = await store.replaceSecret('1', 'docs', 'OTHER_UNMISTAKABLE_EXTENSION_SENTINEL');
  const source = await database('extension_library_revisions').where({ revision: second.revision }).first();
  await database('extension_library_revisions').where({ revision: first.revision }).update({ snapshot: source.snapshot, secrets_encrypted: source.secrets_encrypted });
  await assert.rejects(store.grantSnapshot(token), /identity mismatch/);
  await database('extension_library_revisions').where({ revision: first.revision }).update({ snapshot: JSON.stringify(first) });
  await assert.rejects(store.grantSnapshot(token), /credentials unavailable/);
  await database('extension_library_revisions').where({ revision: second.revision }).update({ snapshot: JSON.stringify(first) });
  await assert.rejects(store.readLibrary('1'), /identity mismatch/);
});

test('gateway accepts progress metadata without forwarding it and preserves credential-named schemas', async t => {
  const { store } = await fixture(t);
  await save(store, input(), { docs: secret });
  const token = await launch(store, 'progress');
  await activate(store, token); // Same task's retry is idempotent.
  const schema = { type: 'object', properties: { page_token: { type: 'string' }, secret: { type: 'string' }, password: { type: 'string' }, authorization: { type: 'string' } } };
  const catalog = await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, async () => ({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup', inputSchema: schema, description: secret }] } }));
  assert.deepEqual((catalog as any).result.tools[0].inputSchema, schema);
  assert.equal((catalog as any).result.tools[0].description, '[REDACTED]');
  const body = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lookup', arguments: { page_token: 'next' }, _meta: { progressToken: 'progress-1' } } };
  await extensionGatewayCall(store, token, 'docs', body, async (_url, forwarded) => {
    assert.deepEqual(forwarded, { ...body, params: { name: 'lookup', arguments: { page_token: 'next' } } });
    return { jsonrpc: '2.0', id: 2, result: { Authorization: 'Bearer unrelated', text: secret } };
  });
  await assert.rejects(extensionGatewayCall(store, token, 'docs', { ...body, params: { ...body.params, unauthorized: true } }), /tool unavailable/);
  await assert.rejects(extensionGatewayCall(store, token, 'docs', { ...body, params: { ...body.params, name: 'unselected' } }), /tool unavailable/);
  assert.deepEqual(redactExtensionOutput({ headers: { Authorization: 'Bearer unrelated', 'x-api-key': 'unknown' }, next_token: 'next', password: { type: 'string' } }, []), { headers: { Authorization: '[REDACTED]', 'x-api-key': '[REDACTED]' }, next_token: 'next', password: { type: 'string' } });
});

test('snapshot loading failures release only their own reserved slot and keep failure charges', async t => {
  const { database, store } = await fixture(t);
  const library = await save(store, input(), { docs: secret });
  const token = await launch(store, 'bad-snapshot');
  const revision = await database('extension_library_revisions').first();
  // Keep a successful call outstanding: failed loads must not release its slot.
  await store.grantSnapshot(token);
  for (const mutation of [
    { snapshot: JSON.stringify({ ...library, instanceId: randomUUID() }) },
    { snapshot: revision.snapshot, secrets_encrypted: 'invalid' },
  ]) {
    await database('extension_library_revisions').update(mutation);
    await assert.rejects(extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'ping' }));
    assert.equal((await database('extension_run_grants').first()).connections, 1);
  }
  await database('extension_library_revisions').delete();
  await assert.rejects(store.grantSnapshot(token), /unavailable/);
  const grantRow = await database('extension_run_grants').first();
  assert.equal(grantRow.connections, 1); assert.equal(grantRow.calls, 4);
  const { EXTENSION_LIMITS } = await import('@propr/shared');
  assert.equal(grantRow.bytes, 4 * EXTENSION_LIMITS.responseBytes);
  await store.finishGatewayCall(token, EXTENSION_LIMITS.responseBytes);
  assert.equal((await database('extension_run_grants').first()).connections, 0);
});

test('operator catalog projections exclude internals and customers cannot smuggle stdio fields', async t => {
  const { database, store } = await fixture(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-catalog-')); extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const { operatorCatalogDigest } = await import('../src/extensions/operatorCatalog.js');
  const entry = { id: 'local-docs', kind: 'stdio' as const, executable: '/usr/bin/env', args: ['node', '--version', 'CATALOG_ARGUMENT_SENTINEL'], secretEnv: { API_KEY: 'OPERATOR_DOCS_KEY' }, tools: ['lookup'], capability: 'read' as const };
  const filename = path.join(root, 'catalog.json'); await fs.writeFile(filename, JSON.stringify([entry]), { mode: 0o600 });
  store.environment.PROPR_EXTENSION_CATALOG_FILE = filename; store.environment.OPERATOR_DOCS_KEY = secret;
  const descriptor = server({ kind: 'catalog', name: 'local', catalogId: entry.id, digest: operatorCatalogDigest(entry), enabled: true, tools: ['lookup'], capability: 'read', authentication: undefined } as any);
  delete (descriptor as any).authentication; delete (descriptor as any).url;
  delete store.environment.OPERATOR_DOCS_KEY;
  const pending = await save(store, input([descriptor]));
  assert.equal(pending.secrets.local.configured, false);
  // A catalog server without its operator credential is skipped, never a launch failure.
  for (const additional of [null, { servers: ['local'], skills: [] }]) {
    const unconfigured = await store.resolveLaunch({ ...context, additional });
    assert.deepEqual(unconfigured.set.servers, []);
    assert.ok(unconfigured.set.skipped.some(s => s.name === 'local' && s.reason === 'secret_not_configured' && s.source === (additional ? 'additional' : 'auto')));
    assert.ok(unconfigured.set.skipped.every(s => s.reason === 'secret_not_configured'));
  }
  // Availability is read from the environment at launch, not from the saved status.
  store.environment.OPERATOR_DOCS_KEY = secret;
  assert.deepEqual((await store.resolveLaunch(context)).set.servers.map(s => s.name), ['local']);
  const library = await save(store, input([descriptor]));
  assert.deepEqual(library.secrets.local, { count: 1, configured: true });
  const projection = JSON.stringify({ library: await store.readLibrary('1'), history: await store.history('1'), catalog: await store.catalog.publicEntries() });
  for (const forbidden of [secret, entry.executable, '--version', 'CATALOG_ARGUMENT_SENTINEL', 'API_KEY', 'OPERATOR_DOCS_KEY', filename]) assert.ok(!projection.includes(forbidden), forbidden);
  assert.deepEqual((await store.catalog.publicEntries())[0], { id: entry.id, digest: (descriptor as any).digest, tools: ['lookup'], capability: 'read', secrets: { count: 1, configured: true } });
  // Previously saved revisions must also stop exposing child environment names.
  await database('extension_library_revisions').where({ revision: library.revision }).update({ snapshot: JSON.stringify({ ...library, secrets: { local: { fields: ['API_KEY'], configured: true } } }) });
  for (const view of [await store.readLibrary('1'), await store.history('1')]) assert.ok(!JSON.stringify(view).includes('API_KEY'));
  for (const patch of [{ command: '/bin/sh' }, { args: ['-c', 'id'] }, { argv: ['id'] }, { env: { API_KEY: secret } }, { hostPath: '/etc' }, { socket: '/var/run/docker.sock' }, { bindMount: '/etc:/etc' }, { url: 'https://internal.local' }]) {
    assert.equal(extensionLibraryInputSchema.safeParse(input([{ ...descriptor, ...patch } as any])).success, false);
    await assert.rejects(save(store, input([{ ...descriptor, ...patch } as any])), /Invalid extension library/);
  }
  await assert.rejects(save(store, input([{ ...descriptor, digest: '0'.repeat(64) } as any])), /digest changed/);
  await assert.rejects(save(store, input([{ ...descriptor, tools: ['delete'] }])), /capability unavailable/);
  await assert.rejects(save(store, input([{ ...descriptor, capability: 'write' }])), /capability unavailable/);
  const writeEntry = { ...entry, id: 'local-writes', capability: 'write' as const };
  await fs.writeFile(filename, JSON.stringify([entry, writeEntry]));
  await assert.rejects(save(store, input([{ ...descriptor, catalogId: writeEntry.id, digest: operatorCatalogDigest(writeEntry), capability: 'read' } as any])), /capability unavailable/);
  await fs.writeFile(filename, JSON.stringify([{ ...entry, args: ['--changed'] }]));
  await assert.rejects(store.resolveLaunch(context), /digest changed/);
});

test('catalog stdio is callable through both selected authorized launcher policies and never retains sentinel secrets', async t => {
  const { database, store } = await fixture(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-launch-')); extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const { operatorCatalogDigest } = await import('../src/extensions/operatorCatalog.js');
  const { executeWithExtensions, currentExtensionLaunch } = await import('../src/extensions/extensionLaunch.js');
  const { claudeToolPolicyArgs, codexToolPolicyArgs } = await import('../src/agents/agentToolPolicy.js');
  const { spawn } = await import('node:child_process'); const { createInterface } = await import('node:readline');
  const code = `const rl = require('node:readline').createInterface({input:process.stdin}); rl.on('line', line => { const rpc=JSON.parse(line); if(rpc.id===undefined)return; const result = rpc.method==='tools/list' ? {tools:[{name:'lookup'},{name:'delete'}]} : {content:[{type:'text',text:'called '+process.env.API_KEY+' '+Buffer.from(process.env.API_KEY).toString('base64')}]}; process.stderr.write(process.env.API_KEY); console.log(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})); });`;
  // The allowlisted env executable invokes this suite's Node via a fixed argument,
  // including NVM/toolcache runtimes outside the production executable roots.
  const entry = { id: 'synthetic-docs', kind: 'stdio' as const, executable: '/usr/bin/env', args: [process.execPath, '-e', code], secretEnv: { API_KEY: 'OPERATOR_DOCS_KEY' }, tools: ['lookup'], capability: 'read' as const };
  const catalogFile = path.join(root, 'catalog.json'); await fs.writeFile(catalogFile, JSON.stringify([entry]), { mode: 0o600 });
  store.environment.PROPR_EXTENSION_CATALOG_FILE = catalogFile; store.environment.OPERATOR_DOCS_KEY = secret;
  await save(store, input([{ kind: 'catalog', name: 'local', catalogId: entry.id, digest: operatorCatalogDigest(entry), enabled: true, tools: ['lookup'], capability: 'read' }]));
  const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
  const options = { extensions: automatic(), taskId: 'catalog-selected', issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: root, prompt: 'Use selected tools', githubToken: '' };
  for (const runtime of ['claude', 'codex'] as const) {
    const config = { type: runtime, alias: runtime, id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: root, supportedModels: ['synthetic'] };
    await executeWithExtensions(config, options, async prepared => {
      await currentExtensionLaunch()!.beforeLaunch();
      const launch = runtime === 'claude' ? claudeToolPolicyArgs(prepared.toolPolicy!) : codexToolPolicyArgs(prepared.toolPolicy!);
      assert.ok(!JSON.stringify(launch.cliArgs).includes(secret));
      assert.ok(!JSON.stringify(launch).includes(secret));
      assert.ok(!JSON.stringify(prepared.toolPolicy).includes(secret));
      const local = prepared.toolPolicy!.localMcpServers![0];
      assert.equal(Object.values(launch.env)[0], secret);
      const child = spawn(process.execPath, [path.resolve('scripts/extension-stdio-bridge.mjs'), local.bridgeConfig], { cwd: root, env: { ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      let logs = ''; child.stderr.on('data', chunk => { logs += chunk; });
      const reader = createInterface({ input: child.stdout }); const lines: string[] = []; const waiters: ((line: string) => void)[] = [];
      reader.on('line', line => { lines.push(line); waiters.shift()?.(line); });
      const call = async (rpc: unknown) => { const reply = new Promise<string>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('stdio fixture timed out')), 5000); waiters.push(line => { clearTimeout(timer); resolve(line); }); child.once('close', () => { clearTimeout(timer); reject(new Error('stdio fixture closed')); }); }); child.stdin.write(JSON.stringify(rpc) + '\n'); return JSON.parse(await reply); };
      try {
        const tools = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }); assert.deepEqual(tools.result.tools, [{ name: 'lookup' }]);
        const output = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lookup' } }); assert.match(output.result.content[0].text, /^called \[REDACTED\] \[REDACTED\]$/);
        const refused = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete' } }); assert.ok(refused.error);
        assert.ok(!JSON.stringify(lines).includes(secret)); assert.equal(logs, '');
      } finally { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('close', () => resolve())); } reader.close(); }
      return result;
    }, store);
    await executeWithExtensions(config, { ...options, extensions: null }, async prepared => { assert.equal(prepared.toolPolicy, undefined); assert.equal(currentExtensionLaunch(), undefined); return result; }, store);
    // A disabled item applies to no run: the launch carries no extensions.
    await store.setItemEnabled('1', { kind: 'server', name: 'local' }, false);
    await executeWithExtensions(config, options, async prepared => { assert.equal(prepared.toolPolicy, undefined); assert.equal(currentExtensionLaunch(), undefined); return result; }, store);
    await store.setItemEnabled('1', { kind: 'server', name: 'local' }, true);
    await assert.rejects(executeWithExtensions(config, options, async prepared => { const changed = { ...entry, args: ['--version'] }; await fs.writeFile(catalogFile, JSON.stringify([changed])); await currentExtensionLaunch()!.beforeLaunch(); return result; }, store), /digest changed/);
    await fs.writeFile(catalogFile, JSON.stringify([entry]));
  }
  for (const name of await fs.readdir(root)) assert.ok(!(await fs.readFile(path.join(root, name), 'utf8')).includes(secret));
  assert.equal((await database('extension_run_grants')).length, 0);
  assert.ok(!JSON.stringify(await database('extension_library_revisions')).includes(secret));
});

test('an auto-applied catalog server without credentials is skipped and the run executes without it', async t => {
  const { database, store } = await fixture(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-unconfigured-')); extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const { operatorCatalogDigest } = await import('../src/extensions/operatorCatalog.js');
  const { executeWithExtensions, currentExtensionLaunch } = await import('../src/extensions/extensionLaunch.js');
  const entry = { id: 'synthetic-docs', kind: 'stdio' as const, executable: '/usr/bin/env', args: ['node', '--version'], secretEnv: { API_KEY: 'UNCONFIGURED_DOCS_KEY' }, tools: ['lookup'], capability: 'read' as const };
  const catalogFile = path.join(root, 'catalog.json'); await fs.writeFile(catalogFile, JSON.stringify([entry]), { mode: 0o600 });
  store.environment.PROPR_EXTENSION_CATALOG_FILE = catalogFile; delete store.environment.UNCONFIGURED_DOCS_KEY;
  await save(store, input([{ kind: 'catalog', name: 'local', catalogId: entry.id, digest: operatorCatalogDigest(entry), enabled: true, tools: ['lookup'], capability: 'read' }]));
  const config = { type: 'claude' as const, alias: 'claude', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: root, supportedModels: ['synthetic'] };
  const options = { extensions: automatic(), taskId: 'catalog-unconfigured', issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: root, prompt: 'Run', githubToken: '' };
  let executed = false;
  await executeWithExtensions(config, options, async prepared => {
    executed = true; assert.equal(prepared.toolPolicy, undefined); assert.equal(currentExtensionLaunch(), undefined);
    return { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
  }, store);
  assert.ok(executed);
  assert.equal((await database('extension_run_grants')).length, 0);
  // An invalid catalog identity is still refused rather than skipped.
  await fs.writeFile(catalogFile, JSON.stringify([{ ...entry, args: ['--changed'] }]));
  await assert.rejects(executeWithExtensions(config, options, async () => assert.fail('must not execute'), store), /digest changed/);
});

test('immutable gateway policy enforces allowlist on every call and private DNS re-resolution; catalog exceptions remain bounded', async t => {
  const { database, store } = await fixture(t);
  await save(store, input(), { docs: secret });
  const token = await launch(store, 'restricted-gateway', { mode: 'restricted', allow: [], instanceAllow: [] });
  let sent = false;
  await assert.rejects(extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'ping' }, async () => { sent = true; return {}; }), /network policy/);
  assert.equal(sent, false); const row = await database('extension_run_grants').first(); assert.equal(row.calls, 1); assert.equal(row.network_denials, 1); assert.equal(row.connections, 0);
  const decisions: boolean[] = [];
  const policy = { network: { mode: 'restricted' as const, allow: ['tools.example.com'], instanceAllow: [] }, onDecision: async (_host: string, allowed: boolean) => { decisions.push(allowed); } };
  let lookup = 0;
  const dns = async () => [{ address: ++lookup === 1 ? '8.8.8.8' : '10.0.0.1', family: 4 }];
  await resolveExtensionEndpoint('https://tools.example.com/mcp', dns, policy);
  await assert.rejects(resolveExtensionEndpoint('https://tools.example.com/mcp', dns, policy), /authorized/); assert.deepEqual(decisions, [true, false]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'internal-catalog-')); extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const { operatorCatalogDigest } = await import('../src/extensions/operatorCatalog.js');
  const entry = { id: 'internal-docs', kind: 'https' as const, url: 'https://10.0.0.1/mcp', addresses: ['10.0.0.1'], bearerSecretRef: 'INTERNAL_DOCS_KEY', tools: ['lookup'], capability: 'read' as const };
  const filename = path.join(root, 'catalog.json'); await fs.writeFile(filename, JSON.stringify([entry]), { mode: 0o600 });
  store.environment.PROPR_EXTENSION_CATALOG_FILE = filename; store.environment.INTERNAL_DOCS_KEY = secret;
  assert.throws(() => extensionEndpoint(entry.url), /public/);
  await save(store, input([{ kind: 'catalog', name: 'internal', catalogId: entry.id, digest: operatorCatalogDigest(entry), tools: ['lookup'], capability: 'read', enabled: true }]));
  for (const authorized of [false, true]) {
    const internalGrant = await launch(store, 'internal-' + authorized, { mode: 'restricted', allow: ['10.0.0.1'], instanceAllow: authorized ? ['10.0.0.1'] : [] });
    const call = () => extensionGatewayCall(store, internalGrant, 'internal', { jsonrpc: '2.0', id: 2, method: 'ping' }, async (url, _body, supplied, policy) => { assert.equal(url, entry.url); assert.equal(supplied, secret); assert.deepEqual(policy.internalAddresses, entry.addresses); return { jsonrpc: '2.0', id: 2, result: {} }; });
    if (authorized) await call(); else await assert.rejects(call(), /authorized/);
  }
  await assert.rejects(resolveExtensionEndpoint('https://tools.example.com/mcp', async () => [{ address: '10.0.0.2', family: 4 }], { internalAddresses: ['10.0.0.1'] }), /authorized/);
});

test('physical skill validation refuses ancestor links, replacement races, digest edits and hardlinks and cleans failures', async t => {
  const { database, store } = await fixture(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-adversary-')); extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const oldTransport = process.env.PROPR_EGRESS_SOCKET_DIR; process.env.PROPR_EGRESS_SOCKET_DIR = root;
  extensionTestResources(t).defer(() => { if (oldTransport === undefined) delete process.env.PROPR_EGRESS_SOCKET_DIR; else process.env.PROPR_EGRESS_SOCKET_DIR = oldTransport; });
  const { executeWithExtensions, currentExtensionLaunch } = await import('../src/extensions/extensionLaunch.js');
  const { ensureStagingRoot } = await import('../src/extensions/skillStaging.js');
  const bundle = await store.importSkill('1', skillFiles(), { kind: 'archive', filename: 'skill.tar' });
  await save(store, input([], [skill(bundle.id)]));
  const config = { type: 'claude' as const, alias: 'claude', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: root, supportedModels: ['synthetic'] };
  const options = { extensions: automatic(), taskId: 'skill-race', issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: root, prompt: 'Skills', githubToken: '' };
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  const link = path.join(root, 'link'); await fs.symlink(outside, link);
  await assert.rejects(ensureStagingRoot(path.join(link, 'nested'))); assert.deepEqual(await fs.readdir(outside), []);
  const notDirectory = path.join(root, 'file'); await fs.writeFile(notDirectory, 'x'); await assert.rejects(ensureStagingRoot(path.join(notDirectory, 'nested')));
  for (const mutation of ['ancestor-link', 'root-link', 'replace-file', 'read-race', 'digest', 'hardlink', 'extra-file']) {
    let staged = '';
    await assert.rejects(executeWithExtensions(config, options, async () => {
      const launch = currentExtensionLaunch()!; staged = launch.mounts[1].match(/source=([^,]+)/)![1];
      const file = path.join(staged, bundle.id, 'SKILL.md');
      if (mutation === 'ancestor-link') { await fs.rename(path.join(staged, bundle.id), path.join(staged, 'original')); await fs.symlink(path.join(staged, 'original'), path.join(staged, bundle.id)); }
      if (mutation === 'root-link') { const parent = path.dirname(staged); await fs.rename(parent, parent + '.original'); await fs.symlink(outside, parent); }
      if (mutation === 'read-race') { const open = fs.open; let replaced = false; t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => { const handle = await open(...args); if (String(args[0]) === file && !replaced) { replaced = true; await fs.rename(file, file + '.old'); await fs.writeFile(file, 'Replacement', { mode: 0o444 }); } return handle; }); }
      if (mutation === 'replace-file') { const content = await fs.readFile(file); await fs.rename(file, file + '.old'); await fs.writeFile(file, content, { mode: 0o444 }); }
      if (mutation === 'digest') { await fs.chmod(file, 0o644); await fs.appendFile(file, '\nChanged'); await fs.chmod(file, 0o444); }
      if (mutation === 'hardlink') await fs.link(file, path.join(staged, 'linked'));
      if (mutation === 'extra-file') await fs.writeFile(path.join(staged, 'extra'), 'unselected');
      await launch.beforeLaunch(); assert.fail('Unsafe mount authorized');
    }, store));
    t.mock.restoreAll();
    if (mutation === 'root-link') { const parent = path.dirname(staged); assert.deepEqual(await fs.readdir(outside), []); await fs.unlink(parent); await fs.rename(parent + '.original', parent); }
    await assert.rejects(fs.lstat(staged), /ENOENT/); assert.equal((await database('extension_run_grants')).length, 0);
  }
});

test('gateway write authority is captured per run and omission stays false', async t => {
  const { database, store } = await fixture(t);
  await save(store, input([server({ capability: 'write' })]), { docs: secret });
  const policy = { mode: 'restricted' as const, allow: ['8.8.8.8'], instanceAllow: [] };
  const readOnly = await launch(store, 'no-write', policy);
  let called = false; const send = async () => { called = true; return { jsonrpc: '2.0', id: 1, result: {} }; };
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup' } };
  await assert.rejects(extensionGatewayCall(store, readOnly, 'docs', body, send), /write grant/); assert.equal(called, false);
  const write = await launch(store, 'explicit-write', policy, true);
  policy.allow.length = 0; // Mutable caller state cannot change the persisted run policy.
  await extensionGatewayCall(store, write, 'docs', body, send); assert.equal(called, true);
});

test('redacted export keeps public presence, launches without the erased credential and permits rotation', async t => {
  const { database, store } = await fixture(t);
  await save(store, input(), { docs: secret });
  await database('extension_library_revisions').update({ secrets_encrypted: '' });
  assert.equal((await store.readLibrary('1')).secrets.docs.configured, false);
  const erased = await store.resolveLaunch(context);
  assert.deepEqual(erased.set.servers, []);
  assert.deepEqual(erased.set.skipped, [{ kind: 'server', name: 'docs', reason: 'secret_not_configured', source: 'auto' }]);
  const restored = await store.replaceSecret('1', 'docs', 'NEW_SYNTHETIC_RESTORE_SENTINEL');
  assert.equal(restored.revision, 2); assert.equal(restored.secrets.docs.configured, true);
  assert.deepEqual((await store.resolveLaunch(context)).set.servers.map(s => s.name), ['docs']);
});

test('follow-up migration upgrades installed v1 tables, revokes policy-less grants and is repeatable', async t => {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('agent_definitions', c => c.string('id').primary());
  await database.schema.createTable('task_submissions', c => c.string('id').primary());
  await up(database);
  const profileId = randomUUID(); const instanceId = (await database('extension_instance_identity').first()).instance_id;
  await database('extension_profiles').insert({ id: profileId, instance_id: instanceId, revision: 1, enabled: true });
  const grant = { token_hash: 'legacy', profile_id: profileId, revision: 1, actor: '1', task_id: 'initial', expires_at: Date.now() + 100000 };
  await database('extension_run_grants').insert(grant);
  await grantMigration(database); assert.equal((await database('extension_run_grants')).length, 0);
  assert.equal(await database.schema.hasColumn('task_submissions', 'extension_authorization'), true);
  const network = JSON.stringify({ mode: 'restricted', allow: ['example.com'], instanceAllow: [] });
  await database('extension_run_grants').insert({ ...grant, token_hash: 'new', network_policy: network }); await grantMigration(database);
  const row = await database('extension_run_grants').first(); assert.equal(row.network_policy, network); assert.equal(Boolean(row.allow_write), false); assert.equal(row.network_events, '[]');
});

test('library migration adds library tables, the automation field and keeps grants of running tasks', async t => {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('agent_definitions', c => c.string('id').primary());
  await up(database); await grantMigration(database);
  const profileId = randomUUID(); const instanceId = (await database('extension_instance_identity').first()).instance_id;
  await database('extension_profiles').insert({ id: profileId, instance_id: instanceId, revision: 1, enabled: true });
  const running = { token_hash: 'running', profile_id: profileId, revision: 1, actor: '1', task_id: 'running-task', expires_at: Date.now() + 100000, network_policy: JSON.stringify({ mode: 'open', allow: [], instanceAllow: [] }), active: true };
  await database('extension_run_grants').insert(running);
  await libraryMigration(database); await libraryMigration(database);
  for (const table of ['extension_library', 'extension_library_revisions', 'extension_legacy_profile_items', 'extension_library_migration']) assert.equal(await database.schema.hasTable(table), true, table);
  assert.equal(await database.schema.hasColumn('agent_definitions', 'extensions'), true);
  assert.equal(await database.schema.hasColumn('extension_run_grants', 'selection'), true);
  const kept = await database('extension_run_grants').first();
  assert.equal(kept.token_hash, 'running'); assert.equal(kept.profile_id, profileId); assert.equal(Boolean(kept.active), true);
  await database('extension_run_grants').insert({ token_hash: 'library', profile_id: null, revision: 1, actor: 'system', task_id: 'library-task', expires_at: Date.now() + 1000, selection: '{"servers":[],"skills":[]}' });
  assert.equal((await database('extension_run_grants')).length, 2);
});

test('gateway accounting and denied resolutions survive grant cleanup in per-task telemetry', async t => {
  const { database, store } = await fixture(t);
  await database.schema.createTable('tasks', c => c.string('task_id').primary());
  await database.schema.createTable('task_history', c => { c.string('task_id'); c.string('state'); c.string('timestamp'); c.text('reason'); c.text('metadata'); });
  await database('tasks').insert({ task_id: 'network-accounting' });
  await save(store, input(), { docs: secret });
  const network = { mode: 'restricted' as const, allow: ['unrelated-base-allow.example'], instanceAllow: ['10.43.21.9'] };
  const token = await launch(store, 'network-accounting', network);
  await assert.rejects(extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'ping' }, async () => { assert.fail('Denied network dialed'); }), /network policy/);
  await store.recordGatewayNetwork(token, 'https://catalog-endpoint-sentinel.internal/mcp', false);
  await store.recordGatewayNetwork(token, '10.43.21.9', false);
  await store.recordGatewayNetwork(token, `catalog:local-docs@${'a'.repeat(64)}`, true);
  await store.retainGatewayTelemetry(token); await database('extension_run_grants').delete();
  const history = await database('task_history').first();
  assert.equal(history.state, 'processing', 'extension telemetry uses a runtime-neutral state');
  const event = JSON.parse(history.metadata);
  assert.equal(event.event, 'network.extensions'); assert.deepEqual(event.network, { mode: 'restricted' }); assert.equal(event.denied, 3); assert.equal(event.calls, 1); assert.equal(event.responseBytes, 1024 * 1024); assert.deepEqual(event.resolutions, [{ allowed: false }, { allowed: false }, { allowed: false }, { host: `catalog:local-docs@${'a'.repeat(64)}`, allowed: true }]);
  for (const sentinel of ['10.43.21.9', 'catalog-endpoint-sentinel', 'unrelated-base-allow.example']) assert.ok(!JSON.stringify(event).includes(sentinel));
  assert.ok(!JSON.stringify(event).includes(secret)); assert.ok(!JSON.stringify(event).includes(token));
});

test('write servers are left out of report and non-opted-in runs, then exposed for action', async t => {
  const { database, store } = await fixture(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-write-')); extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const { operatorCatalogDigest } = await import('../src/extensions/operatorCatalog.js');
  const { executeWithExtensions, currentExtensionLaunch } = await import('../src/extensions/extensionLaunch.js');
  const { agentTaskOptions } = await import('../../../src/jobs/agentRuns/agentTaskOptions.js');
  const entry = { id: 'local-write', kind: 'stdio' as const, executable: '/usr/bin/env', args: ['node', '--version'], secretEnv: { API_KEY: 'LOCAL_WRITE_SECRET' }, tools: ['update'], capability: 'write' as const };
  const catalogFile = path.join(root, 'catalog.json'); await fs.writeFile(catalogFile, JSON.stringify([entry]), { mode: 0o600 });
  store.environment.PROPR_EXTENSION_CATALOG_FILE = catalogFile; store.environment.LOCAL_WRITE_SECRET = secret;
  await save(store, input([
    server({ capability: 'write', repositories: ['Team/Repo'] }),
    { kind: 'catalog', name: 'local-write', catalogId: entry.id, digest: operatorCatalogDigest(entry), enabled: true, tools: ['update'], capability: 'write', repositories: ['Team/Repo'] },
    server({ name: 'read-docs', authentication: 'none', repositories: ['Team/Repo'] }),
  ]), { docs: secret });
  const config = { type: 'claude' as const, alias: 'claude', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: root, supportedModels: ['synthetic'] };
  const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
  for (const phase of ['report', 'action'] as const) {
    const options = agentTaskOptions({ runId: 'run', taskId: phase, definition: { id: 'definition', ownerId: '1', extensions: { servers: [], skills: [] }, repositories: ['team/repo'], capabilities: [] } as any, issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, prompt: 'Run phase', model: undefined, token: '', workspace: { worktreePath: root, promptWorkspace: { repositoriesReadable: false } } as any, ...(phase === 'action' ? { phase } : {}) });
    await executeWithExtensions(config, options, async prepared => {
      await currentExtensionLaunch()!.beforeLaunch();
      assert.deepEqual(prepared.toolPolicy!.mcpServers!.map(s => s.name), phase === 'action' ? ['docs', 'read-docs'] : ['read-docs']);
      assert.deepEqual(prepared.toolPolicy!.localMcpServers!.map(s => s.name), phase === 'action' ? ['local-write'] : []);
      const token = prepared.toolPolicy!.mcpServers![0].bearerToken;
      if (phase === 'report') await assert.rejects(extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'tools/list' }), /capability unavailable/);
      return result;
    }, store);
    if (phase === 'report') {
      // Omitted New Task write opt-in also excludes servers whose catalog or
      // credentials are no longer available; excluded tools are never resolved.
      await fs.writeFile(catalogFile, '[]');
      await database('extension_library_revisions').update({ secrets_encrypted: '' });
      await executeWithExtensions(config, { ...options, extensions: { ...options.extensions!, allowWrite: undefined } }, async prepared => {
        await currentExtensionLaunch()!.beforeLaunch();
        assert.deepEqual(prepared.toolPolicy!.mcpServers!.map(s => s.name), ['read-docs']);
        assert.deepEqual(prepared.toolPolicy!.localMcpServers, []);
        return result;
      }, store);
      await fs.writeFile(catalogFile, JSON.stringify([entry]));
      // Restore synthetic credentials for the action phase.
      await store.replaceSecret('1', 'docs', secret);
    }
  }
  assert.equal((await database('extension_run_grants')).length, 0);
});

test('startup egress sweep reclaims crashed extension owners and preserves live, foreign, legacy and symlink trees', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-orphan-')); extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const { createStagingDirectory, ensureStagingRoot } = await import('../src/extensions/skillStaging.js');
  const { sweepOrphanedEgressProxies } = await import('../src/network/egressExecution.js');
  const instance = path.join(root, 'extensions', randomUUID()); await ensureStagingRoot(instance);
  const live = await createStagingDirectory(instance); extensionTestResources(t).defer(live.cleanup);
  const deadName = path.basename(live.directory).replace(`-${process.pid}-`, '-2147483647-');
  const dead = path.join(instance, deadName); await fs.mkdir(dead); await fs.writeFile(path.join(dead, 'skill'), 'dead-owner');
  const foreign = path.join(instance, deadName.replace(/^(run-[a-f0-9]{16}-)[a-f0-9]{16}/, (_match, prefix) => prefix + '0000000000000000')); await fs.mkdir(foreign);
  const legacy = path.join(instance, 'run-legacy'); await fs.mkdir(legacy);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'sentinel'), 'preserve');
  const linkName = deadName.slice(0, -6) + 'ABCDEF'; await fs.symlink(outside, path.join(instance, linkName));
  const old = new Date(0); await fs.utimes(live.directory, old, old);
  assert.equal((await sweepOrphanedEgressProxies({ root })).removed, 1);
  await assert.rejects(fs.stat(dead), /ENOENT/);
  for (const preserved of [live.directory, foreign, legacy]) assert.ok((await fs.stat(preserved)).isDirectory());
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'preserve');
  assert.ok((await fs.lstat(path.join(instance, linkName))).isSymbolicLink());
});


test('launch wrapper persists restricted egress authority across preparation and activation', async t => {
  const { executeWithExtensions, currentExtensionLaunch } = await import('../src/extensions/extensionLaunch.js');
  const { executeWithNetworkPolicy } = await import('../src/network/egressExecution.js');
  const { baseEgressAllowlist } = await import('../src/network/egressAllowlist.js');
  const { database, store } = await fixture(t);
  await save(store, input(), { docs: secret });
  const policy = { mode: 'restricted' as const, source: 'workflow' as const, allow: ['8.8.8.8', 'docs.example.com'], instanceAllow: ['10.0.0.8'] };
  const config = { type: 'codex' as const, alias: 'codex-main', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: '/unused', supportedModels: ['synthetic'] };
  const options = { extensions: automatic(), taskId: 'restricted-run', issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: '/unused', prompt: 'Selected run', githubToken: '' };
  const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
  await executeWithNetworkPolicy(policy, () => executeWithExtensions(config, options, async prepared => {
    const token = prepared.toolPolicy!.mcpServers![0].bearerToken;
    const readNetwork = async () => JSON.parse((await database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).first()).network_policy);
    const expected = { mode: 'restricted', allow: [...baseEgressAllowlist('codex'), ...policy.allow], instanceAllow: policy.instanceAllow };
    assert.deepEqual(await readNetwork(), expected);
    await currentExtensionLaunch()!.beforeLaunch();
    assert.deepEqual(await readNetwork(), expected);
    assert.deepEqual((await store.grantSnapshot(token)).network, expected);
    return result;
  }, store));
  assert.equal((await database('extension_run_grants')).length, 0);
});

test('telemetry and grant cleanup failures preserve results and original exceptions', async t => {
  const { executeWithExtensions, currentExtensionLaunch } = await import('../src/extensions/extensionLaunch.js');
  const { database, store } = await fixture(t);
  await save(store, input(), { docs: secret });
  const config = { type: 'claude' as const, alias: 'claude-main', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: '/unused', supportedModels: ['synthetic'] };
  const options = { extensions: automatic(), taskId: 'cleanup-run', issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: '/unused', prompt: 'Selected run', githubToken: '' };
  const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
  t.mock.method(store, 'retainGatewayTelemetry', async () => {
    const grant = await database('extension_run_grants').first();
    assert.equal(Boolean(grant.active), false, 'grant authority ends before awaited telemetry');
    throw new Error('synthetic telemetry database failure');
  });
  for (const fails of [false, true]) {
    const original = new Error('original agent failure');
    const execution = executeWithExtensions(config, options, async () => {
      await currentExtensionLaunch()!.beforeLaunch();
      if (fails) throw original;
      return result;
    }, store);
    if (fails) await assert.rejects(execution, error => error === original);
    else assert.equal(await execution, result);
    assert.equal((await database('extension_run_grants')).length, 0);
  }
  const failDeletion = (query: { sql: string }) => { if (query.sql.startsWith('delete from `extension_run_grants`') && !query.sql.includes('expires_at')) throw new Error('synthetic deletion failure'); };
  database.on('query', failDeletion);
  try {
    assert.equal(await executeWithExtensions(config, options, async () => { await currentExtensionLaunch()!.beforeLaunch(); return result; }, store), result);
    assert.equal(Boolean((await database('extension_run_grants').first()).active), false);
  } finally { database.removeListener('query', failDeletion); }
});


test('gateway reservation cleanup errors preserve responses and capability errors without releasing budget', async t => {
  const { database, store } = await fixture(t);
  await save(store, input(), { docs: secret });
  const token = await launch(store, 'gateway-cleanup');
  const failRelease = (query: { sql: string }) => { if (query.sql.includes('`connections` = `connections` -')) throw new Error('synthetic reservation database failure'); };
  database.on('query', failRelease);
  try {
    const response = await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'ping' }, async () => ({ jsonrpc: '2.0', id: 1, result: {} }));
    assert.deepEqual(response, { jsonrpc: '2.0', id: 1, result: {} });
    await assert.rejects(extensionGatewayCall(store, token, 'missing', { jsonrpc: '2.0', id: 2, method: 'ping' }), /capability unavailable/);
    const grant = await database('extension_run_grants').first();
    assert.equal(grant.connections, 2);
    assert.equal(grant.bytes, 2 * 1024 * 1024);
  } finally { database.removeListener('query', failRelease); }
});


test('staging creation preserves its original error when cleanup also fails', async t => {
  const { createStagingDirectory } = await import('../src/extensions/skillStaging.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-staging-error-'));
  extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const original = new Error('synthetic staging creation failure');
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('/' + path.basename(root))) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); throw new Error('synthetic close failure'); });
    }
    return handle;
  });
  t.mock.method(fs, 'mkdtemp', async () => { throw original; });
  await assert.rejects(createStagingDirectory(root), error => error === original);
});


test('skill staging explicitly rejects unsupported worker platforms', async () => {
  const { assertSkillStagingPlatform, ensureStagingRoot } = await import('../src/extensions/skillStaging.js');
  assert.doesNotThrow(() => assertSkillStagingPlatform('linux'));
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    for (const platform of ['darwin', 'win32', 'freebsd'] as const) {
      Object.defineProperty(process, 'platform', { ...original, value: platform });
      await assert.rejects(ensureStagingRoot('/unused-skill-staging'), /requires a Linux worker with \/proc\/self\/fd/);
    }
  } finally { Object.defineProperty(process, 'platform', original); }
});

test('one create/start window reuses catalog validation but fences authority at every boundary', async t => {
  const { executeWithExtensions, currentExtensionLaunch } = await import('../src/extensions/extensionLaunch.js');
  const { operatorCatalogDigest } = await import('../src/extensions/operatorCatalog.js');
  const { database, store } = await fixture(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-window-')); extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const entry = { id: 'local-docs', kind: 'stdio' as const, executable: '/usr/bin/env', args: ['node', '--version'], tools: ['lookup'], capability: 'read' as const, secretEnv: {} };
  const file = path.join(root, 'catalog.json'); await fs.writeFile(file, JSON.stringify([entry])); store.environment.PROPR_EXTENSION_CATALOG_FILE = file;
  await save(store, input([{ kind: 'catalog', name: 'docs', catalogId: entry.id, digest: operatorCatalogDigest(entry), tools: ['lookup'], capability: 'read', enabled: true }]));
  const { OperatorCatalog } = await import('../src/extensions/operatorCatalog.js');
  const resolve = t.mock.method(OperatorCatalog.prototype, 'resolve');
  const config = { type: 'codex', alias: 'codex-main' } as any;
  const options = { extensions: automatic(), taskId: 'window-run', issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: '/unused', prompt: 'Selected run', githubToken: '' };
  const result = { success: true, logs: '', modifiedFiles: [], modelUsed: 'synthetic', executionTimeMs: 1 };
  await executeWithExtensions(config, options, async () => {
    const launch = currentExtensionLaunch()!; const window = {};
    const preparedReads = resolve.mock.callCount();
    await launch.beforeLaunch(window, false);
    assert.equal(resolve.mock.callCount(), preparedReads, 'the pre-admission check cannot populate the resource cache');
    await launch.beforeLaunch(window); await launch.beforeLaunch(window); await launch.beforeLaunch(window);
    assert.equal(resolve.mock.callCount(), preparedReads + 1);
    await launch.beforeLaunch({});
    assert.equal(resolve.mock.callCount(), preparedReads + 2, 'a later container has a fresh validation window');
    // Launch needs no administrator, but disabling the item fences the pending start.
    await database('instance_members').where({ github_user_id: '1' }).update({ role: 'member' });
    await launch.beforeLaunch(window);
    await database('instance_members').where({ github_user_id: '1' }).update({ role: 'admin' });
    await store.setItemEnabled('1', { kind: 'server', name: 'docs' }, false);
    await assert.rejects(launch.beforeLaunch(window), /changed before launch/);
    return result;
  }, store);
});


test('DNS is resolved once per create/start window and checked again for later containers', async t => {
  const dns = (await import('node:dns/promises')).default;
  const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }] as any);
  const { executeWithExtensions, currentExtensionLaunch } = await import('../src/extensions/extensionLaunch.js');
  const { database, store } = await fixture(t);
  await save(store, input([server({ url: 'https://docs.example.com/mcp', authentication: 'none' })]));
  const options = { extensions: automatic(), taskId: 'dns-window-run', issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: '/unused', prompt: 'Selected run', githubToken: '' };
  const result = { success: true, logs: '', modifiedFiles: [], modelUsed: 'synthetic', executionTimeMs: 1 };
  await executeWithExtensions({ type: 'codex', alias: 'codex-main' } as any, options, async () => {
    const launch = currentExtensionLaunch()!; const window = {}; const preparedLookups = lookup.mock.callCount();
    await launch.beforeLaunch(window); await launch.beforeLaunch(window); await launch.beforeLaunch(window);
    assert.equal(lookup.mock.callCount(), preparedLookups + 1);
    lookup.mock.mockImplementation(async () => [{ address: '127.0.0.1', family: 4 }] as any);
    await assert.rejects(launch.beforeLaunch({}), /public addresses/);
    return result;
  }, store);
});


test('accepted MCP notifications refund reservations and release connections', async t => {
  const { database, store } = await fixture(t);
  await save(store, input(), { docs: secret });
  const token = await launch(store, 'accepted-notifications');
  for (let i = 0; i < 20; i++) {
    assert.equal(await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', method: 'notifications/initialized' }, async () => null), null);
    const grant = await database('extension_run_grants').first();
    assert.equal(grant.bytes, 0);
    assert.equal(grant.connections, 0);
  }
  await assert.rejects(extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'ping' }, async () => null), /protocol unavailable/);
  const grant = await database('extension_run_grants').first();
  assert.equal(grant.bytes, 1024 * 1024);
  assert.equal(grant.connections, 0);
});

test('gateway preserves JSON-RPC error codes while removing upstream messages and data', async t => {
  const { database, store } = await fixture(t);
  await save(store, input(), { docs: secret });
  const token = await launch(store, 'protocol-errors');
  for (const method of ['initialize', 'ping', 'tools/list', 'tools/call']) {
    const rpc = { jsonrpc: '2.0', id: 1, method, ...(method === 'tools/call' ? { params: { name: 'lookup' } } : {}) };
    const response = await extensionGatewayCall(store, token, 'docs', rpc, async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: secret, data: { token } } }));
    assert.deepEqual(response, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'MCP request failed' } });
  }
  for (const upstream of [
    { jsonrpc: '2.0', id: 2, error: { code: -32602, message: secret } },
    { jsonrpc: '2.0', id: 1, error: { code: 'bad', message: secret } },
    { jsonrpc: '2.0', id: 1, error: { code: -32602, message: secret }, result: {} },
  ]) await assert.rejects(extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'ping' }, async () => upstream), /MCP (request failed|protocol unavailable)/);
  assert.equal((await database('extension_run_grants').first()).connections, 0);
});

test('staging reclaims expired foreign leases only on the same host boot and preserves refreshed leases', async t => {
  const { createStagingDirectory, ensureStagingRoot, sweepOrphanedExtensionStaging, EXTENSION_STAGING_ORPHAN_MAX_AGE_MS } = await import('../src/extensions/skillStaging.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-foreign-lease-'));
  extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const instance = path.join(root, 'instance'); await ensureStagingRoot(instance);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const live = await createStagingDirectory(instance); extensionTestResources(t).defer(live.cleanup);
  const name = path.basename(live.directory);
  const foreignName = name.replace(/^(run-[a-f0-9]{16}-)[a-f0-9]{16}/, (_match, prefix) => prefix + '0000000000000000');
  const stale = path.join(instance, foreignName); await fs.mkdir(stale);
  const fresh = path.join(instance, foreignName + 'fresh'); await fs.mkdir(fresh);
  const otherBoot = path.join(instance, foreignName.replace(/^run-[a-f0-9]{16}/, 'run-0000000000000000')); await fs.mkdir(otherBoot);
  const legacy = path.join(instance, 'run-0000000000000000-2147483647-ABCDEF'); await fs.mkdir(legacy);
  const old = new Date(Date.now() - EXTENSION_STAGING_ORPHAN_MAX_AGE_MS - 1000);
  for (const directory of [live.directory, stale, otherBoot, legacy]) await fs.utimes(directory, old, old);
  t.mock.timers.tick(60_000);
  // Wait for the asynchronous heartbeat write started by the timer.
  for (let i = 0; i < 20 && (await fs.stat(live.directory)).mtimeMs === old.getTime(); i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok((await fs.stat(live.directory)).mtimeMs > old.getTime());
  // A refresh during the awaited inspection invalidates the age evidence.
  const refreshedDuringSweep = path.join(instance, foreignName + 'raced'); await fs.mkdir(refreshedDuringSweep);
  await fs.utimes(refreshedDuringSweep, old, old);
  const lstat = fs.lstat.bind(fs); let raced = false;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await lstat(...args);
    if (!raced && String(args[0]).endsWith('/' + path.basename(refreshedDuringSweep))) {
      raced = true; const now = new Date(); await fs.utimes(refreshedDuringSweep, now, now);
    }
    return stat;
  });
  assert.equal(await sweepOrphanedExtensionStaging(root), 1);
  assert.equal(raced, true);
  assert.ok((await fs.stat(refreshedDuringSweep)).isDirectory());
  await assert.rejects(fs.stat(stale), /ENOENT/);
  for (const directory of [live.directory, fresh, otherBoot, legacy]) assert.ok((await fs.stat(directory)).isDirectory());
});

test('disabled servers can be saved without live DNS or removed catalog resources and disabling is never refused', async t => {
  const { store } = await fixture(t);
  await save(store, input(), { docs: secret });
  const unavailable = [
    server({ url: 'https://unavailable.invalid/mcp' }),
    { kind: 'catalog' as const, name: 'removed', catalogId: 'removed', digest: 'a'.repeat(64), enabled: true, tools: ['lookup'], capability: 'read' as const, repositories: [], agents: [], autoApply: true },
  ];
  const disabled = await save(store, input(unavailable.map(s => ({ ...s, enabled: false }))));
  assert.deepEqual(disabled.secrets.removed, { count: 0, configured: false });
  await assert.rejects(save(store, input(unavailable)));
  await assert.rejects(save(store, input([{ ...unavailable[0], enabled: false, url: 'http://localhost' } as any])));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'disabled-catalog-')); extensionTestResources(t).defer(() => fs.rm(root, { recursive: true, force: true }));
  const entry = { id: 'docs', kind: 'stdio' as const, executable: '/usr/bin/env', args: ['node', '--version'], tools: ['lookup'], capability: 'read' as const, secretEnv: { API_KEY: 'OPERATOR_DOCS_KEY' } };
  const filename = path.join(root, 'catalog.json'); await fs.writeFile(filename, JSON.stringify([entry]));
  store.environment.PROPR_EXTENSION_CATALOG_FILE = filename; store.environment.OPERATOR_DOCS_KEY = secret;
  const { operatorCatalogDigest } = await import('../src/extensions/operatorCatalog.js');
  await save(store, input([{ kind: 'catalog', name: 'local', catalogId: entry.id, digest: operatorCatalogDigest(entry), enabled: true, tools: ['lookup'], capability: 'read', repositories: [], agents: [], autoApply: true }]));
  await fs.unlink(filename);
  const recovery = await store.setItemEnabled('1', { kind: 'server', name: 'local' }, false);
  assert.deepEqual(recovery.secrets.local, { count: 1, configured: true });
  assert.deepEqual((await store.resolveLaunch(context)).set.servers, []);
  await assert.rejects(store.setItemEnabled('1', { kind: 'server', name: 'local' }, true));
  await assert.rejects(store.setItemEnabled('1', { kind: 'server', name: 'missing' }, false), /unavailable/);
});

test('gateway records one final DNS decision per call while enforcing the second resolution', async t => {
  const { database, store } = await fixture(t);
  await save(store, input(), { docs: secret });
  const token = await launch(store, 'single-decision');
  for (const allowed of [true, false]) {
    const transport = async (url: string, body: unknown, _secret?: string, policy?: any) => {
      // Simulate a DNS change at the physical transport boundary.
      await resolveExtensionEndpoint('https://tools.example.com', async () => [{ address: allowed ? '8.8.8.8' : '127.0.0.1', family: 4 }], policy);
      return { jsonrpc: '2.0', id: (body as any).id, result: {} };
    };
    const call = extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'ping' }, transport);
    if (allowed) await call; else await assert.rejects(call, /connection failed/);
  }
  const row = await database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).first();
  assert.deepEqual(JSON.parse(row.network_events).map((e: any) => e.allowed), [true, false]);
  assert.equal(row.network_denials, 1);
});

test('staging sweep quietly skips unsupported workers and absent roots', async t => {
  const { sweepOrphanedExtensionStaging } = await import('../src/extensions/skillStaging.js');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  extensionTestResources(t).defer(() => Object.defineProperty(process, 'platform', platform));
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  assert.equal(await sweepOrphanedExtensionStaging('/missing/extensions'), 0);
  Object.defineProperty(process, 'platform', platform);
  assert.equal(await sweepOrphanedExtensionStaging(path.join(os.tmpdir(), randomUUID(), 'extensions')), 0);
});
