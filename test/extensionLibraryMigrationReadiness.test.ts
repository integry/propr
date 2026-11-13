import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import type { AgentConfig } from '../packages/core/src/config/configManagerAgents.ts';
import type { RepoToMonitor } from '../packages/core/src/config/configManager.ts';
import { createAgentDefinition, getAgentDefinition, type StoredAgentDefinition } from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import { listAgentRuns } from '../packages/core/src/services/agents/agentRunStore.ts';
import { AgentRunTriggerError, triggerAgentRun, validateAgentDefinitionRuntime, type AgentRunTriggerDependencies } from '../packages/core/src/services/agents/agentRunTrigger.ts';
import { legacyAutomationExtensionsPending } from '../packages/core/src/extensions/extensionLibraryMigration.ts';

/**
 * While the startup profile → library migration has not completed, an
 * automation's or submission's legacy selection must not be read as "no
 * extensions": launches are deferred, and a later successful migration is
 * used (retried inline) rather than a run capturing an empty selection.
 */
const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const NOW = Date.UTC(2026, 10, 13, 9, 0);
const previousSecret = process.env.SYSTEM_TASK_SECRET;
process.env.SYSTEM_TASK_SECRET = 'synthetic-readiness-custody-key';

after(async () => {
  if (previousSecret === undefined) delete process.env.SYSTEM_TASK_SECRET; else process.env.SYSTEM_TASK_SECRET = previousSecret;
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

const agent: AgentConfig = { id: 'agent-claude', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'propr/agent', configPath: '~/.claude', supportedModels: ['opus'], defaultModel: 'opus' };

describe('legacy extension selections while the library migration is incomplete', () => {
  let database: Knex;
  let instanceId: string;
  let profileId: string;
  let failing: boolean;
  const enqueued: unknown[] = [];
  const deps = (): AgentRunTriggerDependencies => ({
    database, now: () => NOW, enqueue: async (_name, data) => { enqueued.push(data); },
    loadRepos: async () => [{ id: 'r', name: 'acme/app', enabled: true } as RepoToMonitor], loadAgents: async () => [agent], loadSyntheticAgents: async () => [],
    costGate: { loadThreshold: async () => 90, evaluateCapacity: async () => ({ status: 'unknown', provider: 'claude' }) },
  });
  const failWrites = (query: { sql: string }) => { if (failing && query.sql.startsWith('insert into `extension_library_revisions`')) throw new Error('synthetic write failure'); };

  beforeEach(async () => {
    database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await database.migrate.latest({ directory: migrations });
    instanceId = (await database('extension_instance_identity').first()).instance_id;
    profileId = randomUUID();
    const snapshot = {
      version: 1, instanceId, profileId, revision: 1, name: 'Docs', enabled: true, agentScope: [], repositoryScope: [], skillBundleIds: [], skillBundles: [], secrets: {},
      mcpServers: [{ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'none' }], createdAt: 1, updatedAt: 1, auditActor: '1',
    };
    await database('extension_profiles').insert({ id: profileId, instance_id: instanceId, revision: 1, enabled: true, deleted: false });
    await database('extension_profile_revisions').insert({ profile_id: profileId, revision: 1, snapshot: JSON.stringify(snapshot), secrets_encrypted: '' });
    failing = true; enqueued.length = 0;
    database.on('query', failWrites);
  });
  afterEach(async () => { database.removeListener('query', failWrites); await database.destroy(); });

  /** An automation saved before the upgrade: it names its profile and has no `extensions` yet. */
  async function legacyDefinition(): Promise<StoredAgentDefinition> {
    const created = await createAgentDefinition({ ownerId: 'alice', name: 'Docs check', prompt: 'Check', repositories: ['acme/app'], agentAlias: 'claude', modelName: 'opus' }, { database, now: () => NOW });
    await database('agent_definitions').where({ id: created.id }).update({ extension_profile: JSON.stringify({ instanceId, profileId, revision: 1 }) });
    return (await getAgentDefinition(created.id, 'alice', { database }))!;
  }

  test('a run is refused, not created without extensions, while the migration keeps failing', async () => {
    const definition = await legacyDefinition();
    assert.deepEqual(definition.extensions, { servers: [], skills: [] }, 'the row mapper sees no translated selection');
    assert.equal(await legacyAutomationExtensionsPending(definition, database), true);
    await assert.rejects(triggerAgentRun({ definition, trigger: 'manual', triggerSource: 'alice' }, deps()),
      (error: unknown) => error instanceof AgentRunTriggerError && error.code === 'EXTENSIONS_MIGRATION_PENDING' && error.status === 409);
    assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).runs.length, 0);
    assert.equal(enqueued.length, 0);
    assert.equal(await database('extension_library_migration').first(), undefined);
  });

  test('once the migration can complete, the trigger retries it and the run captures the translated selection', async () => {
    const definition = await legacyDefinition();
    failing = false;
    const { run, created } = await triggerAgentRun({ definition, trigger: 'manual', triggerSource: 'alice' }, deps());
    assert.equal(created, true);
    assert.deepEqual(run.definitionSnapshot?.extensions, { servers: ['docs'], skills: [] });
    assert.ok(await database('extension_library_migration').first());
    assert.equal(await legacyAutomationExtensionsPending(definition, database), false);
  });

  test('automations without a legacy selection are not held back by a failing migration', async () => {
    const definition = await createAgentDefinition({ ownerId: 'alice', name: 'Plain', prompt: 'Check', repositories: ['acme/app'], agentAlias: 'claude', modelName: 'opus' }, { database, now: () => NOW });
    const { created } = await triggerAgentRun({ definition, trigger: 'manual', triggerSource: 'alice' }, deps());
    assert.equal(created, true);
  });

  test('a run snapshot captured before the upgrade does not launch until its selection is translated', async () => {
    const definition = await legacyDefinition();
    const { extensions: _dropped, ...rest } = definition;
    const snapshot = { ...rest, extensionProfile: { instanceId, profileId, revision: 1 } } as StoredAgentDefinition;
    assert.match((await validateAgentDefinitionRuntime(snapshot, deps())) ?? '', /migration has not completed/);
    failing = false;
    const { ensureExtensionLibraryMigrated } = await import('../packages/core/src/extensions/extensionLibraryMigration.ts');
    assert.equal(await ensureExtensionLibraryMigrated(database), true);
    assert.equal(await validateAgentDefinitionRuntime(snapshot, deps()), null);
  });

  test('a queued legacy submission is refused rather than run without its extensions', async () => {
    const { insertTaskSubmission, sealSubmissionExtensions, submissionExtensionsForRun } = await import('../packages/core/src/services/taskSubmissionService.ts');
    const taskId = 'legacy-submission-task';
    const payload = JSON.stringify({ instruction: 'Check docs', agentAlias: 'claude', model: 'opus', extensionProfile: { instanceId, profileId, revision: 1 } });
    const inserted = await insertTaskSubmission(database, { user_id: '1', submission_key: taskId, payload_hash: taskId, repository: 'acme/app', attachments: '[]', payload });
    await sealSubmissionExtensions(database, inserted, process.env);
    await database('task_submissions').where({ id: inserted.id }).update({ state: 'queued', task_id: taskId, latest_task_id: taskId, issue_number: 7 });
    const row = await database('task_submissions').where({ id: inserted.id }).first();
    const run = { taskId, agentAlias: 'claude', model: 'opus', repository: 'acme/app', issueNumber: 7 };
    await assert.rejects(submissionExtensionsForRun(row, run, process.env, database), /migration has not completed/);
    failing = false;
    assert.deepEqual((await submissionExtensionsForRun(row, run, process.env, database)).extensions?.servers, ['docs']);
  });
});
