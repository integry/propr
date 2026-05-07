import { test, mock, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Label } from '@octokit/webhooks-types';
import { createWebhookIssueCommentCreatedEvent } from './testHelpers.js';

// ========== Mocks ==========

const mockOctokit = {
    request: mock.fn(async () => ({ data: {} })),
};

// Mock simple-git
await mock.module('simple-git', {
    namedExports: {
        simpleGit: mock.fn(() => ({})),
        SimpleGit: class {},
    },
});

// Mock ioredis
await mock.module('ioredis', {
    defaultExport: function Redis() {
        return { on: mock.fn(), quit: mock.fn(async () => {}) };
    },
});

// Mock bullmq — allow tests to inject active/waiting/delayed jobs
const mockQueueAdd = mock.fn(async () => {});
let mockActiveJobs: unknown[] = [];
let mockWaitingJobs: unknown[] = [];
let mockDelayedJobs: unknown[] = [];
await mock.module('bullmq', {
    namedExports: {
        Queue: function Queue() {
            return {
                add: mockQueueAdd,
                close: mock.fn(),
                on: mock.fn(),
                getActive: mock.fn(async () => mockActiveJobs),
                getWaiting: mock.fn(async () => mockWaitingJobs),
                getDelayed: mock.fn(async () => mockDelayedJobs),
            };
        },
        Worker: function Worker() {
            return { on: mock.fn(), close: mock.fn() };
        },
    },
});

// Mock better-sqlite3
await mock.module('better-sqlite3', {
    defaultExport: function Database() {
        return {
            exec: mock.fn(),
            prepare: mock.fn(() => ({ run: mock.fn(), get: mock.fn(), all: mock.fn(() => []) })),
            close: mock.fn(),
            pragma: mock.fn(),
        };
    },
});

// Mock GitHub auth
await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: {
        getAuthenticatedOctokit: mock.fn(async () => mockOctokit),
        getGitHubInstallationToken: mock.fn(async () => 'mock-token'),
    },
});

// Mock logger
const mockLoggerInstance = {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
};

await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: {
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
        debug: mock.fn(),
        withCorrelation: mock.fn(() => mockLoggerInstance),
    },
    namedExports: {
        generateCorrelationId: mock.fn(() => 'test-correlation-id'),
        default: {
            info: mock.fn(),
            warn: mock.fn(),
            error: mock.fn(),
            debug: mock.fn(),
            withCorrelation: mock.fn(() => mockLoggerInstance),
        },
    },
});

// Mock configManager
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        loadFollowupIgnoreKeywords: mock.fn(async () => []),
        loadPrimaryProcessingLabels: mock.fn(async () => ['AI']),
        getConfig: mock.fn(async () => null),
        saveConfig: mock.fn(async () => true),
    },
});

// Mock commentFilters
const mockFilterCommentByAuthor = mock.fn(() => ({ shouldFilter: false }));
await mock.module('../packages/core/src/utils/commentFilters.js', {
    namedExports: {
        filterCommentByAuthor: mockFilterCommentByAuthor,
        checkCommentTrigger: mock.fn(() => ({ isTriggered: true })),
        checkCommentIgnore: mock.fn(() => ({ shouldIgnore: false })),
    },
});

// Mock safeUpdateLabels — capture calls for assertions
const mockSafeUpdateLabels = mock.fn(async () => ({
    success: true,
    removed: [],
    added: ['ultrafix'],
    errors: [],
}));
await mock.module('../packages/core/src/utils/github/labelOperations.js', {
    namedExports: {
        safeUpdateLabels: mockSafeUpdateLabels,
    },
});

// Mock mergeConflictDetector
await mock.module('../packages/core/src/webhook/mergeConflictDetector.js', {
    namedExports: {
        handleMergeCommand: mock.fn(async () => {}),
        handlePullRequestConflictDetection: mock.fn(async () => {}),
        handlePushConflictDetection: mock.fn(async () => {}),
    },
});

// Mock retryHandler
await mock.module('../packages/core/src/utils/retryHandler.js', {
    namedExports: {
        withRetry: mock.fn(async (fn: () => Promise<unknown>) => fn()),
    },
});

// Import module under test AFTER mocks
const { processCommentEvent, setUltrafixDeps } = await import(
    '../packages/core/src/webhook/commentEventHandler.js'
);

// ========== Ultrafix Deps Mock ==========

const mockStartLoop = mock.fn(async (_redis: unknown, _options: unknown, hasPendingReviews: boolean) => ({
    state: {},
    initialAction: (hasPendingReviews ? 'fix' : 'review') as 'review' | 'fix',
}));

const mockGetPendingReviewState = mock.fn(async () => ({
    unprocessedComments: [],
    latestScore: null,
    hasPendingReview: false,
}));

const mockClearState = mock.fn(async () => {});

setUltrafixDeps({
    loadUltrafixRatingGoal: mock.fn(async () => 7),
    loadUltrafixMaxCycles: mock.fn(async () => 5),
    loadUltrafixPauseSeconds: mock.fn(async () => 60),
    loadPrReviewModel: mock.fn(async () => ''),
    startLoop: mockStartLoop,
    clearState: mockClearState,
    getPendingReviewState: mockGetPendingReviewState,
});

// ========== Helpers ==========

function createMockRedis() {
    const store = new Map<string, string>();
    return {
        get: mock.fn(async (key: string) => store.get(key) ?? null),
        setex: mock.fn(async (key: string, _ttl: number, value: string) => {
            store.set(key, value);
        }),
        set: mock.fn(async (key: string, value: string) => {
            store.set(key, value);
        }),
        del: mock.fn(async (key: string) => {
            store.delete(key);
        }),
        rpush: mock.fn(async () => {}),
        expire: mock.fn(async () => {}),
        _store: store,
    };
}

function createTestConfig(overrides: Record<string, unknown> = {}) {
    return {
        redisClient: createMockRedis(),
        PR_FOLLOWUP_TRIGGER_KEYWORDS: ['propr'],
        MODEL_LABEL_PATTERN: '^llm-(.+)$',
        ...overrides,
    };
}

function createPRCommentEvent(body: string, labels: Label[] = []) {
    const event = createWebhookIssueCommentCreatedEvent({
        comment: { body },
        issue: { number: 42, labels: labels.map(l => ({ name: l.name })) },
    });
    (event.issue as Record<string, unknown>).pull_request = { url: 'https://api.github.com/repos/test/repo/pulls/42' };
    return event;
}

// ========== Tests ==========

describe('commentEventHandler — /ultrafix command', () => {
    beforeEach(() => {
        mockSafeUpdateLabels.mock.resetCalls();
        mockQueueAdd.mock.resetCalls();
        mockOctokit.request.mock.resetCalls();
        mockLoggerInstance.info.mock.resetCalls();
        mockLoggerInstance.warn.mock.resetCalls();
        mockStartLoop.mock.resetCalls();
        mockGetPendingReviewState.mock.resetCalls();
        mockFilterCommentByAuthor.mock.resetCalls();
        mockActiveJobs = [];
        mockWaitingJobs = [];
        mockDelayedJobs = [];
        mockFilterCommentByAuthor.mock.mockImplementation(() => ({ shouldFilter: false }));

        // Default: Octokit returns a PR with no labels and empty comments
        mockOctokit.request.mock.mockImplementation(async (url: string) => {
            if (url.includes('/comments')) {
                return { data: [] };
            }
            return {
                data: {
                    head: { ref: 'feature-branch' },
                    labels: [],
                },
            };
        });

        // Default: no pending reviews
        mockGetPendingReviewState.mock.mockImplementation(async () => ({
            unprocessedComments: [],
            latestScore: null,
            hasPendingReview: false,
        }));

        // Default: startLoop returns review as initial action
        mockStartLoop.mock.mockImplementation(async (_redis: unknown, _options: unknown, hasPendingReviews: boolean) => ({
            state: {},
            initialAction: (hasPendingReviews ? 'fix' : 'review') as 'review' | 'fix',
        }));
    });

    test('bare /ultrafix initializes loop and enqueues review job', async () => {
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-1', config);

        // Should call startLoop
        assert.strictEqual(mockStartLoop.mock.callCount(), 1);
        const loopOptions = mockStartLoop.mock.calls[0].arguments[1] as Record<string, unknown>;
        // DB defaults are used when command args match parser defaults
        assert.strictEqual(loopOptions.goal, 7);       // DB default
        assert.strictEqual(loopOptions.maxCycles, 5);   // DB default
        assert.strictEqual(loopOptions.pauseSeconds, 60); // DB default
        assert.strictEqual(loopOptions.reviewModel, ''); // DB default

        // Should add ultrafix label
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const addedLabels = mockSafeUpdateLabels.mock.calls[0].arguments[2] as string[];
        assert.deepStrictEqual(addedLabels, ['ultrafix']);

        // Should enqueue a job with commandMode 'review' (no pending reviews)
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'review');

        // Should carry ultrafixMeta
        const ultrafixMeta = jobData.ultrafixMeta as Record<string, unknown>;
        assert.ok(ultrafixMeta, 'Job data should include ultrafixMeta');
        assert.strictEqual(ultrafixMeta.mode, 'ultrafix');

        // Should have posted a circuit-breaker comment (Octokit request for POST comments)
        const postCalls = mockOctokit.request.mock.calls.filter(
            (c: { arguments: unknown[] }) => (c.arguments[0] as string).includes('POST')
        );
        assert.ok(postCalls.length > 0, 'Expected a POST request to create a comment');
    });

    test('/ultrafix with positional goal override', async () => {
        const event = createPRCommentEvent('/ultrafix 8');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-2', config);

        assert.strictEqual(mockStartLoop.mock.callCount(), 1);
        const loopOptions = mockStartLoop.mock.calls[0].arguments[1] as Record<string, unknown>;
        // Goal should be overridden from command arg
        assert.strictEqual(loopOptions.goal, 8);
        // Other settings use DB defaults
        assert.strictEqual(loopOptions.maxCycles, 5);
        assert.strictEqual(loopOptions.pauseSeconds, 60);
    });

    test('/ultrafix with named overrides', async () => {
        const event = createPRCommentEvent('/ultrafix goal=9 max=3 pause=30 model=claude-sonnet-4-6');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-3', config);

        assert.strictEqual(mockStartLoop.mock.callCount(), 1);
        const loopOptions = mockStartLoop.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(loopOptions.goal, 9);
        assert.strictEqual(loopOptions.maxCycles, 3);
        assert.strictEqual(loopOptions.pauseSeconds, 30);
        assert.strictEqual(loopOptions.reviewModel, 'claude-sonnet-4-6');
    });

    test('first action is fix when pending reviews exist', async () => {
        // Mock pending reviews
        mockGetPendingReviewState.mock.mockImplementation(async () => ({
            unprocessedComments: [{ id: 1, body: 'Review feedback', author: 'bot', created_at: new Date().toISOString() }],
            latestScore: 4,
            hasPendingReview: true,
        }));

        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-4', config);

        // startLoop should receive hasPendingReviews = true
        assert.strictEqual(mockStartLoop.mock.callCount(), 1);
        const hasPendingReviews = mockStartLoop.mock.calls[0].arguments[2] as boolean;
        assert.strictEqual(hasPendingReviews, true);

        // Job should be enqueued with commandMode 'fix'
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'fix');
    });

    test('first action is review when no pending reviews exist', async () => {
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-5', config);

        // startLoop should receive hasPendingReviews = false
        assert.strictEqual(mockStartLoop.mock.callCount(), 1);
        const hasPendingReviews = mockStartLoop.mock.calls[0].arguments[2] as boolean;
        assert.strictEqual(hasPendingReviews, false);

        // Job should be enqueued with commandMode 'review'
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'review');
    });

    test('/ultrafix is batched when an existing job is active for the same PR', async () => {
        // Simulate an active job for PR 42
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-batch', config);

        // Should NOT enqueue a new job
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        // Should store comment for batch via rpush
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        const pendingComment = JSON.parse(config.redisClient.rpush.mock.calls[0].arguments[1] as string) as Record<string, unknown>;
        // The batched comment should carry ultrafixMeta
        assert.ok(pendingComment.ultrafixMeta, 'Batched comment should include ultrafixMeta');
        // The batched comment commandMode should be the first action (review), not 'ultrafix'
        assert.strictEqual(pendingComment.commandMode, 'review');

        // Should NOT post label or circuit-breaker comment (batching guard fires before side effects)
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        const postCalls = mockOctokit.request.mock.calls.filter(
            (c: { arguments: unknown[] }) => (c.arguments[0] as string).includes('POST')
        );
        assert.strictEqual(postCalls.length, 0, 'Should not post circuit-breaker comment when batched');
    });

    test('/ultrafix does not add ultrafix label if it already exists', async () => {
        mockOctokit.request.mock.mockImplementation(async (url: string) => {
            if (url.includes('/comments')) {
                return { data: [] };
            }
            return {
                data: {
                    head: { ref: 'feature-branch' },
                    labels: [
                        { id: 1, name: 'ultrafix', color: '000', default: false, description: null, node_id: 'L_1', url: '' },
                    ],
                },
            };
        });

        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-label-exists', config);

        // Should NOT call safeUpdateLabels since label already exists
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
    });

    test('/ultrafix is batched when a delayed job exists for the same PR', async () => {
        // Simulate a delayed ultrafix job for PR 42
        mockDelayedJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-delayed', config);

        // Should NOT enqueue a new job (batching guard)
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        // Should store comment for batch via rpush
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
    });

    test('/ultrafix is batched when a waiting job exists for the same PR', async () => {
        // Simulate a waiting job for PR 42
        mockWaitingJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-waiting', config);

        // Should NOT enqueue a new job
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/ultrafix enqueued job carries correct ultrafixMeta fields', async () => {
        const event = createPRCommentEvent('/ultrafix goal=9 max=3 pause=30 model=claude-sonnet-4-6');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-meta', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        const ultrafixMeta = jobData.ultrafixMeta as Record<string, unknown>;
        assert.strictEqual(ultrafixMeta.mode, 'ultrafix');
        assert.strictEqual(ultrafixMeta.goal, 9);
        assert.strictEqual(ultrafixMeta.maxCycles, 3);
        assert.strictEqual(ultrafixMeta.pauseSeconds, 30);
        assert.strictEqual(ultrafixMeta.reviewModel, 'claude-sonnet-4-6');
    });

    test('/ultrafix circuit-breaker comment mentions label removal', async () => {
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-comment', config);

        // Find the POST comment request
        const postCalls = mockOctokit.request.mock.calls.filter(
            (c: { arguments: unknown[] }) => (c.arguments[0] as string).includes('POST') && (c.arguments[0] as string).includes('comments')
        );
        assert.ok(postCalls.length > 0, 'Expected a POST comment request');
        const commentBody = (postCalls[0].arguments[1] as Record<string, unknown>).body as string;
        assert.ok(commentBody.includes('ultrafix'), 'Comment should mention ultrafix');
        assert.ok(commentBody.includes('label'), 'Comment should mention the label as a circuit breaker');
    });

    test('bot-authored system /ultrafix comment is allowed even when the login does not match configured bot identity', async () => {
        process.env.GITHUB_BOT_USERNAME = 'configured-bot[bot]';
        mockFilterCommentByAuthor.mock.mockImplementation(() => ({ shouldFilter: true }));

        const event = createPRCommentEvent('/ultrafix goal=8 max=4');
        event.comment.user.login = 'automation-runner[bot]';
        event.comment.user.type = 'Bot';
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-system-bot', config);

        assert.strictEqual(mockStartLoop.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'review');
    });
});
