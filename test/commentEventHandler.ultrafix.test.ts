import { test, mock, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import type { Label } from '@octokit/webhooks-types';
import { createWebhookIssueCommentCreatedEvent } from './testHelpers.js';

// ========== Mocks ==========

const mockOctokitRequest = mock.fn(async () => ({ data: {} }));
const mockOctokit = {
    request: mockOctokitRequest,
    paginate: mock.fn(async (route: string, options: Record<string, unknown>) => {
        const response = await mockOctokitRequest(route, options);
        return response.data;
    }),
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
    namedExports: {
        Redis: function Redis() {
            return {
                on: mock.fn(),
                connect: mock.fn(async () => {}),
                quit: mock.fn(async () => {}),
            };
        },
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
        validateGithubIntakePrerequisites: mock.fn(() => {}),
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
        createCorrelatedLogger: mock.fn(() => mockLoggerInstance),
    },
});

// Mock configManager
const actualConfigManager = await import('../packages/core/src/config/configManager.js');
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        ...actualConfigManager,
        loadFollowupIgnoreKeywords: mock.fn(async () => []),
        loadMonitoredRepos: mock.fn(async () => []),
        loadAiPrimaryTag: mock.fn(async () => 'AI'),
        loadPrimaryProcessingLabels: mock.fn(async () => ['AI']),
        loadSettings: mock.fn(async () => ({})),
        getConfig: mock.fn(async () => null),
        saveConfig: mock.fn(async () => true),
    },
});

// Keep the model-validation fallback isolated from the full agent runtime.
const mockAgentRegistry = {
    ensureInitialized: mock.fn(async () => {}),
    getAllAgents: mock.fn(() => []),
};
await mock.module('../packages/core/src/agents/AgentRegistry.js', {
    namedExports: {
        AgentRegistry: class AgentRegistry {
            static getInstance() {
                return mockAgentRegistry;
            }
        },
        getAgentRegistry: mock.fn(() => mockAgentRegistry),
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
const mockSafeUpdateLabels = mock.fn(async (_context: unknown, labelsToRemove: string[] = [], labelsToAdd: string[] = []) => ({
    success: true,
    removed: [...labelsToRemove],
    added: [...labelsToAdd],
    errors: [],
}));
await mock.module('../packages/core/src/utils/github/labelOperations.js', {
    namedExports: {
        safeRemoveLabel: mock.fn(async () => true),
        safeAddLabel: mock.fn(async () => true),
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
const actualRetryHandler = await import('../packages/core/src/utils/retryHandler.js');
const { default: retryHandlerDefault, ...retryHandlerNamedExports } = actualRetryHandler;
await mock.module('../packages/core/src/utils/retryHandler.js', {
    defaultExport: retryHandlerDefault,
    namedExports: {
        ...retryHandlerNamedExports,
        withRetry: mock.fn(async (fn: () => Promise<unknown>) => fn()),
        retryConfigs: { githubApi: {} },
    },
});

// Import module under test AFTER mocks
const { processCommentEvent, setUltrafixDeps } = await import(
    '../packages/core/src/webhook/commentEventHandler.js'
);
const { closeConnection } = await import('../packages/core/src/db/connection.js');
const { shutdownQueue } = await import('../packages/core/src/queue/taskQueue.js');

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

const mockClearStateIfCurrent = mock.fn(async () => true);
const mockReserveAutomaticWork = mock.fn(async () => 1);
const mockInvalidateAutomaticWork = mock.fn(async () => ({ workEpoch: 1, hadAutomaticWork: false }));
const mockHasAutomaticWork = mock.fn(async () => false);

setUltrafixDeps({
    loadUltrafixRatingGoal: mock.fn(async () => 7),
    loadUltrafixMaxCycles: mock.fn(async () => 5),
    loadUltrafixPauseSeconds: mock.fn(async () => 60),
    loadPrReviewModel: mock.fn(async () => ''),
    startLoop: mockStartLoop,
    clearStateIfCurrent: mockClearStateIfCurrent,
    hasAutomaticWork: mockHasAutomaticWork,
    reserveAutomaticWork: mockReserveAutomaticWork,
    invalidateAutomaticWork: mockInvalidateAutomaticWork,
    getPendingReviewState: mockGetPendingReviewState,
});

after(async () => {
    await shutdownQueue();
    await closeConnection();
});

// ========== Helpers ==========

function createMockRedis() {
    const store = new Map<string, string>();
    return {
        get: mock.fn(async (key: string) => store.get(key) ?? null),
        setex: mock.fn(async (key: string, _ttl: number, value: string) => {
            store.set(key, value);
        }),
        set: mock.fn(async (key: string, value: string, ...args: string[]) => {
            if (args.includes('NX') && store.has(key)) return null;
            store.set(key, value);
            return 'OK';
        }),
        del: mock.fn(async (key: string) => {
            store.delete(key);
        }),
        eval: mock.fn(async (_script: string, _keyCount: number, key: string, token: string) => {
            if (store.get(key) !== token) return 0;
            store.delete(key);
            return 1;
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
        mockSafeUpdateLabels.mock.mockImplementation(async (_context: unknown, labelsToRemove: string[] = [], labelsToAdd: string[] = []) => ({
            success: true,
            removed: [...labelsToRemove],
            added: [...labelsToAdd],
            errors: [],
        }));
        mockQueueAdd.mock.resetCalls();
        mockQueueAdd.mock.mockImplementation(async () => {});
        mockOctokit.request.mock.resetCalls();
        mockLoggerInstance.info.mock.resetCalls();
        mockLoggerInstance.warn.mock.resetCalls();
        mockStartLoop.mock.resetCalls();
        mockClearStateIfCurrent.mock.resetCalls();
        mockClearStateIfCurrent.mock.mockImplementation(async () => true);
        mockReserveAutomaticWork.mock.resetCalls();
        mockReserveAutomaticWork.mock.mockImplementation(async () => 1);
        mockInvalidateAutomaticWork.mock.resetCalls();
        mockHasAutomaticWork.mock.resetCalls();
        mockHasAutomaticWork.mock.mockImplementation(async () => false);
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
        assert.strictEqual(loopOptions.workEpoch, 1);

        // Should add ultrafix label
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const addedLabels = mockSafeUpdateLabels.mock.calls[0].arguments[2] as string[];
        assert.deepStrictEqual(addedLabels, ['ultrafix']);

        // Should enqueue a job with commandMode 'review' (no pending reviews)
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'review');
        assert.strictEqual(jobData.commandCommentId, event.comment.id);

        // Should carry ultrafixMeta
        const ultrafixMeta = jobData.ultrafixMeta as Record<string, unknown>;
        assert.ok(ultrafixMeta, 'Job data should include ultrafixMeta');
        assert.strictEqual(ultrafixMeta.mode, 'ultrafix');
        assert.strictEqual(ultrafixMeta.workEpoch, 1);

        // Should have posted a circuit-breaker comment (Octokit request for POST comments)
        const postCalls = mockOctokit.request.mock.calls.filter(
            (c: { arguments: unknown[] }) => (c.arguments[0] as string).includes('POST')
        );
        assert.ok(postCalls.length > 0, 'Expected a POST request to create a comment');
    });

    test('asserts the circuit-breaker label before publishing active loop state', async () => {
        mockSafeUpdateLabels.mock.mockImplementation(async (_context: unknown, labelsToRemove: string[] = [], labelsToAdd: string[] = []) => {
            assert.strictEqual(mockStartLoop.mock.callCount(), 0);
            return { success: true, removed: [...labelsToRemove], added: [...labelsToAdd], errors: [] };
        });
        mockStartLoop.mock.mockImplementation(async () => {
            assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
            return { state: {}, initialAction: 'review' as const };
        });

        await processCommentEvent(createPRCommentEvent('/ultrafix'), 'issue_comment', 'corr-uf-label-first', createTestConfig());

    });

    test('tracking refresh failure after enqueue does not roll back Ultrafix startup', async () => {
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();
        config.redisClient.setex.mock.mockImplementationOnce(async () => {
            throw new Error('tracking write failed');
        });

        await processCommentEvent(event, 'issue_comment', 'corr-uf-tracking-failure', config);

        assert.strictEqual(mockStartLoop.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(mockClearStateIfCurrent.mock.callCount(), 0);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);

        const postBodies = mockOctokit.request.mock.calls
            .filter((call: { arguments: unknown[] }) => (call.arguments[0] as string).includes('POST'))
            .map((call: { arguments: unknown[] }) => (call.arguments[1] as { body: string }).body);
        assert.ok(postBodies.some(body => body.includes('Ultrafix loop started')));
        assert.ok(postBodies.every(body => !body.includes('Ultrafix loop failed to start')));
    });

    test('duplicate /ultrafix deliveries for the same comment initialize only one loop', async () => {
        const event = createPRCommentEvent('/ultrafix goal=8 max=4');
        const config = createTestConfig();

        await Promise.all([
            processCommentEvent(event, 'issue_comment', 'corr-uf-dupe-1', config),
            processCommentEvent(event, 'issue_comment', 'corr-uf-dupe-2', config),
        ]);

        assert.strictEqual(mockStartLoop.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const postCalls = mockOctokit.request.mock.calls.filter(
            (c: { arguments: unknown[] }) => (c.arguments[0] as string).includes('POST') && (c.arguments[0] as string).includes('comments')
        );
        assert.strictEqual(postCalls.length, 1, 'Expected only one ultrafix started comment');
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

    test('/ultrafix supersedes an existing job with an independent conservative review', async () => {
        // Simulate an active job for PR 42
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-batch', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
        assert.strictEqual(mockReserveAutomaticWork.mock.callCount(), 1);
        assert.strictEqual(mockGetPendingReviewState.mock.callCount(), 0);
        assert.strictEqual(mockStartLoop.mock.callCount(), 1);
        assert.strictEqual(mockStartLoop.mock.calls[0].arguments[2], false);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'review');
        assert.strictEqual((jobData.ultrafixMeta as Record<string, unknown>).workEpoch, 1);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const postCalls = mockOctokit.request.mock.calls.filter(
            (c: { arguments: unknown[] }) => (c.arguments[0] as string).includes('POST')
        );
        assert.ok(postCalls.length > 0, 'Expected the loop-start comment');
    });

    test('/ultrafix rechecks for work that appears while reserving its epoch', async () => {
        mockGetPendingReviewState.mock.mockImplementation(async () => ({
            unprocessedComments: [{ id: 1, body: 'Review feedback' }],
            latestScore: 4,
            hasPendingReview: true,
        }));
        mockReserveAutomaticWork.mock.mockImplementation(async () => {
            mockActiveJobs = [{
                name: 'processPullRequestComment',
                data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
            }];
            return 1;
        });
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-reservation-race', config);

        assert.strictEqual(mockStartLoop.mock.calls[0].arguments[2], false);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'review');
    });

    test('/ultrafix reasserts the ultrafix label even when the PR snapshot contains it', async () => {
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

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[0].arguments[2], ['ultrafix']);
    });

    test('/ultrafix starts independently when a delayed job exists for the same PR', async () => {
        // Simulate a delayed ultrafix job for PR 42
        mockDelayedJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-delayed', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'review');
    });

    test('/ultrafix starts independently when a waiting job exists for the same PR', async () => {
        // Simulate a waiting job for PR 42
        mockWaitingJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-waiting', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
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

    test('queue failure rolls back only the reserved loop and removes its label', async () => {
        mockQueueAdd.mock.mockImplementation(async () => {
            throw new Error('queue unavailable');
        });
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-queue-failure', config),
            /queue unavailable/,
        );

        assert.strictEqual(mockClearStateIfCurrent.mock.callCount(), 1);
        assert.deepStrictEqual(mockClearStateIfCurrent.mock.calls[0].arguments[1], {
            owner: 'testowner', repo: 'testrepo', pr: 42,
        });
        assert.strictEqual(mockClearStateIfCurrent.mock.calls[0].arguments[2], 1);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 2);
        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[1].arguments[1], ['ultrafix']);
        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[1].arguments[2], []);
        assert.strictEqual(config.redisClient.del.mock.callCount(), 1, 'slash-command claim should be released for retry');
    });

    test('queue failure preserves a pre-existing ultrafix label', async () => {
        mockQueueAdd.mock.mockImplementation(async () => {
            throw new Error('queue unavailable');
        });
        mockOctokit.request.mock.mockImplementation(async (url: string) => {
            if (url.includes('/comments')) return { data: [] };
            return {
                data: {
                    head: { ref: 'feature-branch' },
                    labels: [
                        { id: 1, name: 'ultrafix', color: '000', default: false, description: null, node_id: 'L_1', url: '' },
                    ],
                },
            };
        });
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(createPRCommentEvent('/ultrafix'), 'issue_comment', 'corr-uf-existing-label-queue-failure', config),
            /queue unavailable/,
        );

        assert.strictEqual(mockClearStateIfCurrent.mock.callCount(), 1);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1, 'must not remove a label inherited by this startup');
        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[0].arguments[2], ['ultrafix'], 'startup should still reassert the label');
    });

    test('lock acquisition failure cannot clear an unowned epoch-zero state', async () => {
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();
        config.redisClient.set.mock.mockImplementation(async (key: string, value: string, ...args: string[]) => {
            if (key.startsWith('ultrafix:label-transition:')) throw new Error('lock unavailable');
            if (args.includes('NX') && config.redisClient._store.has(key)) return null;
            config.redisClient._store.set(key, value);
            return 'OK';
        });

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-lock-failure', config),
            /lock unavailable/,
        );

        assert.strictEqual(mockReserveAutomaticWork.mock.callCount(), 0);
        assert.strictEqual(mockClearStateIfCurrent.mock.callCount(), 0);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
    });

    test('reservation failure cannot clear an unowned epoch-zero state', async () => {
        mockReserveAutomaticWork.mock.mockImplementation(async () => {
            throw new Error('reservation unavailable');
        });

        await assert.rejects(
            processCommentEvent(createPRCommentEvent('/ultrafix'), 'issue_comment', 'corr-uf-reserve-failure', createTestConfig()),
            /reservation unavailable/,
        );

        assert.strictEqual(mockClearStateIfCurrent.mock.callCount(), 0);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
    });

    test('stale startup rollback preserves a newer loop state and label', async () => {
        mockQueueAdd.mock.mockImplementation(async () => {
            throw new Error('queue unavailable');
        });
        mockClearStateIfCurrent.mock.mockImplementation(async () => false);
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-stale-rollback', config),
            /queue unavailable/,
        );

        assert.strictEqual(mockClearStateIfCurrent.mock.callCount(), 1);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1, 'must not remove a newer loop\'s shared label');
        const failurePosts = mockOctokit.request.mock.calls.filter(
            (c: { arguments: unknown[] }) => (c.arguments[0] as string).includes('POST')
                && String((c.arguments[1] as Record<string, unknown>).body ?? '').includes('No newer Ultrafix state or label was removed')
        );
        assert.strictEqual(failurePosts.length, 1);
    });

    test('bot-authored /ultrafix is filtered when the login does not match configured bot identity', async () => {
        process.env.GITHUB_BOT_USERNAME = 'configured-bot[bot]';
        mockFilterCommentByAuthor.mock.mockImplementation(() => ({ shouldFilter: true }));

        const event = createPRCommentEvent('/ultrafix goal=8 max=4');
        event.comment.user.login = 'automation-runner[bot]';
        event.comment.user.type = 'Bot';
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-system-bot', config);

        assert.strictEqual(mockStartLoop.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });
});
