import { up as blockedEvents } from '../src/db/migrations/20261113000000_add_epic_queue_blocked_events.js';
import { up as epicQueueIssueStates } from '../src/db/migrations/20261112130000_add_epic_queue_issue_states.js';
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up } from '../src/db/migrations/20261003000000_add_epic_execution_queues.js';
import { up as epicQueueFinalization } from '../src/db/migrations/20261003010000_add_epic_queue_finalization.js';
import { up as epicQueueUseEpic } from '../src/db/migrations/20261003020000_add_epic_queue_use_epic.js';
import { up as epicQueueParallel } from '../src/db/migrations/20261003030000_add_epic_queue_parallel.js';
import { up as epicQueueRecovery } from '../src/db/migrations/20261003040000_add_epic_queue_recovery_intent.js';

/**
 * A queued issue whose run stopped on a reported blocker (`on_blocker: report`)
 * holds its epic: the queue explains why, never advances past it or restarts it
 * on its own, and continues once a later run for the issue settles normally.
 * The stale-run reconcile (the real one) must not close the blocked issue.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const starts: number[] = [];
const finalizations: string[] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
const startIssue = async ({ issueNumber }: { issueNumber: number }) => { starts.push(issueNumber); };
const deps = { startIssue, finalize: async (draftId: string) => { finalizations.push(draftId); return true; } };
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/daemon/configLoader.js', { namedExports: { getPrimaryProcessingLabels: () => ['AI'] } });
await mock.module('../src/services/taskPlanning/epicIssueLabelHandoff.js', { namedExports: { releaseEpicIssueLabels: async () => {} } });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => {
  throw new Error('Unexpected GitHub call');
} } });
await mock.module('../src/config/planIssueManager.js', { namedExports: {
  PlanIssueStatus: { PENDING: 'pending', PROCESSING: 'processing', UNDER_REVIEW: 'under_review',
    IN_REFINEMENT: 'in_refinement', REFINEMENT_PROCESSING: 'refinement_processing', MERGED: 'merged', CLOSED: 'closed' },
  getPlanIssuesByDraft: async () => [],
  // The real writer notifies the plan's queue after persisting the status.
  updatePlanIssueStatus: async (repository: string, issueNumber: number, status: string) => {
    await database('plan_issues').where({ repository, issue_number: issueNumber }).update({ status });
    const { advanceEpicQueue } = await import('../src/services/taskPlanning/epicExecutionQueue.js');
    await advanceEpicQueue({ draftId: 'draft', issueNumber, status: status as never }, deps);
    return true;
  },
} });
const { PlanIssueStatus: S } = await import('../src/config/planIssueManager.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, summarizeEpicQueue, advanceEpicQueue, startEpicQueueHead,
  reconcileEpicExecutionQueues } = await import('../src/services/taskPlanning/epicExecutionQueue.js');
const { markEpicQueueHeadBlocked, clearEpicQueueHeadBlocked, agentBlockedHeadReason, isAgentBlockedReason } =
  await import('../src/services/taskPlanning/epicQueueBlockedHead.js');
const { markEpicQueueAwaitingHumanMerge, isAwaitingHumanMergeReason } = await import('../src/services/taskPlanning/epicQueueHumanMerge.js');
const { updatePlanIssueStatus } = await import('../src/config/planIssueManager.js');

await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
});
await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.string('repository'); table.integer('issue_number');
  table.integer('pr_number'); table.string('status'); table.string('task_id');
});
await database.schema.createTable('task_history', table => {
  table.increments('history_id'); table.string('task_id'); table.string('state'); table.bigInteger('timestamp'); table.text('metadata');
});
await up(database);
await epicQueueFinalization(database);
await epicQueueUseEpic(database);
await epicQueueParallel(database);
await epicQueueRecovery(database);
await epicQueueIssueStates(database);
await blockedEvents(database);
after(async () => database.destroy());

const repository = 'acme/repo';
const LATER = Date.now() + 24 * 60 * 60 * 1000;
beforeEach(async () => {
  await database('epic_execution_queues').delete();
  await database('task_drafts').delete();
  await database('plan_issues').delete();
  await database('task_history').delete();
  await database('task_drafts').insert({ draft_id: 'draft', context_config: JSON.stringify({ epicLabel: 'base-epic' }) });
  await database('plan_issues').insert([10, 30].map(issue_number => ({ draft_id: 'draft', repository, issue_number, status: 'pending' })));
  starts.length = 0; finalizations.length = 0;
});

async function planStatus(issueNumber: number): Promise<string> {
  return (await database('plan_issues').where({ issue_number: issueNumber }).first('status')).status;
}

/** The head was dispatched, picked up and its run finished with the given terminal history. */
async function finishHeadRun(issueNumber: number, metadata: Record<string, unknown>): Promise<void> {
  await database('plan_issues').where({ issue_number: issueNumber }).update({ status: S.PROCESSING, task_id: `task-${issueNumber}` });
  await database('task_history').insert({ task_id: `task-${issueNumber}`, state: 'completed', timestamp: 1, metadata: JSON.stringify(metadata) });
}
const BLOCKED_HISTORY = { terminalReason: 'blocked', pr: null, prResult: { status: 'blocked', terminalReason: 'blocked', prCreated: false } };
const NO_PR_HISTORY = { pr: null, prResult: { status: 'claude_success_no_changes', prCreated: false } };

for (const advanceOn of ['merged', 'terminal'] as const) {
  test(`a blocked head holds a ${advanceOn}-policy queue through reconcile passes`, async () => {
    await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30], advanceOn });
    await startEpicQueueHead('draft', deps);
    assert.deepEqual(starts, [10]);
    await finishHeadRun(10, BLOCKED_HISTORY);

    assert.equal(await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }), true);
    const reason = 'Issue #10 stopped on a blocker reported by the agent; resolve the blocker and request processing again to continue this epic.';
    assert.equal(summarizeEpicQueue(await getEpicExecutionQueue('draft'))?.blockedReason, reason);

    // Recovery runs long after the dispatch claim expired: nothing restarts, closes or advances.
    await reconcileEpicExecutionQueues({ ...deps, now: () => LATER });
    await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.PROCESSING }, deps);
    const queue = await getEpicExecutionQueue('draft');
    assert.deepEqual(starts, [10], 'the blocked head is not re-dispatched');
    assert.equal(await planStatus(10), S.PROCESSING, 'the plan issue is neither closed nor merged');
    assert.equal(queue?.cursor, 0);
    assert.equal(queue?.status, 'active');
    assert.equal(queue?.blockedReason, reason);
  });
}

test('a pending blocked head is not re-dispatched once the dispatch claim expires', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30] });
  await startEpicQueueHead('draft', deps);
  await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 });
  // The labeled webhook that moves the plan issue to processing was lost.
  await startEpicQueueHead('draft', { ...deps, now: () => LATER });
  await reconcileEpicExecutionQueues({ ...deps, now: () => LATER });
  assert.deepEqual(starts, [10]);
  assert.ok(isAgentBlockedReason((await getEpicExecutionQueue('draft'))?.blockedReason));
});

test('the stale-run reconcile still closes an ordinary finished run without a PR', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30], advanceOn: 'terminal' });
  await startEpicQueueHead('draft', deps);
  await finishHeadRun(10, NO_PR_HISTORY);
  await reconcileEpicExecutionQueues({ ...deps, now: () => LATER });
  assert.equal(await planStatus(10), S.CLOSED);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 1);
  assert.deepEqual(starts.slice(0, 2), [10, 30]);
});

test('a later run that settles normally clears the reason and the queue advances on merge', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30] });
  await startEpicQueueHead('draft', deps);
  await finishHeadRun(10, BLOCKED_HISTORY);
  await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 });

  assert.equal(await clearEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }), true);
  assert.equal((await getEpicExecutionQueue('draft'))?.blockedReason, null);
  // The PR of the new run merges (or its no-change completion marks the issue merged).
  await updatePlanIssueStatus(repository, 10, S.MERGED);
  const queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.cursor, 1);
  assert.equal(queue?.blockedReason, null);
  assert.deepEqual(starts, [10, 30]);
});

test('a no-change completion of the blocked head advances even before the reason is cleared', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30] });
  await startEpicQueueHead('draft', deps);
  await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 });
  await updatePlanIssueStatus(repository, 10, S.MERGED);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 1);
  assert.equal((await getEpicExecutionQueue('draft'))?.blockedReason, null);
  assert.deepEqual(starts, [10, 30]);
});

test('clearing leaves other reasons in place, and stale executions or cursors are never written', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30] });
  await markEpicQueueAwaitingHumanMerge({ draftId: 'draft', issueNumber: 10, prNumber: 7, reason: 'checks pending' });
  assert.equal(await clearEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }), false);
  assert.ok(isAwaitingHumanMergeReason((await getEpicExecutionQueue('draft'))?.blockedReason));
  assert.equal(await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 30 }), false, 'not the head');
  await database('epic_execution_queues').update({ status: 'cancelled' });
  assert.equal(await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }), false, 'not active');
});

test('a blocked parallel child keeps the execution active with the same reason', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30], parallel: true });
  await finishHeadRun(10, BLOCKED_HISTORY);
  await database('plan_issues').where({ issue_number: 30 }).update({ status: S.MERGED });
  assert.equal(await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }), true);
  await reconcileEpicExecutionQueues({ ...deps, now: () => LATER });
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 30, status: S.MERGED }, deps);
  let queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.status, 'active', 'a blocked child is not terminal');
  assert.equal(queue?.blockedReason, agentBlockedHeadReason(10));
  assert.equal(await planStatus(10), S.PROCESSING);
  assert.deepEqual(finalizations, []);

  await updatePlanIssueStatus(repository, 10, S.MERGED);
  queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.status, 'completed');
  assert.equal(queue?.blockedReason, null);
  assert.deepEqual(finalizations, ['draft']);
});

test('clearing one parallel child keeps the blocker of another child that is still blocked', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30], parallel: true });
  await finishHeadRun(10, BLOCKED_HISTORY);
  assert.equal(await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }), true);
  await finishHeadRun(30, BLOCKED_HISTORY);
  assert.equal(await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 30 }), true);
  assert.equal((await getEpicExecutionQueue('draft'))?.blockedReason, agentBlockedHeadReason(30));

  // #30 is processed again and opens a PR; its normal completion clears its own blocker.
  await database('plan_issues').where({ issue_number: 30 }).update({ status: S.UNDER_REVIEW, pr_number: 31, task_id: 'task-30b' });
  await database('task_history').insert({ task_id: 'task-30b', state: 'completed', timestamp: 2,
    metadata: JSON.stringify({ pr: 31, prResult: { status: 'success', prCreated: true, prNumber: 31 } }) });
  assert.equal(await clearEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 30 }), true);
  let queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.status, 'active');
  assert.equal(queue?.blockedReason, agentBlockedHeadReason(10), 'the other blocked child still explains the epic');

  // Once #10 also settles normally, nothing blocks the execution any more.
  await database('task_history').insert({ task_id: 'task-10', state: 'processing', timestamp: 3, metadata: null });
  assert.equal(await clearEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }), true);
  queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.blockedReason, null);
});

test('clearing a parallel child ignores siblings that are merged or whose latest run was not blocked', async () => {
  await database('plan_issues').insert({ draft_id: 'draft', repository, issue_number: 50, status: 'pending' });
  await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30, 50], parallel: true });
  await finishHeadRun(10, BLOCKED_HISTORY);
  await database('plan_issues').where({ issue_number: 10 }).update({ status: S.MERGED });
  await finishHeadRun(30, NO_PR_HISTORY);
  await finishHeadRun(50, BLOCKED_HISTORY);
  await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 50 });
  assert.equal(await clearEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 50 }), true);
  assert.equal((await getEpicExecutionQueue('draft'))?.blockedReason, null);
});

function issueState(queue: Awaited<ReturnType<typeof getEpicExecutionQueue>>, issueNumber: number) {
  return summarizeEpicQueue(queue)?.issueStates.find(state => state.issue === issueNumber);
}

for (const restart of ['status hook', 'lost status hook'] as const) {
  test(`a closed parallel child that restarts and reports a blocker is tracked again (${restart})`, async () => {
    await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30], parallel: true });
    await finishHeadRun(30, NO_PR_HISTORY);
    await database('plan_issues').where({ issue_number: 30 }).update({ pr_number: 31, status: S.UNDER_REVIEW });
    await updatePlanIssueStatus(repository, 10, S.CLOSED);
    assert.equal(issueState(await getEpicExecutionQueue('draft'), 10)?.state, 'done');

    // #10 is reopened and processed again while #30 still runs.
    if (restart === 'status hook') await updatePlanIssueStatus(repository, 10, S.PROCESSING);
    else await database('plan_issues').where({ issue_number: 10 }).update({ status: S.PROCESSING });
    await database('plan_issues').where({ issue_number: 10 }).update({ task_id: 'task-10b' });
    await database('task_history').insert({ task_id: 'task-10b', state: 'completed', timestamp: 2, metadata: JSON.stringify(BLOCKED_HISTORY) });
    assert.equal(await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }), true);
    let queue = await getEpicExecutionQueue('draft');
    assert.deepEqual(issueState(queue, 10), { issue: 10, state: 'blocked', blockedKind: 'agent_blocked', blockedReason: agentBlockedHeadReason(10),
      schedule: 'blocked', dependsOn: [], waitingOn: [] });
    assert.equal(queue?.blockedReason, agentBlockedHeadReason(10));

    // Recovery and the sibling's merge keep the blocked child and the execution active.
    await reconcileEpicExecutionQueues({ ...deps, now: () => LATER });
    await updatePlanIssueStatus(repository, 30, S.MERGED);
    queue = await getEpicExecutionQueue('draft');
    assert.equal(queue?.status, 'active');
    assert.equal(issueState(queue, 10)?.state, 'blocked');
    assert.equal(await planStatus(10), S.PROCESSING, 'the blocked run is not closed by recovery');
    assert.deepEqual(finalizations, []);

    // A later run settles normally and merges: the execution completes.
    assert.equal(await clearEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }), true);
    await updatePlanIssueStatus(repository, 10, S.MERGED);
    queue = await getEpicExecutionQueue('draft');
    assert.equal(queue?.status, 'completed');
    assert.deepEqual(finalizations, ['draft']);
  });
}

test('recovery reconciles a reopened parallel child even while its row is still done', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30], parallel: true });
  await finishHeadRun(30, BLOCKED_HISTORY);
  await updatePlanIssueStatus(repository, 10, S.CLOSED);
  // #10 is processed again (its status hook was lost) and finishes without a PR.
  await database('plan_issues').where({ issue_number: 10 }).update({ status: S.PROCESSING, task_id: 'task-10b' });
  await database('task_history').insert({ task_id: 'task-10b', state: 'completed', timestamp: 2, metadata: JSON.stringify(NO_PR_HISTORY) });
  await reconcileEpicExecutionQueues({ ...deps, now: () => LATER });
  assert.equal(await planStatus(10), S.CLOSED, 'the stale in-progress run of the done child is reconciled');
  assert.equal(issueState(await getEpicExecutionQueue('draft'), 10)?.state, 'done');
});

test('a late blocker report for a parallel child that is still terminal does not reopen it', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository, issues: [10, 30], parallel: true });
  await finishHeadRun(30, BLOCKED_HISTORY);
  await updatePlanIssueStatus(repository, 10, S.MERGED);
  assert.equal(await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }), false);
  assert.equal(await clearEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }), false);
  const queue = await getEpicExecutionQueue('draft');
  assert.equal(issueState(queue, 10)?.state, 'done');
  assert.equal(queue?.blockedReason, null);
});
