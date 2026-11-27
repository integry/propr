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
 * An issue job whose wait for disk space ran out never reached its processor.
 * The refusal is reported on the issue, and the plan issue leaves `processing`
 * so the plan shows it; a queued issue is blocked on the reason and is not
 * dispatched again at once by the release of its status.
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
const { PlanIssueStatus: S, updatePlanIssue } = await import('../src/config/planIssueManager.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, startEpicQueueHead, summarizeEpicQueue } = await import('../src/services/taskPlanning/epicExecutionQueue.js');
const { reportIssueDiskPressureRefusal, diskPressureRefusalCommentBody, refusalDetails } = await import('../src/services/issueDiskPressureRefusal.js');
const { diskPressureRefusedReason } = await import('../src/services/taskPlanning/epicQueueBlockedHead.js');

await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
});
await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.string('repository'); table.integer('issue_number'); table.integer('pr_number');
  table.string('status'); table.string('task_id'); table.timestamp('updated_at'); table.timestamp('created_at').defaultTo(database.fn.now());
});
for (const migrate of [up, finalization, useEpic, parallel, recovery, issueStates, graph, blockedEvents]) await migrate(database);
after(async () => database.destroy());

const comments: Array<{ route: string; params: Record<string, unknown> }> = [];
const octokit = { request: async (route: string, params: Record<string, unknown>) => { comments.push({ route, params }); return {}; } };
const NOW = 10_000_000;
const deps = { startIssue, now: () => NOW - 60 * 60_000 };

beforeEach(async () => {
  for (const table of ['epic_execution_queue_issues', 'epic_execution_queues', 'plan_issues', 'task_drafts']) await database(table).delete();
  await database('task_drafts').insert({ draft_id: 'draft', context_config: '{}' });
  await database('plan_issues').insert([1, 2].map(issue_number => ({ draft_id: 'draft', repository: 'acme/repo', issue_number, status: 'pending' })));
  starts.length = 0; comments.length = 0;
});

const refusedJob = (number: number) => ({ id: `issue-acme-repo-${number}`, data: {
  repoOwner: 'acme', repoName: 'repo', number, triggeringLabel: 'AI', diskPressureDeferrals: 6, diskPressureSince: NOW - 60 * 60_000,
} });
const planIssue = (number: number) => database('plan_issues').where({ issue_number: number }).first();

test('an exhausted refusal of a queued issue is reported on the issue and blocks the plan issue instead of leaving it processing', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [1, 2] }, deps);
  await startEpicQueueHead('draft', deps);
  assert.deepEqual(starts, [1]);
  await updatePlanIssue('draft', 1, { status: S.PROCESSING });

  const outcome = await reportIssueDiskPressureRefusal(refusedJob(1), { octokit, database, now: () => NOW });
  assert.deepEqual(outcome, { commented: true, planIssueReleased: true, queueBlocked: true });

  assert.equal(comments.length, 1);
  assert.equal(comments[0].route, 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments');
  assert.equal(comments[0].params.issue_number, 1);
  const body = String(comments[0].params.body);
  assert.match(body, /no free disk space/);
  assert.match(body, /waited about 60 minutes/);
  assert.match(body, /remove the `AI` label from this issue and add it again, or retry the issue from its plan\./);

  assert.equal((await planIssue(1)).status, 'pending', 'no longer reported as processing');
  const queue = (await getEpicExecutionQueue('draft'))!;
  const head = queue.items[0];
  assert.deepEqual([head.state, head.blockedKind, head.blockedReason], ['blocked', 'dispatch_failed', diskPressureRefusedReason(1)]);
  assert.equal(summarizeEpicQueue(queue)?.blockedReason, diskPressureRefusedReason(1));
  // The recovery sweep drives a pending head; the renewed claim holds it for the normal retry interval.
  await startEpicQueueHead('draft', { startIssue, now: () => NOW + 60_000 });
  assert.deepEqual(starts, [1], 'the refused issue is not dispatched again at once');
  assert.equal((await getEpicExecutionQueue('draft'))!.items[0].blockedReason, diskPressureRefusedReason(1));
  assert.equal(queue.items[1].state, 'pending', 'the chain does not move past the refused issue');
});

test('a plan issue that a later attempt already started is left alone; the issue still gets the report', async () => {
  await database('plan_issues').where({ issue_number: 2 }).update({ status: 'processing', task_id: 'task-2' });
  const outcome = await reportIssueDiskPressureRefusal(refusedJob(2), { octokit, database, now: () => NOW });
  assert.deepEqual(outcome, { commented: true, planIssueReleased: false, queueBlocked: false });
  assert.equal((await planIssue(2)).status, 'processing');
  assert.equal(comments.length, 1);
});

test('an issue outside any plan gets the report without a plan retry hint', async () => {
  const outcome = await reportIssueDiskPressureRefusal({ data: { ...refusedJob(9).data, triggeringLabel: 'propr' } }, { octokit, database, now: () => NOW });
  assert.deepEqual(outcome, { commented: true, planIssueReleased: false, queueBlocked: false });
  assert.match(String(comments[0].params.body), /remove the `propr` label from this issue and add it again\.$/);
  assert.equal(diskPressureRefusalCommentBody({ data: {} }, { inPlan: false }).includes('waited about'), false);
});

test('a failed comment is logged, never thrown', async () => {
  const failing = { request: async () => { throw new Error('GitHub unavailable'); } };
  const outcome = await reportIssueDiskPressureRefusal(refusedJob(9), { octokit: failing, database, now: () => NOW });
  assert.equal(outcome.commented, false);
});

test('the comment states what admission measured, from the final error or from the job', async () => {
  const details = 'filesystem /tmp/git-processor: free 6.2 GiB < required 7.0 GiB = reserve 2.0 GiB + 4 other claims × 1.0 GiB + this job 1.0 GiB';
  // Only the message survives the queue round-trip.
  const error = new Error(`Worktree disk pressure: admission reserve unavailable after waiting 60 minutes (7 refusals); data retained (${details})`);
  await reportIssueDiskPressureRefusal(refusedJob(9), { octokit, database, now: () => NOW, error });
  assert.ok(String(comments[0].params.body).includes(`Measured at the last refusal:\n\n\`\`\`\n${details}\n\`\`\``), String(comments[0].params.body));
  assert.equal(refusalDetails({ data: { diskPressureDetails: details } }), details);
  assert.equal(diskPressureRefusalCommentBody({ data: {} }, { inPlan: false }).includes('Measured'), false);
});
