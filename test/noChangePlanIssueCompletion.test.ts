import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

/**
 * A no-change auto-merge completion records the plan issue as merged. That
 * status write notifies the plan's execution queue, which alone selects the
 * successor; this path must never pick an issue itself.
 */
const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
const statusWrites: Array<[string, number, string]> = [];
const getPlanIssuesByDraft = mock.fn(async () => [
    { issue_number: 10, status: 'merged' },
    { issue_number: 20, status: 'pending' },
    { issue_number: 30, status: 'pending' },
]);
const octokit = {
    request: async (route: string, body: Record<string, unknown>) => {
        requests.push({ route, body });
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
        safeUpdateLabels: mock.fn(async () => ({ success: true, removed: [], added: [], errors: [] })),
        updatePlanIssueStatus: mock.fn(async (repository: string, issueNumber: number, status: string) => {
            statusWrites.push([repository, issueNumber, status]);
        }),
        PlanIssueStatus: { MERGED: 'merged' },
        getPlanIssuesByDraft,
        db: mock.fn(() => { throw new Error('No plan lookup expected'); }),
    },
});
await mock.module('../src/github/autoMergeOperations.js', { namedExports: { enableAutoMerge: mock.fn() } });
await mock.module('../src/jobs/issueJob/config.js', { namedExports: { redisClient: {} } });

const { handleNoCodeChanges } = await import('../src/jobs/issueJobPostProcessingHelpers.js');
const logger = { debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn() } as never;

beforeEach(() => {
    requests.length = 0;
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
    assert.deepEqual(labelRequests, []);
    assert.deepEqual(requests.map(request => request.body.issue_number), [10]);
});

test('no-change completion without auto-merge leaves plan status to other observers', async () => {
    await completeWithoutChanges(['AI']);
    assert.deepEqual(statusWrites, []);
    assert.deepEqual(requests.filter(request => request.route.endsWith('/labels')), []);
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
