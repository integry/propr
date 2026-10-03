/* eslint-disable max-lines -- command progress and lifecycle race regressions share one database fixture */
import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { up as lifecycleMigration } from '../../core/src/db/migrations/20261001000000_add_mcp_operation_lifecycle.js';
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
  await lifecycleMigration(db);
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
    { task_id: 'boolean-epoch', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment',
      initial_job_data: JSON.stringify({ commandCommentId: 103, commandMode: 'review', ultrafixMeta: { workEpoch: true } }),
      created_at: '2026-09-29T03:00:00Z' },
  ]);
  assert.equal((await detectPickup(db, { repository: 'acme/repo', pullRequest: 42, commentId: 101, tool: 'run_ultrafix' }))?.task_id, 'epoch-1');
  assert.equal((await detectPickup(db, { repository: 'acme/repo', pullRequest: 42, commentId: 102, tool: 'run_ultrafix' }))?.task_id, 'epoch-2');
  assert.equal(await detectPickup(db, { repository: 'acme/repo', pullRequest: 42, commentId: 100, tool: 'run_ultrafix' }), undefined);
  assert.equal(await detectPickup(db, { repository: 'acme/repo', pullRequest: 42, commentId: 103, tool: 'run_ultrafix' }), undefined);
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

test('ultrafixProgress keeps a fix-first running review in the same cycle', async t => {
  const db = await fixture(t);
  await db('tasks').insert([
    { task_id: 'fix-first-1', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment',
      initial_job_data: job(101, 7, 'fix'), created_at: '2026-09-29T01:00:00Z' },
    { task_id: 'review-after-fix-1', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment',
      initial_job_data: job(0, 7, 'review'), created_at: '2026-09-29T01:01:00Z' },
  ]);
  await db('task_history').insert([
    { task_id: 'fix-first-1', state: 'completed', metadata: JSON.stringify({ ultrafixCycle: 1 }) },
    { task_id: 'review-after-fix-1', state: 'processing', metadata: '{}' },
  ]);

  const running = await ultrafixProgress(db, {
    repository: 'acme/repo', pullRequest: 42, sinceMs: 0, goal: 9, maxCycles: 3, workEpoch: 7,
  });
  assert.equal(running.cycle, 1);
  assert.equal(running.phase, 'review');
  assert.equal(running.latestTaskId, 'review-after-fix-1');
  assert.deepEqual(running.cycles, [
    { cycle: 1, fixTaskId: 'fix-first-1', reviewTaskId: 'review-after-fix-1' },
  ]);

  await db('task_history').where({ task_id: 'review-after-fix-1' })
    .update({ state: 'completed', metadata: JSON.stringify({ ultrafixCycle: 1, ultrafixScore: 8 }) });
  const completed = await ultrafixProgress(db, {
    repository: 'acme/repo', pullRequest: 42, sinceMs: 0, goal: 9, maxCycles: 3, workEpoch: 7,
  });
  assert.equal(completed.cycle, 1);
  assert.equal(completed.latestTaskId, 'review-after-fix-1');
  assert.deepEqual(completed.cycles, [
    { cycle: 1, fixTaskId: 'fix-first-1', reviewTaskId: 'review-after-fix-1', score: 8 },
  ]);
});

test('ultrafix tracking keeps fix-first continuation and result navigation on the running review', async t => {
  const db = await fixture(t);
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' },
    github: { request: async () => ({ data: { head: { sha: 'a'.repeat(40) } } }) },
  } as unknown as McpPrincipal;
  const operations = new McpOperations(db);
  const receipt = await operations.run(principal, {
    tool: 'run_ultrafix', repository: 'acme/repo', args: { idempotencyKey: 'ultrafix-fix-first-review' },
  }, async () => ({ status: 202, data: {
    state: 'posted', repository: 'acme/repo', pullRequest: 42, commentId: 101, goal: 9, maxCycles: 3,
  } }));
  await db('tasks').insert([
    { task_id: 'fix-first-1', repository: 'acme/repo', issue_number: 42, pr_number: 42, task_type: 'pr-comment',
      initial_job_data: job(101, 7, 'fix'), created_at: '2026-09-29T01:00:00Z' },
    { task_id: 'review-after-fix-1', repository: 'acme/repo', issue_number: 42, pr_number: 42, task_type: 'pr-comment',
      initial_job_data: job(0, 7, 'review'), created_at: '2026-09-29T01:01:00Z' },
  ]);
  await db('task_history').insert([
    { task_id: 'fix-first-1', state: 'completed', metadata: JSON.stringify({ ultrafixCycle: 1 }) },
    { task_id: 'review-after-fix-1', state: 'processing', metadata: '{}' },
  ]);
  const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    policy: {} as never } as ToolDeps;
  const row = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;

  await trackExecution(deps, row, principal, operations.project(row));

  const tracked = operations.project(await operations.get(principal, String(receipt.operationId)));
  assert.equal(tracked.state, 'running');
  assert.equal(tracked.result.continuation.taskId, 'review-after-fix-1');
  assert.equal(tracked.result.results.taskId, 'review-after-fix-1');
});

test('ultrafixProgress filters the epoch before bounding old pull request tasks', async t => {
  const db = await fixture(t);
  await db('tasks').insert(Array.from({ length: 201 }, (_, index) => ({
    task_id: `old-${String(index).padStart(3, '0')}`, repository: 'acme/repo', issue_number: 42,
    task_type: 'pr-comment', initial_job_data: job(0, 1, 'review'),
    created_at: `2026-09-28T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00Z`,
  })));
  await db('tasks').insert({ task_id: 'current-terminal', repository: 'acme/repo', issue_number: 42,
    task_type: 'pr-comment', initial_job_data: job(101, 9, 'review'), created_at: '2026-09-29T01:00:00Z' });
  await db('task_history').insert({ task_id: 'current-terminal', state: 'completed',
    metadata: JSON.stringify({ ultrafixCycle: 1, ultrafixScore: 10, ultrafixOutcome: 'goal_reached' }) });

  const progress = await ultrafixProgress(db, {
    repository: 'acme/repo', pullRequest: 42, sinceMs: 0, goal: 9, maxCycles: 3, workEpoch: 9,
  });
  assert.equal(progress.outcome, 'goal_reached');
  assert.equal(progress.lastScore, 10);
  assert.deepEqual(progress.cycles, [{ cycle: 1, reviewTaskId: 'current-terminal', score: 10 }]);
});

test('ultrafixProgress rejects null, boolean, and empty numeric metadata', async t => {
  const db = await fixture(t);
  await db('tasks').insert([
    { task_id: 'legacy-review-1', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment',
      initial_job_data: job(101, 7, 'review'), created_at: '2026-09-29T01:00:00Z' },
    { task_id: 'legacy-fix-1', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment',
      initial_job_data: job(0, 7, 'fix'), created_at: '2026-09-29T01:01:00Z' },
    { task_id: 'legacy-review-2', repository: 'acme/repo', issue_number: 42, task_type: 'pr-comment',
      initial_job_data: job(0, 7, 'review'), created_at: '2026-09-29T01:02:00Z' },
  ]);
  await db('task_history').insert([
    { task_id: 'legacy-review-1', state: 'completed', metadata: JSON.stringify({ ultrafixCycle: true, ultrafixScore: 8 }) },
    { task_id: 'legacy-fix-1', state: 'completed', metadata: JSON.stringify({ ultrafixCycle: true, ultrafixScore: '' }) },
    { task_id: 'legacy-review-2', state: 'processing', metadata: JSON.stringify({ ultrafixCycle: true, ultrafixScore: false }) },
    { task_id: 'legacy-review-2', state: 'cancelled', metadata: JSON.stringify({
      ultrafixCycle: null, ultrafixScore: null, ultrafixOutcome: 'stopped',
    }) },
  ]);

  const progress = await ultrafixProgress(db, {
    repository: 'acme/repo', pullRequest: 42, sinceMs: 0, goal: 9, maxCycles: 3, workEpoch: 7,
  });
  assert.equal(progress.cycle, 2);
  assert.equal(progress.lastScore, 8);
  assert.deepEqual(progress.cycles, [
    { cycle: 1, reviewTaskId: 'legacy-review-1', fixTaskId: 'legacy-fix-1', score: 8 },
    { cycle: 2, reviewTaskId: 'legacy-review-2' },
  ]);
  for (const lastScore of [null, false, '']) {
    const summary = summarizeLifecycle('run_ultrafix', { progress: { ...progress, lastScore } });
    assert.match(summary, /no review score yet/);
    assert.doesNotMatch(summary, /0\/10/);
  }
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

test('legacy Redis failure persists terminal ultrafix progress across resolved polling', async t => {
  const db = await fixture(t);
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' },
    github: { request: async () => ({ data: { head: { sha: 'a'.repeat(40) } } }) },
  } as unknown as McpPrincipal;
  const operations = new McpOperations(db);
  const receipt = await operations.run(principal, {
    tool: 'run_ultrafix', repository: 'acme/repo', args: { idempotencyKey: 'ultrafix-legacy-redis-failure' },
  }, async () => ({ status: 202, data: {
    state: 'posted', repository: 'acme/repo', pullRequest: 42, commentId: 101, goal: 9, maxCycles: 3,
  } }));
  await db('tasks').insert({ task_id: 'legacy-redis-review', repository: 'acme/repo', issue_number: 42, pr_number: 42,
    task_type: 'pr-comment', initial_job_data: job(101, 7, 'review'), created_at: new Date() });
  await db('task_history').insert({ task_id: 'legacy-redis-review', state: 'completed', timestamp: new Date(),
    metadata: JSON.stringify({ ultrafixCycle: 2, ultrafixScore: 6 }) });
  let redisReads = 0;
  const deps = { db, redisClient: { get: async () => {
    redisReads++;
    return JSON.stringify({ workEpoch: 7, active: false, cycleCount: 2, finalScore: 6,
      completionStatus: 'failed', completionReason: 'Legacy loop failed.' });
  } } as never, taskQueue: {} as never, runtimeBuildQueue: {} as never, policy: {} as never } as ToolDeps;

  const row = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const projected = operations.project(row);
  await trackExecution(deps, row, principal, projected);
  await syncLifecycle(operations, row, projected);

  const terminalRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const terminalResult = JSON.parse(terminalRow.result!);
  assert.equal(terminalRow.state, 'failed');
  assert.equal(terminalRow.lifecycle, 'failed');
  assert.equal(terminalResult.executionResolved, true);
  assert.equal(terminalResult.ultrafixProgress.outcome, 'failed');
  assert.equal(terminalResult.ultrafixProgress.phase, 'done');
  assert.equal(JSON.parse(terminalRow.progress!).outcome, 'failed');
  const terminalLifecycle = operations.project(terminalRow).lifecycle as {
    failure: { message: string }; summary: string;
  };
  assert.equal(terminalLifecycle.failure.message, 'Legacy loop failed.');
  assert.match(terminalLifecycle.summary, /Ultrafix failed/);
  assert.doesNotMatch(terminalLifecycle.summary, /is reviewing/);

  const resolvedReceipt = operations.project(terminalRow);
  await trackExecution(deps, terminalRow, principal, resolvedReceipt);
  await syncLifecycle(operations, terminalRow, resolvedReceipt);
  const resolved = operations.project(await operations.get(principal, String(receipt.operationId)));
  assert.equal(redisReads, 1, 'resolved polling uses the durable terminal receipt');
  assert.equal(((resolved.lifecycle as { progress: { outcome: string } }).progress).outcome, 'failed');
  assert.equal(((resolved.lifecycle as { progress: { phase: string } }).progress).phase, 'done');
  assert.match(String((resolved.lifecycle as { summary: string }).summary), /Ultrafix failed/);
});

test('terminal ultrafix lifecycle never summarizes stale progress as active', () => {
  const progress = {
    kind: 'ultrafix', goal: 9, maxCycles: 3, cycle: 2, lastScore: 6,
    phase: 'review', outcome: null, cycles: [],
  };
  const summaries = [
    summarizeLifecycle('run_ultrafix', { state: 'failed', progress }),
    summarizeLifecycle('run_ultrafix', { state: 'cancelled', progress }),
    summarizeLifecycle('run_ultrafix', { state: 'completed', progress }),
  ];
  assert.match(summaries[0], /failed/);
  assert.match(summaries[1], /stopped/);
  assert.match(summaries[2], /completed/);
  for (const summary of summaries) assert.doesNotMatch(summary, /is reviewing/);
});

test('a stale ultrafix poll adopts terminal result progress before synchronizing lifecycle', async t => {
  const db = await fixture(t);
  const operations = new McpOperations(db);
  let releaseStale!: () => void;
  let staleReachedRefresh!: () => void;
  const release = new Promise<void>(resolve => { releaseStale = resolve; });
  const reachedRefresh = new Promise<void>(resolve => { staleReachedRefresh = resolve; });
  let githubRequests = 0;
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' }, github: { request: async () => {
      githubRequests++;
      if (githubRequests === 1) { staleReachedRefresh(); await release; }
      return { data: { head: { sha: 'a'.repeat(40) } } };
    } },
  } as unknown as McpPrincipal;
  const receipt = await operations.run(principal, {
    tool: 'run_ultrafix', repository: 'acme/repo', args: { idempotencyKey: 'ultrafix-terminal-race' },
  }, async () => ({ status: 202, data: {
    state: 'posted', repository: 'acme/repo', pullRequest: 42, commentId: 101, goal: 9, maxCycles: 3,
  } }));
  await db('tasks').insert({ task_id: 'race-review', repository: 'acme/repo', issue_number: 42, pr_number: 42,
    task_type: 'pr-comment', initial_job_data: job(101, 7, 'review'), created_at: new Date() });
  await db('task_history').insert({ task_id: 'race-review', state: 'processing', timestamp: new Date(),
    metadata: JSON.stringify({ ultrafixCycle: 1, ultrafixScore: 7 }) });
  const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    policy: {} as never } as ToolDeps;

  const staleRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const staleReceipt = operations.project(staleRow);
  const stalePoll = trackExecution(deps, staleRow, principal, staleReceipt);
  await reachedRefresh;

  await db('task_history').insert({ task_id: 'race-review', state: 'completed', timestamp: new Date(),
    metadata: JSON.stringify({ ultrafixCycle: 1, ultrafixScore: null, ultrafixOutcome: 'goal_reached' }) });
  const terminalRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const terminalReceipt = operations.project(terminalRow);
  await trackExecution(deps, terminalRow, principal, terminalReceipt);
  assert.equal((await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!.lifecycle, 'accepted');

  releaseStale();
  await stalePoll;
  assert.equal((staleReceipt.lifecycleProgress as { outcome: string }).outcome, 'goal_reached');
  await syncLifecycle(operations, staleRow, staleReceipt);

  const durable = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  assert.equal(durable.lifecycle, 'completed');
  assert.equal(JSON.parse(durable.progress!).outcome, 'goal_reached');
  assert.equal(JSON.parse(durable.progress!).phase, 'done');
  assert.equal(JSON.parse(durable.progress!).lastScore, 7);
});

test('a stale ultrafix poll cannot overwrite stopping intent, while terminal evidence can', async t => {
  const db = await fixture(t);
  const operations = new McpOperations(db);
  let releaseStale!: () => void;
  let staleReachedRefresh!: () => void;
  const release = new Promise<void>(resolve => { releaseStale = resolve; });
  const reachedRefresh = new Promise<void>(resolve => { staleReachedRefresh = resolve; });
  let githubRequests = 0;
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' }, github: { request: async () => {
      githubRequests++;
      if (githubRequests === 1) { staleReachedRefresh(); await release; }
      return { data: { head: { sha: 'b'.repeat(40) } } };
    } },
  } as unknown as McpPrincipal;
  const receipt = await operations.run(principal, {
    tool: 'run_ultrafix', repository: 'acme/repo', args: { idempotencyKey: 'ultrafix-stopping-race' },
  }, async () => ({ status: 202, data: {
    state: 'posted', repository: 'acme/repo', pullRequest: 42, commentId: 101, goal: 9, maxCycles: 3,
  } }));
  await db('tasks').insert({ task_id: 'stopping-review', repository: 'acme/repo', issue_number: 42, pr_number: 42,
    task_type: 'pr-comment', initial_job_data: job(101, 7, 'review'), created_at: new Date() });
  await db('task_history').insert({ task_id: 'stopping-review', state: 'processing', timestamp: new Date(),
    metadata: JSON.stringify({ ultrafixCycle: 1, ultrafixScore: 6 }) });
  const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    policy: {} as never } as ToolDeps;
  const staleRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const staleReceipt = operations.project(staleRow);
  const stalePoll = trackExecution(deps, staleRow, principal, staleReceipt);
  await reachedRefresh;

  await db('mcp_operations').where({ id: receipt.operationId }).update({ progress: JSON.stringify({
    kind: 'ultrafix', goal: 9, maxCycles: 3, cycle: 0, lastScore: null,
    phase: 'stopping', outcome: null, cycles: [],
  }) });
  releaseStale();
  await stalePoll;
  await syncLifecycle(operations, staleRow, staleReceipt);
  const stopping = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  assert.equal(JSON.parse(stopping.progress!).phase, 'stopping');
  assert.equal(JSON.parse(stopping.progress!).cycle, 1, 'fresh reconstruction data is retained with the stop phase');

  await db('task_history').insert({ task_id: 'stopping-review', state: 'cancelled', timestamp: new Date(),
    metadata: JSON.stringify({ ultrafixCycle: 1, ultrafixOutcome: 'stopped' }) });
  const terminalRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const terminalReceipt = operations.project(terminalRow);
  await trackExecution(deps, terminalRow, principal, terminalReceipt);
  await syncLifecycle(operations, terminalRow, terminalReceipt);
  const terminal = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  assert.equal(terminal.lifecycle, 'cancelled');
  assert.equal(JSON.parse(terminal.progress!).phase, 'done');
  assert.equal(JSON.parse(terminal.progress!).outcome, 'stopped');
});

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

test('a multi-model review follows each model comment and completes when every review has finished', async t => {
  const db = await fixture(t);
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' },
    github: { request: async () => ({ data: { head: { sha: 'e'.repeat(40) } } }) },
  } as unknown as McpPrincipal;
  const operations = new McpOperations(db);
  const receipt = await operations.run(principal, {
    tool: 'review_pull_request', repository: 'acme/repo', args: { idempotencyKey: 'fan-out-review' },
  }, async () => ({ status: 202, data: { state: 'posted', repository: 'acme/repo', pullRequest: 42, reviews: [
    { model: 'claude-opus-5', commentId: 701, state: 'posted' },
    { model: 'gpt-5.6', commentId: 702, state: 'posted' },
    { model: 'claude-sonnet-5', state: 'not_posted', error: { code: 'STALE_HEAD' } },
  ] } }));
  const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    policy: {} as never } as ToolDeps;
  const poll = async () => {
    const row = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
    const projected = operations.project(row);
    await trackExecution(deps, row, principal, projected);
    await syncLifecycle(operations, row, projected);
    return operations.project(await operations.get(principal, String(receipt.operationId)));
  };
  const pickUp = async (taskId: string, commentId: number, state: string, metadata: unknown = {}) => {
    await db('tasks').insert({ task_id: taskId, repository: 'acme/repo', issue_number: 42, pr_number: 42, task_type: 'pr-comment',
      created_at: new Date(), initial_job_data: JSON.stringify({ commandCommentId: commentId, commandCommentType: 'issue', commandMode: 'review' }) });
    await db('task_history').insert({ task_id: taskId, state, timestamp: new Date(), metadata: JSON.stringify(metadata) });
  };

  // One model picked up and running, the other not yet: the operation runs.
  await pickUp('opus-review', 701, 'processing');
  const running = await poll();
  assert.equal((running.lifecycle as { state: string }).state, 'running');
  const runningReviews = (running.result as { reviews: Array<Record<string, unknown>> }).reviews;
  assert.deepEqual(runningReviews.map(review => [review.model, review.taskId ?? null, review.taskState ?? null]),
    [['claude-opus-5', 'opus-review', 'processing'], ['gpt-5.6', null, 'pending'], ['claude-sonnet-5', null, null]]);
  assert.deepEqual((running.lifecycle as { artifacts: Record<string, unknown> }).artifacts.commentIds, [701, 702]);

  // Both finish; one of them reports a failed review: the fan-out still completed.
  await db('task_history').insert({ task_id: 'opus-review', state: 'completed', timestamp: new Date(), metadata: '{}' });
  await pickUp('gpt-review', 702, 'completed', { reviewResults: [{ success: false, error: 'Model unavailable' }] });
  const finished = await poll();
  assert.equal((finished.lifecycle as { state: string }).state, 'completed');
  const artifacts = (finished.lifecycle as { artifacts: Record<string, unknown> }).artifacts;
  assert.deepEqual(artifacts.taskIds, ['opus-review', 'gpt-review']);
  const finishedReviews = (finished.result as { reviews: Array<Record<string, unknown>> }).reviews;
  assert.deepEqual(finishedReviews.map(review => review.taskState ?? null), ['completed', 'failed', null]);
});

test('a model list that posted only one review still tracks that review and its comment', async t => {
  const db = await fixture(t);
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' },
    github: { request: async () => ({ data: { head: { sha: 'e'.repeat(40) } } }) },
  } as unknown as McpPrincipal;
  const operations = new McpOperations(db);
  const receipt = await operations.run(principal, {
    tool: 'review_pull_request', repository: 'acme/repo', args: { idempotencyKey: 'fan-out-single-posted' },
  }, async () => ({ status: 202, data: { state: 'posted', repository: 'acme/repo', pullRequest: 42, reviews: [
    { model: 'claude-opus-5', commentId: 901, state: 'posted' },
    { model: 'claude-sonnet-5', state: 'not_posted', error: { code: 'STALE_HEAD' } },
    { model: 'gpt-5.6', state: 'not_posted', error: { code: 'STALE_HEAD' } },
  ] } }));
  const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    policy: {} as never } as ToolDeps;
  const poll = async () => {
    const row = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
    const projected = operations.project(row);
    await trackExecution(deps, row, principal, projected);
    await syncLifecycle(operations, row, projected);
    return operations.project(await operations.get(principal, String(receipt.operationId)));
  };

  const waiting = await poll();
  assert.equal((waiting.lifecycle as { artifacts: Record<string, unknown> }).artifacts.commentId, 901);
  assert.deepEqual((waiting.result as { reviews: Array<Record<string, unknown>> }).reviews.map(review => review.taskState ?? null),
    ['pending', null, null]);

  await db('tasks').insert({ task_id: 'only-review', repository: 'acme/repo', issue_number: 42, pr_number: 42, task_type: 'pr-comment',
    created_at: new Date(), initial_job_data: JSON.stringify({ commandCommentId: 901, commandCommentType: 'issue', commandMode: 'review' }) });
  await db('task_history').insert({ task_id: 'only-review', state: 'processing', timestamp: new Date(), metadata: '{}' });
  const running = await poll();
  assert.equal((running.lifecycle as { state: string }).state, 'running');
  assert.deepEqual((running.result as { reviews: Array<Record<string, unknown>> }).reviews.map(review => [review.taskId ?? null, review.taskState ?? null]),
    [['only-review', 'processing'], [null, null], [null, null]]);

  await db('task_history').insert({ task_id: 'only-review', state: 'completed', timestamp: new Date(), metadata: '{}' });
  const finished = await poll();
  assert.equal((finished.lifecycle as { state: string }).state, 'completed');
  const artifacts = (finished.lifecycle as { artifacts: Record<string, unknown> }).artifacts;
  assert.equal(artifacts.commentId, 901);
  assert.deepEqual(artifacts.taskIds, ['only-review']);
});

test('a multi-model review fails only when every model review failed', async t => {
  const db = await fixture(t);
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' },
    github: { request: async () => ({ data: { head: { sha: 'e'.repeat(40) } } }) },
  } as unknown as McpPrincipal;
  const operations = new McpOperations(db);
  const receipt = await operations.run(principal, {
    tool: 'review_pull_request', repository: 'acme/repo', args: { idempotencyKey: 'fan-out-failed' },
  }, async () => ({ status: 202, data: { state: 'posted', repository: 'acme/repo', pullRequest: 42, reviews: [
    { model: 'claude-opus-5', commentId: 801, state: 'posted' }, { model: 'gpt-5.6', commentId: 802, state: 'posted' },
  ] } }));
  for (const [taskId, commentId] of [['failed-a', 801], ['failed-b', 802]] as const) {
    await db('tasks').insert({ task_id: taskId, repository: 'acme/repo', issue_number: 42, pr_number: 42, task_type: 'pr-comment',
      created_at: new Date(), initial_job_data: JSON.stringify({ commandCommentId: commentId, commandCommentType: 'issue', commandMode: 'review' }) });
    await db('task_history').insert({ task_id: taskId, state: 'failed', timestamp: new Date(), metadata: '{}' });
  }
  const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    policy: {} as never } as ToolDeps;
  const row = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const projected = operations.project(row);
  await trackExecution(deps, row, principal, projected);
  await syncLifecycle(operations, row, projected);
  const final = operations.project(await operations.get(principal, String(receipt.operationId)));
  assert.equal((final.lifecycle as { state: string }).state, 'failed');
  assert.equal((final.lifecycle as { failure: { code: string } }).failure.code, 'REVIEW_FAILED');
});

test('a multi-model review stays unknown while a review may have posted without confirmation', async t => {
  const db = await fixture(t);
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' },
    github: { request: async () => ({ data: { head: { sha: 'e'.repeat(40) } } }) },
  } as unknown as McpPrincipal;
  const operations = new McpOperations(db);
  const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    policy: {} as never } as ToolDeps;
  for (const [key, commentId, taskState] of [['fan-out-uncertain-done', 1001, 'completed'], ['fan-out-uncertain-failed', 1002, 'failed']] as const) {
    const receipt = await operations.run(principal, {
      tool: 'review_pull_request', repository: 'acme/repo', args: { idempotencyKey: key },
    }, async () => ({ status: 202, data: { state: 'posted', repository: 'acme/repo', pullRequest: 42, reviews: [
      { model: 'claude-opus-5', commentId, state: 'posted' },
      { model: 'gpt-5.6', state: 'unknown', error: { code: 'OUTCOME_UNKNOWN', cause: { code: 'UPSTREAM_UNREACHABLE' } } },
    ] } }));
    const taskId = `${key}-task`;
    await db('tasks').insert({ task_id: taskId, repository: 'acme/repo', issue_number: 42, pr_number: 42, task_type: 'pr-comment',
      created_at: new Date(), initial_job_data: JSON.stringify({ commandCommentId: commentId, commandCommentType: 'issue', commandMode: 'review' }) });
    await db('task_history').insert({ task_id: taskId, state: taskState, timestamp: new Date(), metadata: '{}' });
    const row = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
    const projected = operations.project(row);
    await trackExecution(deps, row, principal, projected);
    await syncLifecycle(operations, row, projected);
    const final = operations.project(await operations.get(principal, String(receipt.operationId)));
    // The confirmed review settled, but the uncertain one may still be queued.
    assert.equal(final.state, 'unknown', key);
    assert.equal((final.lifecycle as { state: string }).state, 'unknown', key);
    const failure = (final.lifecycle as { failure: { code: string; details: Record<string, unknown> } }).failure;
    assert.equal(failure.code, 'OUTCOME_UNKNOWN', key);
    assert.deepEqual(failure.details.uncertainModels, ['gpt-5.6'], key);
    const reviews = (final.result as { reviews: Array<Record<string, unknown>> }).reviews;
    assert.deepEqual(reviews.map(review => [review.state, review.taskState ?? null]), [['posted', taskState], ['unknown', null]], key);
    assert.notEqual((final.result as { executionResolved?: boolean }).executionResolved, true, key);
  }
});

test('terminal recovery replaces an obsolete pickup failure with the execution failure', async t => {
  const db = await fixture(t);
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' },
    github: { request: async () => ({ data: { head: { sha: 'c'.repeat(40) } } }) },
  } as unknown as McpPrincipal;
  const operations = new McpOperations(db);
  const receipt = await operations.run(principal, {
    tool: 'review_pull_request', repository: 'acme/repo', args: { idempotencyKey: 'late-failed-review' },
  }, async () => ({ status: 202, data: { state: 'posted', repository: 'acme/repo', pullRequest: 42, commentId: 601 } }));
  await db('mcp_operations').where({ id: receipt.operationId }).update({ created_at: Date.now() - PICKUP_DEADLINE_MS - 1 });
  const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    policy: {} as never } as ToolDeps;

  const unpickedRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const unpickedReceipt = operations.project(unpickedRow);
  await trackExecution(deps, unpickedRow, principal, unpickedReceipt);
  await syncLifecycle(operations, unpickedRow, unpickedReceipt);

  await db('tasks').insert({ task_id: 'late-failed-task', repository: 'acme/repo', issue_number: 42, pr_number: 42,
    task_type: 'pr-comment', created_at: new Date(), initial_job_data: JSON.stringify({
      commandCommentId: 601, commandCommentType: 'issue', commandMode: 'review',
    }) });
  await db('task_history').insert({ task_id: 'late-failed-task', state: 'failed', timestamp: new Date(),
    reason: 'Worker execution failed.', metadata: '{}' });
  const pickedUpRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  await trackExecution(deps, pickedUpRow, principal, operations.project(pickedUpRow));

  const interrupted = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  assert.equal(interrupted.state, 'failed');
  assert.equal(interrupted.lifecycle, 'unknown');
  assert.deepEqual(JSON.parse(interrupted.failure!), COMMAND_NOT_PICKED_UP_FAILURE);

  const recovered = operations.project(await operations.get(principal, String(receipt.operationId)));
  assert.equal((recovered.lifecycle as { state: string }).state, 'failed');
  assert.deepEqual((recovered.lifecycle as { failure: unknown }).failure, {
    code: 'EXECUTION_FAILED', message: 'Worker execution failed.', stage: 'internal', retryable: false, status: 500,
  });

  const synchronizedFailure = { code: 'SYNCHRONIZED_FAILURE', message: 'Synchronized execution failure.',
    stage: 'workflow', retryable: false, status: 500 };
  await db('mcp_operations').where({ id: receipt.operationId }).update({ failure: JSON.stringify(COMMAND_NOT_PICKED_UP_FAILURE) });
  await operations.finish(String(receipt.operationId), 'failed', synchronizedFailure);
  assert.deepEqual(JSON.parse((await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!.failure!), synchronizedFailure);

  const authoritative = { code: 'AUTHORITATIVE_FAILURE', message: 'Previously synchronized failure.',
    stage: 'workflow', retryable: false, status: 500 };
  await db('mcp_operations').where({ id: receipt.operationId }).update({ failure: JSON.stringify(authoritative) });
  await operations.finish(String(receipt.operationId), 'failed', synchronizedFailure);
  await operations.reconcileTerminalLifecycles(principal, String(receipt.operationId));
  assert.deepEqual(JSON.parse((await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!.failure!), authoritative);

  const completedReceipt = await operations.run(principal, {
    tool: 'review_pull_request', repository: 'acme/repo', args: { idempotencyKey: 'late-completed-review' },
  }, async () => ({ status: 202, data: { state: 'posted', repository: 'acme/repo', pullRequest: 42, commentId: 603 } }));
  await db('mcp_operations').where({ id: completedReceipt.operationId }).update({
    state: 'completed', lifecycle: 'unknown', finished_at: null, failure: JSON.stringify(COMMAND_NOT_PICKED_UP_FAILURE),
    result: JSON.stringify({ executionResolved: true, targetState: { taskId: 'late-completed-task', state: 'completed' } }),
  });
  await operations.reconcileTerminalLifecycles(principal, String(completedReceipt.operationId));
  const completed = (await db<Operation>('mcp_operations').where({ id: completedReceipt.operationId }).first())!;
  assert.equal(completed.lifecycle, 'completed');
  assert.equal(completed.failure, null);
  await db('mcp_operations').where({ id: completedReceipt.operationId }).update({ failure: JSON.stringify(COMMAND_NOT_PICKED_UP_FAILURE) });
  await operations.finish(String(completedReceipt.operationId), 'completed');
  assert.equal((await db<Operation>('mcp_operations').where({ id: completedReceipt.operationId }).first())!.failure, null);
});

test('a stale pickup poll discards its timeout when adopting a terminal failed receipt', async t => {
  const db = await fixture(t);
  const operations = new McpOperations(db);
  let releaseStale!: () => void;
  let staleReachedRefresh!: () => void;
  const release = new Promise<void>(resolve => { releaseStale = resolve; });
  const reachedRefresh = new Promise<void>(resolve => { staleReachedRefresh = resolve; });
  let githubRequests = 0;
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' }, github: { request: async () => {
      githubRequests++;
      if (githubRequests === 1) { staleReachedRefresh(); await release; }
      return { data: { head: { sha: 'd'.repeat(40) } } };
    } },
  } as unknown as McpPrincipal;
  const receipt = await operations.run(principal, {
    tool: 'review_pull_request', repository: 'acme/repo', args: { idempotencyKey: 'stale-pickup-failure' },
  }, async () => ({ status: 202, data: { state: 'posted', repository: 'acme/repo', pullRequest: 42, commentId: 602 } }));
  await db('mcp_operations').where({ id: receipt.operationId }).update({ created_at: Date.now() - PICKUP_DEADLINE_MS - 1 });
  const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    policy: {} as never } as ToolDeps;

  const staleRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const staleReceipt = operations.project(staleRow);
  const stalePoll = trackExecution(deps, staleRow, principal, staleReceipt);
  await reachedRefresh;

  await db('tasks').insert({ task_id: 'concurrent-failed-task', repository: 'acme/repo', issue_number: 42, pr_number: 42,
    task_type: 'pr-comment', created_at: new Date(), initial_job_data: JSON.stringify({
      commandCommentId: 602, commandCommentType: 'issue', commandMode: 'review',
    }) });
  await db('task_history').insert({ task_id: 'concurrent-failed-task', state: 'failed', timestamp: new Date(),
    reason: 'Concurrent worker failed.', metadata: '{}' });
  const terminalRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  await trackExecution(deps, terminalRow, principal, operations.project(terminalRow));

  releaseStale();
  await stalePoll;
  assert.equal('lifecycleFailure' in staleReceipt, false);
  await syncLifecycle(operations, staleRow, staleReceipt);

  const final = operations.project(await operations.get(principal, String(receipt.operationId)));
  assert.deepEqual((final.lifecycle as { failure: unknown }).failure, {
    code: 'EXECUTION_FAILED', message: 'Concurrent worker failed.', stage: 'internal', retryable: false, status: 500,
  });
});

test('a stale pickup timeout adopts a concurrently running task and cannot overwrite its lifecycle', async t => {
  const db = await fixture(t);
  const operations = new McpOperations(db);
  let releaseStale!: () => void;
  let staleReachedRefresh!: () => void;
  const release = new Promise<void>(resolve => { releaseStale = resolve; });
  const reachedRefresh = new Promise<void>(resolve => { staleReachedRefresh = resolve; });
  let githubRequests = 0;
  const principal = {
    user: { id: 'alice' }, grant: { id: 'grant-a' }, github: { request: async () => {
      githubRequests++;
      if (githubRequests === 1) { staleReachedRefresh(); await release; }
      return { data: { head: { sha: 'e'.repeat(40) } } };
    } },
  } as unknown as McpPrincipal;
  const receipt = await operations.run(principal, {
    tool: 'review_pull_request', repository: 'acme/repo', args: { idempotencyKey: 'stale-running-pickup' },
  }, async () => ({ status: 202, data: {
    state: 'posted', repository: 'acme/repo', pullRequest: 42, commentId: 701,
  } }));
  await db('mcp_operations').where({ id: receipt.operationId }).update({ created_at: Date.now() - PICKUP_DEADLINE_MS - 1 });
  const deps = { db, redisClient: {} as never, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    policy: {} as never } as ToolDeps;

  const staleRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const staleReceipt = operations.project(staleRow);
  const stalePoll = trackExecution(deps, staleRow, principal, staleReceipt);
  await reachedRefresh;

  await db('tasks').insert({ task_id: 'concurrent-running-task', repository: 'acme/repo', issue_number: 42, pr_number: 42,
    task_type: 'pr-comment', created_at: new Date(), initial_job_data: JSON.stringify({
      commandCommentId: 701, commandCommentType: 'issue', commandMode: 'review',
    }) });
  await db('task_history').insert({ task_id: 'concurrent-running-task', state: 'processing', timestamp: new Date(), metadata: '{}' });
  const runningRow = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  const runningReceipt = operations.project(runningRow);
  await trackExecution(deps, runningRow, principal, runningReceipt);
  await syncLifecycle(operations, runningRow, runningReceipt);

  releaseStale();
  await stalePoll;
  assert.equal(staleReceipt.state, 'running');
  assert.equal('lifecycleFailure' in staleReceipt, false);
  assert.equal(((staleReceipt.result as { continuation: { taskId: string } }).continuation).taskId, 'concurrent-running-task');
  await syncLifecycle(operations, staleRow, staleReceipt);

  const durable = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  assert.equal(durable.state, 'running');
  assert.equal(durable.lifecycle, 'running');
  assert.notEqual(durable.started_at, null);
  assert.equal(durable.failure, null);

  await syncLifecycle(operations, staleRow, {
    ...operations.project(staleRow), state: 'unknown', lifecycleFailure: COMMAND_NOT_PICKED_UP_FAILURE,
  });
  const afterStaleLifecycle = (await db<Operation>('mcp_operations').where({ id: receipt.operationId }).first())!;
  assert.equal(afterStaleLifecycle.lifecycle, 'running');
  assert.equal(afterStaleLifecycle.failure, null);
});
