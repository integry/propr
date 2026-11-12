import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up } from '../src/db/migrations/20261003000000_add_epic_execution_queues.js';
import { up as epicQueueFinalization } from '../src/db/migrations/20261003010000_add_epic_queue_finalization.js';
import { up as epicQueueUseEpic } from '../src/db/migrations/20261003020000_add_epic_queue_use_epic.js';
import { up as epicQueueParallel } from '../src/db/migrations/20261003030000_add_epic_queue_parallel.js';
import { up as epicQueueRecovery } from '../src/db/migrations/20261003040000_add_epic_queue_recovery_intent.js';
import { up as createJournal, down as dropJournal } from '../src/db/migrations/20261112160000_create_repository_events.js';

/**
 * The epic queue journals each transition from the code path that persists it:
 * start, advance, the blocked explanations (merge wait, agent blocker, human
 * merge), and completion.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const starts: number[] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/utils/eventPublisher.js', { namedExports: {
  getEventPublisher: () => ({ publishActivity: async () => true }),
} });
await mock.module('../src/services/taskPlanning/epicIssueLabelHandoff.js', { namedExports: { releaseEpicIssueLabels: async () => {} } });
await mock.module('../src/config/planIssueManager.js', { namedExports: {
  PlanIssueStatus: { PENDING: 'pending', PROCESSING: 'processing', UNDER_REVIEW: 'under_review',
    IN_REFINEMENT: 'in_refinement', REFINEMENT_PROCESSING: 'refinement_processing', MERGED: 'merged', CLOSED: 'closed' },
  updatePlanIssue: async () => null,
} });
await mock.module('../src/webhook/planIssueTrigger.js', { namedExports: {
  labelPlanIssueForProcessing: async ({ issueNumber }: { issueNumber: number }) => { starts.push(issueNumber); },
  reconcileTerminalInProgressIssues: async (_repository: string, issues: unknown[]) => issues,
  finalizeEpicPlanIfComplete: async () => true,
} });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => { throw new Error('Unexpected GitHub call'); } } });
const { PlanIssueStatus: S } = await import('../src/config/planIssueManager.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, advanceEpicQueue } = await import('../src/services/taskPlanning/epicExecutionQueue.js');
const { markEpicQueueAwaitingHumanMerge } = await import('../src/services/taskPlanning/epicQueueHumanMerge.js');
const { markEpicQueueHeadBlocked } = await import('../src/services/taskPlanning/epicQueueBlockedHead.js');
const { listRepositoryEvents } = await import('../src/services/repositoryEventJournal.js');

await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
});
await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.integer('issue_number'); table.integer('pr_number'); table.string('status'); table.string('task_id');
});
for (const migration of [up, epicQueueFinalization, epicQueueUseEpic, epicQueueParallel, epicQueueRecovery, createJournal]) await migration(database);
after(async () => database.destroy());

let clock = 1_000;
const deps = { database, now: () => ++clock };
beforeEach(async () => {
  for (const table of ['task_drafts', 'plan_issues', 'epic_execution_queues', 'repository_events']) await database(table).delete();
  await database('task_drafts').insert({ draft_id: 'draft', context_config: JSON.stringify({ epicLabel: 'base-epic' }) });
  await database('plan_issues').insert([10, 20, 30].map(issue_number => ({ draft_id: 'draft', issue_number, status: 'pending' })));
  starts.length = 0;
});

const setStatus = (issue_number: number, status: string) =>
  database('plan_issues').where({ draft_id: 'draft', issue_number }).update({ status });
const journal = async () => (await listRepositoryEvents(database, { repository: 'acme/repo', domains: ['epic_queue'] }))
  .map(event => ({ type: event.type, entityId: event.entityId, planId: event.planId, issueNumber: event.issueNumber, payload: event.payload }));

test('a sequential execution journals started, advanced and completed, each once', async () => {
  const queue = await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] }, deps);
  await setStatus(10, S.MERGED);
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, deps);
  // A redelivered merge for the old head appends nothing.
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, deps);
  await setStatus(20, S.MERGED);
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 20, status: S.MERGED }, deps);
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 20, status: S.MERGED }, deps);

  const events = await journal();
  assert.deepEqual(events.map(event => event.type), ['started', 'advanced', 'completed']);
  assert.ok(events.every(event => event.entityId === queue.executionId && event.planId === 'draft'));
  assert.deepEqual(events[0].payload, { issues: [10, 20], advanceOn: 'merged', parallel: false });
  assert.deepEqual(events[1].payload, { fromIssue: 10, toIssue: 20, cursor: 1 });
  assert.equal(events[1].issueNumber, 20);
  assert.deepEqual(events[2].payload, { fromIssue: 20, cursor: 2 });
});

test('a closed head that must be merged journals blocked once per new explanation', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] }, deps);
  await setStatus(10, S.CLOSED);
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.CLOSED }, deps);
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.CLOSED }, deps);
  const blocked = (await journal()).filter(event => event.type === 'blocked');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].payload.headIssue, 10);
  assert.match(String(blocked[0].payload.blockedReason), /advances only after it is merged/);
  assert.match((await getEpicExecutionQueue('draft', deps))!.blockedReason ?? '', /advances only after it is merged/);
});

test('the agent-blocker and human-merge explanations journal from their own code paths', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] }, deps);
  assert.equal(await markEpicQueueAwaitingHumanMerge({ draftId: 'draft', issueNumber: 10, prNumber: 70, reason: 'skipped_protected_path' }, deps), true);
  assert.equal(await markEpicQueueAwaitingHumanMerge({ draftId: 'draft', issueNumber: 10, prNumber: 70, reason: 'skipped_protected_path' }, deps), true);
  assert.equal(await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }, deps), true);
  assert.equal(await markEpicQueueHeadBlocked({ draftId: 'draft', issueNumber: 10 }, deps), true);
  const blocked = (await journal()).filter(event => event.type === 'blocked').map(event => String(event.payload.blockedReason));
  assert.equal(blocked.length, 2, 'a repeated explanation is not a new event');
  assert.match(blocked[0], /^Waiting for human merge:/);
  assert.match(blocked[1], /stopped on a blocker reported by the agent/);
});

test('a parallel execution journals completed when its last child settles', async () => {
  const queue = await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20], parallel: true }, deps);
  await setStatus(10, S.MERGED);
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, deps);
  await setStatus(20, S.MERGED);
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 20, status: S.MERGED }, deps);
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 20, status: S.MERGED }, deps);
  assert.deepEqual((await journal()).map(event => event.type), ['started', 'completed']);
  assert.equal((await getEpicExecutionQueue('draft', deps))!.executionId, queue.executionId);
});

test('a failed append never fails the queue transition', async () => {
  await dropJournal(database);
  try {
    await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] }, deps);
    await setStatus(10, S.MERGED);
    await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, deps);
    const queue = await getEpicExecutionQueue('draft', deps);
    assert.equal(queue!.cursor, 1);
    assert.equal(queue!.status, 'active');
    assert.deepEqual(starts, [20], 'the next head was still dispatched');
  } finally {
    await createJournal(database);
  }
});
