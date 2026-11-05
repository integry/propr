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
import { up as addReplacementLineage } from '../../core/src/db/migrations/20261006000000_add_task_replacement_lineage.js';

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
    table.integer('pr_number');
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

test('task history names the thread a follow-up for each stored task posts to', async () => {
  const database = await createHistoryDatabase();
  try {
    await database('tasks').insert([
      { task_id: 'issue-27-run', repository: 'acme/repo', task_type: 'issue', issue_number: 27, pr_number: 28 },
      { task_id: 'issue-29-failed', repository: 'acme/repo', task_type: 'issue', issue_number: 29, pr_number: null },
      { task_id: 'pr-comment-28', repository: 'acme/repo', task_type: 'pr-comment', issue_number: 28, pr_number: null },
      { task_id: 'no-thread', repository: 'acme/repo', task_type: 'issue', issue_number: null, pr_number: null },
    ]);
    await database('task_history').insert(['issue-27-run', 'issue-29-failed', 'pr-comment-28', 'no-thread']
      .map(task_id => ({ task_id, state: 'completed', timestamp: '2026-10-17T00:00:00.000Z' })));
    const routes = createTaskHistoryRoutes({ db: database, redisClient: { get: async () => null } as unknown as RedisClientType, taskQueue: {} as never });
    const targetOf = async (taskId: string) => {
      const recorder = responseRecorder();
      await routes.getTaskHistory({ params: { taskId } } as unknown as FlatRequest, recorder.response);
      return (recorder.body() as { taskInfo: { number?: number; followupTarget?: unknown } }).taskInfo;
    };

    // The implementation that created PR #28 still reports its issue as the task's number.
    const implementation = await targetOf('issue-27-run');
    assert.equal(implementation.number, 27);
    assert.deepEqual(implementation.followupTarget, { taskId: 'issue-27-run', repository: 'acme/repo', kind: 'pull_request', number: 28 });
    assert.deepEqual((await targetOf('issue-29-failed')).followupTarget, { taskId: 'issue-29-failed', repository: 'acme/repo', kind: 'issue', number: 29 });
    assert.deepEqual((await targetOf('pr-comment-28')).followupTarget, { taskId: 'pr-comment-28', repository: 'acme/repo', kind: 'pull_request', number: 28 });
    assert.equal((await targetOf('no-thread')).followupTarget, undefined);
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

test('task history preserves its boolean ultrafix flag for legacy and numbered cycle metadata', async () => {
  const database = await createHistoryDatabase();
  try {
    await database('tasks').insert(['legacy', 'numbered', 'invalid'].map(taskId => ({
      task_id: taskId, repository: 'acme/repo', task_type: 'issue', issue_number: 42,
      initial_job_data: JSON.stringify({ title: taskId }),
    })));
    await database('task_history').insert([
      { task_id: 'legacy', state: 'completed', timestamp: '2026-09-29T00:00:00.000Z', metadata: JSON.stringify({ ultrafixCycle: true }) },
      { task_id: 'numbered', state: 'completed', timestamp: '2026-09-29T00:00:00.000Z', metadata: JSON.stringify({ ultrafixCycle: 2 }) },
      { task_id: 'invalid', state: 'completed', timestamp: '2026-09-29T00:00:00.000Z', metadata: JSON.stringify({ ultrafixCycle: 0 }) },
    ]);
    const routes = createTaskHistoryRoutes({
      db: database, redisClient: { get: async () => null } as unknown as RedisClientType, taskQueue: {} as never,
    });

    for (const taskId of ['legacy', 'numbered']) {
      const recorder = responseRecorder();
      await routes.getTaskHistory({ params: { taskId } } as unknown as FlatRequest, recorder.response);
      assert.equal((recorder.body() as { taskInfo: { ultrafixCycle?: boolean } }).taskInfo.ultrafixCycle, true);
    }
    const invalid = responseRecorder();
    await routes.getTaskHistory({ params: { taskId: 'invalid' } } as unknown as FlatRequest, invalid.response);
    assert.equal('ultrafixCycle' in (invalid.body() as { taskInfo: object }).taskInfo, false);
  } finally {
    await database.destroy();
  }
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

test('task detail reports the automatic-replacement attempt lineage', async () => {
  const database = await createHistoryDatabase();
  try {
    await database.schema.alterTable('tasks', table => { table.text('created_at'); });
    await addReplacementLineage(database);
    await database('tasks').insert([
      { task_id: 'attempt-1', repository: 'acme/repo', task_type: 'issue', issue_number: 7, created_at: '2026-10-06T08:00:00.000Z', replaced_by_task_id: 'attempt-2', lineage_root_task_id: 'attempt-1' },
      { task_id: 'attempt-2', repository: 'acme/repo', task_type: 'issue', issue_number: 7, created_at: '2026-10-06T09:00:00.000Z', replaces_task_id: 'attempt-1', attempt_number: 2, lineage_root_task_id: 'attempt-1', replacement_cause: 'infra_lost' },
      { task_id: 'unrelated', repository: 'acme/repo', task_type: 'issue', issue_number: 8 },
    ]);
    await database('task_history').insert([
      { task_id: 'attempt-1', state: 'failed', timestamp: '2026-10-06T08:30:00.000Z', reason: 'orphaned' },
      { task_id: 'attempt-2', state: 'processing', timestamp: '2026-10-06T09:01:00.000Z', reason: 'started' },
      { task_id: 'unrelated', state: 'completed', timestamp: '2026-10-06T09:01:00.000Z', reason: 'done' },
    ]);
    const routes = createTaskHistoryRoutes({ db: database, redisClient: { get: async () => null } as unknown as RedisClientType, taskQueue: {} as never });
    const detail = async (taskId: string) => {
      const recorder = responseRecorder();
      await routes.getTaskHistory({ params: { taskId } } as unknown as FlatRequest, recorder.response);
      return (recorder.body() as { taskInfo: Record<string, unknown> }).taskInfo;
    };

    const replacement = await detail('attempt-2');
    assert.equal(replacement.attemptNumber, 2);
    assert.equal(replacement.replacesTaskId, 'attempt-1');
    assert.equal(replacement.replacedByTaskId, null);
    assert.deepEqual((replacement.attemptLineage as Array<Record<string, unknown>>).map(({ taskId, attemptNumber, state, replacementCause }) => ({ taskId, attemptNumber, state, replacementCause })), [
      { taskId: 'attempt-1', attemptNumber: 1, state: 'failed', replacementCause: null },
      { taskId: 'attempt-2', attemptNumber: 2, state: 'processing', replacementCause: 'infra_lost' },
    ]);
    const original = await detail('attempt-1');
    assert.equal(original.attemptNumber, 1);
    assert.equal(original.replacedByTaskId, 'attempt-2');
    const unrelated = await detail('unrelated');
    assert.equal(unrelated.attemptNumber, 1);
    assert.equal('attemptLineage' in unrelated, false);
  } finally {
    await database.destroy();
  }
});

test('detail context recovers the same inherited route as recorded execution history', async () => {
  const database = await createHistoryDatabase();
  try {
    await database('tasks').insert({ task_id: 'followup', repository: 'acme/repo', task_type: 'pr-comment', model_name: 'claude-opus-5-5', initial_job_data: JSON.stringify({ pullRequestNumber: 7 }) });
    await database('task_history').insert({ task_id: 'followup', state: 'processing', timestamp: '2026-10-13T12:00:00Z', metadata: JSON.stringify({ model: 'gpt-6-astra', executionRouting: { model: 'gpt-6-astra', agentAlias: 'codex' } }) });
    const routes = createTaskHistoryRoutes({ db: database, redisClient: { get: async () => null } as never, taskQueue: { getJob: async () => null } as never });
    const recorder = responseRecorder();
    await routes.getTaskHistory({ params: { taskId: 'followup' } } as unknown as FlatRequest, recorder.response);
    const result = recorder.body() as { taskInfo: { modelName: string; agentAlias: string }; history: Array<{ metadata: { model: string } }> };
    assert.equal(result.taskInfo.modelName, 'gpt-6-astra');
    assert.equal(result.taskInfo.agentAlias, 'codex');
    assert.equal(result.history[0].metadata.model, result.taskInfo.modelName);
  } finally { await database.destroy(); }
});

test('extension task-history API retains accounting and catalog decisions without private network policy', async t => {
  const database = await createHistoryDatabase(); t.after(() => database.destroy());
  const { up } = await import('../../core/src/db/migrations/20261013210000_extension_profiles.js');
  const { up: grantMigration } = await import('../../core/src/db/migrations/20261013220000_extension_grant_network.js');
  const { ExtensionProfileStore } = await import('../../core/src/extensions/extensionProfileStore.js');
  const { operatorCatalogDigest } = await import('../../core/src/extensions/operatorCatalog.js');
  const { extensionGatewayCall } = await import('../../core/src/extensions/mcpGateway.js');
  const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'history-catalog-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await database.schema.createTable('instance_members', c => { c.string('github_user_id'); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => c.string('id').primary());
  await up(database); await grantMigration(database);
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await database('tasks').insert({ task_id: 'catalog-accounting', repository: 'example/docs', task_type: 'issue', issue_number: 1 });
  const entry = { id: 'internal-docs', kind: 'https' as const, url: 'https://10.43.21.9/catalog-endpoint-sentinel', addresses: ['10.43.21.9'], tools: ['lookup'], capability: 'read' as const };
  const filename = path.join(root, 'catalog.json'); await fs.writeFile(filename, JSON.stringify([entry]), { mode: 0o600 });
  const store = new ExtensionProfileStore(database, { SYSTEM_TASK_SECRET: 'synthetic-history-key', PROPR_EXTENSION_CATALOG_FILE: filename });
  const digest = operatorCatalogDigest(entry);
  const profile = await store.save('1', { version: 1, name: 'Internal docs', enabled: true, agentScope: [], repositoryScope: [], skillBundleIds: [], mcpServers: [{ kind: 'catalog', name: 'docs', catalogId: entry.id, digest, enabled: true, tools: ['lookup'], capability: 'read' }] });
  const token = await store.createGrant('1', profile, 'catalog-accounting', { mode: 'restricted', allow: ['10.43.21.9', 'unrelated-base-allow.example'], instanceAllow: ['10.43.21.9'] });
  await store.activateGrant(token, '1', { instanceId: profile.instanceId, profileId: profile.profileId, revision: profile.revision });
  await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'ping' }, async () => ({ jsonrpc: '2.0', id: 1, result: {} }));
  await store.recordGatewayNetwork(token, '10.43.21.9', false);
  await store.retainGatewayTelemetry(token); await database('extension_run_grants').delete();
  const routes = createTaskHistoryRoutes({ db: database, redisClient: { get: async () => null } as unknown as RedisClientType, taskQueue: {} as never });
  const recorder = responseRecorder();
  await routes.getTaskHistory({ params: { taskId: 'catalog-accounting' } } as unknown as FlatRequest, recorder.response);
  const body = recorder.body() as { history: Array<{ metadata: Record<string, unknown> }> };
  const metadata = body.history[0].metadata;
  assert.equal(metadata.event, 'network.extensions'); assert.equal(metadata.calls, 1); assert.equal(metadata.denied, 1);
  assert.deepEqual(metadata.network, { mode: 'restricted' });
  assert.deepEqual(metadata.resolutions, [{ host: `catalog:${entry.id}@${digest}`, allowed: true }, { allowed: false }]);
  for (const sentinel of ['10.43.21.9', 'catalog-endpoint-sentinel', 'unrelated-base-allow.example', 'instanceAllow', token]) assert.ok(!JSON.stringify(body).includes(sentinel), sentinel);
});
