import { up as blockedEvents } from '../src/db/migrations/20261113000000_add_epic_queue_blocked_events.js';
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
 * Graph executions driven through the real plan status writers: a person starting an issue is only
 * visible as an in-progress status notification, so that notification must record the issue's slot.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const starts: number[] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
const startIssue = async ({ issueNumber }: { issueNumber: number }) => { starts.push(issueNumber); };
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({ publishActivity: async () => {} }) } });
await mock.module('../src/config/planIssueDefaults.js', { namedExports: { resolvePlanIssueDefaultSelection: async () => ({}) } });
await mock.module('../src/services/taskPlanningService.js', { namedExports: { checkAndUpdateDraftStatus: async () => {} } });
await mock.module('../src/services/taskPlanning/epicIssueLabelHandoff.js', { namedExports: { releaseEpicIssueLabels: async () => {} } });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => {
  throw new Error('Unexpected GitHub call');
} } });
await mock.module('../src/webhook/planIssueTrigger.js', { namedExports: {
  labelPlanIssueForProcessing: startIssue,
  reconcileTerminalInProgressIssues: async (_repository: string, issues: unknown[]) => issues,
  finalizeEpicPlanIfComplete: async () => true,
} });
const { PlanIssueStatus: S, updatePlanIssue, updatePlanIssueStatus } = await import('../src/config/planIssueManager.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, startEpicQueueHead } = await import('../src/services/taskPlanning/epicExecutionQueue.js');

await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
});
await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.string('repository'); table.integer('issue_number'); table.integer('pr_number');
  table.string('status'); table.string('task_id'); table.timestamp('updated_at');
});
for (const migrate of [up, finalization, useEpic, parallel, recovery, issueStates, graph, blockedEvents]) await migrate(database);
after(async () => database.destroy());

const deps = { startIssue, now: () => 1_000_000 };
beforeEach(async () => {
  for (const table of ['epic_execution_queue_issues', 'epic_execution_queues', 'plan_issues', 'task_drafts']) await database(table).delete();
  await database('task_drafts').insert({ draft_id: 'draft', context_config: '{}' });
  await database('plan_issues').insert([1, 2, 3].map(issue_number => ({ draft_id: 'draft', repository: 'acme/repo', issue_number, status: 'pending' })));
  starts.length = 0;
});

const setPaused = (paused: boolean) => database('task_drafts').where({ draft_id: 'draft' }).update({ paused });
/** One slot; the queue starts issue 1 and the worker picks it up. Issues 2 and 3 are unclaimed and pending. */
async function startSingleSlotGraph() {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [1, 2, 3], mode: 'graph', maxParallel: 1,
    dependsOn: new Map() }, deps);
  await startEpicQueueHead('draft', deps);
  assert.deepEqual(starts, [1]);
  await updatePlanIssue('draft', 1, { status: S.PROCESSING });
}

test('an issue started by hand that closes unmerged before any sweep keeps its slot when the head merges', async () => {
  await startSingleSlotGraph();
  await updatePlanIssue('draft', 2, { status: S.PROCESSING });
  await updatePlanIssue('draft', 2, { status: S.CLOSED });
  const second = (await getEpicExecutionQueue('draft'))!.items[1];
  assert.deepEqual([second.state, second.blockedKind, second.dispatchedAt !== null], ['blocked', 'closed_unmerged', true]);
  await updatePlanIssue('draft', 1, { status: S.MERGED });
  assert.deepEqual(starts, [1], 'issue 2 ran unmerged and still holds the only slot, so issue 3 is not started');
});

test('a manual start seen while the plan is paused is recorded through the repository status writer', async () => {
  await startSingleSlotGraph();
  await setPaused(true);
  await updatePlanIssueStatus('acme/repo', 2, S.PROCESSING);
  await updatePlanIssueStatus('acme/repo', 2, S.CLOSED);
  await setPaused(false);
  await updatePlanIssueStatus('acme/repo', 1, S.MERGED);
  await startEpicQueueHead('draft', deps);
  assert.deepEqual(starts, [1]);
  assert.notEqual((await getEpicExecutionQueue('draft'))!.items[1].dispatchedAt, null, 'the paused manual start was recorded as its slot');
});

test('in-progress notifications leave a sequential execution unchanged', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [1, 2, 3] }, deps);
  await startEpicQueueHead('draft', deps);
  const before = (await getEpicExecutionQueue('draft'))!.items;
  await updatePlanIssue('draft', 2, { status: S.PROCESSING });
  assert.deepEqual((await getEpicExecutionQueue('draft'))!.items, before);
  assert.deepEqual(starts, [1]);
});
