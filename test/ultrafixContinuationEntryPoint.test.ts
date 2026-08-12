import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const mockQueueAdd = mock.fn(async () => ({}));
const mockQueueGetJobs = mock.fn(async () => []);
const mockGetIssueQueue = mock.fn(async () => ({
    add: mockQueueAdd,
    getJobs: mockQueueGetJobs,
}));
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
const mockFindPlanIssueByRepoAndPR = mock.fn(async () => null as { issue_number: number } | null);
const mockEnableAutoMerge = mock.fn(async () => ({ success: true }));
const mockGetPendingReviewState = mock.fn(async () => ({
    latestScore: 5,
    reviewStatus: 'valid_with_blockers' as const,
    hasPendingReview: true,
    unprocessedComments: [],
    isPartial: false,
}));
let labelTransitionActive = false;

await mock.module('@propr/core', {
    namedExports: {
        findPlanIssueByRepoAndPR: mockFindPlanIssueByRepoAndPR,
        generateCorrelationId: mock.fn(() => 'next-correlation-id'),
        getAuthenticatedOctokit: mock.fn(async () => ({ request: mockOctokitRequest })),
        getIssueQueue: mockGetIssueQueue,
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending:${owner}:${repo}:${pr}`,
        retryConfigs: { githubApi: {} },
        safeRemoveLabel: mock.fn(async () => undefined),
        withUltrafixLabelTransition: async (_redis: unknown, _identity: unknown, operation: () => Promise<unknown>) => {
            labelTransitionActive = true;
            try {
                return await operation();
            } finally {
                labelTransitionActive = false;
            }
        },
        withRetry: async (operation: () => Promise<unknown>) => operation(),
    },
});

await mock.module('../src/github/autoMergeOperations.js', {
    namedExports: {
        enableAutoMerge: mockEnableAutoMerge,
    },
});

await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: {
        fetchAllComments: mock.fn(async () => []),
    },
});

await mock.module('../src/jobs/reviewCommentGatherer.js', {
    namedExports: {
        getPendingReviewState: mockGetPendingReviewState,
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
        mockGetIssueQueue.mock.resetCalls();
        mockOctokitRequest.mock.resetCalls();
        mockGetCurrentPRHead.mock.resetCalls();
        mockGetCheckRunsStatus.mock.resetCalls();
        mockAreAllChecksPassing.mock.resetCalls();
        mockFindPlanIssueByRepoAndPR.mock.resetCalls();
        mockFindPlanIssueByRepoAndPR.mock.mockImplementation(async () => null);
        mockEnableAutoMerge.mock.resetCalls();
        mockEnableAutoMerge.mock.mockImplementation(async () => ({ success: true }));
        mockGetPendingReviewState.mock.resetCalls();
        mockGetPendingReviewState.mock.mockImplementation(async () => ({
            latestScore: 5,
            reviewStatus: 'valid_with_blockers',
            hasPendingReview: true,
            unprocessedComments: [],
            isPartial: false,
        }));
        labelTransitionActive = false;
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
        assert.ok(mockGetIssueQueue.mock.callCount() >= 2, 'readiness and enqueue both resolve the lazy queue');
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

    test('successful terminal auto-merge remains inside epoch transition ownership', async () => {
        const redis = createMockRedis();
        await startLoop(redis as never, { owner: 'acme', repo: 'web', pr: 44, goal: 8 }, false);
        mockGetPendingReviewState.mock.mockImplementation(async () => ({
            latestScore: 8,
            reviewStatus: 'valid_clean',
            hasPendingReview: false,
            unprocessedComments: [],
            isPartial: false,
        }));
        mockFindPlanIssueByRepoAndPR.mock.mockImplementation(async () => ({ issue_number: 99 }));
        mockOctokitRequest.mock.mockImplementation(async (_route: string, options: Record<string, unknown>) => ({
            data: { labels: [{ name: options.issue_number === 99 ? 'auto-merge' : 'ultrafix' }] },
        }));
        mockEnableAutoMerge.mock.mockImplementation(async () => {
            assert.equal(labelTransitionActive, true);
            return { success: true };
        });

        const result = await continueUltrafixLoop({
            owner: 'acme',
            repo: 'web',
            pullRequestNumber: 44,
            completedAction: 'review',
            ultrafixMeta: { mode: 'ultrafix', goal: 8, instructions: '' },
            redisClient: redis as never,
            correlatedLogger: logger as never,
            correlationId: 'terminal-review-correlation-id',
            currentJobId: 'completed-clean-review-job',
            currentReviewCommentIds: [202],
            currentReviewResultCount: 1,
        });

        assert.equal(result.continued, false);
        assert.equal(mockEnableAutoMerge.mock.callCount(), 1);
        assert.equal(labelTransitionActive, false);
    });

    test('a partial clean review cannot complete Ultrafix or re-enable auto-merge', async () => {
        const redis = createMockRedis();
        await startLoop(redis as never, { owner: 'acme', repo: 'web', pr: 45, goal: 8 }, false);
        mockGetPendingReviewState.mock.mockImplementation(async () => ({
            latestScore: 9,
            reviewStatus: 'valid_clean',
            hasPendingReview: false,
            unprocessedComments: [],
            isPartial: true,
        }));
        mockFindPlanIssueByRepoAndPR.mock.mockImplementation(async () => ({ issue_number: 100 }));

        const result = await continueUltrafixLoop({
            owner: 'acme',
            repo: 'web',
            pullRequestNumber: 45,
            completedAction: 'review',
            ultrafixMeta: { mode: 'ultrafix', goal: 8, instructions: '' },
            redisClient: redis as never,
            correlatedLogger: logger as never,
            correlationId: 'partial-review-correlation-id',
            currentJobId: 'completed-partial-review-job',
            currentReviewCommentIds: [203],
            currentReviewResultCount: 1,
        });

        assert.equal(result.continued, false);
        assert.match(result.reason, /partial diff coverage/i);
        assert.equal(mockEnableAutoMerge.mock.callCount(), 0);
    });
});
