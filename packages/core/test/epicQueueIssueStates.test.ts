import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up } from '../src/db/migrations/20261003000000_add_epic_execution_queues.js';
import { up as finalization } from '../src/db/migrations/20261003010000_add_epic_queue_finalization.js';
import { up as useEpic } from '../src/db/migrations/20261003020000_add_epic_queue_use_epic.js';
import { up as parallel } from '../src/db/migrations/20261003030000_add_epic_queue_parallel.js';
import { up as recovery } from '../src/db/migrations/20261003040000_add_epic_queue_recovery_intent.js';
import { up as issueStates, down as removeIssueStates } from '../src/db/migrations/20261112130000_add_epic_queue_issue_states.js';

/**
 * Per-issue queue state: legacy single-cursor executions are migrated in place
 * without losing a claim or a reason, and every claim is a compare-and-set on
 * the issue's own row, so concurrent observers never dispatch an issue twice.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const starts: number[] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
const startIssue = async ({ issueNumber }: { issueNumber: number }) => { starts.push(issueNumber); };
const deps = { startIssue, finalize: async () => true };
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
const { PlanIssueStatus: S } = await import('../src/config/planIssueManager.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, summarizeEpicQueue, advanceEpicQueue, startEpicQueueHead,
  reconcileEpicExecutionQueues, appendEpicQueueIssues } = await import('../src/services/taskPlanning/epicExecutionQueue.js');
const { agentBlockedHeadReason } = await import('../src/services/taskPlanning/epicQueueBlockedHead.js');

async function createSchema(target: Knex, migrations = [up, finalization, useEpic, parallel, recovery, issueStates]) {
  await target.schema.createTable('task_drafts', table => {
    table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
  });
  await target.schema.createTable('plan_issues', table => {
    table.increments('id'); table.string('draft_id'); table.integer('issue_number'); table.integer('pr_number'); table.string('status');
  });
  for (const migrate of migrations) await migrate(target);
}
await createSchema(database);
after(async () => database.destroy());
beforeEach(async () => {
  for (const table of ['epic_execution_queue_issues', 'epic_execution_queues', 'plan_issues', 'task_drafts']) await database(table).delete();
  await database('task_drafts').insert({ draft_id: 'draft', context_config: JSON.stringify({ epicLabel: 'base-epic' }) });
  await database('plan_issues').insert([10, 20, 30].map(issue_number => ({ draft_id: 'draft', issue_number, status: 'pending' })));
  starts.length = 0;
});

/** A database whose queue rows were written by the single-cursor schema, then migrated. */
async function migrateLegacy(rows: Array<Record<string, unknown>>) {
  const legacy = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createSchema(legacy, [up, finalization, useEpic, parallel, recovery]);
  for (const row of rows) {
    await legacy('task_drafts').insert({ draft_id: row.draft_id });
    await legacy('epic_execution_queues').insert({ repository: 'acme/repo', created_at: 100, updated_at: 200, ...row });
  }
  await issueStates(legacy);
  return legacy;
}
const states = (queue: Awaited<ReturnType<typeof getEpicExecutionQueue>>) =>
  queue?.items.map(item => [item.issueNumber, item.state, item.dispatchedAt, item.blockedKind]);

test('an active sequential queue migrates in place: done before the cursor, the head keeps its claim and reason', async () => {
  const reason = 'Could not start issue #20: GitHub unavailable';
  const legacy = await migrateLegacy([{ draft_id: 'seq', execution_id: 'seq-1', issues: '[10,20,30]', cursor: 1,
    status: 'active', head_started_at: 500, blocked_reason: reason }]);
  try {
    const queue = await getEpicExecutionQueue('seq', { database: legacy });
    assert.deepEqual(states(queue), [[10, 'done', null, null], [20, 'blocked', 500, 'dispatch_failed'], [30, 'pending', null, null]]);
    assert.equal(queue?.headStartedAt, 500);
    const { issueStates: perIssue, ...summary } = summarizeEpicQueue(queue)!;
    assert.deepEqual(summary, { issues: [10, 20, 30], cursor: 1, head: 20, status: 'active', advanceOn: 'merged', blockedReason: reason });
    assert.deepEqual(perIssue[1], { issue: 20, state: 'blocked', blockedKind: 'dispatch_failed', blockedReason: reason });
    // The reason moved onto the head's row; the queue column keeps only execution-wide notes.
    assert.equal((await legacy('epic_execution_queues').where({ draft_id: 'seq' }).first()).blocked_reason, null);
    await removeIssueStates(legacy);
    const restored = await legacy('epic_execution_queues').where({ draft_id: 'seq' }).first();
    assert.deepEqual([restored.cursor, Number(restored.head_started_at), restored.blocked_reason], [1, 500, reason]);
  } finally { await legacy.destroy(); }
});

test('legacy reasons map to structured kinds, and an unstarted cancellation stays an execution note', async () => {
  const kinds = {
    agent: [agentBlockedHeadReason(10), 'agent_blocked'],
    merge: ['Waiting for human merge: auto-merge was not armed for PR #7 (issue #10, checks).', 'awaiting_human_merge'],
    handoff: ["Could not release issue #10: Waiting for 'AI-done' on issue #10 before releasing its processing labels.", 'label_handoff'],
    missing: ['Selected issue #10 is missing from this plan.', 'missing_from_plan'],
    closed: ['Issue #10 is closed; this epic advances only after it is merged. Reopen, fix and merge it to continue.', 'closed_unmerged'],
    setup: ['Preparing queued issue model and epic branch labels.', 'setup_not_ready'],
  };
  const legacy = await migrateLegacy([
    ...Object.entries(kinds).map(([draft, [reason]]) => ({ draft_id: draft, execution_id: draft, issues: '[10]', cursor: 0,
      status: 'active', blocked_reason: reason })),
    { draft_id: 'unstarted', execution_id: 'unstarted', issues: '[10,20]', cursor: 0, status: 'cancelled', ready: false,
      head_started_at: 50, blocked_reason: 'Initial queue head never started; implementation may be requested again.' },
  ]);
  try {
    for (const [draft, [reason, kind]] of Object.entries(kinds)) {
      const queue = await getEpicExecutionQueue(draft, { database: legacy });
      assert.equal(queue?.items[0].blockedKind, kind, draft);
      assert.equal(queue?.blockedReason, reason, draft);
    }
    const unstarted = await getEpicExecutionQueue('unstarted', { database: legacy });
    assert.equal(unstarted?.unstarted, true);
    assert.deepEqual(states(unstarted), [[10, 'dispatched', 50, null], [20, 'pending', null, null]]);
  } finally { await legacy.destroy(); }
});

test('an active parallel queue migrates with every child dispatched and its blocked child kept', async () => {
  const legacy = await migrateLegacy([{ draft_id: 'par', execution_id: 'par-1', issues: '[10,20,30]', cursor: 0,
    status: 'active', parallel: true, blocked_reason: agentBlockedHeadReason(20) }]);
  try {
    const queue = await getEpicExecutionQueue('par', { database: legacy });
    assert.deepEqual(states(queue), [[10, 'dispatched', 100, null], [20, 'blocked', 100, 'agent_blocked'], [30, 'dispatched', 100, null]]);
    const { issueStates: _perIssue, ...summary } = summarizeEpicQueue(queue)!;
    assert.deepEqual(summary, { issues: [10, 20, 30], cursor: 0, head: null, status: 'active', advanceOn: 'merged',
      blockedReason: agentBlockedHeadReason(20), executionMode: 'parallel' });
  } finally { await legacy.destroy(); }
});

test('a completed queue migrates with every issue done and its finalization untouched', async () => {
  const legacy = await migrateLegacy([{ draft_id: 'done', execution_id: 'done-1', issues: '[10,20]', cursor: 2,
    status: 'completed', finalized_at: null, owes_epic_finalization: true }]);
  try {
    const queue = await getEpicExecutionQueue('done', { database: legacy });
    assert.deepEqual(states(queue), [[10, 'done', null, null], [20, 'done', null, null]]);
    assert.deepEqual([queue?.cursor, queue?.owesEpicFinalization, queue?.finalizedAt], [2, true, null]);
    assert.equal(summarizeEpicQueue(queue)?.head, null);
    // Rerunning the migration does not duplicate rows.
    await issueStates(legacy);
    assert.equal((await legacy('epic_execution_queue_issues').where({ execution_id: 'done-1' })).length, 2);
  } finally { await legacy.destroy(); }
});

test('a restart mid-execution loses nothing: the migrated head is retried, or held, as before', async () => {
  const insertLegacy = async (row: Record<string, unknown>) => {
    await database('epic_execution_queues').insert({ draft_id: 'draft', repository: 'acme/repo', issues: '[10,20,30]',
      status: 'active', created_at: 100, updated_at: 100, ...row });
    await issueStates(database);
  };
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'merged' });
  await insertLegacy({ execution_id: 'legacy', cursor: 1, head_started_at: 1_000, blocked_reason: 'Could not start issue #20: offline' });
  await reconcileEpicExecutionQueues({ ...deps, now: () => 1_000 + 14 * 60_000 });
  assert.deepEqual(starts, [], 'the claim taken before the restart is still honoured');
  await reconcileEpicExecutionQueues({ ...deps, now: () => 1_000 + 15 * 60_000 });
  assert.deepEqual(starts, [20]);
  assert.equal((await getEpicExecutionQueue('draft'))?.blockedReason, null);

  await database('epic_execution_queue_issues').delete();
  await database('epic_execution_queues').delete();
  starts.length = 0;
  await insertLegacy({ execution_id: 'legacy-blocked', cursor: 1, head_started_at: 1_000, blocked_reason: agentBlockedHeadReason(20) });
  await reconcileEpicExecutionQueues({ ...deps, now: () => 1_000 + 60 * 60_000 });
  assert.deepEqual(starts, [], 'an agent-blocked head is never re-dispatched by recovery');
});

/** Holds every observer after its plan-issue read until all of them have read, so their writes race. */
function racingDatabase(observers: number) {
  let waiting = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  return new Proxy(database, { apply(target, thisArg, args) {
    const builder = Reflect.apply(target, thisArg, args);
    if (args[0] === 'plan_issues') {
      const first = builder.first.bind(builder);
      builder.first = async (...columns: string[]) => {
        const row = await first(...columns);
        if (++waiting === observers) release();
        await barrier;
        return row;
      };
    }
    return builder;
  } });
}

test('two concurrent advances of the same head settle it once and dispatch the successor once', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20, 30] });
  await startEpicQueueHead('draft', deps);
  assert.deepEqual(starts, [10]);
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'merged' });
  const racing = { ...deps, database: racingDatabase(2) };
  await Promise.all([advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, racing),
    advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, racing)]);
  assert.deepEqual(starts, [10, 20]);
  const queue = await getEpicExecutionQueue('draft');
  assert.deepEqual(states(queue)?.map(([issue, state]) => [issue, state]), [[10, 'done'], [20, 'dispatched'], [30, 'pending']]);
  assert.equal(queue?.cursor, 1);
});

test('two observers retrying an expired claim dispatch the head once', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] }, { now: () => 0 });
  await startEpicQueueHead('draft', { ...deps, now: () => 0 });
  const later = { ...deps, now: () => 16 * 60_000, database: racingDatabase(2) };
  await Promise.all([startEpicQueueHead('draft', later), startEpicQueueHead('draft', later)]);
  assert.deepEqual(starts, [10, 10]);
  assert.equal((await getEpicExecutionQueue('draft'))?.headStartedAt, 16 * 60_000);
});

test('issues appended to an active queue get pending rows; a stale or replaced execution cannot append', async () => {
  await database('plan_issues').insert({ draft_id: 'draft', issue_number: 40, status: 'pending' });
  const queue = await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] });
  assert.equal(await appendEpicQueueIssues(queue, [30]), true);
  assert.equal(await appendEpicQueueIssues(queue, [40]), false, 'the caller read the issue list before the first append');
  const appended = await getEpicExecutionQueue('draft');
  assert.deepEqual(appended?.issues, [10, 20, 30]);
  assert.deepEqual(appended?.items.map(item => [item.issueNumber, item.position, item.state]), [[10, 0, 'pending'], [20, 1, 'pending'], [30, 2, 'pending']]);
  await database('epic_execution_queues').update({ status: 'cancelled' });
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [40] });
  assert.equal(await appendEpicQueueIssues(appended!, [40]), false, 'a replaced execution never writes');
  assert.deepEqual((await getEpicExecutionQueue('draft'))?.issues, [40]);
});
