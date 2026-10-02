import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up } from '../src/db/migrations/20261003000000_add_epic_execution_queues.js';
import { up as epicQueueFinalization } from '../src/db/migrations/20261003010000_add_epic_queue_finalization.js';
import { up as epicQueueUseEpic } from '../src/db/migrations/20261003020000_add_epic_queue_use_epic.js';
import { up as epicQueueParallel, down as removeEpicQueueParallel } from '../src/db/migrations/20261003030000_add_epic_queue_parallel.js';

/** Which executions owe epic PR finalization, and how parallel epics resolve it. */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const starts: number[] = [];
const finalizations: string[] = [];
const reconciled: number[][] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/config/planIssueManager.js', { namedExports: {
  PlanIssueStatus: { PENDING: 'pending', PROCESSING: 'processing', UNDER_REVIEW: 'under_review',
    IN_REFINEMENT: 'in_refinement', REFINEMENT_PROCESSING: 'refinement_processing', MERGED: 'merged', CLOSED: 'closed' },
} });
await mock.module('../src/webhook/planIssueTrigger.js', { namedExports: {
  labelPlanIssueForProcessing: async ({ issueNumber }: { issueNumber: number }) => { starts.push(issueNumber); },
  reconcileTerminalInProgressIssues: async (_repository: string, issues: Array<{ issue_number: number }>) => {
    reconciled.push(issues.map(issue => issue.issue_number).sort());
    return issues;
  },
  finalizeEpicPlanIfComplete: async (draftId: string, canFinalize: () => Promise<boolean>) => {
    if (!await canFinalize()) return false;
    finalizations.push(draftId);
    return true;
  },
} });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => {
  throw new Error('Unexpected GitHub call');
} } });
const { PlanIssueStatus: S } = await import('../src/config/planIssueManager.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, summarizeEpicQueue, startEpicQueueHead,
  reconcileEpicExecutionQueues, onPlanIssueStatusChanged } = await import('../src/services/taskPlanning/epicExecutionQueue.js');

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
after(async () => database.destroy());
beforeEach(async () => {
  await database('epic_execution_queues').delete();
  await database('task_drafts').delete();
  await database('plan_issues').delete();
  await database('task_drafts').insert({ draft_id: 'draft', context_config: JSON.stringify({ epicLabel: 'base-old-epic' }) });
  await database('plan_issues').insert([10, 20, 30].map(issue_number => ({ draft_id: 'draft', issue_number, status: 'processing' })));
  starts.length = 0; finalizations.length = 0; reconciled.length = 0;
});
const parallel = { draftId: 'draft', repository: 'acme/repo', issues: [10, 20, 30], parallel: true };
async function finish(issueNumber: number, status: 'merged' | 'closed') {
  await database('plan_issues').where({ draft_id: 'draft', issue_number: issueNumber }).update({ status });
  await onPlanIssueStatusChanged('draft', issueNumber, status === 'merged' ? S.MERGED : S.CLOSED);
}

test('parallel epics finalize once after their last child finishes in any order, without dispatching', async () => {
  await createEpicExecutionQueue(parallel);
  assert.deepEqual(summarizeEpicQueue(await getEpicExecutionQueue('draft')), { issues: [10, 20, 30], cursor: 0, head: null,
    status: 'active', advanceOn: 'merged', blockedReason: null, executionMode: 'parallel' });
  await startEpicQueueHead('draft');
  await finish(30, 'merged');
  await finish(10, 'closed');
  assert.equal((await getEpicExecutionQueue('draft'))?.status, 'active');
  assert.deepEqual(finalizations, []);
  await Promise.all([finish(20, 'merged'), startEpicQueueHead('draft'), reconcileEpicExecutionQueues()]);
  const queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.status, 'completed');
  assert.ok(queue?.finalizedAt);
  assert.deepEqual(finalizations, ['draft']);
  assert.deepEqual(starts, []);
});

test('a paused parallel epic keeps its finalization owed until resumed', async () => {
  await createEpicExecutionQueue(parallel);
  await database('task_drafts').where({ draft_id: 'draft' }).update({ paused: true });
  await database('plan_issues').where({ draft_id: 'draft' }).update({ status: 'merged' });
  await reconcileEpicExecutionQueues();
  assert.equal((await getEpicExecutionQueue('draft'))?.status, 'completed');
  assert.equal((await getEpicExecutionQueue('draft'))?.finalizedAt, null);
  assert.deepEqual(finalizations, []);
  await database('task_drafts').where({ draft_id: 'draft' }).update({ paused: false });
  await reconcileEpicExecutionQueues();
  assert.deepEqual(finalizations, ['draft']);
});

test('reconciliation checks every running parallel child, not only the first', async () => {
  await createEpicExecutionQueue(parallel);
  await reconcileEpicExecutionQueues();
  assert.deepEqual(reconciled, [[10, 20, 30]]);
});

test('a completed non-epic queue resolves finalization without labeling a historical epic', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 30],
    advanceOn: 'terminal', autoMerge: true, useEpic: false });
  await finish(10, 'merged');
  await finish(30, 'closed');
  const queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.status, 'completed');
  assert.ok(queue?.finalizedAt);
  assert.deepEqual(finalizations, []);
  assert.deepEqual(await reconcileEpicExecutionQueues(), { reconciled: 0 });
  assert.deepEqual(finalizations, []);
});

test('parallel migration keeps existing queues sequential and rolls back', async () => {
  const oldDatabase = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await oldDatabase.schema.createTable('task_drafts', table => { table.string('draft_id').primary(); });
    await up(oldDatabase);
    await epicQueueFinalization(oldDatabase);
    await epicQueueUseEpic(oldDatabase);
    await oldDatabase('task_drafts').insert({ draft_id: 'old' });
    await oldDatabase('epic_execution_queues').insert({ draft_id: 'old', execution_id: 'execution',
      repository: 'acme/repo', issues: '[10]', cursor: 0, status: 'active', created_at: 100, updated_at: 100 });
    await epicQueueParallel(oldDatabase);
    assert.equal((await getEpicExecutionQueue('old', { database: oldDatabase }))?.parallel, false);
    await removeEpicQueueParallel(oldDatabase);
    assert.equal(Object.hasOwn(await oldDatabase('epic_execution_queues').where({ draft_id: 'old' }).first(), 'parallel'), false);
  } finally {
    await oldDatabase.destroy();
  }
});
