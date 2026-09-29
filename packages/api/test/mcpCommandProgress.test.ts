import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import {
  COMMAND_NOT_PICKED_UP_FAILURE,
  PICKUP_DEADLINE_MS,
  detectPickup,
  summarizeLifecycle,
  ultrafixProgress,
} from '../mcp/commandProgress.js';
import { McpOperations, type Operation } from '../mcp/operations.js';
import { trackExecution } from '../mcp/operationTracking.js';
import { syncLifecycle } from '../mcp/operationLifecycle.js';
import type { ToolDeps } from '../mcp/tools.js';
import type { McpPrincipal } from '../mcp/policy.js';

after(closeConnection);

async function fixture(t: TestContext): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('job_id'); table.string('repository'); table.string('task_type');
    table.integer('issue_number'); table.integer('pr_number'); table.text('initial_job_data'); table.timestamp('created_at');
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary(); table.string('task_id'); table.string('state');
    table.timestamp('timestamp'); table.text('reason'); table.text('metadata');
  });
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  return db;
}

function job(commentId: number, workEpoch: number, commandMode: 'review' | 'fix') {
  return JSON.stringify({ commandCommentId: commentId, commandCommentType: 'issue', commandMode,
    ultrafixMeta: { mode: 'ultrafix', workEpoch, goal: 9, maxCycles: 3 } });
}

test('detectPickup binds each receipt to its selected comment and ultrafix epoch', async t => {
  const db = await fixture(t);
  await db('tasks').insert([
    { task_id: 'epoch-1', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment', initial_job_data: job(101, 1, 'review'), created_at: '2026-09-29T01:00:00Z' },
    { task_id: 'epoch-2', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment', initial_job_data: job(102, 2, 'review'), created_at: '2026-09-29T02:00:00Z' },
  ]);
  assert.equal((await detectPickup(db, { repository: 'acme/repo', pullRequest: 42, commentId: 101, tool: 'run_ultrafix' }))?.task_id, 'epoch-1');
  assert.equal((await detectPickup(db, { repository: 'acme/repo', pullRequest: 42, commentId: 102, tool: 'run_ultrafix' }))?.task_id, 'epoch-2');
  assert.equal(await detectPickup(db, { repository: 'acme/repo', pullRequest: 42, commentId: 100, tool: 'run_ultrafix' }), undefined);
});

test('ultrafixProgress reports cycle two in review without borrowing another epoch', async t => {
  const db = await fixture(t);
  await db('tasks').insert([
    { task_id: 'review-1', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment', initial_job_data: job(101, 7, 'review'), created_at: '2026-09-29T01:00:00Z' },
    { task_id: 'fix-1', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment', initial_job_data: job(0, 7, 'fix'), created_at: '2026-09-29T01:01:00Z' },
    { task_id: 'review-2', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment', initial_job_data: job(0, 7, 'review'), created_at: '2026-09-29T01:02:00Z' },
    { task_id: 'other-loop', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment', initial_job_data: job(102, 8, 'review'), created_at: '2026-09-29T01:03:00Z' },
  ]);
  await db('task_history').insert([
    { task_id: 'review-1', state: 'completed', metadata: JSON.stringify({ ultrafixCycle: 1, ultrafixScore: 5 }) },
    { task_id: 'fix-1', state: 'completed', metadata: JSON.stringify({ ultrafixCycle: 1 }) },
    { task_id: 'review-2', state: 'processing', metadata: JSON.stringify({ ultrafixCycle: 2, ultrafixScore: 7 }) },
    { task_id: 'other-loop', state: 'completed', metadata: JSON.stringify({ ultrafixCycle: 1, ultrafixOutcome: 'goal_reached', ultrafixScore: 10 }) },
  ]);
  const progress = await ultrafixProgress(db, { repository: 'acme/repo', pullRequest: 42, sinceMs: 0, goal: 9, maxCycles: 3, workEpoch: 7 });
  assert.equal(progress.cycle, 2);
  assert.equal(progress.phase, 'review');
  assert.equal(progress.lastScore, 7);
  assert.equal(progress.outcome, null);
  assert.deepEqual(progress.cycles, [
    { cycle: 1, reviewTaskId: 'review-1', fixTaskId: 'fix-1', score: 5 },
    { cycle: 2, reviewTaskId: 'review-2', score: 7 },
  ]);
});

for (const [outcome, expectedState] of [
  ['goal_reached', 'completed'], ['cycles_exhausted', 'completed'], ['stopped', 'cancelled'], ['failed', 'failed'],
] as const) {
  test(`durable ultrafix ${outcome} metadata maps to ${expectedState}`, async t => {
    const db = await fixture(t);
    const principal = {
      user: { id: 'alice' }, grant: { id: 'grant-a' },
      github: { request: async () => ({ data: { head: { sha: 'a'.repeat(40) } } }) },
    } as unknown as McpPrincipal;
    const operations = new McpOperations(db);
    const receipt = await operations.run(principal, {
      tool: 'run_ultrafix', repository: 'acme/repo', args: { idempotencyKey: `ultrafix-${outcome}` },
    }, async () => ({ status: 202, data: { state: 'posted', repository: 'acme/repo', pullRequest: 42, commentId: 101, goal: 9, maxCycles: 3 } }));
    await db('tasks').insert({ task_id: `task-${outcome}`, repository: 'acme/repo', issue_number: 42, pr_number: 42,
      task_type: 'pr-comment', initial_job_data: job(101, 7, 'review'), created_at: new Date() });
    await db('task_history').insert({ task_id: `task-${outcome}`, state: 'completed', timestamp: new Date(),
      metadata: JSON.stringify({ ultrafixCycle: 3, ultrafixScore: 7, ultrafixGoal: 9, ultrafixMaxCycles: 3, ultrafixOutcome: outcome }) });
    const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
      policy: {} as never } as ToolDeps;
    const row = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
    const projected = operations.project(row);
    await trackExecution(deps, row, principal, projected);
    await syncLifecycle(operations, row, projected);
    const final = operations.project(await operations.get(principal, String(receipt.operationId)));
    assert.equal((final.lifecycle as { state: string }).state, expectedState);
    assert.equal(((final.lifecycle as { progress: Record<string, unknown> }).progress).outcome, outcome);
    if (outcome === 'cycles_exhausted') assert.match(String((final.lifecycle as { summary: string }).summary), /did not reach goal 9/);
    if (outcome === 'failed') {
      assert.deepEqual((final.lifecycle as { failure: unknown }).failure, {
        code: 'ULTRAFIX_CYCLE_FAILED', message: 'An ultrafix cycle failed.', stage: 'workflow', retryable: false, status: 500,
        details: { taskId: `task-${outcome}` },
      });
    }
  });
}

test('an unpicked PR command becomes unknown after the pickup deadline with a retryable queue failure', async t => {
  const db = await fixture(t);
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' },
    github: { request: async () => ({ data: { head: { sha: 'a'.repeat(40) } } }) },
  } as unknown as McpPrincipal;
  const operations = new McpOperations(db);
  const receipt = await operations.run(principal, {
    tool: 'review_pull_request', repository: 'acme/repo', args: { idempotencyKey: 'unpicked-review' },
  }, async () => ({ status: 202, data: { state: 'posted', repository: 'acme/repo', pullRequest: 42, commentId: 501 } }));
  await db('mcp_operations').where({ id: receipt.operationId }).update({ created_at: Date.now() - PICKUP_DEADLINE_MS - 1 });
  const row = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const projected = operations.project(row);
  const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    policy: {} as never } as ToolDeps;
  await trackExecution(deps, row, principal, projected);
  await syncLifecycle(operations, row, projected);
  const final = operations.project(await operations.get(principal, String(receipt.operationId)));
  assert.equal((final.lifecycle as { state: string }).state, 'unknown');
  assert.deepEqual((final.lifecycle as { failure: unknown }).failure, COMMAND_NOT_PICKED_UP_FAILURE);
  assert.match(summarizeLifecycle('review_pull_request', final.lifecycle as Record<string, unknown>), /not been confirmed/);

  await db('tasks').insert({ task_id: 'late-review', repository: 'acme/repo', issue_number: 42, pr_number: 42,
    task_type: 'pr-comment', created_at: new Date(), initial_job_data: JSON.stringify({
      commandCommentId: 501, commandCommentType: 'issue', commandMode: 'review',
    }) });
  await db('task_history').insert({ task_id: 'late-review', state: 'pending', timestamp: new Date(), metadata: '{}' });
  const lateRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const lateProjection = operations.project(lateRow);
  await trackExecution(deps, lateRow, principal, lateProjection);
  await syncLifecycle(operations, lateRow, lateProjection);
  const recovered = operations.project(await operations.get(principal, String(receipt.operationId)));
  assert.equal(recovered.state, 'running');
  assert.equal((recovered.lifecycle as { state: string }).state, 'running');
  assert.equal((recovered.lifecycle as { failure: unknown }).failure, null);
  assert.equal(((recovered.lifecycle as { artifacts: Record<string, unknown> }).artifacts).taskId, 'late-review');
});
