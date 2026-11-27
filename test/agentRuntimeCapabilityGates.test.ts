import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import {
  AGENT_RUNTIME_CAPABILITIES, AGENT_TYPES, AUTOMATION_DEFINITION_CONTRACT, EXTENSION_LIBRARY_CONTRACT, agentRuntimeCapabilities,
  agentTypeSupportsProprMcp, extensionItemSkipReason, type AgentRuntimeCapabilityEntry, type AgentType, type ExtensionLibraryServer,
} from '@propr/shared';
import type { AgentConfig } from '../packages/core/src/config/configManagerAgents.ts';
import type { StoredAgentDefinition } from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import { validateAgentDefinitionRuntime } from '../packages/core/src/services/agents/agentRunTrigger.ts';
import { ExtensionLibraryStore } from '../packages/core/src/extensions/extensionProfileStore.ts';
import { executeWithExtensions } from '../packages/core/src/extensions/extensionLaunch.ts';
import { MCP_LAUNCH_BUILDERS } from '../packages/core/src/agents/mcpLaunch/index.ts';
import { up as profilesMigration } from '../packages/core/src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../packages/core/src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../packages/core/src/db/migrations/20261113000000_extension_library.js';
import { launchCarriesExtensions } from '../src/jobs/agentRuns/agentTaskOptions.ts';

/**
 * The runtime capability map is the one source of every extension and ProPR
 * MCP gate: flipping an entry turns each gate on or off for that agent type,
 * and nothing else names a runtime.
 */
const NOW = Date.UTC(2026, 10, 27, 12);
const map = AGENT_RUNTIME_CAPABILITIES as Record<AgentType, AgentRuntimeCapabilityEntry>;
const docs = { kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'none', repositories: [], agents: [], autoApply: true } as const;

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

async function libraryStore(): Promise<{ database: Knex; store: ExtensionLibraryStore }> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await database.schema.createTable('tasks', c => c.string('task_id').primary());
  await database.schema.createTable('task_history', c => { c.string('task_id'); c.string('state'); c.string('timestamp'); c.text('reason'); c.text('metadata'); });
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await profilesMigration(database); await grantMigration(database); await libraryMigration(database);
  const store = new ExtensionLibraryStore(database, { SYSTEM_TASK_SECRET: 'synthetic-capability-gates' });
  await store.saveLibrary('1', { version: 1, servers: [docs], skills: [] }, {}, 0);
  return { database, store };
}

const agent = (type: AgentType): AgentConfig => ({
  id: `agent-${type}`, type, alias: `${type}-main`, enabled: true, dockerImage: 'propr/agent', configPath: '/unused', supportedModels: ['model'], defaultModel: 'model',
});
const definition = (type: AgentType, overrides: Partial<StoredAgentDefinition>): StoredAgentDefinition => ({
  id: 'def-1', ownerId: 'alice', name: 'Triage', description: null, repositories: ['acme/app'], prompt: 'Summarize',
  attachments: [], agentAlias: `${type}-main`, modelName: 'model', capabilities: ['repository_read'], includePreviousReports: false,
  previousReportsLimit: 0, scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
  autonomyMode: 'dry_run', enabled: true, revision: 1, createdAt: NOW, updatedAt: NOW, ...overrides,
});
const repo = { id: 'id-acme/app', name: 'acme/app', enabled: true } as never;

async function withEntry<T>(type: AgentType, entry: Partial<AgentRuntimeCapabilityEntry>, run: () => Promise<T>): Promise<T> {
  const previous = map[type];
  map[type] = { ...previous, ...entry };
  try { return await run(); } finally { map[type] = previous; }
}

describe('runtime capability map drives every gate', () => {
  const cases = AGENT_TYPES.flatMap(type => [true, false].map(enabled => ({ type, enabled })));
  for (const { type, enabled } of cases) {
    test(`${type} with extensions and ProPR MCP ${enabled ? 'on' : 'off'}`, async () => withEntry(type, { extensions: enabled, proprMcp: enabled }, async () => {
      const { database, store } = await libraryStore();
      try {
        const config = agent(type);
        const deps = { loadRepos: async () => [repo], loadAgents: async () => [config], loadSyntheticAgents: async () => [] };
        // Shared resolution: an item that would apply is skipped for `runtime` only.
        assert.equal(extensionItemSkipReason({ servers: [docs as ExtensionLibraryServer], skills: [] }, docs as ExtensionLibraryServer, { agentAlias: config.alias, runtime: type, repository: 'acme/app' }), enabled ? null : 'runtime');
        // New Task preview.
        const preview = await store.taskPreview({ repository: 'acme/app', agentAlias: config.alias, runtime: type });
        assert.equal(preview.qualified, enabled);
        assert.deepEqual(preview.unsupported, enabled ? undefined : { agentAlias: config.alias, runtime: type });
        // Launch resolution.
        const launch = store.resolveLaunch({ agentAlias: config.alias, runtime: type, repositories: ['acme/app'], allowWrite: false }, false);
        if (enabled) assert.deepEqual((await launch).set.servers.map(s => s.name), ['docs']);
        else await assert.rejects(launch, (error: Error & { status?: number }) => error.status === 400 && /Extensions require/.test(error.message));
        // Worker network-scope decision.
        assert.equal(launchCarriesExtensions({ agent: { config } }, { extensions: { autoApply: true, servers: [], skills: [] } } as never), enabled);
        // Agent definitions and automations: added items and ProPR MCP.
        const added = await validateAgentDefinitionRuntime(definition(type, { extensions: { servers: ['docs'], skills: [] } }), deps);
        assert.equal(added === null, enabled, String(added));
        const mcp = await validateAgentDefinitionRuntime(definition(type, { capabilities: ['propr_mcp'] }), deps);
        assert.equal(mcp === null, enabled, String(mcp));
        assert.equal(agentTypeSupportsProprMcp(type), enabled);
        // Task submission routing of a legacy extension selection.
        const { routing } = await import('../packages/api/routes/taskSubmissionRoutes.ts');
        const registry = { ensureInitialized: async () => undefined, getAgentByAlias: () => ({ config }) } as never;
        const routed = routing({ agentAlias: config.alias, model: 'model', extensionProfile: { instanceId: 'i', profileId: 'p', revision: 1 } }, registry, async () => 'llm-selected', async () => ({ agentAlias: config.alias, model: 'model' }));
        if (enabled) assert.equal((await routed).runtime, type);
        else await assert.rejects(routed, (error: Error & { status?: number }) => error.status === 400);
      } finally { await database.destroy(); }
    }));
  }

  test('contracts and MCP builders derive from the map', () => {
    const extensionTypes = AGENT_TYPES.filter(type => map[type].extensions);
    assert.deepEqual([...EXTENSION_LIBRARY_CONTRACT.runtimes], extensionTypes);
    assert.deepEqual([...AUTOMATION_DEFINITION_CONTRACT.extensions.runtimes], extensionTypes);
    assert.deepEqual([...AUTOMATION_DEFINITION_CONTRACT.proprMcpAgentTypes], AGENT_TYPES.filter(type => map[type].proprMcp));
    // Claude, Codex and Antigravity are on; every other runtime is turned on by its own change.
    assert.deepEqual(extensionTypes, ['claude', 'codex', 'antigravity']);
    // A runtime that receives MCP servers renders them through its own builder.
    for (const type of AGENT_TYPES) if (map[type].extensions || map[type].proprMcp) assert.equal(typeof MCP_LAUNCH_BUILDERS[type], 'function', type);
  });

  test('the CLI-version predicate removes capabilities from older OpenCode releases', () => withEntry('opencode', { extensions: true, proprMcp: true }, async () => {
    assert.equal(agentRuntimeCapabilities('opencode', '1.4.2').extensions, false);
    assert.equal(agentRuntimeCapabilities('opencode', '2.0.0').extensions, true);
    // Without a concrete version the mapped entry applies.
    assert.equal(agentRuntimeCapabilities('opencode', 'latest').extensions, true);
    assert.equal(agentRuntimeCapabilities('opencode').proprMcp, true);
    assert.equal(launchCarriesExtensions({ agent: { config: { type: 'opencode', cliVersionResolved: '1.9.0' } } }, { extensions: { autoApply: true, servers: [], skills: [] } } as never), false);
    assert.equal(agentRuntimeCapabilities('unknown-runtime').extensions, false);
  }));
});

test('a runtime without extension support records its skipped auto-applied items and launches without them', async () => {
  const { database, store } = await libraryStore();
  try {
    await database('tasks').insert({ task_id: 'task-1' });
    const config = agent('vibe');
    const options = { taskId: 'task-1', issueRef: { repoOwner: 'acme', repoName: 'app', number: 1 }, prompt: 'Fix it', worktreePath: '/unused', extensions: { autoApply: true, servers: [], skills: [], kind: 'issue' as const, labels: [] } };
    let launched: unknown = 'not launched';
    await executeWithExtensions(config, options as never, async prepared => { launched = prepared.extensions; return { success: true } as never; }, store);
    assert.equal(launched, null);
    const rows = await database('task_history').where({ task_id: 'task-1' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'Extensions resolved; some items were skipped');
    const event = JSON.parse(rows[0].metadata);
    assert.equal(event.event, 'extensions.resolved');
    assert.deepEqual(event.servers, []);
    assert.deepEqual(event.skipped, [{ kind: 'server', name: 'docs', reason: 'runtime', source: 'auto' }]);
    // Explicitly added items still refuse on such a runtime.
    await assert.rejects(executeWithExtensions(config, { ...options, extensions: { ...options.extensions, servers: ['docs'] } } as never, async () => ({ success: true }) as never, store),
      (error: Error & { status?: number }) => error.status === 400 && /Claude, Codex or Antigravity/.test(error.message));
  } finally { await database.destroy(); }
});
