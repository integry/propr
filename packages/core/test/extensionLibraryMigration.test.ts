import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { ExtensionMcpDescriptor } from '@propr/shared';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';
import { migrateExtensionProfilesToLibrary, EXTENSION_LIBRARY_MIGRATION_ACTOR } from '../src/extensions/extensionLibraryMigration.js';
import { ExtensionLibraryStore } from '../src/extensions/extensionProfileStore.js';
import { sealExtensionSecrets } from '../src/extensions/privateSecrets.js';

const environment = { SYSTEM_TASK_SECRET: 'synthetic-migration-custody-key' };
const quiet = { info() {}, warn() {} };
const docs = (extra: Partial<ExtensionMcpDescriptor> = {}): ExtensionMcpDescriptor => ({ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'bearer', ...extra } as ExtensionMcpDescriptor);

async function fixture(t: TestContext) {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await up(database); await grantMigration(database); await libraryMigration(database);
  const instanceId = (await database('extension_instance_identity').first()).instance_id as string;
  return { database, instanceId, store: new ExtensionLibraryStore(database, environment) };
}
interface ProfileSpec { name: string; servers: ExtensionMcpDescriptor[]; secrets?: Record<string, string>; agentScope?: string[]; repositoryScope?: string[]; skillBundleIds?: string[]; enabled?: boolean; deleted?: boolean; key?: string }
// eslint-disable-next-line max-params -- test helper writes one legacy profile with its custody
async function profile(database: Knex, instanceId: string, spec: ProfileSpec): Promise<string> {
  const profileId = randomUUID();
  const snapshot = {
    version: 1, instanceId, profileId, revision: 1, name: spec.name, enabled: spec.enabled ?? true, agentScope: spec.agentScope ?? [], repositoryScope: spec.repositoryScope ?? [],
    mcpServers: spec.servers, skillBundleIds: spec.skillBundleIds ?? [], createdAt: 1, updatedAt: 1, auditActor: '1',
    secrets: Object.fromEntries(spec.servers.filter(s => s.kind === 'https' && s.authentication === 'bearer').map(s => [s.name, { fields: ['bearerToken'], configured: Boolean(spec.secrets?.[s.name]) }])),
    skillBundles: [],
  };
  await database('extension_profiles').insert({ id: profileId, instance_id: instanceId, revision: 1, enabled: spec.enabled ?? true, deleted: spec.deleted ?? false });
  await database('extension_profile_revisions').insert({ profile_id: profileId, revision: 1, snapshot: JSON.stringify(snapshot), secrets_encrypted: sealExtensionSecrets(spec.secrets ?? {}, `${instanceId}/${profileId}/1`, { SYSTEM_TASK_SECRET: spec.key ?? environment.SYSTEM_TASK_SECRET }) });
  return profileId;
}
const selection = (instanceId: string, profileId: string) => JSON.stringify({ instanceId, profileId, revision: 1 });

test('identical servers merge with the union of their limits, colliding names are renamed and nothing auto-applies', async t => {
  const { database, instanceId, store } = await fixture(t);
  const bundleId = randomUUID();
  await database('extension_skill_bundles').insert({ id: bundleId, instance_id: instanceId, descriptor: JSON.stringify({ id: bundleId, instanceId, digest: 'a'.repeat(64), name: 'writing', files: 1, bytes: 1, source: { kind: 'archive', filename: 'x.tar' }, requirements: [], createdAt: 1, auditActor: '1' }), files_json: '[]' });
  const first = await profile(database, instanceId, { name: 'Docs A', servers: [docs()], secrets: { docs: 'SHARED_SENTINEL_TOKEN' }, repositoryScope: ['team/web'], agentScope: ['claude-main'], skillBundleIds: [bundleId] });
  const second = await profile(database, instanceId, { name: 'Docs B', servers: [docs(), docs({ name: 'search', authentication: 'none', url: 'https://8.8.4.4/mcp' })], secrets: { docs: 'SHARED_SENTINEL_TOKEN' }, repositoryScope: ['team/api'], agentScope: ['codex-main'], skillBundleIds: [bundleId] });
  const third = await profile(database, instanceId, { name: 'Other docs', servers: [docs({ url: 'https://1.1.1.1/mcp' })], secrets: { docs: 'OTHER_SENTINEL_TOKEN' } });
  await profile(database, instanceId, { name: 'Deleted', servers: [docs({ name: 'gone', authentication: 'none' })], deleted: true });
  const logged: unknown[] = [];
  const report = await migrateExtensionProfilesToLibrary(database, environment, { info: (...args: unknown[]) => logged.push(args), warn() {} });
  assert.equal(report.migrated, true); assert.equal(report.profiles, 3);
  const library = await store.readLibrary('1');
  assert.equal(library.auditActor, EXTENSION_LIBRARY_MIGRATION_ACTOR);
  assert.deepEqual(library.servers.map(s => s.name).sort(), ['docs', 'docs-2', 'search']);
  assert.ok(library.servers.every(s => s.autoApply === false) && library.skills.every(s => s.autoApply === false));
  const merged = library.servers.find(s => s.kind === 'https' && s.url === 'https://8.8.8.8/mcp')!;
  const renamed = library.servers.find(s => s.kind === 'https' && s.url === 'https://1.1.1.1/mcp')!;
  assert.deepEqual([...merged.repositories].sort(), ['team/api', 'team/web']);
  assert.deepEqual([...merged.agents].sort(), ['claude-main', 'codex-main']);
  // A source with an empty scope keeps the merged limit empty.
  assert.deepEqual(renamed.repositories, []); assert.deepEqual(renamed.agents, []);
  // Profiles are processed in id order: whichever colliding server comes second gets the suffix.
  assert.deepEqual(report.renamed.map(r => [r.from, r.to]), [['docs', 'docs-2']]);
  assert.deepEqual([merged.name, renamed.name].sort(), ['docs', 'docs-2']);
  assert.ok(logged.some(entry => JSON.stringify(entry).includes('renamed')));
  assert.deepEqual(library.skills.map(s => [s.bundleId, [...s.repositories].sort()]), [[bundleId, ['team/api', 'team/web']]]);
  const { secrets } = await store.validationTargets('1');
  assert.equal(secrets[merged.name], 'SHARED_SENTINEL_TOKEN'); assert.equal(secrets[renamed.name], 'OTHER_SENTINEL_TOKEN');
  assert.ok(!JSON.stringify(library).includes('SENTINEL_TOKEN'));
  assert.deepEqual(await store.legacyProfileExtensions(first), { servers: [merged.name], skills: [bundleId] });
  assert.deepEqual(await store.legacyProfileExtensions(second), { servers: [merged.name, 'search'], skills: [bundleId] });
  assert.deepEqual(await store.legacyProfileExtensions(third), { servers: [renamed.name], skills: [] });
  // Old profile tables stay readable.
  assert.equal((await database('extension_profiles')).length, 4);
});

test('an automation bound to an old profile launches with the same servers and skills; re-running changes nothing', async t => {
  const { database, instanceId, store } = await fixture(t);
  const profileId = await profile(database, instanceId, { name: 'Docs', servers: [docs(), docs({ name: 'writer', authentication: 'none', capability: 'write', url: 'https://8.8.4.4/mcp' })], secrets: { docs: 'SHARED_SENTINEL_TOKEN' }, repositoryScope: ['team/repo'] });
  await database('agent_definitions').insert([
    { id: 'bound', name: 'Bound', extension_profile: selection(instanceId, profileId) },
    { id: 'unbound', name: 'Unbound' },
    { id: 'missing', name: 'Missing', extension_profile: selection(instanceId, randomUUID()) },
  ]);
  await migrateExtensionProfilesToLibrary(database, environment, quiet);
  const rows = Object.fromEntries((await database('agent_definitions').select('id', 'extensions', 'extension_profile')).map(r => [r.id, r]));
  assert.deepEqual(JSON.parse(rows.bound.extensions), { servers: ['docs', 'writer'], skills: [] });
  assert.equal(rows.unbound.extensions, null);
  assert.deepEqual(JSON.parse(rows.missing.extensions), { servers: [], skills: [] });
  assert.ok(rows.bound.extension_profile, 'the old selection is kept');
  const context = { agentAlias: 'claude-main', runtime: 'claude', repositories: ['team/repo'] };
  const report = await store.resolveLaunch({ ...context, allowWrite: false, additional: JSON.parse(rows.bound.extensions) }, false);
  assert.deepEqual(report.set.servers.map(s => s.name), ['docs']);
  const action = await store.resolveLaunch({ ...context, allowWrite: true, additional: JSON.parse(rows.bound.extensions) }, false);
  assert.deepEqual(action.set.servers.map(s => s.name), ['docs', 'writer']);
  // Nothing applies automatically, so a run that does not add the items is unchanged.
  assert.deepEqual((await store.resolveLaunch({ ...context, allowWrite: true }, false)).set.servers, []);
  const before = { revisions: await database('extension_library_revisions'), automations: await database('agent_definitions'), mapping: await database('extension_legacy_profile_items') };
  assert.deepEqual(await migrateExtensionProfilesToLibrary(database, environment, quiet), { migrated: false, profiles: 0, servers: 0, skills: 0, automations: 0, renamed: [], warnings: [] });
  assert.deepEqual({ revisions: await database('extension_library_revisions'), automations: await database('agent_definitions'), mapping: await database('extension_legacy_profile_items') }, before);
});

test('an undecryptable credential migrates the server without a secret and never aborts', async t => {
  const { database, instanceId, store } = await fixture(t);
  const profileId = await profile(database, instanceId, { name: 'Wrong key', servers: [docs()], secrets: { docs: 'SENTINEL_TOKEN' }, key: 'a-different-key-root' });
  const warnings: unknown[] = [];
  const report = await migrateExtensionProfilesToLibrary(database, environment, { info() {}, warn: (...args: unknown[]) => warnings.push(args) });
  assert.equal(report.migrated, true); assert.equal(report.warnings.length, 1); assert.equal(warnings.length, 1);
  const library = await store.readLibrary('1');
  assert.deepEqual(library.secrets.docs, { fields: ['bearerToken'], configured: false });
  assert.deepEqual(await store.legacyProfileExtensions(profileId), { servers: ['docs'], skills: [] });
  // The item is skipped at launch rather than failing it.
  const set = (await store.resolveLaunch({ agentAlias: 'claude', runtime: 'claude', repositories: ['team/repo'], allowWrite: false, additional: { servers: ['docs'], skills: [] } }, false)).set;
  assert.deepEqual(set.servers, []); assert.equal(set.skipped[0].reason, 'secret_not_configured');
});

test('a failed migration leaves profile tables unchanged and retries at the next start', async t => {
  const { database, instanceId } = await fixture(t);
  await profile(database, instanceId, { name: 'Docs', servers: [docs({ authentication: 'none' })] });
  const failing = (query: { sql: string }) => { if (query.sql.startsWith('insert into `extension_library_revisions`')) throw new Error('synthetic write failure'); };
  database.on('query', failing);
  try { assert.equal((await migrateExtensionProfilesToLibrary(database, environment, quiet)).migrated, false); }
  finally { database.removeListener('query', failing); }
  assert.equal(await database('extension_library_migration').first(), undefined);
  assert.equal((await database('extension_library_revisions')).length, 0);
  assert.equal((await migrateExtensionProfilesToLibrary(database, environment, quiet)).migrated, true);
  assert.equal((await database('extension_library_revisions')).length, 1);
});

test('a fresh installation without profiles only records completion', async t => {
  const { database } = await fixture(t);
  const report = await migrateExtensionProfilesToLibrary(database, environment, quiet);
  assert.equal(report.migrated, true); assert.equal(report.profiles, 0);
  assert.equal((await database('extension_library_revisions')).length, 0);
  assert.ok(await database('extension_library_migration').first());
});

test('a disabled source selection never maps to an enabled library item', async t => {
  const { database, instanceId, store } = await fixture(t);
  const bundleId = randomUUID(); const inactiveBundleId = randomUUID();
  for (const id of [bundleId, inactiveBundleId]) {
    await database('extension_skill_bundles').insert({ id, instance_id: instanceId, descriptor: JSON.stringify({ id, instanceId, digest: 'a'.repeat(64), name: `skill-${id}`, files: 1, bytes: 1, source: { kind: 'archive', filename: 'x.tar' }, requirements: [], createdAt: 1, auditActor: '1' }), files_json: '[]' });
  }
  const active = await profile(database, instanceId, { name: 'Active', servers: [docs()], secrets: { docs: 'SHARED_SENTINEL_TOKEN' }, repositoryScope: ['team/web'], skillBundleIds: [bundleId] });
  // The same server and credential, but disabled in this enabled profile.
  const serverOff = await profile(database, instanceId, { name: 'Server off', servers: [docs({ enabled: false })], secrets: { docs: 'SHARED_SENTINEL_TOKEN' }, repositoryScope: ['team/api'] });
  // A disabled profile sharing the server and the skill bundle, plus a bundle only it selects.
  const profileOff = await profile(database, instanceId, { name: 'Profile off', servers: [docs()], secrets: { docs: 'SHARED_SENTINEL_TOKEN' }, skillBundleIds: [bundleId, inactiveBundleId], enabled: false });
  await migrateExtensionProfilesToLibrary(database, environment, quiet);
  const library = await store.readLibrary('1');
  const enabledDocs = library.servers.filter(s => s.enabled);
  assert.deepEqual(enabledDocs.length, 1); assert.deepEqual(enabledDocs[0].repositories, ['team/web'], 'disabled sources do not widen the active item');
  assert.equal(library.servers.length, 2, 'the disabled copies stay one separate, disabled item');
  const disabledDocs = library.servers.find(s => !s.enabled)!;
  assert.deepEqual(await store.legacyProfileExtensions(active), { servers: [enabledDocs[0].name], skills: [bundleId] });
  assert.deepEqual(await store.legacyProfileExtensions(serverOff), { servers: [disabledDocs.name], skills: [] });
  assert.deepEqual(await store.legacyProfileExtensions(profileOff), { servers: [disabledDocs.name], skills: [inactiveBundleId] });
  assert.deepEqual(library.skills.map(s => [s.bundleId, s.enabled]).sort(), [[bundleId, true], [inactiveBundleId, false]].sort());
  // An automation that selected either inactive source launches with nothing.
  for (const profileId of [serverOff, profileOff]) {
    const additional = (await store.legacyProfileExtensions(profileId))!;
    const { set } = await store.resolveLaunch({ agentAlias: 'claude-main', runtime: 'claude', repositories: ['team/api'], allowWrite: true, additional }, false);
    assert.deepEqual(set.servers, []); assert.deepEqual(set.skills, []);
    assert.ok(set.skipped.every(s => s.reason === 'disabled'), JSON.stringify(set.skipped));
  }
});

test('nonterminal automation runs keep the extensions their captured definition selected', async t => {
  const { database, instanceId } = await fixture(t);
  await database.schema.createTable('agent_runs', c => { c.string('id').primary(); c.string('state'); c.text('definition_snapshot'); });
  const profileId = await profile(database, instanceId, { name: 'Docs', servers: [docs({ authentication: 'none' })] });
  const snapshot = (extra: Record<string, unknown>) => JSON.stringify({ id: 'bound', name: 'Bound', repositories: ['team/repo'], ...extra });
  await database('agent_runs').insert([
    { id: 'queued', state: 'queued', definition_snapshot: snapshot({ extensionProfile: JSON.parse(selection(instanceId, profileId)) }) },
    { id: 'awaiting', state: 'awaiting_approval', definition_snapshot: snapshot({ extensionProfile: JSON.parse(selection(instanceId, profileId)) }) },
    { id: 'acting', state: 'acting', definition_snapshot: snapshot({ extensionProfile: JSON.parse(selection(instanceId, profileId)) }) },
    { id: 'missing', state: 'queued', definition_snapshot: snapshot({ extensionProfile: JSON.parse(selection(instanceId, randomUUID())) }) },
    { id: 'done', state: 'completed', definition_snapshot: snapshot({ extensionProfile: JSON.parse(selection(instanceId, profileId)) }) },
    { id: 'new', state: 'queued', definition_snapshot: snapshot({ extensions: { servers: [], skills: [] } }) },
  ]);
  const before = Object.fromEntries((await database('agent_runs')).map(r => [r.id, r.definition_snapshot]));
  const report = await migrateExtensionProfilesToLibrary(database, environment, quiet);
  const runs = Object.fromEntries((await database('agent_runs')).map(r => [r.id, r.definition_snapshot]));
  for (const id of ['queued', 'awaiting', 'acting']) {
    const parsed = JSON.parse(runs[id]);
    assert.deepEqual(parsed.extensions, { servers: ['docs'], skills: [] }, id);
    assert.equal(parsed.name, 'Bound'); assert.ok(parsed.extensionProfile, 'the old selection is kept');
  }
  assert.deepEqual(JSON.parse(runs.missing).extensions, { servers: [], skills: [] });
  assert.ok(report.warnings.some(w => w.includes('missing')));
  assert.equal(runs.done, before.done, 'terminal runs are history and stay unchanged');
  assert.equal(runs.new, before.new);
});
