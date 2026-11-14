import assert from 'node:assert/strict';
import knex from 'knex';
import { db } from '@propr/core';
import { ExtensionLibraryStore, extensionTokenHash } from '../../packages/core/src/extensions/extensionProfileStore.js';
import { executeWithExtensions, currentExtensionLaunch } from '../../packages/core/src/extensions/extensionLaunch.js';
import { up } from '../../packages/core/src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../../packages/core/src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../../packages/core/src/db/migrations/20261113000000_extension_library.js';
import type { AgentTaskOptions, AgentConfig } from '@propr/core';

/** Real policy resolution and grant capture; only external execution is replaced. */
export async function extensionLaunchIntegrationFixture() {
  const hadConfigs = await db.schema.hasTable('system_configs');
  if (!hadConfigs) await db.schema.createTable('system_configs', c => { c.string('key').primary(); c.text('value'); });
  const policies = { agent_network_mode: 'restricted', agent_network_mode_enforced: true, agent_network_allow: ['8.8.8.8'], agent_network_ignore_repository_allow: false };
  const keys = Object.keys(policies);
  const previous = await db('system_configs').whereIn('key', keys);
  for (const [key, value] of Object.entries(policies)) await db('system_configs').insert({ key, value: JSON.stringify(value) }).onConflict('key').merge();
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await up(database); await grantMigration(database); await libraryMigration(database);
  const store = new ExtensionLibraryStore(database, { SYSTEM_TASK_SECRET: 'synthetic-integration-custody' });
  // Added explicitly by automations and legacy submissions; it never applies automatically.
  await store.saveLibrary('1', { version: 1, skills: [], servers: [{ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', authentication: 'none', enabled: true, tools: ['lookup'], capability: 'read', autoApply: false }] }, {}, 0);
  const extensions = { servers: ['docs'], skills: [] };
  /** A pre-library profile selection whose legacy mapping names the migrated item. */
  const legacyProfileId = '00000000-0000-4000-8000-000000000001';
  const selection = { instanceId: await store.instanceId(), profileId: legacyProfileId, revision: 1 };
  await database('extension_legacy_profile_items').insert({ profile_id: legacyProfileId, revision: selection.revision, servers: JSON.stringify(['docs']), skills: '[]' });
  let captures = 0;
  return {
    selection,
    extensions,
    store,
    database,
    captures: () => captures,
    /**
     * Makes the library item apply automatically but disabled, so nothing
     * applies until the returned `enable` runs; tests call it after the
     * processor has chosen its network scope, before the launch resolves items.
     */
    lateEnabledAutoApply: async () => {
      const { revision } = await store.readLibrary('1');
      await store.saveLibrary('1', { version: 1, skills: [], servers: [{ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', authentication: 'none', enabled: false, tools: ['lookup'], capability: 'read', autoApply: true }] }, {}, revision);
      return { enable: async () => { await store.setItemEnabled('1', { kind: 'server', name: 'docs' }, true); } };
    },
    execute: (options: AgentTaskOptions, { inspect, networkMode = 'restricted' }: { inspect?: (prepared: AgentTaskOptions) => void; networkMode?: 'open' | 'restricted' } = {}) => executeWithExtensions({ type: 'claude', alias: 'claude' } as AgentConfig, options, async prepared => {
      inspect?.(prepared);
      const token = prepared.toolPolicy!.mcpServers!.find(s => s.name === 'docs')!.bearerToken;
      const grant = await database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).first();
      const network = JSON.parse(grant.network_policy);
      assert.equal(network.mode, networkMode);
      if (networkMode === 'restricted') {
        assert.ok(network.allow.includes('8.8.8.8'));
        assert.deepEqual(network.instanceAllow, ['8.8.8.8']);
      }
      await currentExtensionLaunch()!.beforeLaunch();
      assert.equal((await store.grantSnapshot(token)).network.mode, networkMode);
      captures++;
      return { success: true, logs: '', modifiedFiles: [], modelUsed: 'synthetic', executionTimeMs: 1, summary: 'Documentation checked.' };
    }, store),
    cleanup: async () => {
      await database.destroy();
      await db('system_configs').whereIn('key', keys).delete();
      if (previous.length) await db('system_configs').insert(previous);
      if (!hadConfigs) await db.schema.dropTable('system_configs');
    },
  };
}
