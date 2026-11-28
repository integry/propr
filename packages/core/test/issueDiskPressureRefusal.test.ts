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
 * dispatched again at once by the release of its status. Only a plan issue
 * that is not finished and is linked to this run (no task yet, or a task with
 * this job's correlation ID) is changed.
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
await database.schema.createTable('tasks', table => { table.string('task_id').primary(); table.string('correlation_id'); });
for (const migrate of [up, finalization, useEpic, parallel, recovery, issueStates, graph, blockedEvents]) await migrate(database);
after(async () => database.destroy());

const comments: Array<{ route: string; params: Record<string, unknown> }> = [];
const octokit = { request: async (route: string, params: Record<string, unknown>) => { comments.push({ route, params }); return {}; } };
const NOW = 10_000_000;
const deps = { startIssue, now: () => NOW - 60 * 60_000 };

beforeEach(async () => {
  for (const table of ['epic_execution_queue_issues', 'epic_execution_queues', 'plan_issues', 'task_drafts', 'tasks']) await database(table).delete();
  await database('task_drafts').insert({ draft_id: 'draft', context_config: '{}' });
  await database('plan_issues').insert([1, 2].map(issue_number => ({ draft_id: 'draft', repository: 'acme/repo', issue_number, status: 'pending' })));
  starts.length = 0; comments.length = 0;
});

const refusedJob = (number: number) => ({ id: `issue-acme-repo-${number}`, data: {
  repoOwner: 'acme', repoName: 'repo', number, triggeringLabel: 'AI', correlationId: `corr-${number}`, diskPressureDeferrals: 6, diskPressureSince: NOW - 60 * 60_000,
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
  assert.match(body, /Then remove the `AI` label from this issue and add it again, or retry the issue from its plan\.$/);
  // The failed job stays as evidence and deduplicates a relabel: the comment says so, and how to clear it.
  assert.match(body, /\*\*Relabeling will not retry this issue until the stale job `issue-acme-repo-1` is cleared\*\* \(or until integry\/propr#3873 lands\)\./);
  assert.ok(body.includes('```\nredis-cli ZREM bull:github-issue-processor:failed issue-acme-repo-1\nredis-cli DEL bull:github-issue-processor:issue-acme-repo-1 bull:github-issue-processor:issue-acme-repo-1:logs\n```'), body);
  assert.doesNotMatch(body, /automatic|will be retried|picks it up again/i, 'no automatic retry is promised');

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

test('a plan issue another run\'s task owns is left alone; the issue still gets the report', async () => {
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [2] }, deps);
  await database('tasks').insert({ task_id: 'task-2', correlation_id: 'corr-other-run' });
  await database('plan_issues').where({ issue_number: 2 }).update({ status: 'processing', task_id: 'task-2' });
  const outcome = await reportIssueDiskPressureRefusal(refusedJob(2), { octokit, database, now: () => NOW });
  assert.deepEqual(outcome, { commented: true, planIssueReleased: false, queueBlocked: false });
  assert.equal((await planIssue(2)).status, 'processing');
  assert.notEqual((await getEpicExecutionQueue('draft'))!.items[0].state, 'blocked', 'the other run\'s execution is not blocked');
  assert.equal(comments.length, 1);
});

for (const status of ['merged', 'closed', 'under_review', 'in_refinement'] as const) {
  test(`a plan issue that is ${status} is never reset by a refusal`, async () => {
    await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [1] }, deps);
    await database('plan_issues').where({ issue_number: 1 }).update({ status, pr_number: 10 });
    const before = await planIssue(1);
    const outcome = await reportIssueDiskPressureRefusal(refusedJob(1), { octokit, database, now: () => NOW });
    assert.deepEqual(outcome, { commented: true, planIssueReleased: false, queueBlocked: false });
    assert.deepEqual(await planIssue(1), before, 'the finished plan issue is not touched at all');
    assert.equal((await getEpicExecutionQueue('draft'))!.items[0].blockedReason ?? null, null);
  });
}

test('the newest occurrence decides: a finished newest plan issue leaves an older processing one alone too', async () => {
  await database('task_drafts').insert({ draft_id: 'older', context_config: '{}' });
  await database('plan_issues').where({ issue_number: 4 }).delete();
  const [oldId] = await database('plan_issues').insert({ draft_id: 'older', repository: 'acme/repo', issue_number: 4, status: 'processing' });
  await database('plan_issues').insert({ draft_id: 'draft', repository: 'acme/repo', issue_number: 4, status: 'merged', pr_number: 40 });
  const outcome = await reportIssueDiskPressureRefusal(refusedJob(4), { octokit, database, now: () => NOW });
  assert.equal(outcome.planIssueReleased, false);
  assert.equal((await database('plan_issues').where({ id: oldId }).first()).status, 'processing', 'historical rows are never reset');
});

test('only the refused occurrence is released; the issue\'s completed occurrence in an older draft keeps its status', async () => {
  await database('task_drafts').insert({ draft_id: 'older', context_config: '{}' });
  await database('plan_issues').where({ issue_number: 3 }).delete();
  // The older draft's row first, so the lookup picks the newer draft's row.
  const [oldId] = await database('plan_issues').insert({ draft_id: 'older', repository: 'acme/repo', issue_number: 3, status: 'merged', pr_number: 30 });
  await database('plan_issues').insert({ draft_id: 'draft', repository: 'acme/repo', issue_number: 3, status: 'processing' });
  const before = await database('plan_issues').where({ id: oldId }).first();

  const outcome = await reportIssueDiskPressureRefusal(refusedJob(3), { octokit, database, now: () => NOW });
  assert.equal(outcome.planIssueReleased, true);
  assert.deepEqual(await database('plan_issues').where({ issue_number: 3 }).orderBy('id').pluck('status'), ['merged', 'pending']);
  assert.deepEqual(await database('plan_issues').where({ id: oldId }).first(), before, 'the historical row is not touched at all');
});

test('an issue outside any plan gets the report without a plan retry hint', async () => {
  const outcome = await reportIssueDiskPressureRefusal({ ...refusedJob(9), data: { ...refusedJob(9).data, triggeringLabel: 'propr' } }, { octokit, database, now: () => NOW });
  assert.deepEqual(outcome, { commented: true, planIssueReleased: false, queueBlocked: false });
  assert.match(String(comments[0].params.body), /Then remove the `propr` label from this issue and add it again\.$/);
  // Without a job ID the comment still says a relabel does not retry until the stale job is cleared.
  const noId = diskPressureRefusalCommentBody({ data: { triggeringLabel: 'propr' } }, { inPlan: false, queueName: 'q' });
  assert.match(noId, /\*\*Relabeling will not retry this issue until the stale failed job for it is cleared\*\* from the worker's queue `q`/);
  assert.match(noId, /`bull:q:failed`/);
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

test('a refused retry of a job whose earlier attempt ran says the latest attempt was refused, and releases its own plan issue', async () => {
  // An earlier attempt of this run passed admission, recorded its task on the plan issue and failed; its retry was refused.
  await database('tasks').insert({ task_id: 'task-2', correlation_id: 'corr-2' });
  await database('plan_issues').where({ issue_number: 2 }).update({ status: 'processing', task_id: 'task-2' });
  const job = { ...refusedJob(2), data: { ...refusedJob(2).data, issueJobAdmitted: true } };
  const outcome = await reportIssueDiskPressureRefusal(job, { octokit, database, now: () => NOW });
  assert.deepEqual(outcome, { commented: true, planIssueReleased: true, queueBlocked: false });
  const body = String(comments[0].params.body);
  assert.doesNotMatch(body, /could not start on this issue/);
  assert.doesNotMatch(body, /nothing was changed/i);
  assert.doesNotMatch(body, /no branch, commit or pull request was created/);
  assert.match(body, /stopped retrying this issue: the worker had no free disk space/);
  assert.match(body, /The latest attempt was refused because the disk .* is nearly full, after an earlier attempt of this run had already started\./);
  assert.match(body, /Work from the earlier attempt .* may remain\./);
  assert.match(body, /waited about 60 minutes/);
  assert.equal((await planIssue(2)).status, 'pending', 'the task of this run does not keep the plan issue processing');

  // Without an admitted attempt the job never started, and the comment says so.
  assert.match(diskPressureRefusalCommentBody(refusedJob(2), { inPlan: true, now: NOW }), /No attempt of this run started, so nothing was changed: no branch, commit or pull request was created\./);
});
