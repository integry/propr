import { up as epicQueueRecovery } from '../src/db/migrations/20261003040000_add_epic_queue_recovery_intent.js';
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up } from '../src/db/migrations/20261003000000_add_epic_execution_queues.js';
import { up as epicQueueFinalization, down as removeEpicQueueFinalization } from '../src/db/migrations/20261003010000_add_epic_queue_finalization.js';
import { up as epicQueueUseEpic, down as removeEpicQueueUseEpic } from '../src/db/migrations/20261003020000_add_epic_queue_use_epic.js';
import { up as epicQueueParallel } from '../src/db/migrations/20261003030000_add_epic_queue_parallel.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const starts: number[] = [];
const startEpicLabels: Array<string | undefined> = [];
let pullRequestState: { state: string; merged: boolean } | null = null;
const finalizations: string[] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/config/planIssueManager.js', { namedExports: {
  PlanIssueStatus: { PENDING: 'pending', PROCESSING: 'processing', UNDER_REVIEW: 'under_review',
    IN_REFINEMENT: 'in_refinement', REFINEMENT_PROCESSING: 'refinement_processing', MERGED: 'merged', CLOSED: 'closed' },
  updatePlanIssue: async (draftId: string, issueNumber: number, updates: { status: string }) => {
    await database('plan_issues').where({ draft_id: draftId, issue_number: issueNumber }).update(updates);
  },
} });
await mock.module('../src/webhook/planIssueTrigger.js', { namedExports: {
  labelPlanIssueForProcessing: async ({ issueNumber, epicLabel }: { issueNumber: number; epicLabel?: string }) => {
    starts.push(issueNumber); startEpicLabels.push(epicLabel);
  },
  reconcileTerminalInProgressIssues: async (_repository: string, issues: unknown[]) => issues,
  finalizeEpicPlanIfComplete: async (draftId: string) => { finalizations.push(draftId); return true; },
} });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({ request: async () => {
  if (!pullRequestState) throw new Error('Unexpected GitHub call');
  return { data: pullRequestState };
} }) } });
const { PlanIssueStatus: S } = await import('../src/config/planIssueManager.js');
const { determinePRStatusUpdate } = await import('../src/webhook/statusMachine.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, summarizeEpicQueue, decideEpicAdvance,
  advanceEpicQueue, startEpicQueueHead, reconcileEpicExecutionQueues, readyEpicExecutionQueue,
  cancelEpicExecutionQueue, onPlanIssueStatusChanged, finalizeCompletedEpicQueue } = await import('../src/services/taskPlanning/epicExecutionQueue.js');
const { markEpicQueueAwaitingHumanMerge } = await import('../src/services/taskPlanning/epicQueueHumanMerge.js');

await database.raw('PRAGMA foreign_keys = ON');
await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
});
await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.integer('issue_number'); table.integer('pr_number'); table.string('status');
});
await up(database);
await epicQueueFinalization(database);
await epicQueueUseEpic(database);
await epicQueueParallel(database);
await epicQueueRecovery(database);
after(async () => database.destroy());
beforeEach(async () => {
  await database('task_drafts').delete();
  await database('plan_issues').delete();
  await database('task_drafts').insert({ draft_id: 'draft', context_config: JSON.stringify({ epicLabel: 'base-epic' }) });
  await database('plan_issues').insert([10, 20, 30, 40].map(issue_number => ({ draft_id: 'draft', issue_number, status: 'pending' })));
  starts.length = 0; startEpicLabels.length = 0; finalizations.length = 0; pullRequestState = null;
});
const input = { draftId: 'draft', repository: 'acme/repo', issues: [10, 30, 40] };
async function status(issueNumber: number, status: string) {
  await database('plan_issues').where({ draft_id: 'draft', issue_number: issueNumber }).update({ status });
}

test('policy treats only core terminal states as advance/wait evidence', () => {
  assert.equal(decideEpicAdvance('merged', S.MERGED), 'advance');
  assert.equal(decideEpicAdvance('merged', S.CLOSED), 'wait');
  assert.equal(decideEpicAdvance('terminal', S.CLOSED), 'advance');
  assert.equal(decideEpicAdvance('terminal', S.UNDER_REVIEW), 'ignore');
  assert.equal(determinePRStatusUpdate('reopened', false, S.CLOSED), null);
  assert.equal(determinePRStatusUpdate('closed', true, S.CLOSED), null);
  assert.equal(determinePRStatusUpdate('opened', false, S.CLOSED), null);
  assert.equal(determinePRStatusUpdate('reopened', false, S.MERGED), null);
});

test('concurrent observers start one head, then exactly the selected successor once', async () => {
  await createEpicExecutionQueue(input);
  await Promise.all([startEpicQueueHead('draft'), startEpicQueueHead('draft')]);
  assert.deepEqual(starts, [10]);
  await status(10, 'merged');
  await Promise.all([advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }),
    onPlanIssueStatusChanged('draft', 10, S.MERGED), startEpicQueueHead('draft')]);
  assert.deepEqual(starts, [10, 30]);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 1);
  await onPlanIssueStatusChanged('draft', 20, S.MERGED);
  assert.deepEqual(starts, [10, 30]);
});

test('closed head blocks merged-only queue, and a later merge unblocks it', async () => {
  await createEpicExecutionQueue(input);
  await status(10, 'closed');
  await onPlanIssueStatusChanged('draft', 10, S.CLOSED);
  const blocked = summarizeEpicQueue(await getEpicExecutionQueue('draft'))!;
  assert.equal(blocked.head, 10);
  assert.match(blocked.blockedReason!, /#10.*closed.*merged/);
  assert.deepEqual(starts, []);
  await status(10, 'under_review');
  await startEpicQueueHead('draft');
  assert.equal((await getEpicExecutionQueue('draft'))?.blockedReason, null);
  await status(10, 'merged');
  await onPlanIssueStatusChanged('draft', 10, S.MERGED);
  assert.deepEqual(starts, [30]);
});

test('terminal policy skips closed and merged entries and finalizes after last entry', async () => {
  await createEpicExecutionQueue({ ...input, advanceOn: 'terminal' });
  await status(10, 'closed'); await status(30, 'merged'); await status(40, 'closed');
  await startEpicQueueHead('draft');
  assert.deepEqual(starts, []);
  assert.deepEqual(summarizeEpicQueue(await getEpicExecutionQueue('draft')), {
    issues: [10, 30, 40], cursor: 3, head: null, status: 'completed', advanceOn: 'terminal', blockedReason: null,
  });
  assert.deepEqual(finalizations, ['draft']);
});

test('paused draft advances its cursor but holds the successor until resume', async () => {
  await createEpicExecutionQueue(input);
  await database('task_drafts').where({ draft_id: 'draft' }).update({ paused: true });
  await status(10, 'merged');
  await onPlanIssueStatusChanged('draft', 10, S.MERGED);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 1);
  assert.deepEqual(starts, []);
  await database('task_drafts').where({ draft_id: 'draft' }).update({ paused: false });
  await startEpicQueueHead('draft');
  assert.deepEqual(starts, [30]);
});

test('reconciliation repairs a lost advance and retries a pending head after fifteen minutes', async () => {
  let time = 1_000_000;
  const deps = { now: () => time };
  await createEpicExecutionQueue(input, deps);
  await status(10, 'merged');
  await reconcileEpicExecutionQueues(deps);
  assert.deepEqual(starts, [30]);
  time += 14 * 60_000;
  await reconcileEpicExecutionQueues(deps);
  assert.deepEqual(starts, [30]);
  time += 60_000;
  await Promise.all([reconcileEpicExecutionQueues(deps), reconcileEpicExecutionQueues(deps)]);
  assert.deepEqual(starts, [30, 30]);
  await status(30, 'processing');
  time += 20 * 60_000;
  await reconcileEpicExecutionQueues(deps);
  assert.deepEqual(starts, [30, 30]);
});

test('initial MCP configuration gates even a merged head until selectors are synchronized', async () => {
  await createEpicExecutionQueue({ ...input, ready: false });
  await status(10, 'merged');
  await onPlanIssueStatusChanged('draft', 10, S.MERGED);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 0);
  await readyEpicExecutionQueue('draft');
  assert.deepEqual(starts, [30]);
});

test('reconciliation recovers interrupted selector setup before dispatching a successor', async () => {
  await createEpicExecutionQueue({ ...input, ready: false }, { now: () => 100 });
  await status(10, 'merged');
  const repairSetup = mock.fn(async () => true);
  await reconcileEpicExecutionQueues({ now: () => 16 * 60_000, repairSetup });
  assert.equal(repairSetup.mock.callCount(), 1);
  assert.deepEqual(starts, [30]);
});

test('active queue cannot be replaced, cancelled/completed queue can, and draft deletion cascades', async () => {
  await createEpicExecutionQueue(input);
  await assert.rejects(createEpicExecutionQueue(input), /active epic execution queue/);
  await cancelEpicExecutionQueue('draft');
  await startEpicQueueHead('draft');
  assert.deepEqual(starts, []);
  await createEpicExecutionQueue({ ...input, issues: [40] });
  assert.deepEqual((await getEpicExecutionQueue('draft'))?.issues, [40]);
  await status(40, 'merged');
  await startEpicQueueHead('draft');
  await createEpicExecutionQueue(input);
  await database('task_drafts').where({ draft_id: 'draft' }).delete();
  assert.equal(await getEpicExecutionQueue('draft'), null);
});

test('queue and claims are rolled back together if the caller transaction fails', async () => {
  await assert.rejects(database.transaction(async tx => {
    await createEpicExecutionQueue(input, { database: tx });
    throw new Error('claim conflict');
  }), /claim conflict/);
  assert.equal(await getEpicExecutionQueue('draft'), null);
});

test('failed label dispatch retains claim until recovery and status wrapper never throws', async () => {
  await createEpicExecutionQueue(input);
  await assert.rejects(startEpicQueueHead('draft', { startIssue: async () => { throw new Error('GitHub unavailable'); } }), /GitHub unavailable/);
  const claimedAt = (await getEpicExecutionQueue('draft'))?.headStartedAt;
  assert.ok(claimedAt);
  assert.match((await getEpicExecutionQueue('draft'))?.blockedReason ?? '', /GitHub unavailable/);
  await startEpicQueueHead('draft');
  assert.deepEqual(starts, []);
  await startEpicQueueHead('draft', { now: () => claimedAt + 15 * 60_000 });
  assert.deepEqual(starts, [10]);
  await onPlanIssueStatusChanged('no-queue', 1, S.MERGED);
  assert.equal(summarizeEpicQueue(null), null);
});

test('reconciliation preserves a manual issue close even when its PR is open or merged', async () => {
  await createEpicExecutionQueue(input);
  await database('plan_issues').where({ draft_id: 'draft', issue_number: 10 }).update({ status: 'closed', pr_number: 100 });
  await onPlanIssueStatusChanged('draft', 10, S.CLOSED);
  pullRequestState = { state: 'open', merged: false };
  await reconcileEpicExecutionQueues();
  assert.equal((await database('plan_issues').where({ issue_number: 10 }).first()).status, 'closed');
  assert.match((await getEpicExecutionQueue('draft'))?.blockedReason ?? '', /closed/);
  assert.deepEqual(starts, []);
  await status(10, 'closed');
  pullRequestState = { state: 'closed', merged: true };
  await reconcileEpicExecutionQueues();
  assert.equal((await database('plan_issues').where({ issue_number: 10 }).first()).status, 'closed');
  assert.deepEqual(starts, []);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 0);
});

test('stale observer cannot advance a replacement execution with the same cursor', async () => {
  await createEpicExecutionQueue({ ...input, issues: [10] });
  await status(10, 'merged');
  let observed!: () => void;
  let release!: () => void;
  const observedHead = new Promise<void>(resolve => { observed = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const delayedDatabase = new Proxy(database, { apply(target, thisArg, args) {
    const builder = Reflect.apply(target, thisArg, args);
    if (args[0] === 'plan_issues') {
      const first = builder.first.bind(builder);
      builder.first = async (...columns: string[]) => {
        const row = await first(...columns);
        observed();
        await barrier;
        return row;
      };
    }
    return builder;
  } });
  const stale = advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, { database: delayedDatabase });
  await observedHead;
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED });
  await createEpicExecutionQueue({ ...input, issues: [40] });
  release();
  await stale;
  assert.deepEqual(starts, []);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 0);
  assert.equal((await getEpicExecutionQueue('draft'))?.status, 'active');
});


test('successful finalization is durable and finished queues do not occupy the recovery batch', async () => {
  await createEpicExecutionQueue({ ...input, issues: [10] });
  await status(10, 'merged');
  await startEpicQueueHead('draft');
  assert.ok((await getEpicExecutionQueue('draft'))?.finalizedAt);
  assert.deepEqual(await reconcileEpicExecutionQueues(), { reconciled: 0 });
  assert.deepEqual(await reconcileEpicExecutionQueues(), { reconciled: 0 });
  assert.deepEqual(finalizations, ['draft']);
  // More than a full batch of finalized history must not delay an active queue.
  const finished = await database('epic_execution_queues').where({ draft_id: 'draft' }).first();
  for (let i = 0; i < 101; i++) {
    const draftId = `finished-${i}`;
    await database('task_drafts').insert({ draft_id: draftId });
    await database('epic_execution_queues').insert({ ...finished, draft_id: draftId, updated_at: 0 });
  }
  await createEpicExecutionQueue(input);
  assert.equal((await getEpicExecutionQueue('draft'))?.finalizedAt, null);
  assert.deepEqual(await reconcileEpicExecutionQueues(), { reconciled: 1 });
  assert.deepEqual(starts, [30]);
});

test('failed and deferred finalizations remain owed until reconciliation succeeds', async () => {
  await createEpicExecutionQueue({ ...input, issues: [10] });
  await status(10, 'merged');
  await assert.rejects(startEpicQueueHead('draft', { finalize: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal((await getEpicExecutionQueue('draft'))?.status, 'completed');
  assert.equal((await getEpicExecutionQueue('draft'))?.finalizedAt, null);
  await reconcileEpicExecutionQueues({ finalize: async () => false });
  assert.equal((await getEpicExecutionQueue('draft'))?.finalizedAt, null);
  await reconcileEpicExecutionQueues();
  assert.ok((await getEpicExecutionQueue('draft'))?.finalizedAt);
  assert.deepEqual(await reconcileEpicExecutionQueues(), { reconciled: 0 });
});

test('concurrent recovery claims one finalization and a lost claim expires', async () => {
  await createEpicExecutionQueue({ ...input, issues: [10] });
  await database('epic_execution_queues').where({ draft_id: 'draft' }).update({ status: 'completed', cursor: 1 });
  await Promise.all([reconcileEpicExecutionQueues(), reconcileEpicExecutionQueues()]);
  assert.deepEqual(finalizations, ['draft']);
  await database('epic_execution_queues').where({ draft_id: 'draft' }).update({ finalized_at: null, finalization_started_at: 100 });
  await reconcileEpicExecutionQueues({ now: () => 100 + 14 * 60_000 });
  assert.deepEqual(finalizations, ['draft']);
  await reconcileEpicExecutionQueues({ now: () => 100 + 15 * 60_000 });
  assert.deepEqual(finalizations, ['draft', 'draft']);
});

test('a finalizer cannot label or finalize a replacement execution after an awaited boundary', async () => {
  await createEpicExecutionQueue({ ...input, issues: [10] });
  await database('epic_execution_queues').where({ draft_id: 'draft' }).update({ status: 'completed', cursor: 1 });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const pending = finalizeCompletedEpicQueue('draft', { finalize: async (_id, guard) => {
    entered();
    await barrier;
    assert.equal(await guard(), false);
    return true;
  } });
  await started;
  await createEpicExecutionQueue({ ...input, issues: [40] });
  release();
  await pending;
  const replacement = await getEpicExecutionQueue('draft');
  assert.equal(replacement?.status, 'active');
  assert.equal(replacement?.finalizedAt, null);
  assert.equal(replacement?.finalizationStartedAt, null);
});


test('finalization migration preserves existing queues and rolls back without deleting them', async () => {
  const oldDatabase = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await oldDatabase.schema.createTable('task_drafts', table => { table.string('draft_id').primary(); });
    await up(oldDatabase);
    await oldDatabase('task_drafts').insert({ draft_id: 'old' });
    await oldDatabase('epic_execution_queues').insert({ draft_id: 'old', execution_id: 'execution',
      repository: 'acme/repo', issues: '[10]', cursor: 1, status: 'completed', created_at: 100, updated_at: 100 });
    await epicQueueFinalization(oldDatabase);
    const upgraded = await getEpicExecutionQueue('old', { database: oldDatabase });
    assert.equal(upgraded?.status, 'completed');
    assert.equal(upgraded?.finalizedAt, null);
    assert.equal(upgraded?.finalizationStartedAt, null);
    await removeEpicQueueFinalization(oldDatabase);
    const original = await oldDatabase('epic_execution_queues').where({ draft_id: 'old' }).first();
    assert.equal(original.status, 'completed');
    assert.equal(Object.hasOwn(original, 'finalized_at'), false);
  } finally {
    await oldDatabase.destroy();
  }
});

test('non-epic auto-merge queues advance past a failed head without the plan epic label', async () => {
  await createEpicExecutionQueue({ ...input, advanceOn: 'terminal', autoMerge: true, useEpic: false });
  assert.equal((await getEpicExecutionQueue('draft'))?.useEpic, false);
  await startEpicQueueHead('draft');
  await status(10, S.CLOSED);
  await onPlanIssueStatusChanged('draft', 10, S.CLOSED);
  assert.deepEqual(starts, [10, 30]);
  assert.deepEqual(startEpicLabels, [undefined, undefined]);
  assert.equal((await getEpicExecutionQueue('draft'))?.blockedReason, null);
});

test('use_epic migration keeps existing queues on the epic branch and rolls back', async () => {
  const oldDatabase = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await oldDatabase.schema.createTable('task_drafts', table => { table.string('draft_id').primary(); });
    await up(oldDatabase);
    await epicQueueFinalization(oldDatabase);
    await oldDatabase('task_drafts').insert({ draft_id: 'old' });
    await oldDatabase('epic_execution_queues').insert({ draft_id: 'old', execution_id: 'execution',
      repository: 'acme/repo', issues: '[10]', cursor: 0, status: 'active', created_at: 100, updated_at: 100 });
    await epicQueueUseEpic(oldDatabase);
    assert.equal((await getEpicExecutionQueue('old', { database: oldDatabase }))?.useEpic, true);
    await removeEpicQueueUseEpic(oldDatabase);
    assert.equal(Object.hasOwn(await oldDatabase('epic_execution_queues').where({ draft_id: 'old' }).first(), 'use_epic'), false);
  } finally {
    await oldDatabase.destroy();
  }
});

test('a full failed recovery batch rotates so the healthy queue beyond it can run', async () => {
  for (let index = 0; index < 100; index++) {
    const draftId = `failed-${String(index).padStart(3, '0')}`;
    await database('task_drafts').insert({ draft_id: draftId });
    await createEpicExecutionQueue({ ...input, draftId, ready: false }, { now: () => 0 });
  }
  await createEpicExecutionQueue(input, { now: () => 1 });
  const repairSetup = mock.fn(async () => { throw new Error('Repository inaccessible'); });
  assert.deepEqual(await reconcileEpicExecutionQueues({ now: () => 16 * 60_000, repairSetup }), { reconciled: 0 });
  assert.equal(repairSetup.mock.callCount(), 100);
  assert.deepEqual(starts, []);
  await reconcileEpicExecutionQueues({ now: () => 17 * 60_000, repairSetup });
  assert.deepEqual(starts, [10]);
});

test('failed recovery cannot rotate or cancel a replacement execution', async () => {
  const original = await createEpicExecutionQueue({ ...input, ready: false }, { now: () => 0 });
  let replacementId = '';
  await reconcileEpicExecutionQueues({ now: () => 16 * 60_000, repairSetup: async () => {
    await cancelEpicExecutionQueue('draft', original.executionId);
    const replacement = await createEpicExecutionQueue(input, { now: () => 42 });
    replacementId = replacement.executionId;
    throw new Error('Original setup failed');
  } });
  await cancelEpicExecutionQueue('draft', original.executionId);
  const replacement = await getEpicExecutionQueue('draft');
  assert.equal(replacement?.executionId, replacementId);
  assert.equal(replacement?.status, 'active');
  assert.equal((await database('epic_execution_queues').where({ draft_id: 'draft' }).first()).updated_at, 42);
});

test('a skipped auto-merge arm leaves the queue waiting for a human merge, then resumes', async () => {
  await createEpicExecutionQueue(input);
  await startEpicQueueHead('draft');
  assert.deepEqual(starts, [10]);
  await status(10, S.UNDER_REVIEW);
  // Only the current head can be marked.
  assert.equal(await markEpicQueueAwaitingHumanMerge({ draftId: 'draft', issueNumber: 30, prNumber: 130, reason: 'skipped_protected_path' }, { database }), false);
  assert.equal(await markEpicQueueAwaitingHumanMerge({ draftId: 'draft', issueNumber: 10, prNumber: 110, reason: 'skipped_protected_path' }, { database }), true);
  // Recovery neither fails the queue nor clears the explanation nor starts a successor.
  await reconcileEpicExecutionQueues();
  await startEpicQueueHead('draft');
  let queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.status, 'active');
  assert.equal(queue?.cursor, 0);
  assert.match(queue?.blockedReason ?? '', /^Waiting for human merge: auto-merge was not armed for PR #110 \(issue #10, skipped_protected_path\)/);
  assert.deepEqual(starts, [10]);
  // A person merges the PR: the queue advances and clears the explanation.
  await status(10, S.MERGED);
  await onPlanIssueStatusChanged('draft', 10, S.MERGED);
  queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.cursor, 1);
  assert.equal(queue?.blockedReason, null);
  assert.deepEqual(starts, [10, 30]);
});
