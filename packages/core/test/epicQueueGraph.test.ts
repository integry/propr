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

/**
 * Graph executions: issues start once their prerequisites merged, never more than the
 * stored limit at once, in publication order; a blocked branch holds only its dependents.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const starts: Array<{ issueNumber: number; epicLabel?: string }> = [];
const finalizations: string[] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
let startHook: ((issueNumber: number) => Promise<void>) | undefined;
const startIssue = async ({ issueNumber, epicLabel }: { issueNumber: number; epicLabel?: string }) => {
  starts.push({ issueNumber, epicLabel });
  await startHook?.(issueNumber);
};
let clock = 1_000_000;
const deps = { startIssue, now: () => clock, finalize: async (draftId: string) => { finalizations.push(draftId); return true; } };
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
const { createEpicExecutionQueue, getEpicExecutionQueue, summarizeEpicQueue, advanceEpicQueue, startEpicQueueHead,
  reconcileEpicExecutionQueues, isEpicQueueIssueInFlight } = await import('../src/services/taskPlanning/epicExecutionQueue.js');
const { markEpicQueueAwaitingHumanMerge } = await import('../src/services/taskPlanning/epicQueueHumanMerge.js');

await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
});
await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.integer('issue_number'); table.integer('pr_number'); table.string('status');
  table.string('task_id');
});
for (const migrate of [up, finalization, useEpic, parallel, recovery, issueStates, graph]) await migrate(database);
after(async () => database.destroy());

const ISSUES = [1, 2, 3, 4, 5, 6];
beforeEach(async () => {
  for (const table of ['epic_execution_queue_issues', 'epic_execution_queues', 'plan_issues', 'task_drafts']) await database(table).delete();
  await database('task_drafts').insert({ draft_id: 'draft', context_config: JSON.stringify({ epicLabel: 'base-epic' }) });
  await database('plan_issues').insert([...ISSUES, 99].map(issue_number => ({ draft_id: 'draft', issue_number, status: 'pending' })));
  starts.length = 0; finalizations.length = 0; startHook = undefined; clock = 1_000_000;
});

const started = () => starts.map(start => start.issueNumber);
/** The worker picks the labelled issue up; then its PR merges (or closes) and the status hook advances the queue. */
async function setStatus(issueNumber: number, status: string) {
  await database('plan_issues').where({ draft_id: 'draft', issue_number: issueNumber }).update({ status });
}
async function finish(issueNumber: number, status: 'merged' | 'closed' = 'merged') {
  await setStatus(issueNumber, status);
  await advanceEpicQueue({ draftId: 'draft', issueNumber, status: status as never }, deps);
}
async function markStartedRunning() {
  for (const { issueNumber } of starts) {
    await database('plan_issues').where({ draft_id: 'draft', issue_number: issueNumber, status: 'pending' }).update({ status: 'processing' });
  }
}
// Diamond: 1 -> (2, 3) -> 4, and an independent 5.
const diamond = new Map([[1, []], [2, [1]], [3, [1]], [4, [2, 3]], [5, []]]);
const createGraph = (extra: Record<string, unknown> = {}) => createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo',
  issues: [1, 2, 3, 4, 5], mode: 'graph', maxParallel: 2, dependsOn: diamond, ...extra }, deps);
const schedule = async () => summarizeEpicQueue(await getEpicExecutionQueue('draft'))!.issueStates
  .map(state => [state.issue, state.schedule, state.waitingOn]);

test('a diamond runs A, then B and C in parallel, then D, on the epic branch, and finalizes once', async () => {
  await createGraph({ issues: [1, 2, 3, 4], maxParallel: 3, dependsOn: diamond });
  await startEpicQueueHead('draft', deps);
  assert.deepEqual(started(), [1]);
  assert.deepEqual(starts[0].epicLabel, 'base-epic');
  await markStartedRunning();
  assert.deepEqual(await schedule(), [[1, 'in_flight', []], [2, 'waiting', [1]], [3, 'waiting', [1]], [4, 'waiting', [2, 3]]]);
  await finish(1);
  assert.deepEqual(started(), [1, 2, 3]);
  await markStartedRunning();
  await finish(2);
  assert.deepEqual(started(), [1, 2, 3], 'D waits for C');
  assert.deepEqual((await schedule())[3], [4, 'waiting', [3]]);
  await finish(3);
  assert.deepEqual(started(), [1, 2, 3, 4]);
  await markStartedRunning();
  await finish(4);
  const queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.status, 'completed');
  assert.deepEqual(finalizations, ['draft']);
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 4, status: 'merged' as never }, deps);
  await reconcileEpicExecutionQueues(deps);
  assert.deepEqual(finalizations, ['draft'], 'finalization runs once');
});

test('a limit lower than the ready issues starts in publication order and replenishes as issues merge', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [1, 2, 3, 4, 5], mode: 'graph', maxParallel: 2,
    dependsOn: new Map() }, deps);
  await startEpicQueueHead('draft', deps);
  assert.deepEqual(started(), [1, 2]);
  await markStartedRunning();
  const summary = summarizeEpicQueue(await getEpicExecutionQueue('draft'))!;
  assert.deepEqual([summary.executionMode, summary.maxParallel], ['graph', 2]);
  assert.deepEqual(summary.issueStates.map(state => state.schedule), ['in_flight', 'in_flight', 'ready', 'ready', 'ready']);
  await finish(2);
  assert.deepEqual(started(), [1, 2, 3]);
  await markStartedRunning();
  await finish(1);
  await finish(3);
  assert.deepEqual(started(), [1, 2, 3, 4, 5]);
});

test('a blocked branch keeps its dependents waiting while an independent branch keeps running', async () => {
  await createGraph({ maxParallel: 3 });
  await startEpicQueueHead('draft', deps);
  assert.deepEqual(started(), [1, 5]);
  await markStartedRunning();
  await finish(1, 'closed');
  assert.deepEqual(started(), [1, 5], 'nothing that depends on the closed issue starts');
  const states = await schedule();
  assert.deepEqual(states.slice(0, 4), [[1, 'blocked', []], [2, 'waiting', [1]], [3, 'waiting', [1]], [4, 'waiting', [2, 3]]]);
  const queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.items[0].blockedKind, 'closed_unmerged');
  // The independent branch merges; the execution stays active, and its pending issues stay pending.
  await finish(5);
  assert.equal((await getEpicExecutionQueue('draft'))?.status, 'active');
  assert.deepEqual((await schedule())[4], [5, 'done', []]);
  // Reopened, fixed and merged: its dependents start.
  await setStatus(1, 'processing');
  await startEpicQueueHead('draft', deps);
  await finish(1);
  assert.deepEqual(started(), [1, 5, 2, 3]);
});

test('an unclaimed issue closed while waiting and then reopened starts once its prerequisites merge', async () => {
  await createGraph({ issues: [1, 2, 3], maxParallel: 3, dependsOn: diamond });
  await startEpicQueueHead('draft', deps);
  assert.deepEqual(started(), [1]);
  await markStartedRunning();
  // Issue 2 waits for 1 and was never claimed; someone closes it, and the next pass blocks it.
  await setStatus(2, 'closed');
  await reconcileEpicExecutionQueues(deps);
  let item = (await getEpicExecutionQueue('draft'))!.items[1];
  assert.deepEqual([item.state, item.blockedKind, item.dispatchedAt], ['blocked', 'closed_unmerged', null]);
  // Reopened: the next pass drops the closure block, so it waits for its prerequisite again.
  await setStatus(2, 'pending');
  await reconcileEpicExecutionQueues(deps);
  item = (await getEpicExecutionQueue('draft'))!.items[1];
  assert.deepEqual([item.state, item.blockedKind, item.blockedReason], ['pending', null, null]);
  assert.deepEqual((await schedule())[1], [2, 'waiting', [1]]);
  await finish(1);
  assert.deepEqual(started(), [1, 2, 3]);
});

test('an unclaimed issue keeps an unrelated blocker, and a closed one stays blocked across passes', async () => {
  await createGraph({ issues: [1, 2, 3], maxParallel: 3, dependsOn: diamond });
  await startEpicQueueHead('draft', deps);
  await markStartedRunning();
  await database('epic_execution_queue_issues').where({ issue_number: 3 })
    .update({ state: 'blocked', blocked_kind: 'missing_from_plan', blocked_reason: 'missing', blocked_at: clock });
  await setStatus(2, 'closed');
  await reconcileEpicExecutionQueues(deps);
  // Still closed: further passes keep the closure block.
  await reconcileEpicExecutionQueues(deps);
  const items = (await getEpicExecutionQueue('draft'))!.items;
  assert.deepEqual([items[1].state, items[1].blockedKind], ['blocked', 'closed_unmerged']);
  assert.deepEqual([items[2].state, items[2].blockedKind], ['blocked', 'missing_from_plan']);
});

test('restart in the middle: reconcile restores the in-flight set without duplicate dispatches', async () => {
  await createGraph({ maxParallel: 2 });
  await startEpicQueueHead('draft', deps);
  await markStartedRunning();
  await finish(1);
  assert.deepEqual(started(), [1, 5, 2]);
  await markStartedRunning();
  // A crash after claiming 3 but before its label was applied: its claim is durable.
  await database('epic_execution_queue_issues').where({ issue_number: 5 }).update({ state: 'done' });
  await setStatus(5, 'merged');
  await database('epic_execution_queue_issues').where({ issue_number: 3 })
    .update({ state: 'dispatched', dispatched_at: clock });
  for (let pass = 0; pass < 3; pass++) await reconcileEpicExecutionQueues(deps);
  assert.deepEqual(started(), [1, 5, 2], 'the restored claim is not dispatched again inside the retry window');
  const queue = await getEpicExecutionQueue('draft');
  assert.deepEqual(queue?.items.filter(item => item.state === 'dispatched').map(item => item.issueNumber), [2, 3]);
  // After the retry window the lost dispatch of 3 is retried exactly once.
  clock += 16 * 60 * 1000;
  await reconcileEpicExecutionQueues(deps);
  await reconcileEpicExecutionQueues(deps);
  assert.deepEqual(started(), [1, 5, 2, 3]);
});

test('concurrent advances at the limit never exceed it or dispatch an issue twice', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [1, 2, 3, 4, 5, 6], mode: 'graph', maxParallel: 2,
    dependsOn: new Map() }, deps);
  await Promise.all([startEpicQueueHead('draft', deps), startEpicQueueHead('draft', deps), reconcileEpicExecutionQueues(deps)]);
  assert.deepEqual(started(), [1, 2]);
  await markStartedRunning();
  await setStatus(1, 'merged');
  await setStatus(2, 'merged');
  await Promise.all([
    advanceEpicQueue({ draftId: 'draft', issueNumber: 1, status: 'merged' as never }, deps),
    advanceEpicQueue({ draftId: 'draft', issueNumber: 2, status: 'merged' as never }, deps),
    startEpicQueueHead('draft', deps),
  ]);
  assert.deepEqual(started(), [1, 2, 3, 4]);
  assert.equal(new Set(started()).size, started().length);
  const queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.items.filter(item => item.state === 'dispatched').length, 2);
});

test('an issue started out of band holds a slot, and an unmerged outside prerequisite holds its dependent', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [1, 2, 3], mode: 'graph', maxParallel: 2,
    dependsOn: new Map([[3, [99]]]) }, deps);
  await setStatus(2, 'processing');
  await startEpicQueueHead('draft', deps);
  assert.deepEqual(started(), [1], 'issue 2 runs without a claim and holds the second slot');
  assert.deepEqual((await schedule())[1], [2, 'in_flight', []], 'the issue started by hand reports in flight, not ready');
  assert.deepEqual((await schedule())[2], [3, 'waiting', [99]]);
  await finish(2);
  assert.deepEqual(started(), [1], 'issue 3 still waits for #99, which is not part of the execution');
  await setStatus(99, 'merged');
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 99, status: 'merged' as never }, deps);
  assert.deepEqual(started(), [1, 3]);
});

test('a paused graph settles merges but starts nothing until resumed; a human-merge wait marks only that issue', async () => {
  await createGraph({ maxParallel: 3 });
  await startEpicQueueHead('draft', deps);
  await markStartedRunning();
  assert.equal(isEpicQueueIssueInFlight(await getEpicExecutionQueue('draft'), 5), true);
  assert.equal(isEpicQueueIssueInFlight(await getEpicExecutionQueue('draft'), 2), false);
  assert.equal(await markEpicQueueAwaitingHumanMerge({ draftId: 'draft', issueNumber: 5, prNumber: 7, reason: 'policy' }, { database }), true);
  assert.equal(await markEpicQueueAwaitingHumanMerge({ draftId: 'draft', issueNumber: 2, prNumber: 8, reason: 'policy' }, { database }), false);
  await database('task_drafts').where({ draft_id: 'draft' }).update({ paused: true });
  await finish(1);
  assert.deepEqual(started(), [1, 5]);
  assert.equal((await getEpicExecutionQueue('draft'))?.items[0].state, 'done');
  await database('task_drafts').where({ draft_id: 'draft' }).update({ paused: false });
  await startEpicQueueHead('draft', deps);
  assert.deepEqual(started(), [1, 5, 2, 3]);
});

test('graph inputs are validated, and a later sequential execution does not inherit the graph mode', async () => {
  await assert.rejects(createGraph({ maxParallel: 0 }), /positive integer/);
  await assert.rejects(createGraph({ advanceOn: 'terminal' }), /merged/);
  await assert.rejects(createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [1], maxParallel: 2 }, deps), /graph/);
  await createGraph();
  await database('epic_execution_queues').update({ status: 'cancelled' });
  const sequential = await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [1, 2] }, deps);
  assert.deepEqual([sequential.mode, sequential.maxParallel, sequential.items.map(item => item.dependsOn)], ['sequential', null, [[], []]]);
});
