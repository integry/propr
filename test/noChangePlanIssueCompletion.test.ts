import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { safeUpdateLabels } from '../packages/core/src/utils/github/labelOperations.js';
import { createNoChangeCompletionStoreDouble } from './fixtures/noChangeCompletionStoreDouble.js';

/**
 * A no-change auto-merge completion records the plan issue as merged. That
 * status write notifies the plan's execution queue, which alone selects the
 * successor; this path must never pick an issue itself.
 */
const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
const statusWrites: Array<[string, number, string]> = [];
let rejectPrimaryRemoval = false;
let failStatusWrite = false;
let failPlanLookup = false;
let queue: Record<string, unknown> | null = null;
// Mirrors the Redis commands the completion obligation uses.
const redisClient = createNoChangeCompletionStoreDouble();
const store = { clear: () => redisClient.clear(), get size() { return redisClient.records().length; } };
const getPlanIssuesByDraft = mock.fn(async () => [
    { issue_number: 10, status: 'merged' },
    { issue_number: 20, status: 'pending' },
    { issue_number: 30, status: 'pending' },
]);
const octokit = {
    request: async (route: string, body: Record<string, unknown>) => {
        requests.push({ route, body });
        if (rejectPrimaryRemoval && route.startsWith('DELETE ') && body.name === 'AI') throw new Error('GitHub unavailable');
        return { data: {} };
    },
};

await mock.module('@propr/core', {
    namedExports: {
        getEpicExecutionQueue: mock.fn(async () => queue),
        findIssueSubmission: mock.fn(async () => undefined),
        // Mirrors the real lookup: a failed read resolves null unless the caller asks for the failure.
        findPlanIssueByRepoAndNumber: mock.fn(async (_repository: string, _issueNumber: number, options?: { throwOnError?: boolean }) => {
            if (!failPlanLookup) return { draft_id: 'draft', issue_number: 10, status: 'processing' };
            if (options?.throwOnError) throw new Error('database unavailable');
            return null;
        }),
        // Mirrors the real renderer: observed repository validation follows the summary.
        generateCompletionComment: mock.fn(async (result: { repositoryValidation?: string }) => ['Completed.', result?.repositoryValidation].filter(Boolean).join('\n\n')),
        gateAutoMergeArming: mock.fn(),
        getAuthenticatedOctokit: mock.fn(async () => octokit),
        getPrimaryProcessingLabels: mock.fn(() => ['AI']),
        linkPRToPlanIssue: mock.fn(async () => undefined),
        processCommentEvent: mock.fn(async () => undefined),
        safeUpdateLabels,
        updatePlanIssueStatus: mock.fn(async (repository: string, issueNumber: number, status: string) => {
            // The real writer logs and swallows a database failure, resolving false.
            if (failStatusWrite) return false;
            statusWrites.push([repository, issueNumber, status]);
            return true;
        }),
        PlanIssueStatus: { MERGED: 'merged' },
        getPlanIssuesByDraft,
        db: mock.fn(() => { throw new Error('No plan lookup expected'); }),
    },
});
await mock.module('../src/github/autoMergeOperations.js', { namedExports: { enableAutoMerge: mock.fn() } });
await mock.module('../src/jobs/issueJob/config.js', { namedExports: { redisClient } });

const { handleNoCodeChanges } = await import('../src/jobs/issueJobPostProcessingHelpers.js');
const { readNoChangeCompletions } = await import('../src/jobs/noChangeCompletionObligation.js');
const readNoChangeCompletion = async (ref: never) => (await readNoChangeCompletions(ref))[0] ?? null;
const { replayNoChangeCompletion } = await import('../src/jobs/noChangeCompletion.js');
const issue = { repoOwner: 'acme', repoName: 'repo', number: 10 } as never;
const logger = { debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn() } as never;

beforeEach(() => {
    requests.length = 0;
    rejectPrimaryRemoval = false;
    failStatusWrite = false;
    failPlanLookup = false;
    queue = null;
    store.clear();
    statusWrites.length = 0;
    getPlanIssuesByDraft.mock.resetCalls();
});

async function completeWithoutChanges(labels: string[]) {
    return handleNoCodeChanges({
        octokit: octokit as never,
        issueRef: { repoOwner: 'acme', repoName: 'repo', number: 10 } as never,
        claudeResult: { success: true } as never,
        currentIssueData: { data: { labels: labels.map(name => ({ name })) } },
        AI_PROCESSING_TAG: 'AI-processing',
        AI_DONE_TAG: 'AI-done',
        correlatedLogger: logger,
    });
}

test('no-change completion records merged status but leaves successor selection to the queue', async () => {
    // Issue 20 is pending earlier than the selected successor 30; only the queue may choose.
    const result = await completeWithoutChanges(['AI', 'auto-merge', 'base-epic']);
    assert.equal(result.success, true);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.equal(getPlanIssuesByDraft.mock.callCount(), 0);
    const labelRequests = requests.filter(request => request.route.endsWith('/labels'));
    assert.deepEqual(labelRequests.map(request => request.body.labels), [['AI-done']]);
    assert.deepEqual(requests.map(request => request.body.name ?? request.body.labels ?? 'comment'),
        [['AI-done'], 'AI', 'AI-processing', 'comment']);
    assert.ok(requests.every(request => request.body.issue_number === 10));
    assert.equal(store.size, 0, 'a finished completion owes nothing');
});

test('no-change completion without auto-merge leaves plan status to other observers', async () => {
    await completeWithoutChanges(['AI']);
    assert.deepEqual(statusWrites, []);
    assert.deepEqual(requests.filter(request => request.route.endsWith('/labels')).map(request => request.body.labels), [['AI-done']]);
});

test('with on_blocker: report, a genuine no-change completion of a queue head that was blocked earlier is still marked merged', async () => {
    // A previous run stopped on a blocker; this rerun succeeded without a diff or a blocker marker.
    queue = { status: 'active', issues: [10, 30], cursor: 0,
        items: [{ issueNumber: 10, state: 'blocked', blockedKind: 'agent_blocked' }, { issueNumber: 30, state: 'pending' }],
        blockedReason: 'Issue #10 stopped on a blocker reported by the agent; resolve the blocker and request processing again to continue this epic.' };
    const result = await completeWithoutChanges(['AI']);
    assert.equal(result.success, true);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']], 'the merged status advances the queue');
    assert.deepEqual(requests.filter(request => request.route.endsWith('/labels')).map(request => request.body.labels), [['AI-done']]);
});

test('a no-change issue completion keeps the observed repository validation report', async () => {
    const repositoryValidation = '### Repository validation\n\n- [1] npm test: Passed\n- [2] npm run lint: Not run (execution time limit reached)';
    await handleNoCodeChanges({
        octokit: octokit as never,
        issueRef: { repoOwner: 'acme', repoName: 'repo', number: 10 } as never,
        claudeResult: { success: true, repositoryValidation } as never,
        currentIssueData: { data: { labels: [{ name: 'AI' }] } },
        AI_PROCESSING_TAG: 'AI-processing',
        AI_DONE_TAG: 'AI-done',
        correlatedLogger: logger,
    });
    const [comment] = requests.filter(request => request.route.endsWith('/comments'));
    assert.match(String(comment.body.body), /No code changes needed/);
    assert.ok(String(comment.body.body).includes(repositoryValidation));
});

test('failed trigger cleanup keeps the published completion owed until a replay finishes it', async () => {
    rejectPrimaryRemoval = true;
    await assert.rejects(completeWithoutChanges(['AI', 'auto-merge']), /Failed to remove 'AI'/);
    assert.deepEqual(statusWrites, []);
    assert.ok(!requests.some(request => request.route.endsWith('/comments')));
    const held = await readNoChangeCompletion(issue);
    assert.ok(held, 'the done marker was published, so the remaining steps stay owed');
    assert.deepEqual(held.record.labels, ['AI', 'auto-merge']);

    // A later job finds the marker; the replay finishes the cleanup, comment and status write.
    rejectPrimaryRemoval = false;
    requests.length = 0;
    const labels = await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI', 'AI-done'], held, correlatedLogger: logger });
    assert.deepEqual(labels, ['AI-done']);
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.equal(requests.filter(request => request.route.endsWith('/comments')).length, 1);
    assert.match(String(requests.find(request => request.route.endsWith('/comments'))?.body.body), /No code changes needed/);
    assert.equal(store.size, 0);
});

test('a failed plan-status write stays owed after the comment, which a replay does not repeat', async () => {
    failStatusWrite = true;
    const result = await completeWithoutChanges(['AI', 'auto-merge']);
    assert.equal(result.success, true);
    const held = await readNoChangeCompletion(issue);
    assert.ok(held);
    assert.equal(held.record.comment, undefined, 'the posted comment is no longer owed');
    assert.equal(held.record.commentClaim, undefined);

    failStatusWrite = false;
    requests.length = 0;
    await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI-done'], held, correlatedLogger: logger });
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.ok(!requests.some(request => request.route.endsWith('/comments')));
    assert.equal(store.size, 0);
});

test('a failed plan lookup keeps the status write owed instead of reading as an issue outside every plan', async () => {
    failPlanLookup = true;
    await completeWithoutChanges(['AI', 'auto-merge']);
    const held = await readNoChangeCompletion(issue);
    assert.ok(held, 'the plan issue may still be nonterminal, so the record stays for replay');
    assert.deepEqual(statusWrites, []);

    failPlanLookup = false;
    await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI-done'], held, correlatedLogger: logger });
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.equal(store.size, 0);
});

test('a completion whose done marker was never published is not replayed', async () => {
    const held = await (await import('../src/jobs/noChangeCompletionObligation.js')).retainNoChangeCompletion(issue, {
        processingTag: 'AI-processing', doneTag: 'AI-done', labels: ['AI', 'auto-merge'], comment: 'done',
    });
    const labels = await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI'], held, correlatedLogger: logger });
    assert.deepEqual(labels, ['AI']);
    assert.deepEqual(requests, []);
    assert.deepEqual(statusWrites, []);
});

test('settling one completion never releases another retained for the same issue', async () => {
    const obligations = await import('../src/jobs/noChangeCompletionObligation.js');
    const older = await obligations.retainNoChangeCompletion(issue, { processingTag: 'AI-processing', doneTag: 'AI-done', labels: [] });
    const newer = await obligations.retainNoChangeCompletion(issue, { processingTag: 'AI-processing', doneTag: 'AI-done', labels: [] });
    assert.equal(await obligations.replaceNoChangeCompletion(older, null), null);
    assert.deepEqual((await readNoChangeCompletions(issue)).map(held => held.record.id), [newer.record.id]);
    // A stale copy of a record cannot release it.
    assert.equal(await obligations.replaceNoChangeCompletion({ ...newer, raw: older.raw }, null), null);
    assert.equal((await readNoChangeCompletions(issue)).length, 1);
});
