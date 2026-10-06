import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { Response } from 'express';
import type { RedisClientType } from 'redis';
import type { FlatRequest } from '../requestTypes.js';
import { getTasksFromDb } from '../routes/taskHelpers.js';
import { createTaskHistoryRoutes } from '../routes/taskHistoryRoutes.js';
import { scheduledLabel } from '../services/scheduleProvenance.js';

const databases: Knex[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.destroy()));
});

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

async function createDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  databases.push(database);
  await database.schema.createTable('tasks', table => {
    table.string('task_id').primary();
    table.string('repository');
    table.string('task_type');
    table.string('model_name');
    table.string('correlation_id');
    table.timestamp('created_at');
    table.text('initial_job_data');
    table.text('final_result');
    table.integer('issue_number');
    table.integer('pr_number');
    table.string('commit_hash');
    table.string('schedule_id', 36).nullable();
  });
  await database.schema.createTable('task_schedules', table => {
    table.uuid('id').primary();
    table.string('name', 200).notNullable();
  });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.string('task_id');
    table.string('state');
    table.timestamp('timestamp');
    table.text('reason');
    table.text('metadata');
  });
  await database.schema.createTable('plan_issues', table => {
    table.increments('id').primary();
    table.string('task_id');
    table.string('status');
  });
  await database.schema.createTable('llm_executions', table => {
    table.increments('execution_id').primary();
    table.string('task_id');
    table.text('start_time');
    table.text('session_id');
    table.float('cost_usd');
  });
  await database.schema.createTable('llm_logs', table => {
    table.increments('log_id');
    table.text('draft_id');
    table.text('execution_type');
    table.text('start_time');
    table.text('usage_metrics');
  });

  await database('task_schedules').insert({ id: 'schedule-1', name: 'Nightly dependency patrol' });
  await database('tasks').insert([
    { task_id: 'scheduled', repository: 'acme/widget', task_type: 'issue', issue_number: 3, schedule_id: 'schedule-1', created_at: '2026-10-06T03:00:00.000Z' },
    { task_id: 'orphaned', repository: 'acme/widget', task_type: 'issue', issue_number: 2, schedule_id: 'deleted-schedule', created_at: '2026-10-06T02:00:00.000Z' },
    { task_id: 'manual', repository: 'acme/widget', task_type: 'issue', issue_number: 1, created_at: '2026-10-06T01:00:00.000Z' },
  ]);
  await database('task_history').insert([
    { task_id: 'scheduled', state: 'completed', timestamp: '2026-10-06T03:05:00.000Z' },
    { task_id: 'orphaned', state: 'completed', timestamp: '2026-10-06T02:05:00.000Z' },
    { task_id: 'manual', state: 'completed', timestamp: '2026-10-06T01:05:00.000Z' },
  ]);
  return database;
}

test('the task list names the schedule that created each task', async () => {
  const database = await createDatabase();
  const page = await getTasksFromDb({
    db: database, status: 'all', repository: 'all', limit: 10, offset: 0,
    previewReader: { project: async (sources: unknown[]) => sources.map(() => ({ previews: [] })) } as never,
  });
  const tasks = page.tasks as Array<{ id: string; scheduleId?: string; scheduleName?: string | null }>;
  assert.deepEqual(tasks.map(({ id, scheduleId, scheduleName }) => ({ id, scheduleId, scheduleName })), [
    { id: 'scheduled', scheduleId: 'schedule-1', scheduleName: 'Nightly dependency patrol' },
    // A deleted schedule leaves the provenance without a name.
    { id: 'orphaned', scheduleId: 'deleted-schedule', scheduleName: null },
    { id: 'manual', scheduleId: undefined, scheduleName: undefined },
  ]);
  assert.equal(page.total, 3);
});

test('task detail carries the schedule in its task info', async () => {
  const database = await createDatabase();
  const routes = createTaskHistoryRoutes({
    db: database,
    redisClient: { get: async () => null } as unknown as RedisClientType,
    taskQueue: {} as never,
    previewReader: { project: async (sources: unknown[]) => sources.map(() => ({ previews: [] })) } as never,
  });
  const detail = async (taskId: string) => {
    let payload: unknown;
    const response = {
      status() { return response; },
      json(value: unknown) { payload = value; return response; },
      type() { return response; },
      send(value: string) { payload = JSON.parse(value); return response; },
    } as unknown as Response;
    await routes.getTaskHistory({ params: { taskId } } as unknown as FlatRequest, response);
    return (payload as { taskInfo: Record<string, unknown> }).taskInfo;
  };

  const scheduled = await detail('scheduled');
  assert.equal(scheduled.scheduleId, 'schedule-1');
  assert.equal(scheduled.scheduleName, 'Nightly dependency patrol');
  const orphaned = await detail('orphaned');
  assert.equal(orphaned.scheduleId, 'deleted-schedule');
  assert.equal(orphaned.scheduleName, null);
  const manual = await detail('manual');
  assert.equal('scheduleId' in manual, false);
});

test('the provenance label falls back to "Scheduled" without a name', () => {
  assert.equal(scheduledLabel('Nightly dependency patrol'), 'Scheduled: Nightly dependency patrol');
  assert.equal(scheduledLabel(null), 'Scheduled');
  assert.equal(scheduledLabel('  '), 'Scheduled');
});
