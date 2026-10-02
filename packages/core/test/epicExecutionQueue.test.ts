import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up } from '../src/db/migrations/20261003000000_add_epic_execution_queues.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const starts: number[] = [];
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
  labelPlanIssueForProcessing: async ({ issueNumber }: { issueNumber: number }) => { starts.push(issueNumber); },
  reconcileTerminalInProgressIssues: async (_repository: string, issues: unknown[]) => issues,
  finalizeEpicPlanIfComplete: async (draftId: string) => { finalizations.push(draftId); },
} });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({ request: async () => {
  if (!pullRequestState) throw new Error('Unexpected GitHub call');
  return { data: pullRequestState };
} }) } });
const { PlanIssueStatus: S } = await import('../src/config/planIssueManager.js');
const { determinePRStatusUpdate } = await import('../src/webhook/statusMachine.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, summarizeEpicQueue, decideEpicAdvance,
  advanceEpicQueue, startEpicQueueHead, reconcileEpicExecutionQueues, readyEpicExecutionQueue,
  cancelEpicExecutionQueue, onPlanIssueStatusChanged } = await import('../src/services/taskPlanning/epicExecutionQueue.js');

await database.raw('PRAGMA foreign_keys = ON');
await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
});
await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.integer('issue_number'); table.integer('pr_number'); table.string('status');
});
await up(database);
after(async () => database.destroy());
beforeEach(async () => {
  await database('task_drafts').delete();
  await database('plan_issues').delete();
  await database('task_drafts').insert({ draft_id: 'draft', context_config: JSON.stringify({ epicLabel: 'base-epic' }) });
  await database('plan_issues').insert([10, 20, 30, 40].map(issue_number => ({ draft_id: 'draft', issue_number, status: 'pending' })));
  starts.length = 0; finalizations.length = 0; pullRequestState = null;
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

test('queue-only reconciliation observes a reopened or later-merged closed PR', async () => {
  await createEpicExecutionQueue(input);
  await database('plan_issues').where({ draft_id: 'draft', issue_number: 10 }).update({ status: 'closed', pr_number: 100 });
  await onPlanIssueStatusChanged('draft', 10, S.CLOSED);
  pullRequestState = { state: 'open', merged: false };
  await reconcileEpicExecutionQueues();
  assert.equal((await database('plan_issues').where({ issue_number: 10 }).first()).status, 'under_review');
  assert.equal((await getEpicExecutionQueue('draft'))?.blockedReason, null);
  assert.deepEqual(starts, []);
  await status(10, 'closed');
  pullRequestState = { state: 'closed', merged: true };
  await reconcileEpicExecutionQueues();
  assert.deepEqual(starts, [30]);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 1);
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
