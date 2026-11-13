/* eslint-disable max-lines -- blocked events, skip and retry share one queue fixture */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up } from '../src/db/migrations/20261003000000_add_epic_execution_queues.js';
import { up as finalization } from '../src/db/migrations/20261003010000_add_epic_queue_finalization.js';
import { up as useEpic } from '../src/db/migrations/20261003020000_add_epic_queue_use_epic.js';
import { up as parallel } from '../src/db/migrations/20261003030000_add_epic_queue_parallel.js';
import { up as recovery } from '../src/db/migrations/20261003040000_add_epic_queue_recovery_intent.js';
import { up as issueStates } from '../src/db/migrations/20261112130000_add_epic_queue_issue_states.js';
import { up as graph } from '../src/db/migrations/20261112140000_add_epic_queue_graph.js';
import { up as blockedEvents } from '../src/db/migrations/20261113000000_add_epic_queue_blocked_events.js';

/**
 * Blocked transitions are recorded once per blocked state, whichever writer observes them,
 * and a person can move an execution past a pending or blocked issue (skip) or dispatch a
 * blocked one again (retry), guarded like every other queue write.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const starts: number[] = [];
const reopened: number[] = [];
const delivered: number[] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
let startHook: ((issueNumber: number) => Promise<void>) | undefined;
const startIssue = async ({ issueNumber }: { issueNumber: number }) => {
  starts.push(issueNumber);
  await startHook?.(issueNumber);
};
let clock = 1_000_000;
const deps = { startIssue, now: () => clock, finalize: async () => true,
  reopenIssue: async (_repository: string, issueNumber: number) => { reopened.push(issueNumber); } };
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/services/taskPlanning/epicIssueLabelHandoff.js', { namedExports: { releaseEpicIssueLabels: async () => {} } });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => {
  throw new Error('Unexpected GitHub call');
} } });
await mock.module('../src/config/planIssueManager.js', { namedExports: {
  PlanIssueStatus: { PENDING: 'pending', PROCESSING: 'processing', UNDER_REVIEW: 'under_review',
    IN_REFINEMENT: 'in_refinement', REFINEMENT_PROCESSING: 'refinement_processing', MERGED: 'merged', CLOSED: 'closed' },
} });
await mock.module('../src/webhook/planIssueTrigger.js', { namedExports: {
  labelPlanIssueForProcessing: startIssue,
  reconcileTerminalInProgressIssues: async (_repository: string, issues: unknown[]) => issues,
  finalizeEpicPlanIfComplete: async () => true,
} });
const { createEpicExecutionQueue, getEpicExecutionQueue, summarizeEpicQueue, advanceEpicQueue, startEpicQueueHead, blockQueueIssue,
  reconcileEpicExecutionQueues, listEpicQueueBlockedEvents, setEpicQueueBlockedEventDelivery,
} = await import('../src/services/taskPlanning/epicExecutionQueue.js');
const { markEpicQueueHeadBlocked, clearEpicQueueHeadBlocked } = await import('../src/services/taskPlanning/epicQueueBlockedHead.js');
const { markEpicQueueAwaitingHumanMerge } = await import('../src/services/taskPlanning/epicQueueHumanMerge.js');
const { skipEpicQueueIssue, retryEpicQueueIssue, EpicQueueActionError } = await import('../src/services/taskPlanning/epicQueueActions.js');

await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
});
await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.integer('issue_number'); table.integer('pr_number'); table.string('status');
  table.string('task_id');
});
for (const migrate of [up, finalization, useEpic, parallel, recovery, issueStates, graph, blockedEvents]) await migrate(database);
// Delivery is covered by epicQueueBlockedNotify.test.ts; here it is recorded and marked delivered.
setEpicQueueBlockedEventDelivery(async ids => {
  delivered.push(...ids);
  await database('epic_queue_blocked_events').whereIn('id', ids).update({ notified_at: clock });
});
after(async () => { setEpicQueueBlockedEventDelivery(null); await database.destroy(); });

beforeEach(async () => {
  for (const table of ['epic_queue_blocked_events', 'epic_execution_queue_issues', 'epic_execution_queues', 'plan_issues', 'task_drafts']) {
    await database(table).delete();
  }
  await database('task_drafts').insert([{ draft_id: 'draft', context_config: JSON.stringify({ epicLabel: 'base-epic' }) }, { draft_id: 'manual' }]);
  await database('plan_issues').insert([1, 2, 3, 4].map(issue_number => ({ draft_id: 'draft', issue_number, status: 'pending' })));
  starts.length = 0; reopened.length = 0; delivered.length = 0; startHook = undefined; clock = 1_000_000;
});

const draftId = 'draft';
const setStatus = (issueNumber: number, status: string) =>
  database('plan_issues').where({ draft_id: draftId, issue_number: issueNumber }).update({ status });
const finish = async (issueNumber: number, status: 'merged' | 'closed' = 'merged') => {
  await setStatus(issueNumber, status);
  await advanceEpicQueue({ draftId, issueNumber, status: status as never }, deps);
};
const chain = (issues = [1, 2, 3]) => createEpicExecutionQueue({ draftId, repository: 'acme/repo', issues }, deps);
const events = async () => (await listEpicQueueBlockedEvents(draftId)).events
  .map(event => [event.issueNumber, event.type, event.blockedKind, event.resolution]);
const issueState = async (issueNumber: number) => summarizeEpicQueue(await getEpicExecutionQueue(draftId))!.issueStates
  .find(state => state.issue === issueNumber);
async function refused(action: Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof EpicQueueActionError && error.code === code);
}

test('repeated sweeps and status notifications record one event per blocked transition', async () => {
  await chain();
  await startEpicQueueHead(draftId, deps);
  await finish(1, 'closed');
  const blockedAt = (await getEpicExecutionQueue(draftId))!.items[0].blockedAt;
  for (let sweep = 0; sweep < 3; sweep++) {
    clock += 60_000;
    await advanceEpicQueue({ draftId, issueNumber: 1, status: 'closed' as never }, deps);
    await startEpicQueueHead(draftId, deps);
    await reconcileEpicExecutionQueues(deps);
  }
  assert.deepEqual(await events(), [[1, 'blocked', 'closed_unmerged', null]]);
  assert.equal((await getEpicExecutionQueue(draftId))!.items[0].blockedAt, blockedAt, 'an unchanged blocker keeps its time');
  const [event] = (await listEpicQueueBlockedEvents(draftId)).events;
  assert.equal(event.executionId, (await getEpicExecutionQueue(draftId))!.executionId);
  assert.match(event.reason, /Issue #1 is closed/);
  assert.deepEqual(delivered, [event.id], 'delivered once after commit');
});

test('a different blocker records a new event, replacing the old one, and clearing records its resolution', async () => {
  await chain();
  await startEpicQueueHead(draftId, deps);
  await finish(1, 'closed');
  // Reopened and running again: the closure explanation is cleared.
  await setStatus(1, 'processing');
  await startEpicQueueHead(draftId, deps);
  assert.equal((await issueState(1))?.state, 'dispatched');
  await markEpicQueueHeadBlocked({ draftId, issueNumber: 1 });
  await markEpicQueueHeadBlocked({ draftId, issueNumber: 1 });
  await markEpicQueueAwaitingHumanMerge({ draftId, issueNumber: 1, prNumber: 7, reason: 'checks pending' });
  await markEpicQueueAwaitingHumanMerge({ draftId, issueNumber: 1, prNumber: 7, reason: 'checks pending' });
  await finish(1);
  assert.deepEqual(await events(), [
    [1, 'blocked', 'closed_unmerged', null], [1, 'resolved', 'closed_unmerged', 'cleared'],
    [1, 'blocked', 'agent_blocked', null], [1, 'resolved', 'agent_blocked', 'replaced'],
    [1, 'blocked', 'awaiting_human_merge', null], [1, 'resolved', 'awaiting_human_merge', 'settled'],
  ]);
  const listed = (await listEpicQueueBlockedEvents(draftId)).events;
  assert.equal(listed[1].blockedEventId, listed[0].id);
  // A blocker cleared by a later normal run is resolved too.
  await setStatus(2, 'processing');
  await markEpicQueueHeadBlocked({ draftId, issueNumber: 2 });
  await clearEpicQueueHeadBlocked({ draftId, issueNumber: 2 });
  assert.deepEqual((await events()).slice(-2), [[2, 'blocked', 'agent_blocked', null], [2, 'resolved', 'agent_blocked', 'cleared']]);
});

test('blocked events are listed with a cursor, per execution', async () => {
  await chain();
  await startEpicQueueHead(draftId, deps);
  await markEpicQueueHeadBlocked({ draftId, issueNumber: 1 });
  await clearEpicQueueHeadBlocked({ draftId, issueNumber: 1 });
  await markEpicQueueHeadBlocked({ draftId, issueNumber: 1 });
  const first = await listEpicQueueBlockedEvents(draftId, { limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(first.hasMore, true);
  const second = await listEpicQueueBlockedEvents(draftId, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.events.map(event => event.type), ['blocked']);
  assert.equal(second.hasMore, false);
  const caughtUp = await listEpicQueueBlockedEvents(draftId, { cursor: second.nextCursor });
  assert.deepEqual(caughtUp.events, []);
  assert.equal(caughtUp.nextCursor, second.nextCursor, 'an empty page keeps the cursor');
  assert.deepEqual((await listEpicQueueBlockedEvents(draftId, { executionId: 'other' })).events, []);
  await assert.rejects(listEpicQueueBlockedEvents(draftId, { cursor: 'nope' }), /cursor/);
});

test('skip moves a chain on to the next issue, is idempotent, and is refused for in-flight, done and stale targets', async () => {
  const queue = await chain();
  const target = { draftId, executionId: queue.executionId };
  await startEpicQueueHead(draftId, deps);
  await refused(skipEpicQueueIssue({ ...target, issueNumber: 1 }, deps), 'IN_FLIGHT');
  await finish(1, 'closed');
  await refused(skipEpicQueueIssue({ ...target, issueNumber: 1, expectedState: 'pending' }, deps), 'STATE_CHANGED');
  const skipped = await skipEpicQueueIssue({ ...target, issueNumber: 1, expectedState: 'blocked' }, deps);
  assert.equal(skipped.outcome, 'skipped');
  assert.deepEqual(starts, [1, 2], 'the chain moves on to the next issue');
  assert.deepEqual(skipped.queue?.issueStates.map(state => state.state), ['skipped', 'dispatched', 'pending']);
  assert.equal((await skipEpicQueueIssue({ ...target, issueNumber: 1 }, deps)).outcome, 'already_skipped');
  assert.deepEqual(reopened, [], 'skipping never touches the GitHub issue');
  assert.equal((await database('plan_issues').where({ draft_id: draftId, issue_number: 1 }).first()).status, 'closed');
  assert.deepEqual(await events(), [[1, 'blocked', 'closed_unmerged', null], [1, 'resolved', 'closed_unmerged', 'skipped']]);
  // A pending issue further down the chain can be skipped ahead of time.
  assert.equal((await skipEpicQueueIssue({ ...target, issueNumber: 3 }, deps)).outcome, 'skipped');
  await finish(2);
  await refused(skipEpicQueueIssue({ ...target, issueNumber: 2 }, deps), 'STALE_EXECUTION');
  assert.equal((await getEpicExecutionQueue(draftId))?.status, 'completed');
  assert.deepEqual(starts, [1, 2]);
  await refused(skipEpicQueueIssue({ draftId, executionId: 'other', issueNumber: 2 }, deps), 'STALE_EXECUTION');
});

test('skip and retry refuse done and in-flight issues, including a pending issue a person started', async () => {
  const queue = await createEpicExecutionQueue({ draftId, repository: 'acme/repo', issues: [1, 2, 3], mode: 'graph',
    dependsOn: new Map([[2, [1]]]), maxParallel: 3 }, deps);
  const target = { draftId, executionId: queue.executionId };
  await startEpicQueueHead(draftId, deps);
  assert.deepEqual(starts, [1, 3]);
  await finish(1);
  await refused(skipEpicQueueIssue({ ...target, issueNumber: 1 }, deps), 'ALREADY_DONE');
  await refused(retryEpicQueueIssue({ ...target, issueNumber: 1 }, deps), 'ALREADY_DONE');
  await refused(skipEpicQueueIssue({ ...target, issueNumber: 4 }, deps), 'NOT_FOUND');
  // Issue 2 is claimed by the queue once 1 merged: in flight.
  assert.deepEqual(starts, [1, 3, 2]);
  await refused(skipEpicQueueIssue({ ...target, issueNumber: 2 }, deps), 'IN_FLIGHT');
  await refused(retryEpicQueueIssue({ ...target, issueNumber: 2 }, deps), 'IN_FLIGHT');
  // A pending issue a person started (plan status in progress, no queue claim) is in flight too.
  const chained = await createEpicExecutionQueue({ draftId: 'manual', repository: 'acme/repo', issues: [7, 8] }, deps);
  await database('plan_issues').insert({ draft_id: 'manual', issue_number: 8, status: 'processing' });
  await refused(skipEpicQueueIssue({ draftId: 'manual', executionId: chained.executionId, issueNumber: 8 }, deps), 'IN_FLIGHT');
});

test('in a graph, dependents of an issue skipped without the option wait on it; with the option they start', async () => {
  const queue = await createEpicExecutionQueue({ draftId, repository: 'acme/repo', issues: [1, 2, 3], mode: 'graph',
    dependsOn: new Map([[2, [1]], [3, []]]), maxParallel: 3 }, deps);
  const target = { draftId, executionId: queue.executionId };
  await startEpicQueueHead(draftId, deps);
  assert.deepEqual(starts, [1, 3]);
  await finish(1, 'closed');
  await skipEpicQueueIssue({ ...target, issueNumber: 1 }, deps);
  await startEpicQueueHead(draftId, deps);
  assert.deepEqual(starts, [1, 3], 'a dependent of a skipped prerequisite is not started');
  const waiting = await issueState(2);
  assert.equal(waiting?.schedule, 'waiting');
  assert.deepEqual(waiting?.waitingOn, [1]);
  assert.deepEqual(waiting?.waitingOnSkipped, [1]);
  assert.equal((await issueState(1))?.skipSatisfiesDependents, false);
  // Skipping again with the option treats the dependency as satisfied.
  const satisfied = await skipEpicQueueIssue({ ...target, issueNumber: 1, satisfiesDependents: true }, deps);
  assert.equal(satisfied.outcome, 'skipped');
  assert.deepEqual(starts, [1, 3, 2]);
  assert.equal((await skipEpicQueueIssue({ ...target, issueNumber: 1, satisfiesDependents: true }, deps)).outcome, 'already_skipped');
});

test('in a graph, skipping a pending prerequisite with the option starts its dependents right away', async () => {
  const queue = await createEpicExecutionQueue({ draftId, repository: 'acme/repo', issues: [1, 2, 3], mode: 'graph',
    dependsOn: new Map([[2, [1]], [3, [2]]]), maxParallel: 2 }, deps);
  const target = { draftId, executionId: queue.executionId };
  await startEpicQueueHead(draftId, deps);
  assert.deepEqual(starts, [1]);
  await skipEpicQueueIssue({ ...target, issueNumber: 2, satisfiesDependents: true }, deps);
  assert.deepEqual(starts, [1, 3], 'the skipped 2 counts as met for 3');
  await finish(1);
  await finish(3);
  assert.equal((await getEpicExecutionQueue(draftId))?.status, 'completed');
  assert.deepEqual(starts, [1, 3]);
});

test('retry of a failed dispatch dispatches again now and is idempotent', async () => {
  const queue = await chain();
  const target = { draftId, executionId: queue.executionId, issueNumber: 1 };
  startHook = async () => { startHook = undefined; throw new Error('GitHub unavailable'); };
  await assert.rejects(startEpicQueueHead(draftId, deps), /GitHub unavailable/);
  assert.equal((await issueState(1))?.blockedKind, 'dispatch_failed');
  const retried = await retryEpicQueueIssue(target, deps);
  assert.equal(retried.outcome, 'retried');
  assert.deepEqual(starts, [1, 1]);
  assert.equal((await issueState(1))?.state, 'dispatched');
  assert.equal((await retryEpicQueueIssue(target, deps)).outcome, 'already_retried');
  assert.deepEqual(starts, [1, 1]);
  assert.deepEqual(await events(), [[1, 'blocked', 'dispatch_failed', null], [1, 'resolved', 'dispatch_failed', 'retried']]);
});

test('retry of an agent-reported blocker puts the issue back to pending and dispatches it', async () => {
  const queue = await chain();
  await startEpicQueueHead(draftId, deps);
  await setStatus(1, 'processing');
  await markEpicQueueHeadBlocked({ draftId, issueNumber: 1 });
  await refused(retryEpicQueueIssue({ draftId, executionId: queue.executionId, issueNumber: 2 }, deps), 'NOT_BLOCKED');
  await retryEpicQueueIssue({ draftId, executionId: queue.executionId, issueNumber: 1, expectedState: 'blocked' }, deps);
  assert.deepEqual(starts, [1, 1]);
  assert.equal((await issueState(1))?.state, 'dispatched');
  assert.equal((await database('plan_issues').where({ draft_id: draftId, issue_number: 1 }).first()).status, 'pending');
  await refused(retryEpicQueueIssue({ draftId, executionId: queue.executionId, issueNumber: 2 }, deps), 'NOT_BLOCKED');
});

test('retry of an issue closed without merge reopens it and dispatches it again', async () => {
  const queue = await chain();
  await startEpicQueueHead(draftId, deps);
  await finish(1, 'closed');
  await retryEpicQueueIssue({ draftId, executionId: queue.executionId, issueNumber: 1 }, deps);
  assert.deepEqual(reopened, [1]);
  assert.deepEqual(starts, [1, 1]);
  assert.equal((await issueState(1))?.state, 'dispatched');
});

test('retry of a missing issue re-checks it; retry of a human-merge wait or label handoff keeps the claim', async () => {
  const queue = await chain([1, 2]);
  const target = { draftId, executionId: queue.executionId };
  await database('plan_issues').where({ draft_id: draftId, issue_number: 1 }).delete();
  await startEpicQueueHead(draftId, deps);
  assert.equal((await issueState(1))?.blockedKind, 'missing_from_plan');
  await retryEpicQueueIssue({ ...target, issueNumber: 1 }, deps);
  assert.equal((await issueState(1))?.blockedKind, 'missing_from_plan', 'still missing: blocked again');
  assert.deepEqual((await events()).map(event => event[1]), ['blocked', 'resolved', 'blocked']);
  await database('plan_issues').insert({ draft_id: draftId, issue_number: 1, status: 'pending' });
  await retryEpicQueueIssue({ ...target, issueNumber: 1 }, deps);
  assert.deepEqual(starts, [1]);
  // A PR waiting for a person: the claim is kept and the queue keeps waiting for the merge.
  await setStatus(1, 'under_review');
  await markEpicQueueAwaitingHumanMerge({ draftId, issueNumber: 1, prNumber: 9, reason: 'review required' });
  await retryEpicQueueIssue({ ...target, issueNumber: 1 }, deps);
  assert.equal((await issueState(1))?.state, 'dispatched');
  assert.deepEqual(starts, [1], 'normal guards: a PR under review is not dispatched again');
  // A merged issue whose labels were not released: the retry re-runs the handoff and the queue moves on.
  await setStatus(1, 'merged');
  const current = (await getEpicExecutionQueue(draftId))!;
  await blockQueueIssue(database, current, current.items[0], { kind: 'label_handoff', reason: 'Could not release issue #1: rate limited', timestamp: clock });
  await retryEpicQueueIssue({ ...target, issueNumber: 1 }, deps);
  assert.equal((await issueState(1))?.state, 'done');
  assert.deepEqual(starts, [1, 2]);
});

test('retry of a parallel child dispatches only that child; setup and in-flight issues are refused', async () => {
  const queue = await createEpicExecutionQueue({ draftId, repository: 'acme/repo', issues: [1, 2], parallel: true }, deps);
  await refused(retryEpicQueueIssue({ draftId, executionId: queue.executionId, issueNumber: 1 }, deps), 'IN_FLIGHT');
  await setStatus(2, 'processing');
  await markEpicQueueHeadBlocked({ draftId, issueNumber: 2 });
  await retryEpicQueueIssue({ draftId, executionId: queue.executionId, issueNumber: 2 }, deps);
  assert.deepEqual(starts, [2]);
  assert.equal((await issueState(2))?.state, 'dispatched');
  await database('epic_execution_queues').delete();
  const setup = await createEpicExecutionQueue({ draftId, repository: 'acme/repo', issues: [1, 2], ready: false }, deps);
  await refused(retryEpicQueueIssue({ draftId, executionId: setup.executionId, issueNumber: 1 }, deps), 'NOT_RETRYABLE');
});

test('a parallel retry while paused stays owed: resume and the recovery sweep dispatch it under the normal guards', async () => {
  const queue = await createEpicExecutionQueue({ draftId, repository: 'acme/repo', issues: [1, 2, 3], parallel: true }, deps);
  for (const issueNumber of [2, 3]) {
    await setStatus(issueNumber, 'processing');
    await markEpicQueueHeadBlocked({ draftId, issueNumber });
  }
  await database('task_drafts').where({ draft_id: draftId }).update({ paused: true });
  await retryEpicQueueIssue({ draftId, executionId: queue.executionId, issueNumber: 2 }, deps);
  assert.deepEqual(starts, []);
  assert.equal((await issueState(2))?.state, 'pending');
  assert.equal((await retryEpicQueueIssue({ draftId, executionId: queue.executionId, issueNumber: 2 }, deps)).outcome, 'already_retried');
  // Neither another child's status change nor the sweep dispatches while the plan is paused.
  await finish(1);
  await reconcileEpicExecutionQueues(deps);
  assert.deepEqual(starts, []);
  // Resuming runs the execution's pass, which dispatches the owed child once.
  await database('task_drafts').where({ draft_id: draftId }).update({ paused: false });
  await startEpicQueueHead(draftId, deps);
  await startEpicQueueHead(draftId, deps);
  assert.deepEqual(starts, [2]);
  assert.equal((await issueState(2))?.state, 'dispatched');
  // A process that stops after committing a retry (here: before its own pass) is recovered by the sweep.
  await database('task_drafts').where({ draft_id: draftId }).update({ paused: true });
  await retryEpicQueueIssue({ draftId, executionId: queue.executionId, issueNumber: 3 }, deps);
  await database('task_drafts').where({ draft_id: draftId }).update({ paused: false });
  await reconcileEpicExecutionQueues(deps);
  assert.deepEqual(starts, [2, 3]);
});

test('a retried parallel child whose start was lost is dispatched again after fifteen minutes; initial children are not', async () => {
  const queue = await createEpicExecutionQueue({ draftId, repository: 'acme/repo', issues: [1, 2], parallel: true }, deps);
  await setStatus(2, 'processing');
  await markEpicQueueHeadBlocked({ draftId, issueNumber: 2 });
  await database('task_drafts').where({ draft_id: draftId }).update({ paused: true });
  await retryEpicQueueIssue({ draftId, executionId: queue.executionId, issueNumber: 2 }, deps);
  await database('task_drafts').where({ draft_id: draftId }).update({ paused: false });
  // The dispatch claim commits, but the process stops before the issue is labeled.
  await database('epic_execution_queue_issues').where({ issue_number: 2 }).update({ state: 'dispatched', dispatched_at: clock });
  await reconcileEpicExecutionQueues(deps);
  assert.deepEqual(starts, [], 'the claim is still fresh');
  clock += 15 * 60 * 1000 + 1;
  await reconcileEpicExecutionQueues(deps);
  // Child 1 is still pending in the plan, but the execution dispatched it itself; only the retry is owed.
  assert.deepEqual(starts, [2]);
});
