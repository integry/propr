import { up as blockedEvents } from '../src/db/migrations/20261113000000_add_epic_queue_blocked_events.js';
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
const releaseLabels = async () => {};
let labelHandoff: () => Promise<void> = releaseLabels;
await mock.module('../src/services/taskPlanning/epicIssueLabelHandoff.js', { namedExports: { releaseEpicIssueLabels: () => labelHandoff() } });
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
const { agentBlockedHeadReason, clearEpicQueueHeadBlocked } = await import('../src/services/taskPlanning/epicQueueBlockedHead.js');

async function createSchema(target: Knex, migrations = [up, finalization, useEpic, parallel, recovery, issueStates, blockedEvents]) {
  await target.schema.createTable('task_drafts', table => {
    table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
  });
  await target.schema.createTable('plan_issues', table => {
    table.increments('id'); table.string('draft_id'); table.integer('issue_number'); table.integer('pr_number'); table.string('status');
    table.string('task_id');
  });
  await target.schema.createTable('task_history', table => {
    table.increments('history_id'); table.string('task_id'); table.string('state'); table.bigInteger('timestamp'); table.text('metadata');
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
  labelHandoff = releaseLabels;
});

/** A database whose queue rows were written by the single-cursor schema, then migrated. */
async function migrateLegacy(rows: Array<Record<string, unknown>>, seed?: (legacy: Knex) => Promise<void>) {
  const legacy = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createSchema(legacy, [up, finalization, useEpic, parallel, recovery]);
  await seed?.(legacy);
  for (const row of rows) {
    await legacy('task_drafts').insert({ draft_id: row.draft_id });
    await legacy('epic_execution_queues').insert({ repository: 'acme/repo', created_at: 100, updated_at: 200, ...row });
  }
  await issueStates(legacy);
  await blockedEvents(legacy);
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
    assert.deepEqual(summary, { executionId: 'seq-1', issues: [10, 20, 30], cursor: 1, head: 20, status: 'active', advanceOn: 'merged', blockedReason: reason,
      executionMode: 'sequential', maxParallel: 1 });
    assert.deepEqual(perIssue[1], { issue: 20, state: 'blocked', blockedKind: 'dispatch_failed', blockedReason: reason,
      schedule: 'blocked', dependsOn: [10], waitingOn: [] });
    assert.deepEqual(perIssue[2], { issue: 30, state: 'pending', blockedKind: null, blockedReason: null,
      schedule: 'waiting', dependsOn: [20], waitingOn: [20] });
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
    assert.deepEqual(summary, { executionId: 'par-1', issues: [10, 20, 30], cursor: 0, head: null, status: 'active', advanceOn: 'merged',
      blockedReason: agentBlockedHeadReason(20), executionMode: 'parallel', maxParallel: null });
  } finally { await legacy.destroy(); }
});

const BLOCKED_RUN = JSON.stringify({ terminalReason: 'blocked', prResult: { status: 'success', terminalReason: 'blocked' } });

test('a parallel queue migrates every child whose latest run is still blocked, not only the one its reason names', async () => {
  const legacy = await migrateLegacy([{ draft_id: 'par', execution_id: 'par-1', issues: '[10,20,30,40]', cursor: 0,
    status: 'active', parallel: true, blocked_reason: agentBlockedHeadReason(20) }], async target => {
    await target('plan_issues').insert([
      { draft_id: 'par', issue_number: 10, status: 'processing', task_id: 'task-10' },
      { draft_id: 'par', issue_number: 20, status: 'processing', task_id: 'task-20' },
      { draft_id: 'par', issue_number: 30, status: 'merged', task_id: 'task-30' },
      { draft_id: 'par', issue_number: 40, status: 'processing', task_id: 'task-40' },
    ]);
    await target('task_history').insert([
      { task_id: 'task-10', state: 'completed', timestamp: 1, metadata: BLOCKED_RUN },
      { task_id: 'task-20', state: 'completed', timestamp: 2, metadata: BLOCKED_RUN },
      // Merged since, or rerun since: neither still holds a blocker.
      { task_id: 'task-30', state: 'completed', timestamp: 1, metadata: BLOCKED_RUN },
      { task_id: 'task-40', state: 'completed', timestamp: 1, metadata: BLOCKED_RUN },
      { task_id: 'task-40', state: 'processing', timestamp: 3, metadata: null },
    ]);
  });
  try {
    let queue = await getEpicExecutionQueue('par', { database: legacy });
    assert.deepEqual(states(queue)?.map(([issue, state, , kind]) => [issue, state, kind]),
      [[10, 'blocked', 'agent_blocked'], [20, 'blocked', 'agent_blocked'], [30, 'dispatched', null], [40, 'dispatched', null]]);
    assert.equal(queue?.blockedReason, agentBlockedHeadReason(20), 'the child the legacy reason named stays the latest blocker');

    // The named child finishes a normal rerun; the other child still holds the epic and explains it.
    assert.equal(await clearEpicQueueHeadBlocked({ draftId: 'par', issueNumber: 20 }, { database: legacy }), true);
    queue = await getEpicExecutionQueue('par', { database: legacy });
    assert.equal(queue?.blockedReason, agentBlockedHeadReason(10));
    assert.deepEqual(summarizeEpicQueue(queue)?.issueStates[0],
      { issue: 10, state: 'blocked', blockedKind: 'agent_blocked', blockedReason: agentBlockedHeadReason(10),
        schedule: 'blocked', dependsOn: [], waitingOn: [] });
  } finally { await legacy.destroy(); }
});

test('a legacy queue that requeued a settled issue migrates to one row per issue, keeping outstanding work', async () => {
  const legacy = await migrateLegacy([
    // #10 settled, then was requeued behind the in-flight head #20.
    { draft_id: 'requeued', execution_id: 'requeued-1', issues: '[10,20,10]', cursor: 1, status: 'active', head_started_at: 500 },
    { draft_id: 'finished', execution_id: 'finished-1', issues: '[10,20,10]', cursor: 3, status: 'completed' },
  ]);
  try {
    const queue = await getEpicExecutionQueue('requeued', { database: legacy });
    assert.deepEqual(states(queue), [[20, 'dispatched', 500, null], [10, 'pending', null, null]]);
    assert.deepEqual([queue?.issues, queue?.cursor, queue?.headStartedAt], [[20, 10], 0, 500]);
    const finished = await getEpicExecutionQueue('finished', { database: legacy });
    assert.deepEqual(states(finished)?.map(([issue, state]) => [issue, state]), [[20, 'done'], [10, 'done']]);
    await removeIssueStates(legacy);
    const restored = await legacy('epic_execution_queues').where({ draft_id: 'requeued' }).first();
    assert.deepEqual([restored.issues, restored.cursor, Number(restored.head_started_at)], ['[20,10]', 0, 500]);
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
    await blockedEvents(legacy);
    assert.equal((await legacy('epic_execution_queue_issues').where({ execution_id: 'done-1' })).length, 2);
  } finally { await legacy.destroy(); }
});

test('a restart mid-execution loses nothing: the migrated head is retried, or held, as before', async () => {
  const insertLegacy = async (row: Record<string, unknown>) => {
    await database('epic_execution_queues').insert({ draft_id: 'draft', repository: 'acme/repo', issues: '[10,20,30]',
      status: 'active', created_at: 100, updated_at: 100, ...row });
    await issueStates(database);
    await blockedEvents(database);
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

test('an issue that settled in the active execution is requeued at the tail; an unsettled one is not appended twice', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] });
  await startEpicQueueHead('draft', deps);
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'merged' });
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, deps);
  // #10 is reset to pending while #20 is in flight.
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'pending' });
  const advanced = await getEpicExecutionQueue('draft');
  assert.equal(await appendEpicQueueIssues(advanced!, [20]), false, 'the in-flight head is already owed');
  assert.equal(await appendEpicQueueIssues(advanced!, [10, 30]), true);
  const queue = await getEpicExecutionQueue('draft');
  assert.deepEqual(queue?.items.map(item => [item.issueNumber, item.position, item.state, item.dispatchedAt]),
    [[20, 1, 'dispatched', queue?.items[0].dispatchedAt], [10, 2, 'pending', null], [30, 3, 'pending', null]]);
  assert.deepEqual([queue?.issues, queue?.cursor, summarizeEpicQueue(queue)?.head], [[20, 10, 30], 0, 20]);
  assert.equal((await database('epic_execution_queues').where({ draft_id: 'draft' }).first()).issues, '[20,10,30]');
  assert.equal(await appendEpicQueueIssues(queue!, [10]), false, 'a requeued issue is pending again');
  // The requeued issue runs again after the head settles.
  await database('plan_issues').where({ issue_number: 20 }).update({ status: 'merged' });
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 20, status: S.MERGED }, deps);
  assert.deepEqual(starts, [10, 20, 10]);
});

/** A sequential execution whose head #10 merged, then is requeued while #20 runs. */
async function requeueSettledHead() {
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'pending' });
  assert.equal(await appendEpicQueueIssues((await getEpicExecutionQueue('draft'))!, [10]), true);
}
const occurrences = async () => (await getEpicExecutionQueue('draft'))?.items.map(item => [item.issueNumber, item.position, item.state, item.blockedKind]);
/** A database whose first read of the table waits for `resume` (`entered` resolves once it is waiting), then reads current rows. */
function holdingRead(table: string) {
  let resume!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  let holds = 1;
  const holding = new Proxy(database, { apply(target, thisArg, args) {
    const builder = Reflect.apply(target, thisArg, args);
    if (args[0] === table && holds-- > 0) {
      const first = builder.first.bind(builder);
      builder.first = async (...columns: string[]) => { enter(); await held; return first(...columns); };
    }
    return builder;
  } });
  return { holding, entered, resume };
}

test('an observer whose label handoff returns after a requeue does not settle the requeued occurrence', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] });
  await startEpicQueueHead('draft', deps);
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'merged' });
  let entered!: () => void;
  let resume!: () => void;
  const inHandoff = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  labelHandoff = async () => { labelHandoff = releaseLabels; entered(); await held; };
  const stale = advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, deps);
  await inHandoff;
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, deps);
  assert.deepEqual(starts, [10, 20]);
  await requeueSettledHead();
  resume();
  await stale;
  assert.deepEqual(await occurrences(), [[20, 1, 'dispatched', null], [10, 2, 'pending', null]]);
  await database('plan_issues').where({ issue_number: 20 }).update({ status: 'merged' });
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 20, status: S.MERGED }, deps);
  assert.deepEqual(starts, [10, 20, 10], 'the requeued issue still runs after its predecessor');
});

test('an observer of an earlier occurrence does not block the requeued one', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] });
  await startEpicQueueHead('draft', deps);
  const { holding, entered, resume } = holdingRead('plan_issues');
  const stale = advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.CLOSED }, { ...deps, database: holding });
  await entered;
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'merged' });
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, deps);
  await requeueSettledHead();
  // The stale observer now reads the requeued issue closed without merge.
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'closed' });
  resume();
  await stale;
  assert.deepEqual(await occurrences(), [[20, 1, 'dispatched', null], [10, 2, 'pending', null]]);
});

test('an observer that read an unclaimed head does not dispatch its requeued occurrence while the successor runs', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] });
  // Held after it read the head, before its dispatch claim.
  const { holding, entered, resume } = holdingRead('task_drafts');
  const stale = startEpicQueueHead('draft', { ...deps, database: holding });
  await entered;
  await startEpicQueueHead('draft', deps);
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'merged' });
  await advanceEpicQueue({ draftId: 'draft', issueNumber: 10, status: S.MERGED }, deps);
  await requeueSettledHead();
  resume();
  await stale;
  assert.deepEqual(starts, [10, 20]);
  assert.deepEqual(await occurrences(), [[20, 1, 'dispatched', null], [10, 2, 'pending', null]]);
});
