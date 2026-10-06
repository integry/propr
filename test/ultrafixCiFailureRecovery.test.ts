/**
 * End-to-end recovery of an Ultrafix loop stranded by a CI failure.
 *
 * Each scenario drives the full lifecycle: a fix completes while CI is red and
 * the review is deferred; a CI-failure follow-up (or developer push) bumps the
 * automatic work epoch, which drops the deferred record; CI turns green and a
 * check_run / check_suite / polling trigger calls `resumeDeferredContinuation`.
 */

import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

// --- Fake BullMQ queue: retains jobs by ID like BullMQ does ---

interface FakeJob {
    id: string;
    name: string;
    data: Record<string, any>;
    opts: Record<string, any>;
    state: 'waiting' | 'active' | 'delayed' | 'completed' | 'failed';
}

const queuedJobs = new Map<string, FakeJob>();

function fakeJobHandle(job: FakeJob) {
    return {
        ...job,
        getState: async () => job.state,
        remove: async () => { queuedJobs.delete(job.id); },
    };
}

const mockQueueAdd = mock.fn(async (name: string, data: Record<string, any>, opts: Record<string, any> = {}) => {
    const id = String(opts.jobId);
    // BullMQ silently ignores an add whose job ID is already retained.
    if (queuedJobs.has(id)) return fakeJobHandle(queuedJobs.get(id)!);
    const job: FakeJob = { id, name, data, opts, state: opts.delay ? 'delayed' : 'waiting' };
    queuedJobs.set(id, job);
    return fakeJobHandle(job);
});
let hideQueueScan = false;
const mockQueueGetJobs = mock.fn(async (states: string[] = []) => hideQueueScan ? [] :
    [...queuedJobs.values()].filter(job => states.includes(job.state)).map(fakeJobHandle));
const mockQueueGetJob = mock.fn(async (jobId: string) => {
    const job = queuedJobs.get(jobId);
    return job ? fakeJobHandle(job) : undefined;
});
const mockGetIssueQueue = mock.fn(async () => ({
    add: mockQueueAdd,
    getJobs: mockQueueGetJobs,
    getJob: mockQueueGetJob,
}));

// --- GitHub: PR labels and CI status ---

let prLabels: string[] = ['ultrafix'];
const mockOctokitRequest = mock.fn(async (route: string) => (
    route.startsWith('GET') ? { data: { labels: prLabels.map(name => ({ name })) } } : { data: {} }
));

type CheckStatus = { count: number; allPassing: boolean; anyPending: boolean; anyFailed: boolean };
const RED: CheckStatus = { count: 2, allPassing: false, anyPending: false, anyFailed: true };
const GREEN: CheckStatus = { count: 2, allPassing: true, anyPending: false, anyFailed: false };
let ciStatus: CheckStatus = RED;
let prHead = 'red-head-sha';
const mockGetCheckRunsStatus = mock.fn(async () => ciStatus);
const mockAreAllChecksPassing = mock.fn(async () => ciStatus.allPassing);
const mockGetCurrentPRHead = mock.fn(async () => prHead);

await mock.module('@propr/core', {
    namedExports: {
        AgentRegistry: {},
        logger: { info: () => {} },
        loadUltrafixEscalationSettings: async () => ({ enabled: false, models: [], patience: 3, maxReasoningLevels: 2 }),
        loadModelReasoningLevel: async () => '',
        DEFAULT_ULTRAFIX_CI_WAIT_TIMEOUT_MS: 2 * 60 * 60 * 1000,
        loadUltrafixCiWaitTimeoutMs: async () => 2 * 60 * 60 * 1000,
        resolveAgentModelReasoningLevel: () => undefined,
        resolveRuntimeModelReasoningLevel: () => null,
        resolveLlmLabel: async (model: string) => ({ agentAlias: model.split(':')[0], model: model.split(':')[1] }),
        resolveConfiguredModel: async (model: string) => model,
        findPlanIssueByRepoAndPR: async () => null,
        generateCorrelationId: () => 'recovery-correlation-id',
        getAuthenticatedOctokit: async () => ({ request: mockOctokitRequest }),
        getIssueQueue: mockGetIssueQueue,
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending:${owner}:${repo}:${pr}`,
        retryConfigs: { githubApi: {} },
        safeRemoveLabel: async () => undefined,
        withUltrafixLabelTransition: async (_redis: unknown, _identity: unknown, operation: () => Promise<unknown>) => operation(),
        withRetry: async (operation: () => Promise<unknown>) => operation(),
    },
});

await mock.module('../src/github/autoMergeOperations.js', {
    namedExports: { enableAutoMerge: async () => ({ success: true }) },
});

await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: { fetchAllComments: async () => [] },
});

await mock.module('../src/jobs/reviewCommentGatherer.js', {
    namedExports: {
        getPendingReviewState: async () => ({
            latestScore: 5,
            reviewStatus: 'valid_with_blockers',
            hasPendingReview: true,
            unprocessedComments: [],
            isPartial: false,
        }),
    },
});

const {
    continueUltrafixLoop,
    resumeDeferredContinuation,
    setCheckRunDeps,
} = await import('../src/jobs/ultrafixLoopContinuation.js');
const {
    getUltrafixAutomaticWorkEpoch,
    invalidateUltrafixAutomaticWork,
    loadDeferredContinuation,
    loadState,
    saveState,
    startLoop,
} = await import('../src/jobs/ultrafixOrchestrationService.js');

/** Redis mock that executes the epoch, deferred-record, state and claim scripts faithfully. */
function createRedis() {
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
            if (script.includes("redis.call('PEXPIRE'")) {
                const [claimKey, token] = args;
                return store.get(claimKey) === token ? 1 : 0;
            }
            if (script.includes("redis.call('DEL', KEYS[1])")) {
                const [claimKey, token] = args;
                return store.get(claimKey) === token && store.delete(claimKey) ? 1 : 0;
            }
            if (script.includes('local current_state')) {
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

type FakeRedis = ReturnType<typeof createRedis>;

const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };
const OWNER = 'acme';
const REPO = 'web';

function reviewJobs(pr: number) {
    return [...queuedJobs.values()].filter(job => job.data.pullRequestNumber === pr && job.data.commandMode === 'review');
}

/** Mark every queued job as finished, as if the worker had processed it. */
function drainQueue() {
    for (const job of queuedJobs.values()) job.state = 'completed';
}

/**
 * Drive a loop into the stranded state: the automated fix finishes on red CI,
 * the next review is deferred, then a CI-failure follow-up pushes a fix commit,
 * which bumps the automatic work epoch and removes the deferred record.
 */
async function strandLoopAfterCiFailure(pr: number, stateOverrides: Record<string, unknown> = {}): Promise<FakeRedis> {
    const redis = createRedis();
    const { state } = await startLoop(redis as never, { owner: OWNER, repo: REPO, pr, goal: 8, maxCycles: 5, pauseSeconds: 30 }, false);
    await saveState(redis as never, { ...state, lastAction: 'review', reviewCount: 1, cycleCount: 0 });

    // 1. The automated fix completes while CI on its commit is red.
    ciStatus = RED;
    const paused = await continueUltrafixLoop({
        owner: OWNER,
        repo: REPO,
        pullRequestNumber: pr,
        completedAction: 'fix',
        ultrafixMeta: { mode: 'ultrafix', goal: 8, maxCycles: 5, pauseSeconds: 30, instructions: '', workEpoch: state.workEpoch },
        redisClient: redis as never,
        correlatedLogger: logger as never,
        correlationId: 'fix-correlation-id',
        currentJobId: 'completed-fix-job',
    });
    assert.equal(paused.deferred, true, 'red CI pauses the loop');
    assert.equal(paused.nextAction, 'review');
    assert.notEqual(await loadDeferredContinuation(redis as never, OWNER, REPO, pr), null);
    assert.equal(reviewJobs(pr).length, 0);

    if (Object.keys(stateOverrides).length > 0) {
        const current = await loadState(redis as never, OWNER, REPO, pr);
        await saveState(redis as never, { ...current!, ...stateOverrides });
    }

    // 2. A CI-failure follow-up pushes a fix commit and fences older automatic work.
    const epochBefore = await getUltrafixAutomaticWorkEpoch(redis as never, OWNER, REPO, pr);
    await invalidateUltrafixAutomaticWork(redis as never, OWNER, REPO, pr);
    prHead = `follow-up-fix-sha-${pr}`;
    assert.equal(await getUltrafixAutomaticWorkEpoch(redis as never, OWNER, REPO, pr), epochBefore + 1);
    assert.equal(await loadDeferredContinuation(redis as never, OWNER, REPO, pr), null, 'deferred record removed');
    assert.equal((await loadState(redis as never, OWNER, REPO, pr))?.active, true, 'loop is still active');
    return redis;
}

/** 3. All checks on the new head turn green and a check event wakes the loop. */
function checksTurnGreen(redis: FakeRedis, pr: number) {
    ciStatus = GREEN;
    return resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr }, redis as never, logger as never);
}

describe('Ultrafix recovery after a CI failure', () => {
    beforeEach(() => {
        queuedJobs.clear();
        hideQueueScan = false;
        prLabels = ['ultrafix'];
        ciStatus = RED;
        prHead = 'red-head-sha';
        mockQueueAdd.mock.resetCalls();
        mockOctokitRequest.mock.resetCalls();
        setCheckRunDeps({
            areAllChecksPassing: mockAreAllChecksPassing,
            getCurrentPRHead: mockGetCurrentPRHead,
            getCheckRunsStatus: mockGetCheckRunsStatus,
        });
    });

    test('recovers a stranded loop once checks turn green', async () => {
        const redis = await strandLoopAfterCiFailure(101);
        const newEpoch = await getUltrafixAutomaticWorkEpoch(redis as never, OWNER, REPO, 101);

        const result = await checksTurnGreen(redis, 101);

        assert.equal(result.continued, true);
        assert.equal(result.reason, 'stranded_loop_rearmed');
        assert.equal(result.nextAction, 'review');
        const reviews = reviewJobs(101);
        assert.equal(reviews.length, 1, 'exactly one review cycle scheduled');
        assert.equal(reviews[0].data.ultrafixMeta.workEpoch, newEpoch, 'review runs under the new epoch');
        assert.equal(reviews[0].opts.delay, 30_000, 'configured pause applies');
        const state = await loadState(redis as never, OWNER, REPO, 101);
        assert.equal(state?.active, true);
        assert.equal(state?.workEpoch, newEpoch, 'loop ownership moved to the new epoch');
        assert.ok(mockGetCurrentPRHead.mock.callCount() > 0, 'readiness checked the live PR head');
    });

    test('does not resume while the follow-up commit is still red', async () => {
        const redis = await strandLoopAfterCiFailure(102);

        const result = await resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 102 }, redis as never, logger as never);

        assert.equal(result.continued, false);
        assert.match(result.reason, /checks_not_passing/);
        assert.equal(reviewJobs(102).length, 0);
        assert.equal((await loadState(redis as never, OWNER, REPO, 102))?.active, true, 'loop stays armed for the next trigger');

        // The next trigger after CI recovers still resumes the loop.
        const recovered = await checksTurnGreen(redis, 102);
        assert.equal(recovered.reason, 'stranded_loop_rearmed');
        assert.equal(reviewJobs(102).length, 1);
    });

    test('prevents double-firing when several check events arrive together', async () => {
        const redis = await strandLoopAfterCiFailure(103);
        ciStatus = GREEN;

        // check_run, check_suite and the polling reconciler all fire at once.
        const results = await Promise.all([1, 2, 3].map(() =>
            resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 103 }, redis as never, logger as never)));

        assert.equal(results.filter(result => result.continued).length, 1);
        assert.equal(reviewJobs(103).length, 1, 'only one review job enqueued');

        // A later event while that review is still queued must not add another.
        const late = await checksTurnGreen(redis, 103);
        assert.equal(late.continued, false);
        assert.match(late.reason, /follow_up_jobs_active/);
        assert.equal(reviewJobs(103).length, 1);
    });

    test('does not enqueue a duplicate while an Ultrafix job is active in BullMQ', async () => {
        const redis = await strandLoopAfterCiFailure(104);
        queuedJobs.set('running-ultrafix-review', {
            id: 'running-ultrafix-review',
            name: 'processPullRequestComment',
            data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: 104, ultrafixMeta: { mode: 'ultrafix' } },
            opts: {},
            state: 'active',
        });

        const result = await checksTurnGreen(redis, 104);

        assert.equal(result.continued, false);
        assert.match(result.reason, /follow_up_jobs_active/);
        assert.equal(mockQueueAdd.mock.callCount(), 0);
    });

    test('BullMQ job ID deduplication skips a step that is already pending', async () => {
        const redis = await strandLoopAfterCiFailure(105);
        await checksTurnGreen(redis, 105);
        const [first] = reviewJobs(105);
        // The queue scan misses the job (e.g. it moved between states), but its ID is retained.
        hideQueueScan = true;

        const second = await checksTurnGreen(redis, 105);

        assert.equal(second.continued, false);
        assert.equal(second.reason, 'rearm_duplicate');
        assert.equal(reviewJobs(105).length, 1);
        assert.equal(reviewJobs(105)[0].id, first.id);
    });

    test('enforces the max cycles circuit breaker', async () => {
        const redis = await strandLoopAfterCiFailure(106, { reviewCount: 5, fixCount: 5, cycleCount: 5 });

        const result = await checksTurnGreen(redis, 106);

        assert.equal(result.continued, false);
        assert.equal(result.outcome, 'cycles_exhausted');
        assert.equal(reviewJobs(106).length, 0, 'no further review');
        const state = await loadState(redis as never, OWNER, REPO, 106);
        assert.equal(state?.active, false);
        assert.equal(state?.completionStatus, 'failed');
    });

    test('enforces the rating goal circuit breaker', async () => {
        const redis = await strandLoopAfterCiFailure(107, { finalScore: 9 });

        const result = await checksTurnGreen(redis, 107);

        assert.equal(result.continued, false);
        assert.equal(result.outcome, 'goal_reached');
        assert.equal(reviewJobs(107).length, 0, 'no further review');
        // A succeeded loop clears its state, like a normal goal-reached finish.
        assert.equal(await loadState(redis as never, OWNER, REPO, 107), null);
    });

    test('respects removal of the ultrafix label while waiting for CI', async () => {
        const redis = await strandLoopAfterCiFailure(108);
        prLabels = [];

        const result = await checksTurnGreen(redis, 108);

        assert.equal(result.continued, false);
        assert.equal(result.reason, 'label_removed');
        assert.equal(result.outcome, 'stopped');
        assert.equal(reviewJobs(108).length, 0);
        assert.equal(await loadState(redis as never, OWNER, REPO, 108), null, 'loop state cleaned up');
        assert.equal(await loadDeferredContinuation(redis as never, OWNER, REPO, 108), null);
    });

    test('a recovered loop keeps cycling after the resumed review finishes', async () => {
        const redis = await strandLoopAfterCiFailure(109);
        await checksTurnGreen(redis, 109);
        const [review] = reviewJobs(109);
        drainQueue();

        const next = await continueUltrafixLoop({
            owner: OWNER,
            repo: REPO,
            pullRequestNumber: 109,
            completedAction: 'review',
            ultrafixMeta: review.data.ultrafixMeta,
            redisClient: redis as never,
            correlatedLogger: logger as never,
            correlationId: 'resumed-review-correlation-id',
            currentJobId: review.id,
            currentReviewCommentIds: [501],
            currentReviewResultCount: 1,
        });

        assert.equal(next.continued, true);
        assert.equal(next.nextAction, 'fix', 'the resumed review is honoured under the new epoch');
    });
});
