import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Response } from 'express';
import knex, { type Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { FlatRequest } from '../requestTypes.js';
import { createTaskHistoryRoutes } from '../routes/taskHistoryRoutes.js';

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

/** The task tables the detail route reads, with the run table that owns automation tasks. */
async function createHistoryDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('tasks', table => {
    for (const column of ['task_id', 'repository', 'task_type', 'correlation_id', 'initial_job_data', 'model_name']) table.text(column);
    table.integer('issue_number');
  });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id');
    for (const column of ['task_id', 'state', 'timestamp', 'reason', 'metadata']) table.text(column);
  });
  await database.schema.createTable('llm_executions', table => {
    table.increments('execution_id');
    for (const column of ['task_id', 'start_time', 'session_id', 'model_name']) table.text(column);
    table.float('cost_usd');
  });
  await database.schema.createTable('llm_logs', table => {
    table.increments('log_id');
    for (const column of ['draft_id', 'execution_type', 'start_time', 'usage_metrics']) table.text(column);
  });
  await database.schema.createTable('agent_runs', table => {
    for (const column of ['id', 'report_task_id', 'action_task_id', 'definition_snapshot']) table.text(column);
  });
  return database;
}

function responseRecorder(): { response: Response; body: () => unknown } {
  let payload: unknown;
  const response = {
    status() { return response; },
    json(value: unknown) { payload = value; return response; },
    type() { return response; },
    send(value: string) { payload = JSON.parse(value); return response; },
  } as unknown as Response;
  return { response, body: () => payload };
}

test('a historical automation report task is named by its run snapshot and keeps no issue target', async () => {
  const database = await createHistoryDatabase();
  try {
    const reportRef = { number: 0, repoOwner: '', repoName: '', type: 'agent-run', title: 'Agent: Desktop acceptance', subtitle: 'Report run' };
    await database('tasks').insert([
      { task_id: 'agent-run-pinned-report', repository: '/', task_type: 'agent-run', issue_number: 0, initial_job_data: JSON.stringify(reportRef) },
      { task_id: 'agent-run-default-report', repository: '/', task_type: 'agent-run', issue_number: 0, initial_job_data: JSON.stringify(reportRef) },
    ]);
    await database('task_history').insert(['pinned', 'default'].map(id => ({
      task_id: `agent-run-${id}-report`, state: 'completed', timestamp: '2026-10-14T00:00:00.000Z', metadata: '{}',
    })));
    await database('agent_runs').insert([
      { id: 'pinned', report_task_id: 'agent-run-pinned-report', definition_snapshot: JSON.stringify({ agentAlias: 'codex', modelName: 'gpt-6-astra' }) },
      // A definition on defaults records neither; its current defaults are no evidence of what ran.
      { id: 'default', report_task_id: 'agent-run-default-report', definition_snapshot: JSON.stringify({ agentAlias: null, modelName: null }) },
    ]);
    const routes = createTaskHistoryRoutes({ db: database, redisClient: { get: async () => null } as unknown as RedisClientType, taskQueue: {} as never });

    const read = async (taskId: string) => {
      const recorder = responseRecorder();
      await routes.getTaskHistory({ params: { taskId } } as unknown as FlatRequest, recorder.response);
      return (recorder.body() as { taskInfo: Record<string, unknown> }).taskInfo;
    };
    const pinned = await read('agent-run-pinned-report');
    assert.equal(pinned.type, 'agent-run');
    assert.equal(pinned.taskKind, 'automation-report');
    assert.equal(pinned.number, 0);
    assert.equal(pinned.modelName, 'gpt-6-astra');
    assert.equal(pinned.agentAlias, 'codex');
    const unknown = await read('agent-run-default-report');
    assert.equal(unknown.taskKind, 'automation-report');
    assert.equal(unknown.modelName, null);
  } finally {
    await database.destroy();
  }
});

test('a live automation report task keeps its kind and type while running', async () => {
  const database = await createHistoryDatabase();
  try {
    const redisClient = {
      get: async () => JSON.stringify({
        history: [{ state: 'claude_execution', timestamp: '2026-10-14T00:00:00.000Z', metadata: { model: 'gpt-6-astra', executionRouting: { model: 'gpt-6-astra', agentAlias: 'codex' } } }],
        issueRef: { number: 0, repoOwner: 'acme', repoName: 'web', type: 'agent-run', title: 'Agent: Watch', subtitle: 'Report run' },
      }),
    } as unknown as RedisClientType;
    const routes = createTaskHistoryRoutes({ db: database, redisClient, taskQueue: {} as never });
    const recorder = responseRecorder();
    await routes.getTaskHistory({ params: { taskId: 'agent-run-live-report' } } as unknown as FlatRequest, recorder.response);
    const { taskInfo } = recorder.body() as { taskInfo: Record<string, unknown> };
    assert.equal(taskInfo.type, 'agent-run');
    assert.equal(taskInfo.taskKind, 'automation-report');
    assert.equal(taskInfo.modelName, 'gpt-6-astra');
    assert.equal(taskInfo.agentAlias, 'codex');
  } finally {
    await database.destroy();
  }
});
