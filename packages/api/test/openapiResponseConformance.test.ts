import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import type { RedisClientType } from 'redis';
import { z } from 'zod';
import { closeConnection, runCostCapKey } from '@propr/core';
import { configureDemoMode } from '../demoMode.js';
import { TaskHistory, TaskPage, TaskSubmission } from '../openapi/schemas.js';
import type { FlatRequest } from '../requestTypes.js';
import { createTaskHistoryRoutes } from '../routes/taskHistoryRoutes.js';
import { createTaskRoutes } from '../routes/taskRoutes.js';
import { createTaskSubmissionRoutes } from '../routes/taskSubmissionRoutes.js';

/**
 * The handlers and the schemas in openapi/schemas.ts are maintained
 * separately. These tests run the handlers of the operations `@propr/client`
 * types against a migrated database and check what they send against the
 * schemas the published spec and the client types are generated from.
 */

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/src/db/migrations');
const databases: Knex[] = [];

after(closeConnection);
afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.destroy()));
});

async function migratedDatabase(): Promise<Knex> {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
    migrations: { directory: migrations, loadExtensions: ['.js'] },
  });
  databases.push(database);
  await database.migrate.latest();
  return database;
}

/** Records what a handler sends, as the client receives it: status and parsed JSON. */
function recorder() {
  const sent: { status: number; body?: unknown } = { status: 200 };
  const response = {
    status(code: number) { sent.status = code; return response; },
    type() { return response; },
    json(value: unknown) { sent.body = JSON.parse(JSON.stringify(value)); return response; },
    send(value: string) { sent.body = JSON.parse(value); return response; },
  } as unknown as Response;
  return { response, sent };
}

function assertConforms(schema: z.ZodType, body: unknown, label: string): void {
  const result = schema.safeParse(body);
  assert.ok(result.success, `${label} does not match its schema:\n${result.success ? '' : z.prettifyError(result.error)}`);
  // Parsing drops fields a closed (non-`.loose()`) schema does not list, so any
  // difference is a field the handler sends but the spec forbids.
  assert.deepEqual(result.data, body, `${label} sends fields its schema does not allow`);
}

function redis(values: Record<string, unknown> = {}): RedisClientType {
  return {
    get: async (key: string) => key in values ? JSON.stringify(values[key]) : null,
  } as unknown as RedisClientType;
}

describe('Handler responses match the published schemas', () => {
  it('GET /api/tasks returns TaskPage, by run and grouped by task', async () => {
    const db = await migratedDatabase();
    await db('tasks').insert([
      {
        task_id: 'run-completed', repository: 'acme/app', task_type: 'issue', issue_number: 12, pr_number: 40,
        model_name: 'opus', commit_hash: 'abc1234', created_at: '2026-10-06T10:00:00.000Z',
        initial_job_data: JSON.stringify({ title: 'Fix login', subtitle: 'Redirect', agentAlias: 'claude', issueNumber: 12 }),
      },
      {
        task_id: 'run-failed', repository: 'acme/app', task_type: 'pr-comment', issue_number: 40,
        created_at: '2026-10-06T09:00:00.000Z',
      },
      {
        task_id: 'run-queued', repository: 'acme/other', task_type: 'issue', issue_number: 3,
        created_at: '2026-10-06T08:00:00.000Z', initial_job_data: '{not json',
      },
    ]);
    await db('task_history').insert([
      { task_id: 'run-completed', state: 'processing', timestamp: '2026-10-06T10:01:00.000Z' },
      {
        task_id: 'run-completed', state: 'completed', timestamp: '2026-10-06T10:05:00.000Z',
        metadata: JSON.stringify({ notificationRecap: 'Score 8/10' }),
      },
      { task_id: 'run-failed', state: 'failed', reason: 'Agent exited', timestamp: '2026-10-06T09:02:00.000Z' },
      { task_id: 'run-queued', state: 'queued', timestamp: '2026-10-06T08:00:01.000Z' },
    ]);
    await db('task_drafts').insert({ draft_id: 'draft-1', user_id: 'alice', repository: 'acme/app', name: 'Login' });
    await db('plan_issues').insert({
      draft_id: 'draft-1', repository: 'acme/app', issue_number: 12, task_id: 'run-completed', status: 'merged',
    });
    const routes = createTaskRoutes({ db });

    for (const query of [{}, { status: 'failed' }, { groupBy: 'task', limit: '2' }]) {
      const { response, sent } = recorder();
      await routes.getTasks({ query } as unknown as Request, response);
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assertConforms(TaskPage, sent.body, `GET /api/tasks?${new URLSearchParams(query)}`);
      assert.ok((sent.body as { tasks: unknown[] }).tasks.length > 0);
    }
  });

  describe('GET /api/task/{taskId}/history returns TaskHistory', () => {
    async function history(db: Knex, taskId: string, options: { redis?: RedisClientType; job?: unknown } = {}) {
      const routes = createTaskHistoryRoutes({
        db,
        redisClient: options.redis ?? redis(),
        taskQueue: { getJob: async () => options.job } as never,
      });
      const { response, sent } = recorder();
      await routes.getTaskHistory({ params: { taskId } } as unknown as FlatRequest, response);
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assertConforms(TaskHistory, sent.body, `history of ${taskId}`);
      return sent.body as { history: unknown[]; taskInfo: unknown; budget?: unknown };
    }

    it('from the database, with executions, usage and a budget', async () => {
      const db = await migratedDatabase();
      await db('tasks').insert({
        task_id: 'db-task', repository: 'acme/app', task_type: 'issue', issue_number: 12, correlation_id: 'c-1',
        model_name: 'opus', initial_job_data: JSON.stringify({ title: 'Fix login', agentAlias: 'claude', commandMode: 'fix' }),
      });
      const [historyId] = await db('task_history').insert([
        { task_id: 'db-task', state: 'processing', timestamp: '2026-10-06T10:01:00.000Z' },
      ]);
      await db('task_history').insert([
        {
          task_id: 'db-task', state: 'completed', timestamp: '2026-10-06T10:05:00.000Z', reason: null,
          metadata: JSON.stringify({ sessionId: 'session-2', ultrafixCycle: 1 }),
        },
      ]);
      await db('llm_executions').insert({
        task_id: 'db-task', history_id: historyId, session_id: 'session-1', model_name: 'opus',
        start_time: '2026-10-06T10:01:00.000Z', duration_ms: 1000, success: true, num_turns: 3, input_tokens: 10,
      });
      const body = await history(db, 'db-task', {
        redis: redis({ [runCostCapKey('db-task')]: { capUsd: 5, source: 'override', spentUsd: 1 } }),
      });
      assert.equal(body.history.length, 2);
      assert.ok(body.taskInfo);
      assert.ok(body.budget, 'the budget branch should be covered');
    });

    it('falling back to live worker state in Redis', async () => {
      const db = await migratedDatabase();
      const body = await history(db, 'live-task', {
        redis: redis({
          'worker:state:live-task': {
            history: [
              { state: 'queued', timestamp: '2026-10-06T10:00:00.000Z' },
              { state: 'processing', timestamp: '2026-10-06T10:01:00.000Z', metadata: { sessionId: 'session-1' } },
            ],
            issueRef: { repoOwner: 'acme', repoName: 'app', number: 12, title: 'Fix login', modelName: 'opus' },
          },
        }),
      });
      assert.equal(body.history.length, 2);
      assert.ok(body.taskInfo);
    });

    it('falling back to the queued job', async () => {
      const db = await migratedDatabase();
      const finishedOn = Date.parse('2026-10-06T10:05:00.000Z');
      const body = await history(db, 'pr-comments-batch-1', {
        job: {
          timestamp: finishedOn - 300_000,
          processedOn: finishedOn - 240_000,
          finishedOn,
          data: { repoOwner: 'acme', repoName: 'app', pullRequestNumber: 40, title: 'Fixes #12', comments: [] },
          returnvalue: {
            modelName: 'opus',
            claudeResult: { sessionId: 'session-1', executionTime: 60_000, success: true, conversationLog: [] },
            postProcessing: { success: true, pr: { number: 40, url: 'https://github.com/acme/app/pull/40' } },
          },
        },
      });
      assert.ok(body.history.length >= 5);
      assert.ok(body.taskInfo);
    });

    it('for a task with no recorded state', async () => {
      const db = await migratedDatabase();
      const body = await history(db, 'unknown-task');
      assert.deepEqual(body.history, []);
      assert.equal(body.taskInfo, null);
    });
  });

  it('task submission routes return TaskSubmission', async () => {
    configureDemoMode(false);
    const db = await migratedDatabase();
    let queueAvailable = false;
    const routes = createTaskSubmissionRoutes({ db, services: {
      authorize: async () => ({ id: 'repo', name: 'acme/app', enabled: true, baseBranch: 'main' }),
      routing: async () => ({ agentAlias: 'claude', model: 'opus', routingLabel: 'llm-claude-opus' }),
      getOctokit: async () => ({ request: async (route: string) => {
        if (route.endsWith('/issues')) return { data: { number: 42, html_url: 'https://github.com/acme/app/issues/42' } };
        return { data: route.endsWith('/timeline') ? [] : {} };
      } }) as never,
      processingLabels: async () => ['AI'],
      enqueue: async () => { if (!queueAvailable) throw new Error('Queue unavailable'); },
    } });
    const request = (body?: unknown) => ({
      body, user: { id: 'alice', username: 'alice' }, files: [], params: { key: 'key-1' }, get: () => 'key-1',
    }) as unknown as Request;

    const created = recorder();
    await routes.submit(request({ repository: 'acme/app', instruction: 'Fix login' }), created.response);
    assert.equal(created.sent.status, 202, JSON.stringify(created.sent.body));
    assertConforms(TaskSubmission, created.sent.body, 'POST /api/task-submissions (stopped part way)');

    const read = recorder();
    await routes.get(request(), read.response);
    assert.equal(read.sent.status, 200);
    assertConforms(TaskSubmission, read.sent.body, 'GET /api/task-submissions/{key}');

    queueAvailable = true;
    const retried = recorder();
    await routes.retry(request(), retried.response);
    assert.equal(retried.sent.status, 200, JSON.stringify(retried.sent.body));
    assertConforms(TaskSubmission, retried.sent.body, 'POST /api/task-submissions/{key}/retry');
    assert.equal((retried.sent.body as { state: string }).state, 'queued');
  });
});
