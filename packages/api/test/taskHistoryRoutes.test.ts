import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import type { Response } from 'express';
import knex, { type Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { FlatRequest } from '../requestTypes.js';
import { createTaskHistoryRoutes } from '../routes/taskHistoryRoutes.js';

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

async function createHistoryDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('tasks', table => {
    table.text('task_id').primary();
    table.text('repository');
    table.text('task_type');
    table.integer('issue_number');
    table.text('correlation_id');
    table.text('initial_job_data');
    table.text('model_name');
  });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id');
    table.text('task_id');
    table.text('state');
    table.text('timestamp');
    table.text('reason');
    table.text('metadata');
  });
  await database.schema.createTable('llm_executions', table => {
    table.increments('execution_id');
    table.text('task_id');
    table.text('start_time');
    table.text('session_id');
  });
  await database.schema.createTable('llm_logs', table => {
    table.increments('log_id');
    table.text('draft_id');
    table.text('execution_type');
    table.text('start_time');
    table.text('usage_metrics');
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

function assertRedacted(payload: unknown, localPaths: readonly string[]): void {
  const serialized = JSON.stringify(payload);
  for (const localPath of localPaths) assert.equal(serialized.includes(localPath), false, localPath);
  assert.match(serialized, /local preview omitted/);
}

test('task history redacts nested database history and task info without changing non-string fields', async () => {
  const database = await createHistoryDatabase();
  const previewPath = '/tmp/jobs/task-db/.propr/previews/private.png';
  const sourcePath = '/tmp/jobs/task-db/.propr/preview-src/capture.ts';
  try {
    await database('tasks').insert({
      task_id: 'task-db', repository: 'acme/repo', task_type: 'issue', issue_number: 2283,
      correlation_id: 'correlation-1', model_name: 'codex',
      initial_job_data: JSON.stringify({
        title: `Captured ${sourcePath}`,
        subtitle: 'Nested task info',
        agentAlias: 'codex',
      }),
    });
    await database('task_history').insert({
      task_id: 'task-db', state: 'failed', timestamp: '2026-09-11T00:00:00.000Z',
      reason: `Could not read ${previewPath}`,
      metadata: JSON.stringify({
        diagnostic: { source: sourcePath, retryable: false, attempts: 2 },
        files: [previewPath, { staged: sourcePath, exists: true }],
        nestedMetadata: { [previewPath]: { source: sourcePath } },
      }),
    });
    const routes = createTaskHistoryRoutes({
      db: database,
      redisClient: { get: async () => null } as unknown as RedisClientType,
      taskQueue: {} as never,
    });
    const recorder = responseRecorder();

    await routes.getTaskHistory({ params: { taskId: 'task-db' } } as unknown as FlatRequest, recorder.response);

    const body = recorder.body() as {
      history: Array<{ metadata: {
        diagnostic: { retryable: boolean; attempts: number };
        files: unknown[];
        nestedMetadata: Record<string, { source: string }>;
      } }>;
      taskInfo: { number: number; title: string };
      usageMetrics: null;
      usageMetricRecords: unknown[];
    };
    assertRedacted(body, [previewPath, sourcePath]);
    assert.equal(body.taskInfo.number, 2283);
    assert.equal(body.history[0].metadata.diagnostic.retryable, false);
    assert.equal(body.history[0].metadata.diagnostic.attempts, 2);
    assert.equal(body.history[0].metadata.files.length, 2);
    assert.deepEqual(Object.keys(body.history[0].metadata.nestedMetadata), ['[local preview omitted]']);
    assert.equal(body.usageMetrics, null);
    assert.deepEqual(body.usageMetricRecords, []);
  } finally {
    await database.destroy();
  }
});

test('task history redacts nested Redis history and task info without changing response shape', async () => {
  const database = await createHistoryDatabase();
  const previewPath = '/tmp/jobs/task-redis/.propr/previews/private.webp';
  const sourcePath = '/tmp/jobs/task-redis/.propr/preview-src/render.tsx';
  try {
    const redisClient = {
      get: async () => JSON.stringify({
        history: [{
          state: 'processing', timestamp: '2026-09-11T00:00:00.000Z',
          message: `Rendering ${previewPath}`,
          metadata: { detail: { sourcePath, complete: false }, count: 3 },
        }],
        issueRef: {
          repoOwner: 'acme', repoName: 'repo', number: 2283,
          title: `Preview ${previewPath}`,
          comments: [{ body: `Source ${sourcePath}`, resolved: true }],
          modelName: 'codex', agentAlias: 'codex',
        },
      }),
    } as unknown as RedisClientType;
    const routes = createTaskHistoryRoutes({ db: database, redisClient, taskQueue: {} as never });
    const recorder = responseRecorder();

    await routes.getTaskHistory({ params: { taskId: 'task-redis' } } as unknown as FlatRequest, recorder.response);

    const body = recorder.body() as {
      taskId: string;
      history: Array<{ metadata: { detail: { complete: boolean }; count: number } }>;
      taskInfo: { comments: Array<{ resolved: boolean }>; number: number };
    };
    assertRedacted(body, [previewPath, sourcePath]);
    assert.equal(body.taskId, 'task-redis');
    assert.equal(body.history[0].metadata.detail.complete, false);
    assert.equal(body.history[0].metadata.count, 3);
    assert.equal(body.taskInfo.number, 2283);
    assert.equal(body.taskInfo.comments[0].resolved, true);
  } finally {
    await database.destroy();
  }
});

test('task history emits HTML-significant values as escaped JSON wire bytes', async t => {
  const database = await createHistoryDatabase();
  const attackerValue = '</script><img src=x onerror=alert(1)><&>';
  const previewPath = '/tmp/jobs/task-xss/.propr/previews/private.png';
  const redisClient = { get: async () => JSON.stringify({
    history: [{
      state: 'processing',
      metadata: { nested: { attackerValue, symbols: '<&>', previewPath } },
    }],
    issueRef: { repoOwner: 'acme', repoName: 'repo', number: 2288, title: attackerValue },
  }) } as unknown as RedisClientType;
  const routes = createTaskHistoryRoutes({ db: database, redisClient, taskQueue: {} as never });
  const app = express();
  app.get('/api/task/:taskId/history', routes.getTaskHistory as RequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await database.destroy();
  });

  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/api/task/task-xss/history`);
  const wireBody = await response.text();

  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
  assert.doesNotMatch(wireBody, /[<>&]/);
  assert.match(wireBody, /\\u003c\/script\\u003e\\u003cimg/);
  assert.match(wireBody, /\\u003c\\u0026\\u003e/);
  const body = JSON.parse(wireBody) as {
    history: Array<{ metadata: { nested: { attackerValue: string; symbols: string; previewPath: string } } }>;
    taskInfo: { title: string };
  };
  assert.equal(body.history[0].metadata.nested.attackerValue, attackerValue);
  assert.equal(body.history[0].metadata.nested.symbols, '<&>');
  assert.equal(body.taskInfo.title, attackerValue);
  assert.equal(body.history[0].metadata.nested.previewPath, '[local preview omitted]');
});

test('task history returns run-scoped preview media and omits it for runs without previews', async () => {
  const database = await createHistoryDatabase();
  const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;
  const comment = `Applied fixes\n<!-- propr-visual-preview -->\n### Fixed dialog\n\n![Fixed dialog](${asset('fix')})\nThe dialog after the fix\n`;
  const sources: unknown[] = [];
  const previewReader = {
    enabledRepositories: async () => new Set(['acme/repo']),
    project: async (input: Array<{ commentBody?: string; prNumbers: number[] }>, limit: number, mode: string) => {
      sources.push({ input, limit, mode });
      return input.map(source => ({ previews: source.commentBody
        ? [{ type: 'image' as const, title: 'Fixed dialog', description: 'The dialog after the fix', url: asset('fix') }]
        : [] }));
    },
  };
  try {
    await database('tasks').insert([
      { task_id: 'fix-run', repository: 'acme/repo', task_type: 'pr-comment', issue_number: 7, initial_job_data: JSON.stringify({ pullRequestNumber: 7 }) },
      { task_id: 'review-run', repository: 'acme/repo', task_type: 'pr-comment', issue_number: 7, initial_job_data: JSON.stringify({ pullRequestNumber: 7 }) },
    ]);
    await database('task_history').insert([
      { task_id: 'fix-run', state: 'completed', timestamp: '2026-09-16T00:00:00.000Z', metadata: JSON.stringify({ githubComment: { body: comment } }) },
      { task_id: 'fix-run', state: 'cleanup', timestamp: '2026-09-16T00:01:00.000Z', metadata: '{}' },
      { task_id: 'review-run', state: 'completed', timestamp: '2026-09-16T00:00:00.000Z', metadata: JSON.stringify({ githubComment: { body: 'No changes' } }) },
    ]);
    const routes = createTaskHistoryRoutes({
      db: database, redisClient: { get: async () => null } as unknown as RedisClientType, taskQueue: {} as never,
      previewReader: previewReader as never,
    });
    const fix = responseRecorder();
    await routes.getTaskHistory({ params: { taskId: 'fix-run' } } as unknown as FlatRequest, fix.response);
    assert.deepEqual((fix.body() as { previewMedia: unknown }).previewMedia, [
      { type: 'image', title: 'Fixed dialog', description: 'The dialog after the fix', url: asset('fix') },
    ]);
    assert.deepEqual(sources[0], { input: [{ repository: 'acme/repo', prNumbers: [], isFollowUp: true, commentBody: comment }], limit: 8, mode: 'gallery' });
    const review = responseRecorder();
    await routes.getTaskHistory({ params: { taskId: 'review-run' } } as unknown as FlatRequest, review.response);
    assert.equal('previewMedia' in (review.body() as object), false);
  } finally {
    await database.destroy();
  }
});
