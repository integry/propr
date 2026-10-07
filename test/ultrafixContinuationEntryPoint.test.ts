import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const mockQueueAdd = mock.fn(async () => ({}));
const mockQueueGetJobs = mock.fn(async () => [] as unknown[]);
const mockQueueGetJob = mock.fn(async (_jobId: string) => undefined as unknown);
const mockGetIssueQueue = mock.fn(async () => ({
    add: mockQueueAdd,
    getJobs: mockQueueGetJobs,
    getJob: mockQueueGetJob,
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
const evaluatedPullRequest = { headSha: 'evaluated-head', baseRef: 'main' };
const mockGateAutoMergeArming = mock.fn(async (_input: Record<string, unknown>) => ({
    arm: true, reason: 'armed', mergeMethod: 'SQUASH', pullRequest: evaluatedPullRequest,
}));
let escalationEnabled = false;

await mock.module('@propr/core', {
    namedExports: {
        AgentRegistry: {},
        logger: { info: () => {} },
        loadUltrafixEscalationSettings: async () => ({ enabled: escalationEnabled, models: [], patience: 3, maxReasoningLevels: 2 }),
        loadModelReasoningLevel: async () => '',
        DEFAULT_ULTRAFIX_CI_WAIT_TIMEOUT_MS: 2 * 60 * 60 * 1000,
        loadUltrafixCiWaitTimeoutMs: async () => 2 * 60 * 60 * 1000,
        resolveAgentModelReasoningLevel: () => undefined,
        resolveRuntimeModelReasoningLevel: () => null,
        resolveLlmLabel: async (model: string) => ({ agentAlias: model.split(':')[0], model: model.split(':')[1] }),
    resolveConfiguredModel: async (model: string) => model,
        findPlanIssueByRepoAndPR: mockFindPlanIssueByRepoAndPR,
        gateAutoMergeArming: mockGateAutoMergeArming,
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
    resumeDeferredContinuation,
    setCheckRunDeps,
} = await import('../src/jobs/ultrafixLoopContinuation.js');
const { acquireResumeClaim } = await import('../src/jobs/ultrafixResumeClaim.js');
const { getUltrafixStepJobId } = await import('../src/jobs/ultrafixLoopContinuationHelpers.js');
const {
    createDefaultState,
    getUltrafixAutomaticWorkEpoch,
    invalidateUltrafixAutomaticWork,
    loadDeferredContinuation,
    saveDeferredContinuation,
    saveState,
    loadState,
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
        const gateInput = mockGateAutoMergeArming.mock.calls.at(-1)?.arguments[0];
        assert.equal(gateInput?.opportunity, 'ultrafix_goal');
        assert.equal(gateInput?.prNumber, 44);
        // Auto-merge is armed only for the head and base the policy evaluated.
        const enableInput = (mockEnableAutoMerge.mock.calls.at(-1)?.arguments as unknown as [Record<string, unknown>])[0];
        assert.deepEqual(enableInput.expectedHead, evaluatedPullRequest);
    });

    test('a goal-reaching Ultrafix does not arm auto-merge when the repository policy skips it', async () => {
        const redis = createMockRedis();
        await startLoop(redis as never, { owner: 'acme', repo: 'web', pr: 46, goal: 8 }, false);
        mockGetPendingReviewState.mock.mockImplementation(async () => ({
            latestScore: 9, reviewStatus: 'valid_clean', hasPendingReview: false, unprocessedComments: [], isPartial: false,
        }));
        mockFindPlanIssueByRepoAndPR.mock.mockImplementation(async () => ({ issue_number: 99 }));
        mockOctokitRequest.mock.mockImplementation(async (_route: string, options: Record<string, unknown>) => ({
            data: { labels: [{ name: options.issue_number === 99 ? 'auto-merge' : 'ultrafix' }] },
        }));
        mockGateAutoMergeArming.mock.mockImplementationOnce(async () => ({ arm: false, reason: 'skipped_protected_path' }) as never);
        const enableCalls = mockEnableAutoMerge.mock.callCount();

        await continueUltrafixLoop({
            owner: 'acme', repo: 'web', pullRequestNumber: 46, completedAction: 'review',
            ultrafixMeta: { mode: 'ultrafix', goal: 8, instructions: '' }, redisClient: redis as never, correlatedLogger: logger as never,
            correlationId: 'policy-skip-correlation-id', currentJobId: 'completed-policy-skip-review-job',
            currentReviewCommentIds: [204], currentReviewResultCount: 1,
        });

        assert.equal(mockGateAutoMergeArming.mock.calls.at(-1)?.arguments[0]?.prNumber, 46);
        assert.equal(mockEnableAutoMerge.mock.callCount(), enableCalls);
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
    test('state lost after record decides reason and outcome from one epoch read', async () => {
        const { getUltrafixStateKey } = await import('../src/jobs/ultrafixOrchestrationService.js');
        const { getUltrafixAutomaticWorkEpochKey } = await import('../src/jobs/ultrafixAutomaticWorkEpoch.js');
        const stateKey = getUltrafixStateKey('acme', 'web', 45);
        const epochKey = getUltrafixAutomaticWorkEpochKey('acme', 'web', 45);

        const run = async (moveEpochAfterLoad: boolean) => {
            const redis = createMockRedis();
            await startLoop(redis as never, { owner: 'acme', repo: 'web', pr: 45, goal: 8 }, false);
            let stateReads = 0;
            let epochReadsAfterLoss = 0;
            const originalGet = redis.get.bind(redis);
            redis.get = async (key: string) => {
                if (key === stateKey) {
                    stateReads += 1;
                    // The first read serves continuation's own load; the record
                    // step then finds the state gone (cleared by a concurrent stop).
                    if (stateReads > 1) {
                        if (moveEpochAfterLoad) await redis.set(epochKey, '1');
                        return null;
                    }
                }
                if (key === epochKey && stateReads > 1) epochReadsAfterLoss += 1;
                return originalGet(key);
            };
            const result = await continueUltrafixLoop({
                owner: 'acme',
                repo: 'web',
                pullRequestNumber: 45,
                completedAction: 'review',
                ultrafixMeta: { mode: 'ultrafix', goal: 8, instructions: '' },
                redisClient: redis as never,
                correlatedLogger: logger as never,
                correlationId: 'lost-state-correlation-id',
                currentJobId: 'completed-review-job',
            });
            return { result, epochReadsAfterLoss };
        };

        const lost = await run(false);
        assert.equal(lost.result.continued, false);
        assert.equal(lost.result.reason, 'state_lost_after_record');
        assert.equal(lost.result.outcome, 'failed');
        assert.equal(lost.epochReadsAfterLoss, 1, 'reason and outcome derive from a single epoch read');

        const superseded = await run(true);
        assert.equal(superseded.result.continued, false);
        assert.equal(superseded.result.reason, 'ultrafix_superseded');
        assert.equal(superseded.result.outcome, 'stopped');
        assert.equal(superseded.epochReadsAfterLoss, 1);
        assert.equal(mockQueueAdd.mock.callCount(), 0);
    });
});


test('reaching the final model keeps the loop running with its current execution', async () => {
    escalationEnabled = true;
    const redis = createMockRedis();
    const { state } = await startLoop(redis as never, { owner: 'acme', repo: 'web', pr: 90, goal: 9, maxCycles: 20 }, false);
    state.escalation = {
        models: ['base'], patience: 1, maxReasoningLevels: 0, modelIndex: 0,
        current: { model: 'base', levels: ['low', 'high'], effort: 'low' },
        climbs: 0, bestScore: 8, stalledReviews: 0, exhausted: false,
    };
    await saveState(redis as never, state);
    const before = mockOctokitRequest.mock.callCount();
    const result = await continueUltrafixLoop({
        owner: 'acme', repo: 'web', pullRequestNumber: 90, completedAction: 'review',
        ultrafixMeta: { mode: 'ultrafix', goal: 9, instructions: '' },
        redisClient: redis as never, correlatedLogger: logger as never,
        correlationId: 'exhaustion', currentReviewCommentIds: [101], currentReviewResultCount: 1,
    });
    assert.equal(result.continued, true);
    const saved = await loadState(redis as never, 'acme', 'web', 90);
    assert.equal(saved?.active, true);
    assert.equal(saved?.escalation?.exhausted, false);
    assert.equal(saved?.escalation?.modelIndex, 0);
    assert.deepEqual(saved?.escalation?.current, state.escalation.current);
    const comments = mockOctokitRequest.mock.calls.slice(before).filter(call => call.arguments[0].startsWith('POST'));
    assert.equal(comments.length, 0);
    assert.equal(mockQueueAdd.mock.callCount(), 1);
});

test('disabled escalation leaves persisted review state byte-for-byte unchanged', async () => {
    escalationEnabled = false;
    const redis = createMockRedis();
    const { state } = await startLoop(redis as never, { owner: 'acme', repo: 'web', pr: 91 }, false);
    const before = JSON.stringify(state);
    const { recordUltrafixEscalationReview } = await import('../src/jobs/ultrafixEscalation.js');
    await recordUltrafixEscalationReview(redis as never, state, 6);
    assert.equal(JSON.stringify(await loadState(redis as never, 'acme', 'web', 91)), before);
});

// --- Stranded loop re-arming ---

/** Redis mock that executes the epoch, deferred, and claim scripts faithfully. */
function createRearmRedis() {
    const store = new Map<string, string>();
    return {
        store,
        async get(key: string) { return store.get(key) ?? null; },
        async set(key: string, value: string, ...options: Array<string | number>) {
            if (options.includes('NX') && store.has(key)) return null;
            store.set(key, value);
            return 'OK';
        },
        async del(key: string) { return store.delete(key) ? 1 : 0; },
        async getdel(key: string) {
            const value = store.get(key) ?? null;
            store.delete(key);
            return value;
        },
        async eval(script: string, _keyCount: number, ...args: string[]) {
            if (script.includes('-- clear rearm retry if claim held')) {
                const [claimKey, retryKey, epochKey, token, expectedEpoch] = args;
                if (store.get(claimKey) !== token) return 0;
                if (expectedEpoch !== '' && (store.get(epochKey) ?? '0') !== expectedEpoch) return -1;
                store.delete(retryKey);
                return 1;
            }
            if (script.includes('-- save rearm retry unless claim taken')) {
                const [claimKey, retryKey, token, value] = args;
                const holder = store.get(claimKey);
                if (holder !== undefined && holder !== token) return 0;
                store.set(retryKey, value);
                return 1;
            }
            if (script.includes('-- restore deferred if loop unchanged')) {
                const [epochKey, stateKey, deferredKey, expectedEpoch, expectedState, value] = args;
                if ((store.get(epochKey) ?? '0') !== expectedEpoch) return 0;
                if (store.get(stateKey) !== expectedState) return 0;
                if (store.has(deferredKey)) return 0;
                store.set(deferredKey, value);
                return 1;
            }
            if (script.includes("redis.call('PEXPIRE'")) {
                const [claimKey, token] = args;
                return store.get(claimKey) === token ? 1 : 0;
            }
            if (script.includes("redis.call('DEL', KEYS[1])")) {
                const [claimKey, token] = args;
                return store.get(claimKey) === token && store.delete(claimKey) ? 1 : 0;
            }
            if (script.includes('-- reserve epoch and replace state')) {
                // Epoch- and snapshot-conditional reservation of the next epoch.
                const [epochKey, stateKey, deferredKey, expectedEpoch, expectedState, value] = args;
                if ((store.get(epochKey) ?? '0') !== expectedEpoch) return 0;
                if (store.get(stateKey) !== expectedState) return 0;
                const next = Number(expectedEpoch) + 1;
                store.set(epochKey, String(next));
                store.delete(deferredKey);
                store.set(stateKey, value);
                return next;
            }
            if (script.includes('local current_state')) {
                // Epoch- and snapshot-conditional state replace/clear.
                const [epochKey, stateKey, expectedEpoch, expectedState, value] = args;
                if ((store.get(epochKey) ?? '0') !== expectedEpoch) return 0;
                if (store.get(stateKey) !== expectedState) return 0;
                if (script.includes("redis.call('DEL', KEYS[2])")) store.delete(stateKey);
                else store.set(stateKey, value);
                return 1;
            }
            const [epochKey, targetKey, expectedEpoch, value] = args;
            if (script.includes("redis.call('INCR'")) {
                const next = Number(store.get(epochKey) ?? '0') + 1;
                store.set(epochKey, String(next));
                store.delete(targetKey);
                return next;
            }
            if ((store.get(epochKey) ?? '0') !== expectedEpoch) return 0;
            if (script.includes("redis.call('DEL', KEYS[2])")) store.delete(targetKey);
            else store.set(targetKey, value);
            return 1;
        },
        async llen(_key: string) { return 0; },
    };
}

const greenChecks = async () => ({ count: 1, allPassing: true, anyPending: false, anyFailed: false });

describe('stranded Ultrafix loop re-arming', () => {
    beforeEach(() => {
        mockQueueAdd.mock.resetCalls();
        mockQueueAdd.mock.mockImplementation(async () => ({}));
        mockQueueGetJobs.mock.resetCalls();
        mockQueueGetJobs.mock.mockImplementation(async () => []);
        mockQueueGetJob.mock.resetCalls();
        mockQueueGetJob.mock.mockImplementation(async () => undefined);
        mockOctokitRequest.mock.resetCalls();
        mockOctokitRequest.mock.mockImplementation(async () => ({ data: { labels: [{ name: 'ultrafix' }] } }));
        mockGetCheckRunsStatus.mock.resetCalls();
        mockGetCheckRunsStatus.mock.mockImplementation(greenChecks);
        setCheckRunDeps({
            areAllChecksPassing: mockAreAllChecksPassing,
            getCurrentPRHead: mockGetCurrentPRHead,
            getCheckRunsStatus: mockGetCheckRunsStatus,
        });
    });

    /** Active loop deferred on red CI, then fenced by a CI-failure follow-up. */
    async function strandLoop(pr: number, overrides: Record<string, unknown> = {}) {
        const redis = createRearmRedis();
        await saveState(redis as never, {
            ...createDefaultState({ owner: 'acme', repo: 'web', pr, goal: 8, maxCycles: 5, pauseSeconds: 30 }),
            lastAction: 'fix', reviewCount: 1, fixCount: 1, cycleCount: 1,
            ...overrides,
        });
        await saveDeferredContinuation(redis as never, {
            owner: 'acme', repo: 'web', pr, nextAction: 'review',
            savedAt: new Date().toISOString(), reason: 'checks_not_passing', workEpoch: 0,
        });
        await invalidateUltrafixAutomaticWork(redis as never, 'acme', 'web', pr);
        return redis;
    }

    test('green checks re-arm a loop whose deferred continuation was cleared', async () => {
        const redis = await strandLoop(60);
        assert.equal(await loadDeferredContinuation(redis as never, 'acme', 'web', 60), null);

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 60 }, redis as never, logger as never);

        assert.equal(result.continued, true);
        assert.equal(result.reason, 'stranded_loop_rearmed');
        assert.equal(result.nextAction, 'review');
        assert.equal(mockQueueAdd.mock.callCount(), 1);
        const [, data, options] = mockQueueAdd.mock.calls[0].arguments as unknown as [string, any, any];
        assert.equal(data.commandMode, 'review');
        // The fenced epoch was 1; the re-arm reserves its own so later fences supersede it.
        assert.equal(data.ultrafixMeta.workEpoch, 2);
        assert.equal(options.jobId, getUltrafixStepJobId('acme', 'web', 60, { action: 'review', workEpoch: 2, stepNumber: 2 }));
        assert.match(options.jobId, /^pr-comments-batch-acme-web-60-ultrafix-review-2-2-[0-9a-f]{32}$/);
        assert.equal(options.delay, 30_000);
        assert.equal((await loadState(redis as never, 'acme', 'web', 60))?.workEpoch, 2);
        assert.equal(await getUltrafixAutomaticWorkEpoch(redis as never, 'acme', 'web', 60), 2);
    });

    test('a deferred record from a superseded epoch falls back to re-arming', async () => {
        const redis = await strandLoop(61);
        // A stale continuation slipped its old-epoch record back in.
        redis.store.set('ultrafix:deferred:acme:web:61', JSON.stringify({
            owner: 'acme', repo: 'web', pr: 61, nextAction: 'review',
            savedAt: new Date().toISOString(), reason: 'checks_not_passing', workEpoch: 0,
        }));

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 61 }, redis as never, logger as never);

        assert.equal(result.reason, 'stranded_loop_rearmed');
        assert.equal(mockQueueAdd.mock.callCount(), 1);
    });

    test('does not re-arm while an Ultrafix job is already queued', async () => {
        const redis = await strandLoop(62);
        mockQueueGetJobs.mock.mockImplementation(async () => [{
            id: 'queued-review',
            data: { repoOwner: 'acme', repoName: 'web', pullRequestNumber: 62, ultrafixMeta: { mode: 'ultrafix' } },
        }]);

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 62 }, redis as never, logger as never);

        assert.equal(result.continued, false);
        assert.match(result.reason, /follow_up_jobs_active/);
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        assert.equal((await loadState(redis as never, 'acme', 'web', 62))?.workEpoch, 0, 'epoch is only synced when re-arming');
    });

    test('does not re-arm while head checks are not passing', async () => {
        const redis = await strandLoop(63);
        mockGetCheckRunsStatus.mock.mockImplementation(async () => ({ count: 1, allPassing: false, anyPending: true, anyFailed: false }));

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 63 }, redis as never, logger as never);

        assert.match(result.reason, /checks_not_passing/);
        assert.equal(mockQueueAdd.mock.callCount(), 0);
    });

    test('a concurrent trigger holding the claim prevents a double re-arm', async () => {
        const redis = await strandLoop(64);
        await acquireResumeClaim(redis as never, { owner: 'acme', repo: 'web', pr: 64 }, 'other-trigger', 60_000);

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 64 }, redis as never, logger as never);

        assert.equal(result.reason, 'resume_in_progress');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
    });

    test('the claim is released so a later trigger can re-evaluate', async () => {
        const redis = await strandLoop(65);
        mockGetCheckRunsStatus.mock.mockImplementation(async () => ({ count: 1, allPassing: false, anyPending: true, anyFailed: false }));
        await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 65 }, redis as never, logger as never);

        mockGetCheckRunsStatus.mock.mockImplementation(greenChecks);
        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 65 }, redis as never, logger as never);

        // The red pass turned the loop into a deferral under the current epoch.
        assert.equal(result.reason, 'deferred_resumed');
        assert.equal(mockQueueAdd.mock.callCount(), 1);
    });

    test('a step that is already pending in the queue is not inserted twice', async () => {
        const redis = await strandLoop(66);
        const remove = mock.fn(async () => undefined);
        mockQueueGetJob.mock.mockImplementation(async () => ({ getState: async () => 'delayed', remove }));

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 66 }, redis as never, logger as never);

        assert.equal(result.reason, 'rearm_duplicate');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        assert.equal(remove.mock.callCount(), 0);
    });

    test('a finished attempt with the same step ID is replaced instead of silently blocking', async () => {
        const redis = await strandLoop(67);
        const remove = mock.fn(async () => undefined);
        mockQueueGetJob.mock.mockImplementation(async () => ({ getState: async () => 'failed', remove }));

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 67 }, redis as never, logger as never);

        assert.equal(result.reason, 'stranded_loop_rearmed');
        assert.equal(remove.mock.callCount(), 1);
        assert.equal(mockQueueAdd.mock.callCount(), 1);
    });

    test('a step ID whose job vanished (state unknown) does not block the enqueue', async () => {
        const redis = await strandLoop(87);
        const remove = mock.fn(async () => undefined);
        mockQueueGetJob.mock.mockImplementation(async () => ({ getState: async () => 'unknown', remove }));

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 87 }, redis as never, logger as never);

        assert.equal(result.reason, 'stranded_loop_rearmed');
        assert.equal(remove.mock.callCount(), 0);
        assert.equal(mockQueueAdd.mock.callCount(), 1);
    });

    test('a duplicate-job error from the queue is handled gracefully', async () => {
        const redis = await strandLoop(68);
        mockQueueAdd.mock.mockImplementation(async () => {
            throw Object.assign(new Error('Job pr-comments-batch already exists'), { name: 'JobAlreadyExistsError' });
        });

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 68 }, redis as never, logger as never);

        assert.equal(result.reason, 'rearm_duplicate');
    });

    test('exhausted maxCycles completes the loop as failed without a review', async () => {
        const redis = await strandLoop(69, { reviewCount: 5, fixCount: 5, cycleCount: 5 });

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 69 }, redis as never, logger as never);

        assert.equal(result.continued, false);
        assert.equal(result.outcome, 'cycles_exhausted');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        const state = await loadState(redis as never, 'acme', 'web', 69);
        assert.equal(state?.active, false);
        assert.equal(state?.completionStatus, 'failed');
    });

    test('a reached goal completes the loop as succeeded without a review', async () => {
        const redis = await strandLoop(70, { finalScore: 9 });

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 70 }, redis as never, logger as never);

        assert.equal(result.continued, false);
        assert.equal(result.outcome, 'goal_reached');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        // Success clears the loop state, just like a normal goal-reached finish.
        assert.equal(await loadState(redis as never, 'acme', 'web', 70), null);
    });

    test('a removed ultrafix label clears the loop without a review', async () => {
        const redis = await strandLoop(71);
        mockOctokitRequest.mock.mockImplementation(async () => ({ data: { labels: [] } }));

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 71 }, redis as never, logger as never);

        assert.equal(result.reason, 'label_removed');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        assert.equal(await loadState(redis as never, 'acme', 'web', 71), null);
    });

    test('inactive loops are never resumed and skip GitHub entirely', async () => {
        const redis = await strandLoop(72, { active: false });

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 72 }, redis as never, logger as never);

        assert.equal(result.reason, 'no_deferred_continuation');
        assert.equal(mockOctokitRequest.mock.callCount(), 0);
        assert.equal(mockQueueAdd.mock.callCount(), 0);
    });

    test('a trigger arriving while a deferred fix is resumed cannot re-arm a conflicting review', async () => {
        const redis = createRearmRedis();
        await saveState(redis as never, {
            ...createDefaultState({ owner: 'acme', repo: 'web', pr: 73, goal: 8, maxCycles: 5, pauseSeconds: 30 }),
            lastAction: 'review', reviewCount: 1, fixCount: 0, cycleCount: 0,
        });
        await saveDeferredContinuation(redis as never, {
            owner: 'acme', repo: 'web', pr: 73, nextAction: 'fix',
            savedAt: new Date().toISOString(), reason: 'pending_comments', workEpoch: 0,
        });
        // Hold trigger A inside its pending-comments read, after it claimed the record.
        let releasePendingRead!: () => void;
        const pendingRead = new Promise<void>(resolve => { releasePendingRead = resolve; });
        let signalReading!: () => void;
        const reading = new Promise<void>(resolve => { signalReading = resolve; });
        redis.llen = async (_key: string) => { signalReading(); await pendingRead; return 0; };

        // The queue reflects enqueued steps, as BullMQ does.
        const queued: unknown[] = [];
        mockQueueAdd.mock.mockImplementation(async (_name: string, data: Record<string, unknown>) => { queued.push({ id: 'queued', data }); return {}; });
        mockQueueGetJobs.mock.mockImplementation(async () => queued);

        const first = resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 73 }, redis as never, logger as never);
        await reading;
        assert.equal(await loadDeferredContinuation(redis as never, 'acme', 'web', 73), null, 'A already claimed the record');
        redis.llen = async (_key: string) => 0;

        const second = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 73 }, redis as never, logger as never);
        assert.equal(second.reason, 'resume_in_progress');
        assert.equal(mockQueueAdd.mock.callCount(), 0);

        releasePendingRead();
        const result = await first;
        assert.equal(result.reason, 'deferred_resumed');
        assert.equal(result.nextAction, 'fix');
        assert.equal(mockQueueAdd.mock.callCount(), 1);
        const [, data] = mockQueueAdd.mock.calls[0].arguments as unknown as [string, any];
        assert.equal(data.commandMode, 'fix');

        // Once A finishes, the claim is free again for later triggers.
        const third = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 73 }, redis as never, logger as never);
        assert.notEqual(third.reason, 'resume_in_progress');
    });

    test('a stale exhausted snapshot cannot finish a newer loop that started meanwhile', async () => {
        const redis = await strandLoop(74, { reviewCount: 5, fixCount: 5, cycleCount: 5 });
        const epochKey = 'ultrafix:automatic-work-epoch:acme:web:74';
        const get = redis.get.bind(redis);
        let started = false;
        redis.get = async (key: string) => {
            if (key === epochKey && !started) {
                // A new /ultrafix startup lands between the snapshot and the epoch read.
                started = true;
                const workEpoch = await invalidateUltrafixAutomaticWork(redis as never, 'acme', 'web', 74);
                await saveState(redis as never, {
                    ...createDefaultState({ owner: 'acme', repo: 'web', pr: 74, goal: 9, maxCycles: 5, pauseSeconds: 30 }),
                    workEpoch,
                });
                mockQueueGetJobs.mock.mockImplementation(async () => [{
                    id: 'startup-review',
                    data: { repoOwner: 'acme', repoName: 'web', pullRequestNumber: 74, ultrafixMeta: { mode: 'ultrafix' } },
                }]);
            }
            return get(key);
        };

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 74 }, redis as never, logger as never);

        assert.match(result.reason, /rearm_not_ready: .*follow_up_jobs_active/);
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        const state = await loadState(redis as never, 'acme', 'web', 74);
        assert.equal(state?.active, true);
        assert.equal(state?.workEpoch, 2);
        assert.equal(state?.reviewCount, 0);
        assert.equal(state?.goal, 9);
        assert.equal(state?.completionStatus, null);
        const posts = mockOctokitRequest.mock.calls.filter(call => String(call.arguments[0]).startsWith('POST'));
        assert.equal(posts.length, 0, 'no stopped-loop comment for the newer loop');
    });

    test('a loop stopped during the readiness check is not overwritten or re-armed', async () => {
        const redis = await strandLoop(75);
        redis.llen = async (_key: string) => {
            const current = await loadState(redis as never, 'acme', 'web', 75);
            await saveState(redis as never, { ...current!, active: false });
            return 0;
        };

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 75 }, redis as never, logger as never);

        assert.equal(result.reason, 'no_active_loop');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        const state = await loadState(redis as never, 'acme', 'web', 75);
        assert.equal(state?.active, false);
        assert.equal(state?.workEpoch, 0);
    });

    test('a permitted final fix still queued is not cut off by a cycles-exhausted recovery', async () => {
        // Fifth review found issues; the normal continuation queued the fifth fix with a delay.
        const redis = await strandLoop(77, { lastAction: 'review', reviewCount: 5, fixCount: 4, cycleCount: 4 });
        mockQueueGetJobs.mock.mockImplementation(async () => [{
            id: 'delayed-final-fix',
            data: { repoOwner: 'acme', repoName: 'web', pullRequestNumber: 77, ultrafixMeta: { mode: 'ultrafix' } },
        }]);

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 77 }, redis as never, logger as never);

        assert.equal(result.continued, false);
        assert.match(result.reason, /rearm_not_ready: .*follow_up_jobs_active/);
        assert.equal(result.outcome, undefined);
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        const state = await loadState(redis as never, 'acme', 'web', 77);
        assert.equal(state?.active, true);
        assert.equal(state?.completionStatus, null);
        assert.equal(state?.workEpoch, 0, 'ownership is left with the queued fix');
        const posts = mockOctokitRequest.mock.calls.filter(call => String(call.arguments[0]).startsWith('POST'));
        assert.equal(posts.length, 0, 'no cycles-exhausted comment');
    });

    test('pending batched comments also hold back a terminal recovery', async () => {
        const redis = await strandLoop(78, { finalScore: 9 });
        redis.llen = async (_key: string) => 1;

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 78 }, redis as never, logger as never);

        assert.match(result.reason, /rearm_not_ready: .*pending_comments_exist/);
        assert.equal((await loadState(redis as never, 'acme', 'web', 78))?.active, true);
    });

    test('an unreadable queue fails closed instead of finishing the loop', async () => {
        const redis = await strandLoop(79, { reviewCount: 5, fixCount: 5, cycleCount: 5 });
        mockQueueGetJobs.mock.mockImplementation(async () => { throw new Error('queue unavailable'); });

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 79 }, redis as never, logger as never);

        assert.match(result.reason, /rearm_not_ready: .*follow_up_jobs_unknown/);
        assert.equal((await loadState(redis as never, 'acme', 'web', 79))?.active, true);
    });

    test('a removed label does not clear a loop whose step is still queued', async () => {
        const redis = await strandLoop(80);
        mockOctokitRequest.mock.mockImplementation(async () => ({ data: { labels: [] } }));
        mockQueueGetJobs.mock.mockImplementation(async () => [{
            id: 'running-fix',
            data: { repoOwner: 'acme', repoName: 'web', pullRequestNumber: 80, ultrafixMeta: { mode: 'ultrafix' } },
        }]);

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 80 }, redis as never, logger as never);

        assert.match(result.reason, /follow_up_jobs_active/);
        assert.notEqual(await loadState(redis as never, 'acme', 'web', 80), null);
    });

    test('a deferred resume whose claim expired mid-readiness does not enqueue', async () => {
        const redis = createRearmRedis();
        await saveState(redis as never, {
            ...createDefaultState({ owner: 'acme', repo: 'web', pr: 81, goal: 8, maxCycles: 5, pauseSeconds: 30 }),
            lastAction: 'review', reviewCount: 1, fixCount: 0, cycleCount: 0,
        });
        await saveDeferredContinuation(redis as never, {
            owner: 'acme', repo: 'web', pr: 81, nextAction: 'fix',
            savedAt: new Date().toISOString(), reason: 'pending_comments', workEpoch: 0,
        });
        // A stalls in its pending-comments read; its claim expires and trigger B takes it.
        redis.llen = async (_key: string) => {
            redis.store.set('ultrafix:resume-claim:acme:web:81', 'trigger-b');
            return 0;
        };

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 81 }, redis as never, logger as never);

        assert.equal(result.continued, false);
        assert.equal(result.reason, 'resume_claim_lost');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        assert.equal(redis.store.get('ultrafix:resume-claim:acme:web:81'), 'trigger-b', "B's claim is left intact");
    });

    test('a deferred resume that lost its claim puts the claimed step back', async () => {
        const redis = createRearmRedis();
        await saveState(redis as never, {
            ...createDefaultState({ owner: 'acme', repo: 'web', pr: 82, goal: 8, maxCycles: 5, pauseSeconds: 30 }),
            lastAction: 'fix', reviewCount: 1, fixCount: 1, cycleCount: 1,
        });
        await saveDeferredContinuation(redis as never, {
            owner: 'acme', repo: 'web', pr: 82, nextAction: 'review',
            savedAt: new Date().toISOString(), reason: 'checks_not_passing', workEpoch: 0,
        });
        mockGetCheckRunsStatus.mock.mockImplementation(async () => {
            redis.store.set('ultrafix:resume-claim:acme:web:82', 'trigger-b');
            return { count: 1, allPassing: false, anyPending: true, anyFailed: false };
        });

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 82 }, redis as never, logger as never);

        assert.equal(result.reason, 'resume_claim_lost');
        // Epoch-fenced: a taker that re-arms reserves a newer epoch, which drops it.
        const restored = await loadDeferredContinuation(redis as never, 'acme', 'web', 82);
        assert.equal(restored?.nextAction, 'review');
        assert.equal(restored?.workEpoch, 0);
        assert.equal(mockQueueAdd.mock.callCount(), 0);
    });

    test('a re-arm whose claim expired mid-readiness neither takes ownership nor enqueues', async () => {
        const redis = await strandLoop(83);
        mockGetCheckRunsStatus.mock.mockImplementation(async () => {
            redis.store.set('ultrafix:resume-claim:acme:web:83', 'trigger-b');
            return greenChecks();
        });

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 83 }, redis as never, logger as never);

        assert.equal(result.reason, 'resume_claim_lost');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        assert.equal((await loadState(redis as never, 'acme', 'web', 83))?.workEpoch, 0);
    });

    test('a terminal recovery whose claim expired does not finish the loop', async () => {
        const redis = await strandLoop(84, { reviewCount: 5, fixCount: 5, cycleCount: 5 });
        mockOctokitRequest.mock.mockImplementation(async () => {
            redis.store.set('ultrafix:resume-claim:acme:web:84', 'trigger-b');
            return { data: { labels: [{ name: 'ultrafix' }] } };
        });

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 84 }, redis as never, logger as never);

        assert.equal(result.reason, 'resume_claim_lost');
        const state = await loadState(redis as never, 'acme', 'web', 84);
        assert.equal(state?.active, true);
        assert.equal(state?.workEpoch, 0);
    });

    test('a loop deleted during the label check is not resurrected', async () => {
        const redis = await strandLoop(76);
        mockOctokitRequest.mock.mockImplementation(async () => {
            redis.store.delete('ultrafix:state:acme:web:76');
            return { data: { labels: [{ name: 'ultrafix' }] } };
        });

        const result = await resumeDeferredContinuation({ owner: 'acme', repo: 'web', pr: 76 }, redis as never, logger as never);

        assert.equal(result.reason, 'no_active_loop');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        assert.equal(await loadState(redis as never, 'acme', 'web', 76), null);
    });
});
