import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import {
  createAgentDefinition,
  deleteAgentDefinition,
  getAgentDefinition,
  listAgentDefinitions,
  rowToAgentDefinition,
  setAgentDefinitionAttachments,
  updateAgentDefinition,
  type AgentDefinitionRow,
} from '../packages/core/src/services/agents/agentDefinitionStore.ts';

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
// 2026-10-06T10:07:00Z
const NOW = Date.UTC(2026, 9, 6, 10, 7);

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

async function openDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.raw('PRAGMA foreign_keys = ON');
  await database.migrate.latest({ directory: migrations });
  return database;
}

describe('agent definition migration', () => {
  test('rollback drops agent_runs and agent_definitions', async () => {
    const database = await openDatabase();
    try {
      assert.ok(await database.schema.hasTable('agent_definitions'));
      assert.ok(await database.schema.hasTable('agent_runs'));
      const migration = await import('../packages/core/src/db/migrations/20261006000000_create_agent_definitions.js');
      await migration.down(database);
      assert.equal(await database.schema.hasTable('agent_runs'), false);
      assert.equal(await database.schema.hasTable('agent_definitions'), false);
    } finally {
      await database.destroy();
    }
  });
});

describe('agentDefinitionStore', () => {
  let database: Knex;
  const deps = () => ({ database, now: () => NOW });

  beforeEach(async () => { database = await openDatabase(); });
  afterEach(async () => { await database.destroy(); });

  test('creates a definition with defaults and reads it back for its owner only', async () => {
    const created = await createAgentDefinition({ ownerId: 'alice', name: 'Triage', prompt: 'Summarize new issues', repositories: ['acme/web'] }, deps());
    assert.equal(created.revision, 0);
    assert.equal(created.autonomyMode, 'dry_run');
    assert.deepEqual(created.capabilities, ['repository_read']);
    assert.equal(created.includePreviousReports, true);
    assert.equal(created.previousReportsLimit, 1);
    assert.equal(created.scheduleTimezone, 'UTC');
    assert.equal(created.nextRunAt, null);
    assert.equal(created.createdAt, NOW);

    assert.deepEqual(await getAgentDefinition(created.id, 'alice', deps()), created);
    assert.equal(await getAgentDefinition(created.id, 'bob', deps()), undefined);
    assert.equal(await updateAgentDefinition(created.id, 'bob', { name: 'Stolen' }, undefined, deps()), undefined);
    assert.equal(await deleteAgentDefinition(created.id, 'bob', deps()), false);
    assert.equal(await setAgentDefinitionAttachments(created.id, 'bob', [], deps()), undefined);
    assert.equal((await getAgentDefinition(created.id, 'alice', deps()))?.name, 'Triage');
  });

  test('lists only the owner definitions, newest first, with paging', async () => {
    for (const [index, name] of ['one', 'two', 'three'].entries()) {
      await createAgentDefinition({ ownerId: 'alice', name, prompt: 'p' }, { database, now: () => NOW + index });
    }
    await createAgentDefinition({ ownerId: 'bob', name: 'other', prompt: 'p' }, deps());

    const first = await listAgentDefinitions('alice', { limit: 2 }, deps());
    assert.equal(first.total, 3);
    assert.deepEqual(first.definitions.map(definition => definition.name), ['three', 'two']);
    const second = await listAgentDefinitions('alice', { limit: 2, offset: 2 }, deps());
    assert.deepEqual(second.definitions.map(definition => definition.name), ['one']);
  });

  test('a corrupt JSON column does not break the list page', async () => {
    const created = await createAgentDefinition({ ownerId: 'alice', name: 'Broken', prompt: 'p' }, deps());
    await database('agent_definitions').where({ id: created.id })
      .update({ repositories: '{not json', capabilities: '"web"', attachments: '[1, {"id": "a1"}]', autonomy_mode: 'bogus' });
    const { definitions } = await listAgentDefinitions('alice', {}, deps());
    assert.deepEqual(definitions[0].repositories, []);
    assert.deepEqual(definitions[0].capabilities, []);
    assert.deepEqual(definitions[0].attachments, [{ id: 'a1' }]);
    assert.equal(definitions[0].autonomyMode, 'dry_run');
  });

  test('rowToAgentDefinition maps integer booleans and null JSON', () => {
    const definition = rowToAgentDefinition({
      id: 'd1', owner_id: 'alice', name: 'n', description: null, repositories: null, prompt: 'p', attachments: null,
      agent_alias: null, model_name: null, capabilities: '["web","nope"]', include_previous_reports: 0, previous_reports_limit: 3,
      schedule_cron: null, schedule_timezone: null, schedule_enabled: 1, next_run_at: null, autonomy_mode: 'auto',
      enabled: 0, revision: 4, created_at: 1, updated_at: 2,
    } satisfies AgentDefinitionRow);
    assert.equal(definition.includePreviousReports, false);
    assert.equal(definition.scheduleEnabled, true);
    assert.equal(definition.enabled, false);
    assert.deepEqual(definition.capabilities, ['web']);
    assert.deepEqual(definition.repositories, []);
    assert.equal(definition.scheduleTimezone, 'UTC');
    assert.equal(definition.autonomyMode, 'auto');
  });

  test('enabling a schedule sets next_run_at to the next UTC occurrence and disabling clears it', async () => {
    const created = await createAgentDefinition({ ownerId: 'alice', name: 'Cron', prompt: 'p', scheduleCron: '*/15 * * * *' }, deps());
    assert.equal(created.nextRunAt, null);

    const enabled = await updateAgentDefinition(created.id, 'alice', { scheduleEnabled: true }, 0, deps());
    assert.equal(enabled?.nextRunAt, Date.UTC(2026, 9, 6, 10, 15));
    assert.equal(enabled?.revision, 1);

    const recron = await updateAgentDefinition(created.id, 'alice', { scheduleCron: '@daily' }, 1, deps());
    assert.equal(recron?.nextRunAt, Date.UTC(2026, 9, 7));

    const paused = await updateAgentDefinition(created.id, 'alice', { enabled: false }, undefined, deps());
    assert.equal(paused?.nextRunAt, null);
    const resumed = await updateAgentDefinition(created.id, 'alice', { enabled: true }, undefined, deps());
    assert.equal(resumed?.nextRunAt, Date.UTC(2026, 9, 7));

    const disabled = await updateAgentDefinition(created.id, 'alice', { scheduleEnabled: false }, undefined, deps());
    assert.equal(disabled?.nextRunAt, null);
    assert.equal(disabled?.scheduleCron, '@daily');

    const cleared = await updateAgentDefinition(created.id, 'alice', { scheduleEnabled: true, scheduleCron: null }, undefined, deps());
    assert.equal(cleared?.nextRunAt, null);

    const row = await database('agent_definitions').where({ id: created.id }).first();
    assert.equal(row.next_run_at, null);
  });

  test('creating an enabled schedule computes next_run_at, and an invalid cron is a 400', async () => {
    const created = await createAgentDefinition({ ownerId: 'alice', name: 'Weekday', prompt: 'p', scheduleCron: '0 9 * * 1-5', scheduleEnabled: true }, deps());
    assert.equal(created.nextRunAt, Date.UTC(2026, 9, 7, 9));
    await assert.rejects(
      createAgentDefinition({ ownerId: 'alice', name: 'Bad', prompt: 'p', scheduleCron: 'not a cron', scheduleEnabled: true }, deps()),
      (error: Error & { status?: number }) => error.status === 400,
    );
  });

  test('a stale expectedRevision throws 409 and leaves the definition unchanged', async () => {
    const created = await createAgentDefinition({ ownerId: 'alice', name: 'Rev', prompt: 'p' }, deps());
    const updated = await updateAgentDefinition(created.id, 'alice', { name: 'Rev 2', capabilities: ['web'] }, 0, deps());
    assert.equal(updated?.revision, 1);
    assert.deepEqual(updated?.capabilities, ['web']);

    await assert.rejects(
      updateAgentDefinition(created.id, 'alice', { name: 'Lost' }, 0, deps()),
      (error: Error & { status?: number }) => error.status === 409,
    );
    assert.equal((await getAgentDefinition(created.id, 'alice', deps()))?.name, 'Rev 2');
  });

  test('setting attachments keeps the revision', async () => {
    const created = await createAgentDefinition({ ownerId: 'alice', name: 'Files', prompt: 'p' }, deps());
    const attachment = { id: 'att-1', originalName: 'a.txt', storedPath: '/tmp/a.txt', mimeType: 'text/plain', size: 3, tokenEstimate: 1, type: 'text' as const };
    const updated = await setAgentDefinitionAttachments(created.id, 'alice', [attachment], deps());
    assert.deepEqual(updated?.attachments, [attachment]);
    assert.equal(updated?.revision, 0);
  });

  test('deleting a definition cascades to its runs', async () => {
    const created = await createAgentDefinition({ ownerId: 'alice', name: 'Runs', prompt: 'p' }, deps());
    const run = {
      definition_id: created.id, owner_id: 'alice', trigger: 'manual', state: 'queued', autonomy_mode: 'dry_run',
      definition_snapshot: JSON.stringify(created), created_at: NOW, updated_at: NOW,
    };
    await database('agent_runs').insert({ ...run, id: crypto.randomUUID(), idempotency_key: 'k1' });
    await assert.rejects(database('agent_runs').insert({ ...run, id: crypto.randomUUID(), idempotency_key: 'k1' }));
    await database('agent_runs').insert({ ...run, id: crypto.randomUUID(), idempotency_key: null });

    assert.equal(await deleteAgentDefinition(created.id, 'alice', deps()), true);
    assert.equal(await getAgentDefinition(created.id, 'alice', deps()), undefined);
    assert.deepEqual(await database('agent_runs').where({ definition_id: created.id }), []);
  });
});
