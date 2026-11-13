import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';
import { ExtensionLibraryStore } from '../src/extensions/extensionProfileStore.js';
import { extensionLibraryUsage } from '../src/extensions/extensionLibraryUsage.js';

test('library usage names the automations that add items and the profiles migrated items came from', async t => {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await up(database); await grantMigration(database); await libraryMigration(database);
  const instanceId = (await database('extension_instance_identity').first()).instance_id as string;
  const store = new ExtensionLibraryStore(database, { SYSTEM_TASK_SECRET: 'synthetic-usage-custody-key' });
  const server = (name: string) => ({ kind: 'https' as const, name, url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read' as const, authentication: 'none' as const, repositories: [], agents: [], autoApply: false });
  const library = await store.saveLibrary('1', { version: 1, servers: [server('docs'), server('search'), server('constructor'), server('tostring')], skills: [] }, {}, 0);
  const bundleId = randomUUID();
  await database('agent_definitions').insert([
    { id: 'b', name: 'Weekly', extensions: JSON.stringify({ servers: ['docs'], skills: [] }) },
    { id: 'a', name: 'Audit', extensions: JSON.stringify({ servers: ['docs', 'search'], skills: [] }) },
    { id: 'c', name: 'Unrelated', extensions: JSON.stringify({ servers: ['gone'], skills: [] }) },
    { id: 'd', name: 'Corrupt', extensions: '{' },
  ]);
  const profileId = randomUUID();
  await database('extension_profiles').insert({ id: profileId, instance_id: instanceId, revision: 2, enabled: true, deleted: false });
  await database('extension_profile_revisions').insert({ profile_id: profileId, revision: 2, snapshot: JSON.stringify({ name: 'Docs profile' }), secrets_encrypted: '' });
  await database('extension_legacy_profile_items').insert({ profile_id: profileId, revision: 2, servers: JSON.stringify(['search', 'removed', 'constructor']), skills: JSON.stringify([bundleId]) });

  const usage = await extensionLibraryUsage(store, library);
  assert.deepEqual(usage.automations.map(a => [a.name, a.servers]), [['Audit', ['docs', 'search']], ['Weekly', ['docs']]]);
  // Only items still in the library are reported.
  // A name matching an inherited Object property is data: `constructor` is reported, `tostring` stays absent.
  assert.deepEqual(usage.importedFrom, { servers: { search: ['Docs profile'], constructor: ['Docs profile'] }, skills: {} });
  assert.equal(Object.hasOwn(usage.importedFrom.servers, 'tostring'), false);
});
