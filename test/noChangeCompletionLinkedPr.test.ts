import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { safeUpdateLabels } from '../packages/core/src/utils/github/labelOperations.js';
import { up as addPlanIssues } from '../packages/core/src/db/migrations/20260120000000_add_plan_issues.js';
import { createNoChangeCompletionStoreDouble } from './fixtures/noChangeCompletionStoreDouble.js';

/**
 * Two models of one request run concurrently: model A finishes without
 * changes, model B publishes a pull request. A pull request linked to the plan
 * issue and still awaiting merge owns its status, so A's no-change completion,
 * whether written first time, replayed by a later job or recovered by the
 * sweep, must not mark the issue merged and release the epic successor before
 * that pull request merges. The real plan-issue writer runs against SQLite.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
/** Every epic queue notification, as the queue would receive it. */
const notified: Array<[string, number, string]> = [];
await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: database } });
await mock.module('../packages/core/src/utils/logger.js', { defaultExport: quiet });
await mock.module('../packages/core/src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({ publishActivity: async () => true }) } });
await mock.module('../packages/core/src/config/planIssueDefaults.js', { namedExports: { resolvePlanIssueDefaultSelection: async () => ({}) } });
await mock.module('../packages/core/src/services/taskPlanningService.js', { namedExports: { checkAndUpdateDraftStatus: async () => undefined } });
await mock.module('../packages/core/src/services/taskPlanning/epicExecutionQueue.js', { namedExports: {
    onPlanIssueStatusChanged: async (draftId: string, issueNumber: number, status: string) => { notified.push([draftId, issueNumber, status]); },
} });
const plan = await import('../packages/core/src/config/planIssueManager.js');

let liveLabels: string[] = [];
const comments: string[] = [];
const octokit = {
    request: async (route: string, body: Record<string, unknown>) => {
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') return { data: { labels: liveLabels.map(name => ({ name })) } };
        if (route.endsWith('/labels')) { for (const label of body.labels as string[]) if (!liveLabels.includes(label)) liveLabels.push(label); return { data: {} }; }
        if (route.startsWith('DELETE ')) { liveLabels = liveLabels.filter(label => label !== body.name); return { data: {} }; }
        if (route.startsWith('GET ') && route.endsWith('/comments')) return { data: comments.map(text => ({ body: text })) };
        if (route.endsWith('/comments')) { comments.push(String(body.body)); return { data: {} }; }
        throw new Error(`Unexpected route ${route}`);
    },
};
let failStatusWrite = false;
/** Runs after the writer's final ownership check, immediately before its update. */
let beforeUpdate: (() => Promise<void>) | undefined;
await mock.module('@propr/core', { namedExports: {
    getEpicExecutionQueue: async () => ({ status: 'active', issues: [10, 20], cursor: 0 }),
    findPlanIssueByRepoAndNumber: plan.findPlanIssueByRepoAndNumber,
    getAuthenticatedOctokit: async () => octokit,
    logger: quiet,
    safeUpdateLabels,
    updatePlanIssueStatus: async (...[repository, issueNumber, status, options]: Parameters<typeof plan.updatePlanIssueStatus>) => {
        // The real writer logs and swallows a database failure, resolving false.
        if (failStatusWrite) return false;
        const stillApplies = options?.stillApplies;
        return plan.updatePlanIssueStatus(repository, issueNumber, status, { ...options,
            stillApplies: async () => { const owns = stillApplies ? await stillApplies() : true; await beforeUpdate?.(); return owns; } });
    },
    PlanIssueStatus: plan.PlanIssueStatus,
} });
const redisClient = createNoChangeCompletionStoreDouble();
await mock.module('../src/jobs/issueJob/config.js', { namedExports: { redisClient } });
const { completeNoChangeIssue, replayNoChangeCompletion } = await import('../src/jobs/noChangeCompletion.js');
const { recoverNoChangeCompletions } = await import('../src/jobs/noChangeCompletionRecovery.js');
const { readNoChangeCompletions } = await import('../src/jobs/noChangeCompletionObligation.js');

await database.schema.createTable('task_drafts', table => { table.uuid('draft_id').primary(); });
await addPlanIssues(database);
after(() => database.destroy());

const repository = 'acme/repo';
/** Both models belong to one dispatched request, so they share its correlation ID. */
const issue = { repoOwner: 'acme', repoName: 'repo', number: 10, correlationId: 'request-1', triggeringLabel: 'AI', dispatchId: 'dispatch-1' } as never;
const planRow = async () => database('plan_issues').where({ repository, issue_number: 10 }).first('status', 'pr_number');
const owedCount = () => redisClient.records().length;

beforeEach(async () => {
    await database('plan_issues').delete();
    await database('task_drafts').delete();
    await database('task_drafts').insert({ draft_id: 'draft' });
    await database('plan_issues').insert({ draft_id: 'draft', repository, issue_number: 10, status: 'processing' });
    redisClient.clear(); notified.length = 0; comments.length = 0;
    liveLabels = ['AI', 'AI-processing', 'auto-merge']; failStatusWrite = false; beforeUpdate = undefined;
});

/** Model A finds the work already done. */
const completeModelA = () => completeNoChangeIssue({
    octokit: octokit as never, issueRef: issue, labels: ['AI', 'auto-merge'], comment: 'No code changes needed',
    AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: quiet as never,
});
/** Model B publishes a pull request: the worker links it to the plan issue. */
const publishModelBPullRequest = () => plan.linkPRToPlanIssue(repository, 10, 42);

/** A finishes first, but its status write fails, so the write stays owed; B then opens its pull request. */
async function aOwesStatusWhenBLinksItsPullRequest() {
    failStatusWrite = true;
    await completeModelA();
    failStatusWrite = false;
    assert.equal(owedCount(), 1, 'A\'s plan-status write is owed');
    await publishModelBPullRequest();
    assert.deepEqual(await planRow(), { status: 'under_review', pr_number: 42 });
}

test('recovery leaves a sibling\'s unmerged pull request under review and settles the obsolete no-change write', async () => {
    await aOwesStatusWhenBLinksItsPullRequest();
    const later = () => Date.now() + 60 * 60_000;
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, now: later, log: quiet }), 1);
    assert.deepEqual(await planRow(), { status: 'under_review', pr_number: 42 }, 'B\'s review status is preserved');
    assert.deepEqual(notified, [], 'the epic successor is not released');
    assert.equal(owedCount(), 0, 'the pull request owns the status now');
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, now: later, log: quiet }), 0);

    // B's merge records the outcome and releases the successor.
    await plan.updatePlanIssueByPR(repository, 42, { status: plan.PlanIssueStatus.MERGED });
    assert.deepEqual(notified, [['draft', 10, 'merged']]);
});

test('a later job\'s replay leaves a sibling\'s pull request in refinement untouched', async () => {
    await aOwesStatusWhenBLinksItsPullRequest();
    await database('plan_issues').where({ repository, issue_number: 10 }).update({ status: 'in_refinement' });
    // The worker replays owed completions it finds before the already-done skip.
    liveLabels = ['AI-done', 'auto-merge'];
    const [held] = await readNoChangeCompletions(issue);
    await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: liveLabels, held, correlatedLogger: quiet as never });
    assert.deepEqual(await planRow(), { status: 'in_refinement', pr_number: 42 });
    assert.deepEqual(notified, []);
    assert.equal(owedCount(), 0);
    assert.equal(comments.length, 1, 'the delivered completion comment is not repeated');
});

test('a pull request linked after the writer\'s last ownership check still keeps its status', async () => {
    beforeUpdate = async () => { beforeUpdate = undefined; await publishModelBPullRequest(); };
    await completeModelA();
    assert.deepEqual(await planRow(), { status: 'under_review', pr_number: 42 });
    assert.deepEqual(notified, []);
    assert.equal(owedCount(), 0);
});

test('a no-change completion still marks merged when no linked pull request awaits merge', async () => {
    // An earlier attempt's pull request was closed unmerged; the issue was then reprocessed.
    await database('plan_issues').where({ repository, issue_number: 10 }).update({ pr_number: 41, status: 'closed' });
    await completeModelA();
    assert.deepEqual(await planRow(), { status: 'merged', pr_number: 41 });
    assert.deepEqual(notified, [['draft', 10, 'merged']]);
    assert.equal(owedCount(), 0);

    // An owed write recovered with no pull request linked at all also lands.
    await database('plan_issues').where({ repository, issue_number: 10 }).update({ pr_number: null, status: 'processing' });
    notified.length = 0;
    liveLabels = ['AI', 'AI-processing', 'auto-merge'];
    failStatusWrite = true;
    await completeModelA();
    failStatusWrite = false;
    assert.equal(await recoverNoChangeCompletions({ store: redisClient as never, now: () => Date.now() + 60 * 60_000, log: quiet }), 1);
    assert.deepEqual(await planRow(), { status: 'merged', pr_number: null });
    assert.deepEqual(notified, [['draft', 10, 'merged']]);
    assert.equal(owedCount(), 0);
});
