import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { safeUpdateLabels } from '../packages/core/src/utils/github/labelOperations.js';

/**
 * A no-change auto-merge completion records the plan issue as merged. That
 * status write notifies the plan's execution queue, which alone selects the
 * successor; this path must never pick an issue itself.
 */
const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
const statusWrites: Array<[string, number, string]> = [];
let rejectPrimaryRemoval = false;
let failStatusWrite = false;
// Mirrors the Redis commands the completion obligation uses.
const store = new Map<string, string>();
const redisClient = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => { store.set(key, value); return 'OK'; },
    eval: async (script: string, _keys: number, key: string, expected: string, next: string) => {
        assert.match(script, /redis.call\('GET', KEYS\[1\]\)/);
        if (store.get(key) !== expected) return 0;
        if (next === '') store.delete(key); else store.set(key, next);
        return 1;
    },
};
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
        getEpicExecutionQueue: mock.fn(async () => null),
        findIssueSubmission: mock.fn(async () => undefined),
        findPlanIssueByRepoAndNumber: mock.fn(async () => ({ draft_id: 'draft', issue_number: 10, status: 'processing' })),
        // Mirrors the real renderer: observed repository validation follows the summary.
        generateCompletionComment: mock.fn(async (result: { repositoryValidation?: string }) => ['Completed.', result?.repositoryValidation].filter(Boolean).join('\n\n')),
        gateAutoMergeArming: mock.fn(),
        getAuthenticatedOctokit: mock.fn(async () => octokit),
        getPrimaryProcessingLabels: mock.fn(() => ['AI']),
        linkPRToPlanIssue: mock.fn(async () => undefined),
        processCommentEvent: mock.fn(async () => undefined),
        safeUpdateLabels,
        updatePlanIssueStatus: mock.fn(async (repository: string, issueNumber: number, status: string) => {
            if (failStatusWrite) throw new Error('database unavailable');
            statusWrites.push([repository, issueNumber, status]);
        }),
        PlanIssueStatus: { MERGED: 'merged' },
        getPlanIssuesByDraft,
        db: mock.fn(() => { throw new Error('No plan lookup expected'); }),
    },
});
await mock.module('../src/github/autoMergeOperations.js', { namedExports: { enableAutoMerge: mock.fn() } });
await mock.module('../src/jobs/issueJob/config.js', { namedExports: { redisClient } });

const { handleNoCodeChanges } = await import('../src/jobs/issueJobPostProcessingHelpers.js');
const { readNoChangeCompletion } = await import('../src/jobs/noChangeCompletionObligation.js');
const { replayNoChangeCompletion } = await import('../src/jobs/noChangeCompletion.js');
const issue = { repoOwner: 'acme', repoName: 'repo', number: 10 } as never;
const logger = { debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn() } as never;

beforeEach(() => {
    requests.length = 0;
    rejectPrimaryRemoval = false;
    failStatusWrite = false;
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

    failStatusWrite = false;
    requests.length = 0;
    await replayNoChangeCompletion({ octokit: octokit as never, issueRef: issue, currentLabels: ['AI-done'], held, correlatedLogger: logger });
    assert.deepEqual(statusWrites, [['acme/repo', 10, 'merged']]);
    assert.ok(!requests.some(request => request.route.endsWith('/comments')));
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

test('settling never releases a newer completion retained for the same issue', async () => {
    const obligations = await import('../src/jobs/noChangeCompletionObligation.js');
    const older = await obligations.retainNoChangeCompletion(issue, { processingTag: 'AI-processing', doneTag: 'AI-done', labels: [] });
    const newer = await obligations.retainNoChangeCompletion(issue, { processingTag: 'AI-processing', doneTag: 'AI-done', labels: [] });
    assert.equal(await obligations.replaceNoChangeCompletion(older, null), null);
    assert.equal((await readNoChangeCompletion(issue))?.record.id, newer.record.id);
});
