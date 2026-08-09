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
const { handleCommentEdited, processCommentEvent, setUltrafixDeps } = await import(
    '../packages/core/src/webhook/commentEventHandler.js'
);
const { closeConnection } = await import('../packages/core/src/db/connection.js');
const { shutdownQueue } = await import('../packages/core/src/queue/taskQueue.js');
const { applyPendingCommentCommandContext } = await import('../src/jobs/prPendingComments.js');

// ========== Ultrafix Deps Mock ==========

const mockCommitFreshLoop = mock.fn(async (_redis: unknown, _options: unknown, hasPendingReviews: boolean) => ({
    state: {},
    initialAction: (hasPendingReviews ? 'fix' : 'review') as 'review' | 'fix',
}));
const mockReserveFreshTransition = mock.fn(async () => ({ generation: 1, baseGeneration: 0 }));
const mockAbortFreshTransition = mock.fn(async () => true);

const mockGetPendingReviewState = mock.fn(async () => ({
    unprocessedComments: [],
    latestScore: null,
    hasPendingReview: false,
}));

const mockClearDeferredContinuation = mock.fn(async () => 1);
async function stageMockManualTakeover(
    redis: unknown,
    _identity: unknown,
    commandSequence: number,
    recovery?: { stageKey: string; intentKey: string; serializedComment: string },
): Promise<boolean> {
    if (recovery) {
        const client = redis as {
            set: (key: string, value: string) => Promise<unknown>;
        };
        await client.set(recovery.stageKey, String(commandSequence));
        await client.set(recovery.intentKey, recovery.serializedComment);
    }
    return true;
}
const mockBeginManualTakeover = mock.fn(stageMockManualTakeover);
const mockAbortManualTakeover = mock.fn(async () => true);
const mockWithTransitionLease = mock.fn(async (
    _redis: unknown,
    _identity: unknown,
    _correlationId: string,
    operation: (assertOwned: () => Promise<void>) => Promise<unknown>,
) => operation(async () => {}));

function createUltrafixDepsForTest() {
    return {
        loadUltrafixRatingGoal: mock.fn(async () => 7),
        loadUltrafixMaxCycles: mock.fn(async () => 5),
        loadUltrafixPauseSeconds: mock.fn(async () => 60),
        loadPrReviewModel: mock.fn(async () => ''),
        beginManualTakeover: mockBeginManualTakeover,
        abortManualTakeover: mockAbortManualTakeover,
        completeManualTakeover: mockClearDeferredContinuation,
        reserveFreshTransition: mockReserveFreshTransition,
        commitFreshLoop: mockCommitFreshLoop,
        abortFreshTransition: mockAbortFreshTransition,
        withTransitionLease: mockWithTransitionLease,
        getPendingReviewState: mockGetPendingReviewState,
    };
}

setUltrafixDeps(createUltrafixDepsForTest());

after(async () => {
    await shutdownQueue();
    await closeConnection();
});

// ========== Helpers ==========

function createMockRedis() {
    const store = new Map<string, string>();
    const lists = new Map<string, string[]>();
    const rpush = mock.fn(async (key: string, value: string) => {
        const list = lists.get(key) ?? [];
        list.push(value);
        lists.set(key, list);
    });
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
        lrange: mock.fn(async (key: string, start: number, end: number) => {
            const list = lists.get(key) ?? [];
            return list.slice(start, end === -1 ? undefined : end + 1);
        }),
        expire,
        eval: mock.fn(async (
            script: string,
            keyCount: number,
            ...args: string[]
        ) => {
            if (script.includes("if redis.call('GET', KEYS[1]) ~= ARGV[1]")) {
                const expectedSequence = args[keyCount];
                if (store.get(args[0]) !== expectedSequence) return 0;
                for (const key of args.slice(0, keyCount)) store.delete(key);
                return 1;
            }
            if (script.includes("local existing = redis.call('GET', KEYS[1])")) {
                const [sequenceKey, counterKey] = args;
                const existing = store.get(sequenceKey);
                if (existing) return Number(existing);
                const next = Number(store.get(counterKey) ?? '0') + 1;
                store.set(counterKey, String(next));
                store.set(sequenceKey, String(next));
                return next;
            }
            throw new Error('unexpected Redis script');
        }),
        _store: store,
        _lists: lists,
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
        setUltrafixDeps(createUltrafixDepsForTest());
        mockSafeUpdateLabels.mock.resetCalls();
        mockQueueAdd.mock.resetCalls();
        mockOctokit.request.mock.resetCalls();
        mockLoggerInstance.info.mock.resetCalls();
        mockLoggerInstance.warn.mock.resetCalls();
        mockCommitFreshLoop.mock.resetCalls();
        mockCommitFreshLoop.mock.mockImplementation(async (_redis, _options, hasPendingReviews) => ({
            state: {},
            initialAction: hasPendingReviews ? 'fix' : 'review',
        }));
        mockClearDeferredContinuation.mock.resetCalls();
        mockClearDeferredContinuation.mock.mockImplementation(async () => 1);
        mockReserveFreshTransition.mock.resetCalls();
        mockReserveFreshTransition.mock.mockImplementation(async () => ({ generation: 1, baseGeneration: 0 }));
        mockAbortFreshTransition.mock.resetCalls();
        mockAbortFreshTransition.mock.mockImplementation(async () => true);
        mockBeginManualTakeover.mock.resetCalls();
        mockBeginManualTakeover.mock.mockImplementation(stageMockManualTakeover);
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

        // Default: fresh-loop commit returns review as initial action
        mockCommitFreshLoop.mock.mockImplementation(async (_redis: unknown, _options: unknown, hasPendingReviews: boolean) => ({
            state: {},
            initialAction: (hasPendingReviews ? 'fix' : 'review') as 'review' | 'fix',
        }));
    });

    test('bare /ultrafix initializes loop and enqueues review job', async () => {
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-uf-1', config);

        // Should call startLoop
        assert.strictEqual(mockCommitFreshLoop.mock.callCount(), 1);
        assert.strictEqual(mockReserveFreshTransition.mock.callCount(), 1);
        assert.strictEqual(mockWithTransitionLease.mock.callCount(), 1);
        const loopOptions = mockCommitFreshLoop.mock.calls[0].arguments[1] as Record<string, unknown>;
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
        const jobOptions = mockQueueAdd.mock.calls[0].arguments[2] as Record<string, unknown>;
        assert.strictEqual(jobOptions.delay, 30_000);
        assert.match(String(jobOptions.jobId), /-1$/);

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
        mockCommitFreshLoop.mock.mockImplementationOnce(async () => {
            throw new Error('Ultrafix loop startup was superseded by a newer command');
        });
        mockAbortFreshTransition.mock.mockImplementationOnce(async () => false);
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-stale-rollback', config),
            /superseded/,
        );

        assert.strictEqual(mockAbortFreshTransition.mock.callCount(), 1);
        assert.deepStrictEqual(mockAbortFreshTransition.mock.calls[0].arguments.slice(1), [
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

        assert.strictEqual(mockCommitFreshLoop.mock.callCount(), 0);
        assert.strictEqual(mockAbortFreshTransition.mock.callCount(), 1);
        assert.deepStrictEqual(mockAbortFreshTransition.mock.calls[0].arguments.slice(1), [
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

    test('settings failure aborts the reservation before any generation is published', async () => {
        const failingDeps = {
            ...createUltrafixDepsForTest(),
            loadUltrafixRatingGoal: mock.fn(async () => { throw new Error('settings unavailable'); }),
        };
        setUltrafixDeps(failingDeps);
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-settings-failure', config),
            /settings unavailable/,
        );

        assert.strictEqual(mockReserveFreshTransition.mock.callCount(), 1);
        assert.strictEqual(mockAbortFreshTransition.mock.callCount(), 1);
        assert.strictEqual(mockCommitFreshLoop.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        setUltrafixDeps(createUltrafixDepsForTest());
    });

    test('publishes the new generation only after its first job is durable', async () => {
        const operations: string[] = [];
        mockReserveFreshTransition.mock.mockImplementationOnce(async () => {
            operations.push('reserve');
            return { generation: 1, baseGeneration: 0 };
        });
        mockQueueAdd.mock.mockImplementationOnce(async () => { operations.push('enqueue'); });
        mockCommitFreshLoop.mock.mockImplementationOnce(async () => {
            operations.push('commit');
            return { state: {}, initialAction: 'review' };
        });

        await processCommentEvent(
            createPRCommentEvent('/ultrafix'), 'issue_comment', 'corr-uf-publish-order', createTestConfig(),
        );

        assert.deepStrictEqual(operations, ['reserve', 'enqueue', 'commit']);
    });

    test('accepts an ambiguously acknowledged deterministic startup job before publishing', async () => {
        let lookupCount = 0;
        mockQueueAdd.mock.mockImplementationOnce(async () => { throw new Error('queue response lost'); });
        mockQueueGetJob.mock.mockImplementation(async () => {
            lookupCount += 1;
            return lookupCount === 1 ? null : {};
        });

        await processCommentEvent(
            createPRCommentEvent('/ultrafix'), 'issue_comment', 'corr-uf-ambiguous-enqueue', createTestConfig(),
        );

        assert.strictEqual(mockCommitFreshLoop.mock.callCount(), 1);
        assert.strictEqual(mockAbortFreshTransition.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
    });

    test('a failed publication retry uses a new generation and job identity', async () => {
        let reservationCount = 0;
        mockReserveFreshTransition.mock.mockImplementation(async () => ({
            generation: ++reservationCount,
            baseGeneration: 0,
        }));
        let commitCount = 0;
        mockCommitFreshLoop.mock.mockImplementation(async () => {
            if (++commitCount === 1) throw new Error('redis response lost');
            return { state: {}, initialAction: 'review' };
        });
        const event = createPRCommentEvent('/ultrafix');
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-uf-publish-failure', config),
            /redis response lost/,
        );
        await processCommentEvent(event, 'issue_comment', 'corr-uf-publish-retry', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 2);
        const firstOptions = mockQueueAdd.mock.calls[0].arguments[2] as Record<string, unknown>;
        const secondOptions = mockQueueAdd.mock.calls[1].arguments[2] as Record<string, unknown>;
        assert.notStrictEqual(firstOptions.jobId, secondOptions.jobId);
        assert.strictEqual((mockQueueAdd.mock.calls[0].arguments[1].ultrafixMeta as Record<string, unknown>).generation, 1);
        assert.strictEqual((mockQueueAdd.mock.calls[1].arguments[1].ultrafixMeta as Record<string, unknown>).generation, 2);
        assert.deepStrictEqual(mockReserveFreshTransition.mock.calls.map(call => call.arguments[2]), [1, 1]);
    });

    test('duplicate /ultrafix deliveries for the same comment initialize only one loop', async () => {
        const event = createPRCommentEvent('/ultrafix goal=8 max=4');
        const config = createTestConfig();

        await Promise.all([
            processCommentEvent(event, 'issue_comment', 'corr-uf-dupe-1', config),
            processCommentEvent(event, 'issue_comment', 'corr-uf-dupe-2', config),
        ]);

        assert.strictEqual(mockCommitFreshLoop.mock.callCount(), 1);
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

        assert.strictEqual(mockCommitFreshLoop.mock.callCount(), 1);
        const loopOptions = mockCommitFreshLoop.mock.calls[0].arguments[1] as Record<string, unknown>;
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

        assert.strictEqual(mockCommitFreshLoop.mock.callCount(), 1);
        const loopOptions = mockCommitFreshLoop.mock.calls[0].arguments[1] as Record<string, unknown>;
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
        assert.strictEqual(mockCommitFreshLoop.mock.callCount(), 1);
        const hasPendingReviews = mockCommitFreshLoop.mock.calls[0].arguments[2] as boolean;
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
        assert.strictEqual(mockCommitFreshLoop.mock.callCount(), 1);
        const hasPendingReviews = mockCommitFreshLoop.mock.calls[0].arguments[2] as boolean;
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

        assert.strictEqual(mockCommitFreshLoop.mock.calls[0].arguments[2], true);
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

        assert.strictEqual(mockCommitFreshLoop.mock.callCount(), 0);
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
        mockBeginManualTakeover.mock.mockImplementationOnce(async (...args) => {
            operations.push('fence');
            return stageMockManualTakeover(...args);
        });
        mockQueueAdd.mock.mockImplementationOnce(async () => { operations.push('enqueue'); });
        mockClearDeferredContinuation.mock.mockImplementationOnce(async () => {
            operations.push('cancel');
            return 2;
        });
        const event = createPRCommentEvent('/fix F1');
        const config = createTestConfig();
        config.redisClient.set.mock.mockImplementation(async (
            key: string, value: string, ...args: string[]
        ) => {
            if (args.includes('NX') && config.redisClient._store.has(key)) return null;
            config.redisClient._store.set(key, value);
            if (key.startsWith('pr-command-takeover:') && !key.endsWith(':intent')) operations.push('stage');
            return 'OK';
        });

        await processCommentEvent(event, 'issue_comment', 'corr-uf-manual-fix', config);

        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 1);
        assert.deepStrictEqual(
            mockClearDeferredContinuation.mock.calls[0].arguments.slice(1),
            [{ owner: 'testowner', repo: 'testrepo', pr: 42 }, 1],
        );
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.deepStrictEqual(
            operations,
            ['lease-start', 'fence', 'stage', 'enqueue', 'cancel', 'lease-end'],
        );
    });

    test('editing a committed slash command allocates a new command sequence and job', async () => {
        const original = createPRCommentEvent('/fix F1');
        original.comment.id = 700;
        original.comment.updated_at = '2026-08-09T01:00:00Z';
        const config = createTestConfig();
        config.processCommentEvent = (
            payload: Parameters<typeof processCommentEvent>[0],
            eventType: Parameters<typeof processCommentEvent>[1],
            correlationId: string,
        ) => processCommentEvent(payload, eventType, correlationId, config);

        await processCommentEvent(original, 'issue_comment', 'corr-original-command', config);

        const edited = createPRCommentEvent('/fix F2');
        edited.comment.id = original.comment.id;
        edited.comment.updated_at = '2026-08-09T01:01:00Z';
        await handleCommentEdited(edited, 'issue_comment', 'corr-edited-command', config);

        assert.deepStrictEqual(
            mockBeginManualTakeover.mock.calls.map(call => call.arguments[2]),
            [1, 2],
        );
        assert.strictEqual(mockQueueAdd.mock.callCount(), 2);
        const jobIds = mockQueueAdd.mock.calls.map(call => call.arguments[2].jobId as string);
        assert.notStrictEqual(jobIds[0], jobIds[1]);
        assert.ok(jobIds[0].endsWith('-700-1'));
        assert.ok(jobIds[1].endsWith('-700-2'));
    });

    test('an edit retires an older durable recovery stage before scheduling its new revision', async () => {
        const durableJobIds = new Set<string>();
        mockQueueAdd.mock.mockImplementation(async (_name: string, _data: unknown, options: { jobId?: string }) => {
            if (options.jobId) durableJobIds.add(options.jobId);
        });
        mockQueueGetJob.mock.mockImplementation(async (jobId: string) => durableJobIds.has(jobId) ? {} : null);
        mockClearDeferredContinuation.mock.mockImplementationOnce(async () => {
            throw new Error('first transition commit interrupted');
        });
        const original = createPRCommentEvent('/fix F1');
        original.comment.id = 701;
        original.comment.updated_at = '2026-08-09T01:00:00Z';
        const config = createTestConfig();
        config.processCommentEvent = (
            payload: Parameters<typeof processCommentEvent>[0],
            eventType: Parameters<typeof processCommentEvent>[1],
            correlationId: string,
        ) => processCommentEvent(payload, eventType, correlationId, config);

        await assert.rejects(
            processCommentEvent(original, 'issue_comment', 'corr-interrupted-original', config),
            /first transition commit interrupted/,
        );

        const edited = createPRCommentEvent('/fix F2');
        edited.comment.id = original.comment.id;
        edited.comment.updated_at = '2026-08-09T01:01:00Z';
        await handleCommentEdited(edited, 'issue_comment', 'corr-new-revision', config);

        assert.deepStrictEqual(
            mockClearDeferredContinuation.mock.calls.map(call => call.arguments[2]),
            [1, 1, 2],
        );
        assert.strictEqual(mockQueueAdd.mock.callCount(), 2);
        assert.ok((mockQueueAdd.mock.calls[1].arguments[2].jobId as string).endsWith('-701-2'));
        assert.strictEqual(mockQueueAdd.mock.calls[1].arguments[1].commandInstructions, 'F2');
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
        let replacementLookup = 0;
        mockQueueGetJob.mock.mockImplementation(async () => (++replacementLookup === 1 ? null : {}));
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
        assert.strictEqual(
            [...config.redisClient._store.keys()].some(key => key.endsWith(':intent')),
            true,
        );
    });

    test('ambiguous atomic takeover acknowledgement preserves its recovery intent', async () => {
        const event = createPRCommentEvent('/review');
        const config = createTestConfig();
        mockBeginManualTakeover.mock.mockImplementationOnce(async (...args) => {
            await stageMockManualTakeover(...args);
            throw new Error('connection lost after Redis accepted takeover');
        });

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-ambiguous-batch', config),
            /connection lost after Redis accepted takeover/,
        );

        assert.strictEqual(mockAbortManualTakeover.mock.callCount(), 0);
        assert.strictEqual(mockClearDeferredContinuation.mock.callCount(), 0);
        assert.strictEqual(
            [...config.redisClient._store.entries()].some(([key, value]) =>
                key.startsWith('pr-command-takeover:') && value === '1'),
            true,
        );
        assert.strictEqual(
            [...config.redisClient._store.keys()].some(key => key.endsWith(':intent')),
            true,
        );
    });

    test('an older handler cannot delete a stage now owned by a newer sequence', async () => {
        const event = createPRCommentEvent('/fix F1');
        event.comment.id = 702;
        const config = createTestConfig();
        mockClearDeferredContinuation.mock.mockImplementationOnce(async () => {
            const stageKey = [...config.redisClient._store.keys()].find(key =>
                key.startsWith('pr-command-takeover:'))!;
            config.redisClient._store.set(stageKey, '2');
            return 2;
        });

        await processCommentEvent(event, 'issue_comment', 'corr-stage-owner', config);

        assert.strictEqual(
            [...config.redisClient._store.entries()].some(([key, value]) =>
                key.startsWith('pr-command-takeover:') && value === '2'),
            true,
        );
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
            [1, 1],
        );
        assert.deepStrictEqual(
            mockReserveFreshTransition.mock.calls.map(call => call.arguments[2]),
            [2],
        );
    });
});
