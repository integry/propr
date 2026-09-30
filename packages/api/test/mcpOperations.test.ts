/* eslint-disable max-lines -- MCP operation and migration regressions share one database fixture. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { McpOperations, type Operation } from '../mcp/operations.js';
import { McpError } from '../mcp/config.js';
import { callWorkflow } from '../mcp/adapter.js';
import { parseClientMetadataDocument } from '../mcp/clients.js';
import { createToolCatalog, type ToolDeps } from '../mcp/tools.js';
import type { McpPrincipal } from '../mcp/policy.js';
import { artifactsFromReceipt, failureFromReceipt, syncLifecycle } from '../mcp/operationLifecycle.js';
import { trackCancellation, trackExecution } from '../mcp/operationTracking.js';

after(closeConnection);

test('mutation deduplication survives concurrent callers and reopening the SQLite database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-'));
  const config = { client: 'better-sqlite3', connection: { filename: path.join(root, 'test.sqlite') }, useNullAsDefault: true };
  let db = knex(config);
  try {
    await db.schema.createTable('task_drafts', table => { table.string('draft_id').primary(); table.string('name'); });
    await up(db);
    const principal = { user: { id: '123' }, grant: { id: 'grant-1' } } as never;
    const args = { idempotencyKey: 'durable-key-1', value: 'payload' };
    let invoked = 0;
    const operations = new McpOperations(db);
    const results = await Promise.all(Array.from({ length: 10 }, () => operations.run(principal, { tool: 'fixture_action', args, repository: 'acme/repo' }, async () => { invoked++; return { status: 200, data: { changed: true } }; })));
    assert.equal(invoked, 1);
    assert.equal(new Set(results.map(result => result.operationId)).size, 1);
    await db.destroy(); db = knex(config);
    const restarted = new McpOperations(db);
    const result = await restarted.run(principal, { tool: 'fixture_action', args, repository: 'acme/repo' }, async () => { throw new Error('Must not replay'); });
    assert.equal(result.state, 'completed'); assert.deepEqual(result.result, { changed: true });
    assert.equal((result.lifecycle as { state: string }).state, 'completed');
    assert.match((result.lifecycle as { acceptedAt: string }).acceptedAt, /^\d{4}-\d\d-\d\dT/);
    assert.ok((result.lifecycle as { finishedAt: string }).finishedAt);
    await assert.rejects(restarted.run(principal, { tool: 'fixture_action', args: { ...args, value: 'changed' }, repository: 'acme/repo' }, async () => ({ status: 200, data: {} })), /different arguments/);
    await assert.rejects(restarted.get({ user: { id: '999' }, grant: { id: 'grant-1' } } as never, String(result.operationId)), /not found/);
    const uncertain = await restarted.run(principal, { tool: 'external_action', args: { idempotencyKey: 'uncertain-key-1' }, repository: 'acme/repo' }, async () => { throw new Error('Network disconnected after possible side effect'); });
    assert.equal(uncertain.state, 'unknown');
    assert.deepEqual(uncertain.result, { error: {
      code: 'OUTCOME_UNKNOWN', message: 'Outcome uncertain. Inspect the target before issuing a new action.', stage: 'internal', retryable: false, status: 500,
      cause: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' },
    } });
    const githubRejected = await restarted.run(principal, { tool: 'publish_plan', args: { idempotencyKey: 'github-reject-1' }, repository: 'acme/repo' }, async () => {
      throw Object.assign(new Error('request failed'), { name: 'HttpError', status: 422,
        response: { status: 422, headers: {}, data: { message: 'Validation Failed', errors: [{ message: 'Reference does not exist' }] } } });
    });
    assert.deepEqual(githubRejected.result, { error: {
      code: 'OUTCOME_UNKNOWN', message: 'Outcome uncertain. Inspect the target before issuing a new action.', stage: 'github', retryable: false, status: 422,
      cause: { code: 'GITHUB_REJECTED', message: 'Validation Failed: Reference does not exist' },
    } });
    const rejected = await restarted.run(principal, { tool: 'guarded_action', args: { idempotencyKey: 'rejected-key-1' }, repository: 'acme/repo' }, async () => { throw new McpError('STALE_HEAD', 'Head changed', 409); });
    assert.equal(rejected.state, 'failed');
    assert.deepEqual((rejected.lifecycle as { failure: unknown }).failure, rejected.result && (rejected.result as { error: unknown }).error);
    const workflowFailure = await restarted.run(principal, { tool: 'workflow_action', args: { idempotencyKey: 'workflow-failure-1' }, repository: 'acme/repo' }, async () =>
      callWorkflow(async (_req, res) => { res.status(500).json({ error: 'The workflow may have changed the target.' }); }, principal, {}));
    assert.equal(workflowFailure.state, 'unknown');
    assert.deepEqual(workflowFailure.result, { error: {
      code: 'OUTCOME_UNKNOWN', message: 'Outcome uncertain. Inspect the target before issuing a new action.', stage: null, retryable: false, status: 500,
      cause: { code: 'WORKFLOW_REJECTED', message: 'Workflow failed; inspect the operation and target before retrying.' },
    } });
    await db('task_drafts').insert({ draft_id: 'plan-1', name: 'Initial' });
    await db('task_drafts').where({ draft_id: 'plan-1' }).update({ name: 'Browser edit' });
    await db('task_drafts').where({ draft_id: 'plan-1' }).update({ name: 'Background edit' });
    assert.equal((await db('task_drafts').where({ draft_id: 'plan-1' }).first()).mcp_revision, 2);
  } finally { await db.destroy(); await rm(root, { recursive: true, force: true }); }
});

test('operation lifecycle transitions, artifacts and progress are durable and monotonic', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  const operations = new McpOperations(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as never;
  const receipt = await operations.run(principal, {
    tool: 'run_ultrafix', args: { idempotencyKey: 'lifecycle-key-1' }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { state: 'queued', pullRequest: 42, commentId: 99 } }));
  assert.equal((receipt.lifecycle as { state: string }).state, 'accepted');
  assert.equal((receipt.lifecycle as { startedAt: unknown }).startedAt, null);
  assert.deepEqual((receipt.lifecycle as { artifacts: unknown }).artifacts, {
    pullRequest: { repository: 'acme/repo', number: 42, url: 'https://github.com/acme/repo/pull/42' }, commentId: 99,
  });
  const replay = await operations.run(principal, {
    tool: 'run_ultrafix', args: { idempotencyKey: 'lifecycle-key-1' }, repository: 'acme/repo',
  }, async () => { throw new Error('Must not invoke on replay'); });
  assert.deepEqual((replay.lifecycle as { artifacts: unknown }).artifacts, (receipt.lifecycle as { artifacts: unknown }).artifacts);

  const id = String(receipt.operationId);
  await operations.markStarted(id, 1_800_000_000_000);
  await Promise.all([
    operations.recordArtifacts(id, { taskId: 'task-1' }),
    operations.recordArtifacts(id, { pullRequest: { repository: 'acme/repo', number: 42, url: 'https://github.com/acme/repo/pull/42' } }),
  ]);
  await operations.recordProgress(id, { taskId: 'task-1', state: 'processing' });
  await Promise.all([operations.finish(id, 'completed'), operations.markStarted(id, 1_700_000_000_000)]);
  await operations.finish(id, 'failed', { code: 'LATE_FAILURE', message: 'stale', stage: null, retryable: false, status: 500 });

  const projected = operations.project(await operations.get(principal, id));
  assert.equal((projected.lifecycle as { state: string }).state, 'completed');
  assert.equal((projected.lifecycle as { startedAt: string }).startedAt, '2027-01-15T08:00:00.000Z');
  assert.ok((projected.lifecycle as { finishedAt: string }).finishedAt);
  assert.deepEqual((projected.lifecycle as { artifacts: unknown }).artifacts, {
    taskId: 'task-1', pullRequest: { repository: 'acme/repo', number: 42, url: 'https://github.com/acme/repo/pull/42' }, commentId: 99,
  });
  assert.deepEqual((projected.lifecycle as { progress: unknown }).progress, { taskId: 'task-1', state: 'processing' });
  assert.equal((projected.lifecycle as { failure: unknown }).failure, null);
});

test('a delayed invocation result cannot replace terminal evidence persisted by a poll', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  const operations = new McpOperations(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  let invocationStarted!: () => void;
  let finishInvocation!: (result: { status: number; data: unknown }) => void;
  const started = new Promise<void>(resolve => { invocationStarted = resolve; });
  const pending = operations.run(principal, {
    tool: 'review_pull_request', args: { idempotencyKey: 'late-invocation-result' }, repository: 'acme/repo',
  }, async () => {
    invocationStarted();
    return new Promise(resolve => { finishInvocation = resolve; });
  });
  await started;

  const row = (await db<Operation>('mcp_operations').where({ idempotency_key: 'late-invocation-result' }).first())!;
  const targetState = { taskId: 'review-task', state: 'completed', timestamp: '2026-09-29T04:01:00.000Z' };
  await db('mcp_operations').where({ id: row.id }).update({
    state: 'completed', result: JSON.stringify({ executionResolved: true, targetState }), updated_at: Date.now(),
  });
  await operations.finish(row.id, 'completed', undefined, targetState);
  finishInvocation({ status: 202, data: { state: 'queued', pullRequest: 42 } });

  const completed = await pending;
  assert.equal(completed.state, 'completed');
  assert.deepEqual(completed.result, { executionResolved: true, targetState });
  assert.deepEqual((completed.lifecycle as { progress: unknown }).progress, targetState);
});

test('stale concurrent polls cannot replace terminal tracker receipts or lifecycle progress', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await db.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('repository'); table.string('task_type');
    table.integer('issue_number'); table.integer('pr_number'); table.text('initial_job_data');
    table.timestamp('created_at').defaultTo(db.fn.now());
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary(); table.string('task_id'); table.string('state');
    table.timestamp('timestamp'); table.text('reason'); table.text('metadata');
  });
  await up(db);

  const operations = new McpOperations(db);
  const args = { idempotencyKey: 'stale-terminal-poll-1' };
  let releaseStale!: () => void;
  let staleReachedRefresh!: () => void;
  const release = new Promise<void>(resolve => { releaseStale = resolve; });
  const reachedRefresh = new Promise<void>(resolve => { staleReachedRefresh = resolve; });
  let githubRequests = 0;
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' }, github: { request: async () => {
      githubRequests++;
      if (githubRequests === 1) { staleReachedRefresh(); await release; }
      return { data: { head: { sha: `head-${githubRequests}` } } };
    } },
  } as unknown as McpPrincipal;
  const receipt = await operations.run(principal, { tool: 'review_pull_request', args, repository: 'acme/repo' }, async () => ({
    status: 202, data: { state: 'queued', pullRequest: 42, commentId: 99 },
  }));
  await db('tasks').insert({ task_id: 'review-task', repository: 'acme/repo', task_type: 'issue', issue_number: 42,
    initial_job_data: JSON.stringify({ commandCommentId: 99, commandMode: 'review' }) });
  await db('task_history').insert({ task_id: 'review-task', state: 'processing',
    timestamp: '2026-09-29T04:00:00.000Z', reason: 'Review is running' });
  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;

  const staleRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const staleReceipt = operations.project(staleRow);
  const stalePoll = trackExecution(deps, staleRow, principal, staleReceipt);
  await reachedRefresh;

  const terminalAt = '2026-09-29T04:01:00.000Z';
  await db('task_history').insert({ task_id: 'review-task', state: 'completed', timestamp: terminalAt,
    reason: 'Review processing completed successfully' });
  const terminalRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const terminalReceipt = operations.project(terminalRow);
  await trackExecution(deps, terminalRow, principal, terminalReceipt);
  await syncLifecycle(operations, terminalRow, terminalReceipt);

  releaseStale();
  await stalePoll;
  await syncLifecycle(operations, staleRow, staleReceipt);

  const durable = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const durableResult = JSON.parse(durable.result!);
  assert.equal(durable.state, 'completed');
  assert.equal(durable.lifecycle, 'completed');
  assert.equal(durableResult.executionResolved, true);
  assert.equal(durableResult.targetState.state, 'completed');
  assert.equal(durableResult.targetState.reason, 'Review processing completed successfully');
  assert.deepEqual(JSON.parse(durable.progress!), durableResult.targetState);
  assert.equal(staleReceipt.state, 'completed', 'the stale caller returns the winning durable observation');
  assert.deepEqual(staleReceipt.targetState, durableResult.targetState);

  await db('task_history').delete();
  const replayed = await operations.replay(principal, 'review_pull_request', args);
  assert.equal((replayed?.lifecycle as { state: string }).state, 'completed');
  assert.deepEqual((replayed?.lifecycle as { progress: unknown }).progress, durableResult.targetState);
  const list = createToolCatalog(deps).find(tool => tool.name === 'list_operations')!;
  const listed = (await list.run({ principal, args: list.schema.parse({}) })).data as { operations: Array<Record<string, unknown>> };
  const listedReceipt = listed.operations.find(operation => operation.operationId === receipt.operationId)!;
  assert.deepEqual((listedReceipt.lifecycle as { progress: unknown }).progress, durableResult.targetState);
});

test('terminal execution restoration preserves target state resolved by get_operation', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await db.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('job_id'); table.string('repository'); table.string('task_type');
    table.integer('pr_number'); table.text('initial_job_data'); table.timestamp('created_at').defaultTo(db.fn.now());
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary(); table.string('task_id'); table.string('state'); table.timestamp('timestamp');
  });
  await up(db);

  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const operations = new McpOperations(db);
  const receipt = await operations.run(principal, {
    tool: 'send_task_followup', args: { idempotencyKey: 'resolved-target-fallback' }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { state: 'queued', continuation: { taskId: 'resolved-task' } } }));
  const observedAt = '2026-09-29T05:00:00.000Z';
  await db('tasks').insert({ task_id: 'resolved-task', job_id: 'resolved-job', repository: 'acme/repo', task_type: 'issue', pr_number: 81 });
  await db('task_history').insert({ task_id: 'resolved-task', state: 'completed', timestamp: observedAt });
  await db('mcp_operations').where({ id: receipt.operationId }).update({
    state: 'completed', lifecycle: 'completed', finished_at: Date.now(),
    result: JSON.stringify({ jobId: 'resolved-job', continuation: { taskId: 'resolved-task' }, executionResolved: true }),
  });

  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const get = createToolCatalog(deps).find(tool => tool.name === 'get_operation')!;
  const restored = (await get.run({ principal, args: get.schema.parse({ operationId: receipt.operationId }) })).data as Record<string, unknown>;
  assert.deepEqual(restored.targetState, {
    state: 'completed', timestamp: observedAt, taskId: 'resolved-task', pr_number: 81,
  });
});

test('get_operation exposes structured invalid-refinement failures', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => {
    table.string('draft_id').primary(); table.string('user_id'); table.string('repository');
    table.string('status'); table.boolean('paused'); table.text('refinement_result');
  });
  await up(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const operations = new McpOperations(db);
  const receipt = await operations.run(principal, {
    tool: 'refine_plan', args: { idempotencyKey: 'invalid-refinement-output' }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { planId: 'plan-invalid-refinement', runId: 'refinement-run-1' } }));
  const details = { reason: 'unknown_target', operations: 1 };
  await db('task_drafts').insert({
    draft_id: 'plan-invalid-refinement', user_id: 'alice', repository: 'acme/repo', status: 'review', paused: false,
    refinement_result: JSON.stringify({
      runId: 'refinement-run-1', status: 'failed', code: 'REFINEMENT_OUTPUT_INVALID',
      error: 'A refinement edit referred to an unknown task.', details,
    }),
  });
  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const get = createToolCatalog(deps).find(tool => tool.name === 'get_operation')!;
  const failed = (await get.run({ principal, args: get.schema.parse({ operationId: receipt.operationId }) })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.result.error, {
    code: 'REFINEMENT_OUTPUT_INVALID', stage: 'workflow', retryable: true, status: 500,
    message: 'A refinement edit referred to an unknown task.', details,
  });
  assert.deepEqual(failed.targetState.error, failed.result.error);
  assert.equal(failed.targetState.status, 'failed');
  assert.deepEqual(failed.lifecycle.failure, failed.result.error);
});

test('an exact refinement failure supersedes uncertainty written by a concurrent poll', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => {
    table.string('draft_id').primary(); table.string('user_id'); table.string('repository');
    table.string('status'); table.boolean('paused'); table.text('refinement_result');
  });
  await up(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const operations = new McpOperations(db);
  const receipt = await operations.run(principal, {
    tool: 'refine_plan', args: { idempotencyKey: 'concurrent-refinement-polls' }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { planId: 'plan-concurrent-refinement', runId: 'refinement-run-a' } }));
  const exactFailure = {
    code: 'REFINEMENT_OUTPUT_INVALID', stage: 'workflow', retryable: true, status: 500,
    message: 'A refinement edit referred to an unknown task.', details: { reason: 'unknown_target' },
  };
  await db('task_drafts').insert({
    draft_id: 'plan-concurrent-refinement', user_id: 'alice', repository: 'acme/repo', status: 'review', paused: false,
    refinement_result: JSON.stringify({
      runId: 'refinement-run-a', status: 'failed', code: exactFailure.code,
      error: exactFailure.message, details: exactFailure.details,
    }),
  });
  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const get = createToolCatalog(deps).find(tool => tool.name === 'get_operation')!;

  let releaseExactFailure!: () => void;
  let exactFailureReachedFinish!: () => void;
  const release = new Promise<void>(resolve => { releaseExactFailure = resolve; });
  const reachedFinish = new Promise<void>(resolve => { exactFailureReachedFinish = resolve; });
  const originalFinish = McpOperations.prototype.finish;
  let paused = false;
  McpOperations.prototype.finish = async function(id, outcome, failure, progress) {
    if (!paused && id === receipt.operationId && failure?.code === 'REFINEMENT_OUTPUT_INVALID') {
      paused = true;
      exactFailureReachedFinish();
      await release;
    }
    return originalFinish.call(this, id, outcome, failure, progress);
  };
  t.after(() => { McpOperations.prototype.finish = originalFinish; });

  const exactPoll = get.run({ principal, args: get.schema.parse({ operationId: receipt.operationId }) });
  await reachedFinish;
  await db('task_drafts').where({ draft_id: 'plan-concurrent-refinement' }).update({
    refinement_result: JSON.stringify({ runId: 'refinement-run-b', status: 'completed', action: 'replace' }),
  });
  const uncertainPoll = (await get.run({
    principal, args: get.schema.parse({ operationId: receipt.operationId }),
  })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(uncertainPoll.state, 'unknown');
  assert.equal(uncertainPoll.lifecycle.failure.code, 'REFINEMENT_OUTCOME_UNAVAILABLE');

  releaseExactFailure();
  const failedPoll = (await exactPoll).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(failedPoll.state, 'failed');
  assert.deepEqual(failedPoll.lifecycle.failure, exactFailure);

  const durable = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  assert.equal(durable.lifecycle, 'failed');
  assert.deepEqual(JSON.parse(durable.failure!), exactFailure);
  const replay = await operations.replay(principal, 'refine_plan', { idempotencyKey: 'concurrent-refinement-polls' });
  assert.equal(replay?.state, 'failed');
  assert.deepEqual((replay?.lifecycle as { failure: unknown }).failure, exactFailure);
});

test('replay repairs an already-failed lifecycle that retained unavailable refinement evidence', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const operations = new McpOperations(db);
  const args = { idempotencyKey: 'recover-refinement-failure' };
  const receipt = await operations.run(principal, { tool: 'refine_plan', args, repository: 'acme/repo' },
    async () => ({ status: 202, data: { planId: 'plan-recovery', runId: 'refinement-run-a' } }));
  const exactFailure = {
    code: 'REFINEMENT_OUTPUT_INVALID', stage: 'workflow', retryable: true, status: 500,
    message: 'The refinement output was invalid.',
  };
  const unavailableFailure = {
    code: 'REFINEMENT_OUTCOME_UNAVAILABLE', stage: 'workflow', retryable: false, status: 500,
    message: 'The historical refinement outcome is unavailable because a later refinement replaced its metadata.',
  };
  await db('mcp_operations').where({ id: receipt.operationId }).update({
    state: 'failed', lifecycle: 'failed', finished_at: Date.now(),
    result: JSON.stringify({ planId: 'plan-recovery', runId: 'refinement-run-a', error: exactFailure }),
    failure: JSON.stringify(unavailableFailure),
  });

  const replay = await operations.replay(principal, 'refine_plan', args);
  assert.equal(replay?.state, 'failed');
  assert.deepEqual((replay?.lifecycle as { failure: unknown }).failure, exactFailure);
  const durable = await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first();
  assert.deepEqual(JSON.parse(durable!.failure!), exactFailure);
});

test('get_operation settles a displaced refinement receipt as unknown without attaching a later failure', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => {
    table.string('draft_id').primary(); table.string('user_id'); table.string('repository');
    table.string('status'); table.boolean('paused'); table.text('refinement_result');
  });
  await up(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const operations = new McpOperations(db);
  const first = await operations.run(principal, {
    tool: 'refine_plan', args: { idempotencyKey: 'first-refinement-run' }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { planId: 'plan-refined-twice', runId: 'refinement-run-a' } }));
  await db('task_drafts').insert({
    draft_id: 'plan-refined-twice', user_id: 'alice', repository: 'acme/repo', status: 'review', paused: false,
    refinement_result: JSON.stringify({ runId: 'refinement-run-a', status: 'completed', action: 'replace' }),
  });
  const second = await operations.run(principal, {
    tool: 'refine_plan', args: { idempotencyKey: 'second-refinement-run' }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { planId: 'plan-refined-twice', runId: 'refinement-run-b' } }));
  await db('task_drafts').where({ draft_id: 'plan-refined-twice' }).update({
    refinement_result: JSON.stringify({
      runId: 'refinement-run-b', status: 'failed', code: 'REFINEMENT_OUTPUT_INVALID',
      error: 'The later refinement returned an invalid edit.',
    }),
  });
  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const get = createToolCatalog(deps).find(tool => tool.name === 'get_operation')!;

  const firstPoll = (await get.run({ principal, args: get.schema.parse({ operationId: first.operationId }) })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(firstPoll.state, 'unknown');
  assert.deepEqual(firstPoll.result, { planId: 'plan-refined-twice', runId: 'refinement-run-a' });
  assert.equal(firstPoll.result.error, undefined);
  assert.equal(firstPoll.targetState.error, undefined);
  assert.equal(firstPoll.lifecycle.state, 'unknown');
  assert.deepEqual(firstPoll.lifecycle.failure, {
    code: 'REFINEMENT_OUTCOME_UNAVAILABLE', stage: 'workflow', retryable: false, status: 500,
    message: 'The historical refinement outcome is unavailable because a later refinement replaced its metadata.',
  });
  assert.equal(firstPoll.lifecycle.progress, null);
  assert.equal(firstPoll.message, firstPoll.lifecycle.failure.message);
  assert.equal(firstPoll.retryAfterSeconds, undefined);

  const firstReplay = await operations.replay(principal, 'refine_plan', { idempotencyKey: 'first-refinement-run' });
  assert.equal(firstReplay?.state, 'unknown');
  assert.equal(firstReplay?.retryAfterSeconds, undefined);
  assert.deepEqual((firstReplay?.lifecycle as { failure: unknown }).failure, firstPoll.lifecycle.failure);

  const secondPoll = (await get.run({ principal, args: get.schema.parse({ operationId: second.operationId }) })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(secondPoll.state, 'failed');
  assert.equal(secondPoll.result.error.code, 'REFINEMENT_OUTPUT_INVALID');
  assert.equal(secondPoll.result.error.message, 'The later refinement returned an invalid edit.');
});

test('get_operation preserves terminal refinement evidence after a later run replaces draft metadata', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => {
    table.string('draft_id').primary(); table.string('user_id'); table.string('repository');
    table.string('status'); table.boolean('paused'); table.text('refinement_result');
  });
  await up(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const operations = new McpOperations(db);
  const receipt = await operations.run(principal, {
    tool: 'refine_plan', args: { idempotencyKey: 'retained-refinement' }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { planId: 'plan-retained-refinement', runId: 'refinement-run-a' } }));
  await db('task_drafts').insert({
    draft_id: 'plan-retained-refinement', user_id: 'alice', repository: 'acme/repo', status: 'review', paused: false,
    refinement_result: JSON.stringify({ runId: 'refinement-run-a', status: 'completed', action: 'replace' }),
  });
  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const get = createToolCatalog(deps).find(tool => tool.name === 'get_operation')!;

  const completed = (await get.run({ principal, args: get.schema.parse({ operationId: receipt.operationId }) })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(completed.state, 'completed');
  assert.equal(completed.lifecycle.state, 'completed');

  await db('task_drafts').where({ draft_id: 'plan-retained-refinement' }).update({
    refinement_result: JSON.stringify({ runId: 'refinement-run-b', status: 'failed', error: 'Later failure' }),
  });
  const retained = (await get.run({ principal, args: get.schema.parse({ operationId: receipt.operationId }) })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(retained.state, 'completed');
  assert.equal(retained.lifecycle.state, 'completed');
  assert.equal(retained.lifecycle.failure, null);
  assert.equal(retained.retryAfterSeconds, undefined);
});

test('replay recovers terminal lifecycle, artifacts and failure from durable receipts', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const operations = new McpOperations(db);
  const args = { idempotencyKey: 'interrupted-success-1' };
  const receipt = await operations.run(principal, { tool: 'fixture_action', args, repository: 'acme/repo' },
    async () => ({ status: 202, data: { state: 'queued' } }));
  const persistedAt = Date.now() - 500;
  await db('mcp_operations').where({ id: receipt.operationId }).update({
    state: 'completed', result: JSON.stringify({ changed: true, taskId: 'task-recovered' }), updated_at: persistedAt,
  });
  assert.deepEqual(await db('mcp_operations').where({ id: receipt.operationId }).first('state', 'lifecycle', 'finished_at'), {
    state: 'completed', lifecycle: 'accepted', finished_at: null,
  });

  const restarted = new McpOperations(db);
  const replay = await restarted.replay(principal, 'fixture_action', args);
  assert.equal(replay?.state, 'completed');
  assert.deepEqual(replay?.result, { changed: true, taskId: 'task-recovered' });
  assert.deepEqual(replay?.lifecycle, {
    state: 'completed', acceptedAt: (receipt.lifecycle as { acceptedAt: string }).acceptedAt,
    startedAt: null, finishedAt: new Date(persistedAt).toISOString(), failure: null,
    artifacts: { taskId: 'task-recovered' }, progress: null,
  });

  // Repeat entry points also repair rows left terminal by the older
  // lifecycle-only reconciliation.
  await db('mcp_operations').where({ id: receipt.operationId }).update({ artifacts: JSON.stringify({}) });
  let invoked = false;
  const duplicate = await restarted.run(principal, { tool: 'fixture_action', args, repository: 'acme/repo' }, async () => {
    invoked = true;
    return { status: 200, data: {} };
  });
  assert.equal(invoked, false);
  assert.equal((duplicate.lifecycle as { state: string }).state, 'completed');
  assert.deepEqual((duplicate.lifecycle as { artifacts: unknown }).artifacts, { taskId: 'task-recovered' });

  const failedArgs = { idempotencyKey: 'interrupted-failure-1' };
  const failed = await operations.run(principal, { tool: 'fixture_action', args: failedArgs, repository: 'acme/repo' },
    async () => ({ status: 202, data: { state: 'queued' } }));
  const failure = { code: 'WORKFLOW_FAILED', message: 'The durable workflow failed.', stage: 'internal', retryable: false, status: 500 };
  await db('mcp_operations').where({ id: failed.operationId }).update({
    state: 'failed', result: JSON.stringify({ error: failure }), updated_at: persistedAt,
  });
  const failedReplay = await restarted.replay(principal, 'fixture_action', failedArgs);
  assert.equal((failedReplay?.lifecycle as { state: string }).state, 'failed');
  assert.deepEqual((failedReplay?.lifecycle as { failure: unknown }).failure, failure);
});

test('list_operations recovers tracker lifecycle, artifacts and failure before filtering', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await db.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('job_id'); table.string('repository'); table.string('task_type');
    table.integer('pr_number'); table.text('initial_job_data'); table.timestamp('created_at').defaultTo(db.fn.now());
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary(); table.string('task_id'); table.string('state');
    table.timestamp('timestamp'); table.text('reason'); table.text('metadata');
  });
  await up(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const operations = new McpOperations(db);
  const failedArgs = { idempotencyKey: 'tracker-failure-02' };
  const failed = await operations.run(principal, {
    tool: 'send_task_followup', args: failedArgs, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { state: 'queued', jobId: 'job-failed', continuation: { taskId: 'task-failed' } } }));
  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const observedAt = '2026-09-29T03:00:00.000Z';
  await db('tasks').insert({ task_id: 'task-failed', job_id: 'job-failed', repository: 'acme/repo', task_type: 'issue', pr_number: 73 });
  await db('task_history').insert({ task_id: 'task-failed', state: 'failed', timestamp: observedAt, reason: 'Agent stopped after tests failed.' });
  await operations.recordProgress(String(failed.operationId), { taskId: 'task-failed', state: 'processing' });
  const failedRow = await db<Operation>('mcp_operations').where({ id: failed.operationId }).first();
  // Stop immediately after the awaited tracker write, before syncLifecycle can
  // project its nested targetState into lifecycle columns.
  await trackExecution(deps, failedRow!, principal, operations.project(failedRow!));
  const trackerWrite = await db<Operation>('mcp_operations').where({ id: failed.operationId }).first();
  assert.equal(trackerWrite?.state, 'failed');
  assert.equal(trackerWrite?.lifecycle, 'accepted');
  assert.equal(trackerWrite?.failure, null);
  assert.deepEqual(JSON.parse(trackerWrite!.progress!), { taskId: 'task-failed', state: 'processing' });
  assert.deepEqual(JSON.parse(trackerWrite!.result!).targetState, {
    taskId: 'task-failed', pr_number: 73, state: 'failed', timestamp: observedAt, reason: 'Agent stopped after tests failed.',
  });

  const list = createToolCatalog(deps).find(tool => tool.name === 'list_operations')!;
  const active = (await list.run({ principal, args: list.schema.parse({ lifecycle: 'active' }) })).data as { operations: Array<Record<string, unknown>> };
  const failures = (await list.run({ principal, args: list.schema.parse({ lifecycle: 'failed' }) })).data as { operations: Array<Record<string, unknown>> };
  assert.deepEqual(active.operations, []);
  assert.deepEqual(failures.operations.map(row => row.operationId), [failed.operationId]);
  const recoveredLifecycle = failures.operations[0].lifecycle as Record<string, unknown>;
  assert.deepEqual(recoveredLifecycle.failure, {
    code: 'EXECUTION_FAILED', message: 'Agent stopped after tests failed.', stage: 'internal', retryable: false, status: 500,
  });
  assert.deepEqual(recoveredLifecycle.artifacts, {
    taskId: 'task-failed',
    pullRequest: { repository: 'acme/repo', number: 73, url: 'https://github.com/acme/repo/pull/73' },
  });
  assert.deepEqual(recoveredLifecycle.progress, {
    taskId: 'task-failed', pr_number: 73, state: 'failed', timestamp: observedAt, reason: 'Agent stopped after tests failed.',
  });
  const replay = await operations.replay(principal, 'send_task_followup', failedArgs);
  assert.deepEqual(replay?.lifecycle, recoveredLifecycle);
});

test('replay and listing recover confirmed cancellation propagation after the tracker write', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await db.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('repository'); table.string('task_type');
  });
  await db.schema.createTable('goals', table => {
    table.string('goal_id').primary(); table.string('current_task_id');
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary(); table.string('task_id'); table.string('state'); table.timestamp('timestamp');
  });
  await up(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const otherGrant = { user: { id: 'alice' }, grant: { id: 'grant-b' } } as McpPrincipal;
  const operations = new McpOperations(db);
  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const createInterruptedConfirmation = async (suffix: string) => {
    const taskId = `cancel-task-${suffix}`;
    const source = await operations.run(principal, {
      tool: 'review_pull_request', args: { idempotencyKey: `cancel-source-${suffix}` }, repository: 'acme/repo',
    }, async () => ({ status: 202, data: { state: 'queued', continuation: { taskId } } }));
    const args = { idempotencyKey: `cancel-receipt-${suffix}` };
    const cancellation = await operations.run(principal, { tool: 'cancel_operation', args, repository: 'acme/repo' }, async () => ({
      status: 202, data: { operationId: source.operationId, cancellation: 'requested', continuation: { taskId }, targetTool: 'review_pull_request' },
    }));
    await db('tasks').insert({ task_id: taskId, repository: 'acme/repo', task_type: 'issue' });
    await db('task_history').insert({ task_id: taskId, state: 'cancelled', timestamp: new Date() });
    const row = (await db<Operation>('mcp_operations').where({ id: cancellation.operationId }).first())!;
    await trackCancellation(deps, row, principal, operations.project(row));
    const persisted = (await db<Operation>('mcp_operations').where({ id: cancellation.operationId }).first())!;
    assert.equal(persisted.state, 'completed');
    assert.equal(persisted.lifecycle, 'accepted');
    assert.equal((await db<Operation>('mcp_operations').where({ id: source.operationId }).first())!.lifecycle, 'accepted');
    return { args, cancellation, persisted, source };
  };

  const replayCase = await createInterruptedConfirmation('replay-01');
  const replayed = await operations.replay(principal, 'cancel_operation', replayCase.args);
  assert.equal((replayed?.lifecycle as { state: string }).state, 'completed');
  const replayedSource = (await db<Operation>('mcp_operations').where({ id: replayCase.source.operationId }).first())!;
  assert.equal(replayedSource.lifecycle, 'cancelled');
  assert.equal(replayedSource.finished_at, replayCase.persisted.updated_at);

  const listCase = await createInterruptedConfirmation('listing-1');
  const foreignSource = await operations.run(otherGrant, {
    tool: 'review_pull_request', args: { idempotencyKey: 'foreign-cancel-source' }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { state: 'queued' } }));
  await operations.run(principal, {
    tool: 'cancel_operation', args: { idempotencyKey: 'foreign-cancel-proof' },
  }, async () => ({ status: 200, data: { operationId: foreignSource.operationId, cancellation: 'confirmed', executionResolved: true } }));
  const completedSource = await operations.run(principal, {
    tool: 'review_pull_request', args: { idempotencyKey: 'completed-cancel-source' }, repository: 'acme/repo',
  }, async () => ({ status: 200, data: { changed: true } }));
  await operations.run(principal, {
    tool: 'cancel_operation', args: { idempotencyKey: 'completed-cancel-proof' }, repository: 'acme/repo',
  }, async () => ({ status: 200, data: { operationId: completedSource.operationId, cancellation: 'confirmed', executionResolved: true } }));

  const list = createToolCatalog(deps).find(tool => tool.name === 'list_operations')!;
  const listed = (await list.run({ principal, args: list.schema.parse({}) })).data as { operations: Array<Record<string, unknown>> };
  assert.ok(listed.operations.some(row => row.operationId === listCase.cancellation.operationId));
  const listedSource = (await db<Operation>('mcp_operations').where({ id: listCase.source.operationId }).first())!;
  assert.equal(listedSource.lifecycle, 'cancelled');
  assert.equal(listedSource.finished_at, listCase.persisted.updated_at);
  assert.equal((await db<Operation>('mcp_operations').where({ id: foreignSource.operationId }).first())!.lifecycle, 'accepted');
  assert.equal((await db<Operation>('mcp_operations').where({ id: completedSource.operationId }).first())!.lifecycle, 'completed');
});

test('polling an accepted wrapper does not fabricate backend execution start', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  const operations = new McpOperations(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  let finishInvocation!: (result: { status: number; data: unknown }) => void;
  let invocationStarted!: () => void;
  const started = new Promise<void>(resolve => { invocationStarted = resolve; });
  const pending = operations.run(principal, {
    tool: 'review_pull_request', args: { idempotencyKey: 'pending-wrapper-1' }, repository: 'acme/repo',
  }, async () => {
    invocationStarted();
    return new Promise(resolve => { finishInvocation = resolve; });
  });
  await started;

  const row = await db('mcp_operations').first() as Operation;
  const polled = operations.project(row);
  assert.equal(polled.state, 'accepted');
  await syncLifecycle(operations, row, polled);
  const unchanged = operations.project(await operations.get(principal, row.id));
  assert.equal((unchanged.lifecycle as { state: string }).state, 'accepted');
  assert.equal((unchanged.lifecycle as { startedAt: unknown }).startedAt, null);

  finishInvocation({ status: 202, data: { state: 'queued' } });
  const queued = await pending;
  assert.equal(queued.state, 'queued');
  assert.equal((queued.lifecycle as { state: string }).state, 'accepted');
  assert.equal((queued.lifecycle as { startedAt: unknown }).startedAt, null);
});

test('interrupted accepted invocations become durable unknown while acknowledged queues remain active', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  const operations = new McpOperations(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  let finishInvocation!: (result: { status: number; data: unknown }) => void;
  let invocationStarted!: () => void;
  const started = new Promise<void>(resolve => { invocationStarted = resolve; });
  const args = { idempotencyKey: 'interrupted-wrapper-1' };
  const pending = operations.run(principal, { tool: 'review_pull_request', args, repository: 'acme/repo' }, async () => {
    invocationStarted();
    return new Promise(resolve => { finishInvocation = resolve; });
  });
  await started;

  const interrupted = await db<Operation>('mcp_operations').where({ idempotency_key: args.idempotencyKey }).first();
  const invokedAt = Date.now() - 120_001;
  await db('mcp_operations').where({ id: interrupted!.id }).update({ accepted_at: invokedAt, created_at: invokedAt, updated_at: Date.now() });
  const projected = operations.project((await db<Operation>('mcp_operations').where({ id: interrupted!.id }).first())!);
  assert.equal(projected.state, 'unknown');
  assert.equal((projected.lifecycle as { state: string }).state, 'unknown');
  assert.equal(projected.retryAfterSeconds, undefined);
  assert.match(String(projected.message), /may have been interrupted/);

  const queued = await operations.run(principal, {
    tool: 'review_pull_request', args: { idempotencyKey: 'acknowledged-queue-1' }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { state: 'queued', commentId: 42 } }));
  await db('mcp_operations').where({ id: queued.operationId }).update({ accepted_at: invokedAt, created_at: invokedAt, updated_at: Date.now() });

  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const catalog = createToolCatalog(deps);
  const list = catalog.find(tool => tool.name === 'list_operations')!;
  const get = catalog.find(tool => tool.name === 'get_operation')!;
  const active = (await list.run({ principal, args: list.schema.parse({ lifecycle: 'active' }) })).data as { operations: Array<Record<string, unknown>> };
  const unknown = (await list.run({ principal, args: list.schema.parse({ lifecycle: 'unknown' }) })).data as { operations: Array<Record<string, unknown>> };
  assert.deepEqual(active.operations.map(row => row.operationId), [queued.operationId]);
  assert.deepEqual(unknown.operations.map(row => row.operationId), [interrupted!.id]);

  const refreshed = (await get.run({ principal, args: get.schema.parse({ operationId: interrupted!.id }) })).data as Record<string, unknown>;
  assert.equal(refreshed.state, 'unknown');
  assert.equal((refreshed.lifecycle as { state: string }).state, 'unknown');
  let replayed = false;
  const replay = await operations.run(principal, { tool: 'review_pull_request', args, repository: 'acme/repo' }, async () => {
    replayed = true;
    return { status: 200, data: {} };
  });
  assert.equal(replayed, false);
  assert.equal(replay.state, 'unknown');
  assert.equal((replay.lifecycle as { state: string }).state, 'unknown');

  const queuedRow = await operations.get(principal, String(queued.operationId));
  assert.equal(queuedRow.state, 'queued');
  assert.equal(queuedRow.lifecycle, 'accepted');

  // If the original process is merely slow rather than gone, its fresh result
  // remains authoritative and resolves the unavoidable timeout race.
  finishInvocation({ status: 202, data: { state: 'queued', commentId: 99 } });
  const resolved = await pending;
  assert.equal(resolved.state, 'queued');
  assert.equal((resolved.lifecycle as { state: string }).state, 'accepted');
});

test('tracker-observed running operations remain active when their projection timestamp ages', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await db.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('job_id'); table.string('repository'); table.string('task_type');
    table.integer('pr_number'); table.text('initial_job_data'); table.timestamp('created_at').defaultTo(db.fn.now());
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary(); table.string('task_id'); table.string('state');
    table.timestamp('timestamp'); table.text('reason'); table.text('metadata');
  });
  await up(db);

  const operations = new McpOperations(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const args = { idempotencyKey: 'long-running-tracker-1' };
  const receipt = await operations.run(principal, {
    tool: 'send_task_followup', args, repository: 'acme/repo',
  }, async () => ({ status: 202, data: {
    state: 'queued', jobId: 'long-running-job', continuation: { taskId: 'long-running-task' },
  } }));
  await db('tasks').insert({
    task_id: 'long-running-task', job_id: 'long-running-job', repository: 'acme/repo', task_type: 'issue',
    initial_job_data: JSON.stringify({}),
  });
  await db('task_history').insert({
    task_id: 'long-running-task', state: 'processing', timestamp: new Date(), reason: 'Task is still running',
  });
  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const catalog = createToolCatalog(deps);
  const get = catalog.find(tool => tool.name === 'get_operation')!;
  const list = catalog.find(tool => tool.name === 'list_operations')!;

  const polled = (await get.run({
    principal, args: get.schema.parse({ operationId: receipt.operationId }),
  })).data as Record<string, unknown>;
  assert.equal(polled.state, 'running');
  assert.equal((polled.lifecycle as { state: string }).state, 'running');

  await db('mcp_operations').where({ id: receipt.operationId }).update({ updated_at: Date.now() - 120_001 });
  const assertRunning = (projected: Record<string, unknown> | undefined) => {
    assert.equal(projected?.state, 'running');
    assert.equal((projected?.lifecycle as { state: string }).state, 'running');
    assert.equal(projected?.retryAfterSeconds, 3);
    assert.equal(projected?.message, undefined);
  };

  const active = (await list.run({
    principal, args: list.schema.parse({ lifecycle: 'active' }),
  })).data as { operations: Array<Record<string, unknown>> };
  assertRunning(active.operations.find(operation => operation.operationId === receipt.operationId));
  assertRunning(await operations.replay(principal, 'send_task_followup', args));

  let invoked = false;
  const duplicate = await operations.run(principal, {
    tool: 'send_task_followup', args, repository: 'acme/repo',
  }, async () => {
    invoked = true;
    return { status: 200, data: {} };
  });
  assert.equal(invoked, false);
  assertRunning(duplicate);
});

test('tracker uncertainty resolves from later evidence and preserves observed timestamps and terminal outcomes', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  const operations = new McpOperations(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const receipt = await operations.run(principal, {
    tool: 'send_task_followup', args: { idempotencyKey: 'tracker-unknown-1' }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { state: 'queued' } }));
  const id = String(receipt.operationId);
  const row = await operations.get(principal, id);

  await syncLifecycle(operations, row, { ...receipt, state: 'unknown' });
  assert.equal((operations.project(await operations.get(principal, id)).lifecycle as { state: string }).state, 'unknown');
  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const list = createToolCatalog(deps).find(tool => tool.name === 'list_operations')!;
  const unknown = (await list.run({ principal, args: list.schema.parse({ lifecycle: 'unknown' }) })).data as { operations: unknown[] };
  const active = (await list.run({ principal, args: list.schema.parse({ lifecycle: 'active' }) })).data as { operations: unknown[] };
  assert.equal(unknown.operations.length, 1);
  assert.deepEqual(active.operations, []);
  await syncLifecycle(operations, row, { ...receipt, state: 'queued', targetState: { taskId: 'task-1', state: 'pending' } });
  assert.equal((operations.project(await operations.get(principal, id)).lifecycle as { state: string }).state, 'accepted');

  const observedAt = 1_800_000_000_000;
  await syncLifecycle(operations, row, { ...receipt, state: 'running', targetState: { taskId: 'task-1', state: 'processing', timestamp: observedAt } });
  await syncLifecycle(operations, row, { ...receipt, state: 'unknown' });
  let lifecycle = operations.project(await operations.get(principal, id)).lifecycle as { state: string; startedAt: string | null };
  assert.equal(lifecycle.state, 'unknown');
  assert.equal(lifecycle.startedAt, '2027-01-15T08:00:00.000Z');
  await syncLifecycle(operations, row, { ...receipt, state: 'running', targetState: { taskId: 'task-1', state: 'processing' } });
  lifecycle = operations.project(await operations.get(principal, id)).lifecycle as typeof lifecycle;
  assert.equal(lifecycle.state, 'running');
  assert.equal(lifecycle.startedAt, '2027-01-15T08:00:00.000Z');
  await operations.finish(id, 'completed');
  await syncLifecycle(operations, row, { ...receipt, state: 'unknown' });
  assert.equal((operations.project(await operations.get(principal, id)).lifecycle as { state: string }).state, 'completed');
});

test('tracker task and review failures populate and can enrich the durable failure envelope', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  const operations = new McpOperations(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const create = (tool: string, key: string) => operations.run(principal, {
    tool, args: { idempotencyKey: key }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { state: 'queued' } }));

  const task = await create('send_task_followup', 'tracker-failure-1');
  const taskRow = await operations.get(principal, String(task.operationId));
  await syncLifecycle(operations, taskRow, { ...task, state: 'failed', targetState: { taskId: 'task-1', state: 'failed' } });
  assert.equal((operations.project(await operations.get(principal, taskRow.id)).lifecycle as { failure: unknown }).failure, null);
  await syncLifecycle(operations, taskRow, { ...task, state: 'failed', targetState: { taskId: 'task-1', state: 'failed', reason: 'Agent stopped' } });
  assert.deepEqual((operations.project(await operations.get(principal, taskRow.id)).lifecycle as { failure: unknown }).failure, {
    code: 'EXECUTION_FAILED', message: 'Agent stopped', stage: 'internal', retryable: false, status: 500,
  });

  const review = await create('review_pull_request', 'review-failure-01');
  const reviewRow = await operations.get(principal, String(review.operationId));
  await syncLifecycle(operations, reviewRow, { ...review, state: 'failed', targetState: {
    taskId: 'review-task', state: 'completed', reason: 'Review processing completed successfully',
    reviewResults: [{ success: false, error: 'Reviewer unavailable' }, { success: false, error: 'Model timed out' }],
  } });
  assert.deepEqual((operations.project(await operations.get(principal, reviewRow.id)).lifecycle as { failure: unknown }).failure, {
    code: 'REVIEW_FAILED', message: 'Reviewer unavailable; Model timed out', stage: 'internal', retryable: false, status: 500,
    details: { failedReviewCount: 2 },
  });

  const ultrafix = await create('run_ultrafix', 'ultrafix-failure-1');
  const ultrafixRow = await operations.get(principal, String(ultrafix.operationId));
  await syncLifecycle(operations, ultrafixRow, { ...ultrafix, state: 'failed',
    targetState: { taskId: 'ultrafix-task', state: 'completed', reason: 'Task completed successfully' },
    result: { loop: { completionStatus: 'failed', completionReason: 'Maximum cycles reached without resolving the findings.' } },
  });
  assert.deepEqual((operations.project(await operations.get(principal, ultrafixRow.id)).lifecycle as { failure: unknown }).failure, {
    code: 'EXECUTION_FAILED', message: 'Maximum cycles reached without resolving the findings.',
    stage: 'internal', retryable: false, status: 500,
  });
  assert.equal(failureFromReceipt({
    targetState: { state: 'completed', reason: 'Task completed successfully' },
    result: { loop: { completionStatus: 'failed' } },
  })?.message, 'Ultrafix loop failed.');
  assert.equal(failureFromReceipt({ targetState: { currentTask: { reason: 'Nested goal task failed' } } })?.message,
    'Nested goal task failed');
  assert.deepEqual(artifactsFromReceipt({ repository: 'acme/repo' }, {
    targetState: { currentTask: { taskId: 'nested-goal-task' }, final_pr_number: 64 },
  }), {
    taskId: 'nested-goal-task',
    pullRequest: { repository: 'acme/repo', number: 64, url: 'https://github.com/acme/repo/pull/64' },
  });
  assert.deepEqual(artifactsFromReceipt({ repository: 'acme/repo' }, {
    targetState: { taskId: 'completed-task', state: 'completed' },
    result: {
      continuation: { taskId: 'retry-task' },
      progress: { task: { id: 'retry-task', state: 'processing' } },
    },
  }), { taskId: 'completed-task' });
  assert.deepEqual(artifactsFromReceipt({ repository: 'acme/repo' }, {
    result: { pullRequest: true, commentId: true, reviewResults: [{ commentId: false }] },
  }), {});
});

test('goal failures and generated task pull requests remain durable after backend history is removed', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await db.schema.createTable('goals', table => {
    table.string('goal_id').primary(); table.string('owner_id'); table.string('repository');
    table.string('desired_state'); table.string('result_state'); table.string('current_task_id');
    table.integer('final_pr_number'); table.text('failure_reason');
  });
  await db.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('job_id'); table.string('repository'); table.string('task_type');
    table.integer('pr_number'); table.text('initial_job_data'); table.text('final_result');
    table.timestamp('created_at').defaultTo(db.fn.now());
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary(); table.string('task_id'); table.string('state');
    table.timestamp('timestamp').defaultTo(db.fn.now()); table.text('reason'); table.text('metadata');
  });
  await db.schema.createTable('task_submissions', table => {
    table.string('id').primary(); table.string('user_id'); table.string('submission_key'); table.string('payload_hash');
    table.string('repository'); table.text('payload'); table.text('attachments'); table.string('state');
    table.integer('issue_number'); table.text('issue_url'); table.string('task_id'); table.string('retry_event_id');
    table.boolean('dispatch_complete'); table.text('error'); table.timestamp('created_at').defaultTo(db.fn.now());
  });
  await db.schema.createTable('notification_pull_request_state', table => {
    table.string('repository'); table.integer('pr_number'); table.string('merged_at');
    table.primary(['repository', 'pr_number']);
  });
  await up(db);

  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const operations = new McpOperations(db);
  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const catalog = createToolCatalog(deps);
  const get = catalog.find(tool => tool.name === 'get_operation')!;
  const list = catalog.find(tool => tool.name === 'list_operations')!;

  const goalArgs = { idempotencyKey: 'durable-goal-output-1' };
  const goalId = 'goal-output-1';
  const goalTaskId = 'goal-task-output-1';
  const goalReceipt = await operations.run(principal, { tool: 'create_goal', args: goalArgs, repository: 'acme/repo' },
    async () => ({ status: 202, data: { state: 'accepted', continuation: { goalId } } }));
  await db('tasks').insert({ task_id: goalTaskId, repository: 'acme/repo', task_type: 'goal' });
  await db('task_history').insert({ task_id: goalTaskId, state: 'failed', reason: 'Backing task stopped' });
  await db('goals').insert({ goal_id: goalId, owner_id: 'alice', repository: 'acme/repo', desired_state: 'running',
    result_state: 'failed', current_task_id: goalTaskId, final_pr_number: 61, failure_reason: 'Provider exhausted its retry budget' });

  const failedGoal = (await get.run({ principal, args: get.schema.parse({ operationId: goalReceipt.operationId }) })).data as Record<string, unknown>;
  assert.deepEqual(failedGoal.lifecycle, {
    state: 'failed', acceptedAt: (goalReceipt.lifecycle as { acceptedAt: string }).acceptedAt,
    startedAt: (failedGoal.lifecycle as { startedAt: string }).startedAt,
    finishedAt: (failedGoal.lifecycle as { finishedAt: string }).finishedAt,
    failure: { code: 'EXECUTION_FAILED', message: 'Provider exhausted its retry budget', stage: 'internal', retryable: false, status: 500 },
    artifacts: { taskId: goalTaskId, pullRequest: { repository: 'acme/repo', number: 61, url: 'https://github.com/acme/repo/pull/61' } },
    progress: (failedGoal.lifecycle as { progress: unknown }).progress,
  });

  const submissionId = 'submission-output-1';
  const taskId = 'ordinary-task-output-1';
  const taskArgs = { idempotencyKey: 'durable-task-output-1' };
  const taskReceipt = await operations.run(principal, { tool: 'create_task', args: taskArgs, repository: 'acme/repo' }, async () => ({
    status: 202, data: { id: submissionId, submissionId, submissionState: 'queued', state: 'queued',
      continuation: { submissionId, taskId } },
  }));
  await db('task_submissions').insert({ id: submissionId, user_id: 'alice', submission_key: 'submission-key', payload_hash: 'hash',
    repository: 'acme/repo', payload: '{}', attachments: '[]', state: 'queued', task_id: taskId, dispatch_complete: true });
  await db('tasks').insert({ task_id: taskId, repository: 'acme/repo', task_type: 'issue' });
  await db('task_history').insert({ task_id: taskId, state: 'completed', reason: 'Task completed successfully' });

  const completedWithoutPr = (await get.run({ principal, args: get.schema.parse({ operationId: taskReceipt.operationId }) })).data as Record<string, unknown>;
  assert.deepEqual((completedWithoutPr.lifecycle as { artifacts: unknown }).artifacts, { submissionId, taskId });
  // Task completion is published before tasks.pr_number, so a later poll must
  // still enrich the already-terminal durable receipt.
  await db('tasks').where({ task_id: taskId }).update({ pr_number: 73 });
  const completedWithPr = (await get.run({ principal, args: get.schema.parse({ operationId: taskReceipt.operationId }) })).data as Record<string, unknown>;
  assert.deepEqual((completedWithPr.lifecycle as { artifacts: unknown }).artifacts, {
    submissionId, taskId, pullRequest: { repository: 'acme/repo', number: 73, url: 'https://github.com/acme/repo/pull/73' },
  });

  await db('task_history').delete();
  await db('goals').delete();
  await db('tasks').delete();
  await db('task_submissions').delete();

  const durableGoal = (await get.run({ principal, args: get.schema.parse({ operationId: goalReceipt.operationId }) })).data as Record<string, unknown>;
  assert.deepEqual((durableGoal.lifecycle as { failure: unknown }).failure,
    { code: 'EXECUTION_FAILED', message: 'Provider exhausted its retry budget', stage: 'internal', retryable: false, status: 500 });
  assert.deepEqual((durableGoal.lifecycle as { artifacts: unknown }).artifacts,
    { taskId: goalTaskId, pullRequest: { repository: 'acme/repo', number: 61, url: 'https://github.com/acme/repo/pull/61' } });
  const durableTask = await operations.replay(principal, 'create_task', taskArgs);
  assert.deepEqual((durableTask?.lifecycle as { artifacts: unknown }).artifacts,
    { submissionId, taskId, pullRequest: { repository: 'acme/repo', number: 73, url: 'https://github.com/acme/repo/pull/73' } });
  const replayedGoal = await operations.replay(principal, 'create_goal', goalArgs);
  assert.equal(replayedGoal?.state, 'failed');
  assert.equal(replayedGoal?.retryAfterSeconds, undefined);
  const listed = (await list.run({ principal, args: list.schema.parse({}) })).data as { operations: Array<Record<string, unknown>> };
  assert.equal(listed.operations.length, 2);
  assert.ok(listed.operations.every(operation => Object.keys((operation.lifecycle as { artifacts: object }).artifacts).length > 0));
  const listedGoal = listed.operations.find(operation => operation.operationId === goalReceipt.operationId)!;
  assert.equal(listedGoal.state, 'failed');
  assert.equal(listedGoal.retryAfterSeconds, undefined);
});

test('list_operations filters active receipts by exact owner and grant without refreshing trackers', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  const operations = new McpOperations(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' } } as McpPrincipal;
  const otherGrant = { user: { id: 'alice' }, grant: { id: 'grant-b' } } as McpPrincipal;
  const accepted = async (actor: McpPrincipal, tool: string, key: string) => operations.run(actor, {
    tool, args: { idempotencyKey: key }, repository: 'acme/repo',
  }, async () => ({ status: 202, data: { state: 'queued' } }));
  await accepted(principal, 'run_ultrafix', 'active-ultrafix-1');
  await accepted(principal, 'review_pull_request', 'active-review-0001');
  await accepted(otherGrant, 'review_pull_request', 'other-grant-run1');
  await operations.run(principal, { tool: 'run_ultrafix', args: { idempotencyKey: 'done-ultrafix-01' }, repository: 'acme/repo' },
    async () => ({ status: 200, data: { changed: true } }));

  const deps = { db, policy: { repository: async () => {}, requirePermission: () => {}, config: {} } as never,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const tool = createToolCatalog(deps).find(candidate => candidate.name === 'list_operations')!;
  const args = tool.schema.parse({ tool: 'run_ultrafix', lifecycle: 'active' });
  const result = (await tool.run({ principal, args })).data as { operations: Array<Record<string, unknown>>; nextOffset: number | null };
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].tool, 'run_ultrafix');
  assert.equal((result.operations[0].lifecycle as { state: string }).state, 'accepted');
  assert.equal(result.operations[0].refreshWith, 'get_operation');
  const hidden = (await tool.run({ principal: otherGrant, args: tool.schema.parse({ tool: 'run_ultrafix', lifecycle: 'active' }) })).data as { operations: unknown[] };
  assert.deepEqual(hidden.operations, []);
});

test('list_operations filters current repository, tool permission and cancellation-source authorization before paging', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  const operations = new McpOperations(db);
  const principal = { user: { id: 'alice' }, grant: { id: 'grant-a' }, authorization: { permissions: [] } } as unknown as McpPrincipal;
  const run = (tool: string, key: string, repository?: string, data: Record<string, unknown> = {}) => operations.run(principal, {
    tool, args: { idempotencyKey: key }, repository,
  }, async () => ({ status: 200, data }));
  const forbiddenPermission = await run('update_execution_settings', 'permission-hidden-1', undefined, { secret: 'permission-secret' });
  const forbiddenRepository = await run('run_ultrafix', 'repository-hidden1', 'acme/forbidden', { secret: 'repository-secret' });
  const firstAllowed = await run('run_ultrafix', 'allowed-operation1', 'acme/allowed', { marker: 'first' });
  const secondAllowed = await run('review_pull_request', 'allowed-operation2', 'acme/allowed', { marker: 'second' });
  const source = await run('review_pull_request', 'cancel-source-key', 'acme/forbidden', { marker: 'source' });
  const cancellation = await run('cancel_operation', 'cancel-receipt-01', undefined, { operationId: source.operationId, cancellation: 'requested' });
  const now = Date.now();
  for (const [receipt, acceptedAt] of [[forbiddenPermission, now], [forbiddenRepository, now - 1], [firstAllowed, now - 2], [secondAllowed, now - 3], [source, now - 4], [cancellation, now - 5]] as const) {
    await db('mcp_operations').where({ id: receipt.operationId }).update({ accepted_at: acceptedAt, created_at: acceptedAt });
  }

  const policy = {
    config: {},
    repository: async (_actor: McpPrincipal, repository: string) => {
      if (repository === 'acme/forbidden') throw new McpError('REPOSITORY_FORBIDDEN', 'No current access', 403);
    },
    requirePermission: (actor: McpPrincipal, permission: string) => {
      if (!actor.authorization.permissions.includes(permission as never)) throw new McpError('INSUFFICIENT_INSTANCE_PERMISSION', 'Permission removed', 403);
    },
  };
  const deps = { db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as unknown as ToolDeps;
  const catalog = createToolCatalog(deps);
  const list = catalog.find(tool => tool.name === 'list_operations')!;
  const get = catalog.find(tool => tool.name === 'get_operation')!;

  const pageOne = (await list.run({ principal, args: list.schema.parse({ limit: 1 }) })).data as { operations: Array<Record<string, unknown>>; nextOffset: number | null };
  assert.deepEqual(pageOne.operations.map(item => item.operationId), [firstAllowed.operationId]);
  assert.equal(pageOne.nextOffset, 1);
  assert.doesNotMatch(JSON.stringify(pageOne), /permission-secret|repository-secret/);
  const pageTwo = (await list.run({ principal, args: list.schema.parse({ offset: 1, limit: 1 }) })).data as { operations: Array<Record<string, unknown>>; nextOffset: number | null };
  assert.deepEqual(pageTwo.operations.map(item => item.operationId), [secondAllowed.operationId]);
  assert.equal(pageTwo.nextOffset, null);
  const cancellations = (await list.run({ principal, args: list.schema.parse({ tool: 'cancel_operation' }) })).data as { operations: unknown[] };
  assert.deepEqual(cancellations.operations, []);

  const allowedSource = await run('review_pull_request', 'allowed-cancel-src', 'acme/allowed', { marker: 'allowed-source' });
  const allowedCancellation = await run('cancel_operation', 'allowed-cancel-rct', undefined,
    { operationId: allowedSource.operationId, cancellation: 'requested' });
  const otherSource = await run('review_pull_request', 'other-cancel-src-1', 'acme/other', { marker: 'other-source' });
  await run('cancel_operation', 'other-cancel-rct1', undefined,
    { operationId: otherSource.operationId, cancellation: 'requested' });
  const repositoryCancellations = (await list.run({ principal, args: list.schema.parse({
    tool: 'cancel_operation', repository: 'acme/allowed', limit: 1,
  }) })).data as { operations: Array<Record<string, unknown>> };
  assert.deepEqual(repositoryCancellations.operations.map(item => item.operationId), [allowedCancellation.operationId]);

  await assert.rejects(get.run({ principal, args: get.schema.parse({ operationId: forbiddenPermission.operationId }) }), /Permission removed/);
  await assert.rejects(get.run({ principal, args: get.schema.parse({ operationId: forbiddenRepository.operationId }) }), /No current access/);
  await assert.rejects(get.run({ principal, args: get.schema.parse({ operationId: cancellation.operationId }) }), /No current access/);
});

test('CIMD intersects plural supported methods with public PKCE instead of trusting a legacy preference', () => {
  const id = 'https://client.example/oauth/client.json';
  const document = { client_id: id, client_name: 'Test', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], token_endpoint_auth_method: 'private_key_jwt' };
  assert.equal(parseClientMetadataDocument(document, id).token_endpoint_auth_method, 'none');
  assert.equal(parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: undefined, token_endpoint_auth_method: undefined }, id).token_endpoint_auth_method, 'none');
  assert.equal(parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'] }, id).token_endpoint_auth_method, 'none');
  assert.throws(() => parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: ['private_key_jwt'] }, id));
  for (const supported of [[], ['none', 42], ['none', null], ['none', {}], ['none', ''], ['none', 'private key jwt'], 'none']) {
    assert.throws(() => parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: supported }, id));
  }
  for (const preference of [null, 42, {}, [], '', 'private key jwt']) {
    assert.throws(() => parseClientMetadataDocument({ ...document, token_endpoint_auth_method: preference }, id));
  }
  assert.equal(parseClientMetadataDocument({ ...document, token_endpoint_auth_method: undefined }, id).token_endpoint_auth_method, 'none');
  assert.equal(parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: undefined, token_endpoint_auth_method: 'none' }, id).token_endpoint_auth_method, 'none');
  assert.throws(() => parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: undefined }, id));
  assert.throws(() => parseClientMetadataDocument({ ...document, client_id: 'https://imposter.example/client.json' }, id));
});

test('CIMD accepts Claude by intersecting broader advertised grant capabilities', () => {
  const id = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
  const document = {
    client_id: id,
    client_name: 'Claude',
    client_uri: 'https://claude.ai',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  const client = parseClientMetadataDocument(document, id);
  assert.deepEqual(client.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepEqual(client.redirect_uris, document.redirect_uris);
  assert.throws(() => parseClientMetadataDocument({ ...document,
    grant_types: ['urn:ietf:params:oauth:grant-type:jwt-bearer'] }, id));
  for (const grantTypes of [[], ['authorization_code', 42], ['authorization_code', ''], ['authorization code'], 'authorization_code']) {
    assert.throws(() => parseClientMetadataDocument({ ...document, grant_types: grantTypes }, id));
  }
});
