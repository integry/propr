import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const mockQueueAdd = mock.fn(async () => ({}));
const mockQueueGetJobs = mock.fn(async () => []);
const mockOctokitRequest = mock.fn(async () => ({
    data: { labels: [{ name: 'ultrafix' }] },
}));
const mockGetCurrentPRHead = mock.fn(async () => 'red-head-sha');
const mockGetCheckRunsStatus = mock.fn(async () => ({
    count: 1,
    allPassing: false,
    anyPending: false,
    anyFailed: true,
}));
const mockAreAllChecksPassing = mock.fn(async () => false);

await mock.module('@propr/core', {
    namedExports: {
        findPlanIssueByRepoAndPR: mock.fn(async () => null),
        generateCorrelationId: mock.fn(() => 'next-correlation-id'),
        getAuthenticatedOctokit: mock.fn(async () => ({ request: mockOctokitRequest })),
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending:${owner}:${repo}:${pr}`,
        issueQueue: {
            add: mockQueueAdd,
            getJobs: mockQueueGetJobs,
        },
        retryConfigs: { githubApi: {} },
        safeRemoveLabel: mock.fn(async () => undefined),
        withRetry: async (operation: () => Promise<unknown>) => operation(),
    },
});

await mock.module('../src/github/autoMergeOperations.js', {
    namedExports: {
        enableAutoMerge: mock.fn(async () => ({ success: true })),
    },
});

await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: {
        fetchAllComments: mock.fn(async () => []),
    },
});

await mock.module('../src/jobs/reviewCommentGatherer.js', {
    namedExports: {
        getPendingReviewState: mock.fn(async () => ({
            latestScore: 5,
            reviewStatus: 'valid_with_blockers',
            hasPendingReview: true,
            unprocessedComments: [],
        })),
    },
});

const {
    continueUltrafixLoop,
    setCheckRunDeps,
} = await import('../src/jobs/ultrafixLoopContinuation.js');
const {
    loadDeferredContinuation,
    startLoop,
} = await import('../src/jobs/ultrafixOrchestrationService.js');

function createMockRedis() {
    const store = new Map<string, string>();
    return {
        async get(key: string) { return store.get(key) ?? null; },
        async set(key: string, value: string) { store.set(key, value); return 'OK'; },
        async del(key: string) { return store.delete(key) ? 1 : 0; },
        async eval(_script: string, _keyCount: number, ...args: string[]) {
            const [epochKey, deferredKey, expectedEpoch, serializedDeferred] = args;
            if ((store.get(epochKey) ?? '0') !== expectedEpoch) return 0;
            store.set(deferredKey, serializedDeferred);
            return 1;
        },
        async llen(_key: string) { return 0; },
    };
}

const logger = {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
};

describe('Ultrafix continuation entry point', () => {
    beforeEach(() => {
        mockQueueAdd.mock.resetCalls();
        mockQueueGetJobs.mock.resetCalls();
        mockOctokitRequest.mock.resetCalls();
        mockGetCurrentPRHead.mock.resetCalls();
        mockGetCheckRunsStatus.mock.resetCalls();
        mockAreAllChecksPassing.mock.resetCalls();
        setCheckRunDeps({
            areAllChecksPassing: mockAreAllChecksPassing,
            getCurrentPRHead: mockGetCurrentPRHead,
            getCheckRunsStatus: mockGetCheckRunsStatus,
        });
    });

    test('a completed review enqueues the concrete fix action without consulting red CI', async () => {
        const redis = createMockRedis();
        await startLoop(redis as never, { owner: 'acme', repo: 'web', pr: 42, goal: 8 }, false);

        const result = await continueUltrafixLoop({
            owner: 'acme',
            repo: 'web',
            pullRequestNumber: 42,
            completedAction: 'review',
            ultrafixMeta: { mode: 'ultrafix', goal: 8, instructions: '' },
            redisClient: redis as never,
            correlatedLogger: logger as never,
            correlationId: 'review-correlation-id',
            currentJobId: 'completed-review-job',
            currentReviewCommentIds: [101],
            currentReviewResultCount: 1,
        });

        assert.equal(result.continued, true);
        assert.equal(result.nextAction, 'fix');
        assert.equal(mockGetCurrentPRHead.mock.callCount(), 0);
        assert.equal(mockGetCheckRunsStatus.mock.callCount(), 0);
        assert.equal(mockQueueAdd.mock.callCount(), 1);
        assert.equal(mockQueueAdd.mock.calls[0].arguments[1].commandMode, 'fix');
        assert.equal(await loadDeferredContinuation(redis as never, 'acme', 'web', 42), null);
    });

    test('a completed fix defers the concrete review action while CI is red', async () => {
        const redis = createMockRedis();
        await startLoop(redis as never, { owner: 'acme', repo: 'web', pr: 43, goal: 8 }, false);

        const result = await continueUltrafixLoop({
            owner: 'acme',
            repo: 'web',
            pullRequestNumber: 43,
            completedAction: 'fix',
            ultrafixMeta: { mode: 'ultrafix', goal: 8, instructions: '' },
            redisClient: redis as never,
            correlatedLogger: logger as never,
            correlationId: 'fix-correlation-id',
            currentJobId: 'completed-fix-job',
        });

        assert.equal(result.continued, false);
        assert.equal(result.deferred, true);
        assert.equal(result.nextAction, 'review');
        assert.match(result.reason, /checks_not_passing/);
        assert.equal(mockGetCurrentPRHead.mock.callCount(), 1);
        assert.equal(mockGetCheckRunsStatus.mock.callCount(), 1);
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        assert.equal(
            (await loadDeferredContinuation(redis as never, 'acme', 'web', 43))?.nextAction,
            'review',
        );
    });
});
