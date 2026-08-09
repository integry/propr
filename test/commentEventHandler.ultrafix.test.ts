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
const mockQueueGetJob = mock.fn(async () => null as unknown);
let mockActiveJobs: unknown[] = [];
let mockWaitingJobs: unknown[] = [];
let mockDelayedJobs: unknown[] = [];
await mock.module('bullmq', {
    namedExports: {
        Queue: function Queue() {
            return {
                add: mockQueueAdd,
                getJob: mockQueueGetJob,
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
const mockSafeUpdateLabels = mock.fn(async () => ({
    success: true,
    removed: [],
    added: ['ultrafix'],
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
const { applyPendingCommentCommandContext } = await import('../src/jobs/prPendingComments.js');

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

const mockClearStateIfGenerationCurrent = mock.fn(async () => true);
const mockClearDeferredContinuation = mock.fn(async () => 1);
const mockBeginManualTakeover = mock.fn(async () => true);
const mockAbortManualTakeover = mock.fn(async () => true);
const mockWithTransitionLease = mock.fn(async (
    _redis: unknown,
    _identity: unknown,
    _correlationId: string,
    operation: (assertOwned: () => Promise<void>) => Promise<unknown>,
) => operation(async () => {}));

setUltrafixDeps({
    loadUltrafixRatingGoal: mock.fn(async () => 7),
    loadUltrafixMaxCycles: mock.fn(async () => 5),
    loadUltrafixPauseSeconds: mock.fn(async () => 60),
    loadPrReviewModel: mock.fn(async () => ''),
    startLoop: mockStartLoop,
    clearStateIfGenerationCurrent: mockClearStateIfGenerationCurrent,
    beginManualTakeover: mockBeginManualTakeover,
    abortManualTakeover: mockAbortManualTakeover,
    completeManualTakeover: mockClearDeferredContinuation,
    startFreshTransition: mockClearDeferredContinuation,
    withTransitionLease: mockWithTransitionLease,
    getPendingReviewState: mockGetPendingReviewState,
});

after(async () => {
    await shutdownQueue();
    await closeConnection();
});

// ========== Helpers ==========

function createMockRedis() {
    const store = new Map<string, string>();
    const rpush = mock.fn(async () => {});
    const expire = mock.fn(async () => {});
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
        incr: mock.fn(async (key: string) => {
            const next = Number(store.get(key) ?? '0') + 1;
            store.set(key, String(next));
            return next;
        }),
        rpush,
        expire,
        eval: mock.fn(async (
            script: string,
            _keyCount: number,
            pendingKey: string,
            stageKey: string,
            serializedComment: string,
            _pendingTtl: string,
            _stageTtl: string,
            takeoverSequence: string,
        ) => {
            if (script.includes("local existing = redis.call('GET', KEYS[1])")) {
                const existing = store.get(pendingKey);
                if (existing) return Number(existing);
                const next = Number(store.get(stageKey) ?? '0') + 1;
                store.set(stageKey, String(next));
                store.set(pendingKey, String(next));
                return next;
            }
            await rpush(pendingKey, serializedComment);
            await expire(pendingKey, 3600);
            store.set(stageKey, takeoverSequence);
            return 1;
        }),
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
        mockStartLoop.mock.mockImplementation(async (_redis, _options, hasPendingReviews) => ({
            state: {},
            initialAction: hasPendingReviews ? 'fix' : 'review',
        }));
        mockClearStateIfGenerationCurrent.mock.resetCalls();
        mockClearStateIfGenerationCurrent.mock.mockImplementation(async () => true);
        mockClearDeferredContinuation.mock.resetCalls();
        mockClearDeferredContinuation.mock.mockImplementation(async () => 1);
        mockBeginManualTakeover.mock.resetCalls();
        mockBeginManualTakeover.mock.mockImplementation(async () => true);
        mockAbortManualTakeover.mock.resetCalls();
        mockAbortManualTakeover.mock.mockImplementation(async () => true);
        mockWithTransitionLease.mock.resetCalls();
        mockWithTransitionLease.mock.mockImplementation(async (
            _redis,
            _identity,
            _correlationId,
            operation,
        ) => operation(async () => {}));
        mockGetPendingReviewState.mock.resetCalls();
        mockGetPendingReviewState.mock.mockImplementation(async () => ({
            unprocessedComments: [], latestScore: null, hasPendingReview: false,
        }));
        mockFilterCommentByAuthor.mock.resetCalls();
        mockQueueAdd.mock.mockImplementation(async () => {});
        mockQueueGetJob.mock.resetCalls();
        mockQueueGetJob.mock.mockImplementation(async () => null);
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
        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 1);
        assert.strictEqual(mockWithTransitionLease.mock.callCount(), 1);
        const loopOptions = mockStartLoop.mock.calls[0].arguments[1] as Record<string, unknown>;
        // DB defaults are used when command args match parser defaults
        assert.strictEqual(loopOptions.goal, 7);       // DB default
        assert.strictEqual(loopOptions.maxCycles, 5);   // DB default
        assert.strictEqual(loopOptions.pauseSeconds, 60); // DB default
        assert.strictEqual(loopOptions.reviewModel, ''); // DB default
        assert.strictEqual(loopOptions.generation, 1);

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
        assert.strictEqual(ultrafixMeta.generation, 1);

        // Should have posted a circuit-breaker comment (Octokit request for POST comments)
        const postCalls = mockOctokit.request.mock.calls.filter(
            (c: { arguments: unknown[] }) => (c.arguments[0] as string).includes('POST')
        );
        assert.ok(postCalls.length > 0, 'Expected a POST request to create a comment');
    });

    test('stale startup rollback preserves a label that may belong to a newer loop', async () => {
        mockStartLoop.mock.mockImplementationOnce(async () => {
            throw new Error('Ultrafix loop startup was superseded by a newer command');
        });
        mockClearStateIfGenerationCurrent.mock.mockImplementationOnce(async () => false);
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-stale-rollback', config),
            /superseded/,
        );

        assert.strictEqual(mockClearStateIfGenerationCurrent.mock.callCount(), 1);
        assert.deepStrictEqual(mockClearStateIfGenerationCurrent.mock.calls[0].arguments.slice(1), [
            { owner: 'testowner', repo: 'testrepo', pr: 42 }, 1,
        ]);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[0].arguments[2], ['ultrafix']);
    });

    test('queue failure rolls back a newly started ultrafix loop and label', async () => {
        mockQueueAdd.mock.mockImplementationOnce(async () => {
            throw new Error('queue unavailable');
        });
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-enqueue-failure', config),
            /queue unavailable/,
        );

        assert.strictEqual(mockStartLoop.mock.callCount(), 1);
        assert.strictEqual(mockClearStateIfGenerationCurrent.mock.callCount(), 1);
        assert.deepStrictEqual(mockClearStateIfGenerationCurrent.mock.calls[0].arguments.slice(1), [
            { owner: 'testowner', repo: 'testrepo', pr: 42 }, 1,
        ]);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 2);
        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[1].arguments.slice(1), [
            ['ultrafix'], [],
        ]);
        const failureComments = mockOctokit.request.mock.calls.filter(
            (call: { arguments: unknown[] }) => String(
                (call.arguments[1] as Record<string, unknown>)?.body ?? '',
            ).includes('failed to start'),
        );
        assert.strictEqual(failureComments.length, 1);
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

    test('/ultrafix supersedes active work with a concrete fix when findings are pending', async () => {
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];
        mockGetPendingReviewState.mock.mockImplementationOnce(async () => ({
            unprocessedComments: [{ id: 1 }],
            latestScore: 5,
            hasPendingReview: true,
        }));

        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-batch', config);

        assert.strictEqual(mockStartLoop.mock.calls[0].arguments[2], true);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.calls[0].arguments[1].commandMode, 'fix');
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
    });

    test('older batched /fix cannot take ownership from a fresh /ultrafix job', async () => {
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];
        const config = createTestConfig();
        const fixEvent = createPRCommentEvent('/fix F1');
        fixEvent.comment.id = 100;

        await processCommentEvent(fixEvent, 'issue_comment', 'corr-old-fix', config);

        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        mockGetPendingReviewState.mock.mockImplementationOnce(async () => ({
            unprocessedComments: [{ id: 1 }],
            latestScore: 5,
            hasPendingReview: true,
        }));
        const ultrafixEvent = createPRCommentEvent('/ultrafix');
        ultrafixEvent.comment.id = 101;

        await processCommentEvent(ultrafixEvent, 'issue_comment', 'corr-new-ultrafix', config);

        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        const pendingFix = JSON.parse(
            config.redisClient.rpush.mock.calls[0].arguments[1] as string,
        ) as Record<string, unknown>;
        const commentsToProcess = [
            ...(jobData.comments as Array<Record<string, unknown>>),
            pendingFix,
        ];
        applyPendingCommentCommandContext(jobData as never, commentsToProcess as never, mockLoggerInstance as never);

        assert.strictEqual(mockWithTransitionLease.mock.callCount(), 2);
        assert.strictEqual(jobData.commandCommentId, 101);
        assert.strictEqual(jobData.commandMode, 'fix');
        assert.strictEqual((jobData.ultrafixMeta as Record<string, unknown>).generation, 1);
        assert.strictEqual(commentsToProcess.some(comment => comment.id === 100), true);
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

    test('/ultrafix supersedes a delayed job with its own concrete job', async () => {
        mockDelayedJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-delayed', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.calls[0].arguments[1].commandMode, 'review');
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
    });

    test('/ultrafix supersedes a waiting job with its own concrete job', async () => {
        mockWaitingJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-waiting', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.calls[0].arguments[1].commandMode, 'review');
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

    test('manual /fix enqueues its replacement before cancelling a deferred transition', async () => {
        const operations: string[] = [];
        mockWithTransitionLease.mock.mockImplementationOnce(async (
            _redis: unknown,
            _identity: unknown,
            _correlationId: string,
            operation: (assertOwned: () => Promise<void>) => Promise<unknown>,
        ) => {
            operations.push('lease-start');
            const result = await operation(async () => {});
            operations.push('lease-end');
            return result;
        });
        mockBeginManualTakeover.mock.mockImplementationOnce(async () => {
            operations.push('fence');
            return true;
        });
        mockQueueAdd.mock.mockImplementationOnce(async () => { operations.push('enqueue'); });
        mockClearDeferredContinuation.mock.mockImplementationOnce(async () => {
            operations.push('cancel');
            return 2;
        });
        const event = createPRCommentEvent('/fix F1');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-manual-fix', config);

        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 1);
        assert.deepStrictEqual(
            mockClearDeferredContinuation.mock.calls[0].arguments.slice(1),
            [{ owner: 'testowner', repo: 'testrepo', pr: 42 }, 1],
        );
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.deepStrictEqual(
            operations,
            ['lease-start', 'fence', 'enqueue', 'cancel', 'lease-end'],
        );
    });

    test('manual /fix preserves deferred ultrafix when replacement enqueue fails', async () => {
        mockQueueAdd.mock.mockImplementationOnce(async () => {
            throw new Error('queue unavailable');
        });
        const event = createPRCommentEvent('/fix F1');
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-manual-fix-enqueue-failure', config),
            /queue unavailable/,
        );

        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 0);
    });

    test('manual /fix redelivery resumes failed cancellation without enqueueing twice', async () => {
        mockClearDeferredContinuation.mock.mockImplementationOnce(async () => {
            throw new Error('transition commit failed');
        });
        const event = createPRCommentEvent('/fix F1');
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-manual-fix-cancel-failure', config),
            /transition commit failed/,
        );
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 1);

        await processCommentEvent(
            event, 'issue_comment', 'corr-uf-manual-fix-cancel-retry', config,
        );

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 2);
        assert.strictEqual(
            [...config.redisClient._store.keys()].some(key =>
                key.startsWith('pr-command-takeover:testowner:testrepo:42:issue_comment:')),
            false,
        );
    });

    test('manual /fix retry keeps its intake order when the stage write fails', async () => {
        const event = createPRCommentEvent('/fix F1');
        const config = createTestConfig();
        let failStageWrite = true;
        config.redisClient.set.mock.mockImplementation(async (
            key: string,
            value: string,
            ...args: string[]
        ) => {
            if (key.startsWith('pr-command-takeover:') && failStageWrite) {
                failStageWrite = false;
                throw new Error('stage write failed');
            }
            if (args.includes('NX') && config.redisClient._store.has(key)) return null;
            config.redisClient._store.set(key, value);
            return 'OK';
        });
        let replacementLookup = 0;
        mockQueueGetJob.mock.mockImplementation(async () => {
            replacementLookup += 1;
            return replacementLookup === 1 ? null : {};
        });

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-stage-write-failure', config),
            /stage write failed/,
        );
        await processCommentEvent(event, 'issue_comment', 'corr-stage-write-retry', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 1);
        assert.deepStrictEqual(
            mockBeginManualTakeover.mock.calls.map(call => call.arguments[2]),
            [1, 1],
        );
    });

    test('manual /review stores its replacement before cancelling a deferred transition', async () => {
        const operations: string[] = [];
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];
        const event = createPRCommentEvent('/review');
        const config = createTestConfig();
        config.redisClient.rpush.mock.mockImplementationOnce(async () => { operations.push('store'); });
        mockClearDeferredContinuation.mock.mockImplementationOnce(async () => {
            operations.push('cancel');
            return 2;
        });

        await processCommentEvent(event, 'issue_comment', 'corr-uf-manual-review', config);

        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        assert.deepStrictEqual(operations, ['store', 'cancel']);
    });

    test('manual /review preserves deferred ultrafix when pending storage fails', async () => {
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];
        const event = createPRCommentEvent('/review');
        const config = createTestConfig();
        config.redisClient.rpush.mock.mockImplementationOnce(async () => {
            throw new Error('redis unavailable');
        });

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-manual-review-store-failure', config),
            /redis unavailable/,
        );

        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('manual /review redelivery resumes failed cancellation without batching twice', async () => {
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];
        mockClearDeferredContinuation.mock.mockImplementationOnce(async () => {
            throw new Error('transition commit failed');
        });
        const event = createPRCommentEvent('/review');
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-manual-review-cancel-failure', config),
            /transition commit failed/,
        );
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 1);

        await processCommentEvent(
            event, 'issue_comment', 'corr-uf-manual-review-cancel-retry', config,
        );

        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 2);
    });

    test('stale manual retry cannot cancel a newer /ultrafix transition', async () => {
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];
        let transitionCall = 0;
        mockClearDeferredContinuation.mock.mockImplementation(async (
            _redis: unknown,
            _identity: unknown,
            sequence: number,
        ) => {
            transitionCall += 1;
            if (transitionCall === 1) throw new Error('transition commit failed');
            return sequence === 1 ? null : 2;
        });
        const manualEvent = createPRCommentEvent('/fix F1');
        manualEvent.comment.id = 100;
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(manualEvent, 'issue_comment', 'corr-old-manual', config),
            /transition commit failed/,
        );

        mockActiveJobs = [];
        const freshEvent = createPRCommentEvent('/ultrafix');
        freshEvent.comment.id = 101;
        await processCommentEvent(freshEvent, 'issue_comment', 'corr-fresh-loop', config);
        await processCommentEvent(manualEvent, 'issue_comment', 'corr-old-manual-retry', config);

        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.deepStrictEqual(
            mockClearDeferredContinuation.mock.calls.map(call => call.arguments[2]),
            [1, 2, 1],
        );
    });
});
