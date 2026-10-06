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
    sweepUltrafixResumeCandidates,
} = await import('../src/jobs/ultrafixLoopContinuation.js');
const {
    getUltrafixAutomaticWorkEpoch,
    getUltrafixRearmRetryKey,
    invalidateUltrafixAutomaticWork,
    loadDeferredContinuation,
    loadRearmRetry,
    loadState,
    saveDeferredContinuation,
    saveState,
    startLoop,
} = await import('../src/jobs/ultrafixOrchestrationService.js');
const { enqueueNextStep, getUltrafixStepJobId } = await import('../src/jobs/ultrafixLoopContinuationHelpers.js');
const { getUltrafixCiWaitKey, ULTRAFIX_CI_TIMEOUT_REASON } = await import('../src/jobs/ultrafixCiWait.js');
const { getUltrafixResumeClaimKey } = await import('../src/jobs/ultrafixResumeClaim.js');
const { IN_FLIGHT_STEP_RETRY_DELAY_MS } = await import('../src/jobs/ultrafixStrandedLoopRearm.js');

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
        async scan(_cursor: string, _match: string, pattern: string) {
            const prefix = pattern.replace(/\*$/, '');
            return ['0', [...store.keys()].filter(key => key.startsWith(prefix))];
        },
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
async function strandLoopAfterCiFailure(
    pr: number,
    stateOverrides: Record<string, unknown> = {},
    startOverrides: { instructions?: string; userId?: string } = {},
): Promise<FakeRedis> {
    const redis = createRedis();
    const { state } = await startLoop(redis as never, { owner: OWNER, repo: REPO, pr, goal: 8, maxCycles: 5, pauseSeconds: 30, ...startOverrides }, false);
    await saveState(redis as never, { ...state, lastAction: 'review', reviewCount: 1, cycleCount: 0 });

    // 1. The automated fix completes while CI on its commit is red.
    ciStatus = RED;
    const paused = await continueUltrafixLoop({
        owner: OWNER,
        repo: REPO,
        pullRequestNumber: pr,
        completedAction: 'fix',
        ultrafixMeta: { mode: 'ultrafix', goal: 8, maxCycles: 5, pauseSeconds: 30, instructions: startOverrides.instructions ?? '', workEpoch: state.workEpoch },
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

/**
 * Capture the Redis contents right after the re-arm reserves its epoch: what a
 * process terminated before handing the loop to the queue or a deferred record
 * would leave behind.
 */
function captureAfterOwnership(redis: FakeRedis): () => Map<string, string> | undefined {
    let captured: Map<string, string> | undefined;
    const evaluate = redis.eval.bind(redis);
    redis.eval = async (script: string, keyCount: number, ...args: string[]) => {
        const result = await evaluate(script, keyCount, ...args);
        if (script.includes('-- reserve epoch and replace state') && result) captured ??= new Map(redis.store);
        return result;
    };
    return () => captured;
}

/** A fresh process over the captured Redis contents; the dead holder's claim has expired. */
function restartFrom(captured: Map<string, string>, pr: number): FakeRedis {
    const redis = createRedis();
    for (const [key, value] of captured) {
        if (key !== getUltrafixResumeClaimKey(OWNER, REPO, pr)) redis.store.set(key, value);
    }
    queuedJobs.clear();
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
        mockQueueGetJobs.mock.restore();
        mockQueueAdd.mock.restore();
        mockGetCheckRunsStatus.mock.restore();
        mockOctokitRequest.mock.resetCalls();
        setCheckRunDeps({
            areAllChecksPassing: mockAreAllChecksPassing,
            getCurrentPRHead: mockGetCurrentPRHead,
            getCheckRunsStatus: mockGetCheckRunsStatus,
        });
    });

    test('recovers a stranded loop once checks turn green', async () => {
        const redis = await strandLoopAfterCiFailure(101);
        const fencedEpoch = await getUltrafixAutomaticWorkEpoch(redis as never, OWNER, REPO, 101);

        const result = await checksTurnGreen(redis, 101);
        const newEpoch = await getUltrafixAutomaticWorkEpoch(redis as never, OWNER, REPO, 101);
        assert.equal(newEpoch, fencedEpoch + 1, 'the re-arm reserves its own epoch');

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
        assert.equal(result.deferred, true);
        assert.match(result.reason, /checks_not_passing/);
        assert.equal(reviewJobs(102).length, 0);
        assert.equal((await loadState(redis as never, OWNER, REPO, 102))?.active, true, 'loop stays armed for the next trigger');
        const newEpoch = await getUltrafixAutomaticWorkEpoch(redis as never, OWNER, REPO, 102);
        assert.equal((await loadDeferredContinuation(redis as never, OWNER, REPO, 102))?.workEpoch, newEpoch,
            'the review waits as an ordinary deferral under the new epoch');

        // The next trigger after CI recovers still resumes the loop.
        const recovered = await checksTurnGreen(redis, 102);
        assert.equal(recovered.reason, 'deferred_resumed');
        assert.equal(reviewJobs(102).length, 1);
        assert.equal(reviewJobs(102)[0].data.ultrafixMeta.workEpoch, newEpoch);
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

    test('a re-arm that misses a pending review in the queue scan supersedes it', async () => {
        const redis = await strandLoopAfterCiFailure(105);
        await checksTurnGreen(redis, 105);
        const [first] = reviewJobs(105);
        // The queue scan misses the job (e.g. it moved between states).
        hideQueueScan = true;

        const second = await checksTurnGreen(redis, 105);

        // Each re-arm reserves its own epoch, so the earlier review is fenced
        // and only the latest one passes the execution-time epoch check.
        assert.equal(second.continued, true);
        const current = await getUltrafixAutomaticWorkEpoch(redis as never, OWNER, REPO, 105);
        const runnable = reviewJobs(105).filter(job => job.data.ultrafixMeta.workEpoch === current);
        assert.equal(runnable.length, 1);
        assert.notEqual(runnable[0].id, first.id);
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

    test('a trigger arriving while another holds the claim is re-run, not dropped', async () => {
        const redis = await strandLoopAfterCiFailure(110);
        // Trigger A (CI job A finished) reads check runs while job B is still running.
        ciStatus = { count: 2, allPassing: false, anyPending: true, anyFailed: false };
        let releaseRead!: () => void;
        const readHeld = new Promise<void>(resolve => { releaseRead = resolve; });
        let signalRead!: () => void;
        const reading = new Promise<void>(resolve => { signalRead = resolve; });
        mockGetCheckRunsStatus.mock.mockImplementationOnce(async () => {
            const observed = ciStatus;
            signalRead();
            await readHeld;
            return observed;
        });

        const first = resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 110 }, redis as never, logger as never);
        await reading;
        // Job B finishes inside A's window; its check_run and check_suite events arrive.
        ciStatus = GREEN;
        const second = await resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 110 }, redis as never, logger as never);
        const third = await resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 110 }, redis as never, logger as never);
        assert.equal(second.reason, 'resume_in_progress');
        assert.equal(third.reason, 'resume_in_progress');
        assert.equal(reviewJobs(110).length, 0);

        releaseRead();
        const result = await first;

        // A saw pending CI, then honoured the re-check request against green CI.
        assert.equal(result.continued, true);
        assert.equal(reviewJobs(110).length, 1, 'exactly one review once both triggers settle');
        assert.equal(redis.store.get('ultrafix:resume-recheck:acme:web:110'), undefined, 're-check request consumed');
        assert.equal(redis.store.get('ultrafix:resume-claim:acme:web:110'), undefined, 'claim released');
    });

    test('a recovered loop keeps the instructions and user that started it', async () => {
        const instructions = 'Keep the public API stable.';
        const redis = await strandLoopAfterCiFailure(111, {}, { instructions, userId: '4242' });
        assert.equal((await loadState(redis as never, OWNER, REPO, 111))?.instructions, instructions);

        const result = await checksTurnGreen(redis, 111);

        assert.equal(result.reason, 'stranded_loop_rearmed');
        const [review] = reviewJobs(111);
        assert.equal(review.data.commandInstructions, instructions);
        assert.equal(review.data.ultrafixMeta.instructions, instructions);
        assert.equal(review.data.userId, '4242');

        // Later steps inherit the restored metadata from the recovered review.
        drainQueue();
        const next = await continueUltrafixLoop({
            owner: OWNER, repo: REPO, pullRequestNumber: 111, completedAction: 'review',
            userId: review.data.userId, ultrafixMeta: review.data.ultrafixMeta,
            redisClient: redis as never, correlatedLogger: logger as never,
            correlationId: 'resumed-review', currentJobId: review.id,
            currentReviewCommentIds: [601], currentReviewResultCount: 1,
        });
        assert.equal(next.nextAction, 'fix');
        const fix = [...queuedJobs.values()].find(job => job.data.pullRequestNumber === 111 && job.data.commandMode === 'fix');
        assert.equal(fix?.data.commandInstructions, instructions);
        assert.equal(fix?.data.userId, '4242');
    });

    test('a recovery deferred on red CI keeps the instructions through the deferred resume', async () => {
        const instructions = 'Only touch the parser.';
        const redis = await strandLoopAfterCiFailure(112, {}, { instructions, userId: '77' });

        const red = await resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 112 }, redis as never, logger as never);
        assert.equal(red.deferred, true);
        const green = await checksTurnGreen(redis, 112);

        assert.equal(green.reason, 'deferred_resumed');
        const [review] = reviewJobs(112);
        assert.equal(review.data.commandInstructions, instructions);
        assert.equal(review.data.userId, '77');
    });

    test('a queue outage during recovery leaves a durable retry that the sweep honours', async () => {
        const redis = await strandLoopAfterCiFailure(113);
        ciStatus = GREEN;
        mockQueueGetJobs.mock.mockImplementation(async () => { throw new Error('queue unavailable'); });

        const failed = await resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 113 }, redis as never, logger as never);

        assert.match(failed.reason, /rearm_not_ready: .*follow_up_jobs_unknown/);
        assert.equal(reviewJobs(113).length, 0);
        const retry = await loadRearmRetry(redis as never, OWNER, REPO, 113);
        assert.ok(retry, 'retry obligation recorded');
        assert.equal(retry.workEpoch, await getUltrafixAutomaticWorkEpoch(redis as never, OWNER, REPO, 113));

        // The queue recovers; no further check event arrives, only the periodic sweep.
        mockQueueGetJobs.mock.restore();
        const outcomes = await sweepUltrafixResumeCandidates(redis as never, () => logger as never);

        assert.deepEqual(outcomes.map(outcome => outcome.result.reason), ['stranded_loop_rearmed']);
        assert.equal(reviewJobs(113).length, 1);
        assert.equal(redis.store.get(getUltrafixRearmRetryKey(OWNER, REPO, 113)), undefined, 'obligation released');
    });

    test('a failed enqueue after taking ownership is retried by the sweep', async () => {
        const redis = await strandLoopAfterCiFailure(114);
        ciStatus = GREEN;
        mockQueueAdd.mock.mockImplementationOnce(async () => { throw new Error('queue unavailable'); });

        await assert.rejects(
            resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 114 }, redis as never, logger as never),
            /queue unavailable/,
        );
        assert.equal(reviewJobs(114).length, 0);
        assert.ok(await loadRearmRetry(redis as never, OWNER, REPO, 114), 'retry obligation recorded');

        await sweepUltrafixResumeCandidates(redis as never, () => logger as never);

        assert.equal(reviewJobs(114).length, 1);
        assert.equal(await loadRearmRetry(redis as never, OWNER, REPO, 114), null);
    });

    test('a retry for a loop that has since ended is dropped without GitHub calls', async () => {
        const redis = await strandLoopAfterCiFailure(115);
        mockQueueGetJobs.mock.mockImplementation(async () => { throw new Error('queue unavailable'); });
        await resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 115 }, redis as never, logger as never);
        assert.ok(await loadRearmRetry(redis as never, OWNER, REPO, 115));
        const state = await loadState(redis as never, OWNER, REPO, 115);
        await saveState(redis as never, { ...state!, active: false });
        mockOctokitRequest.mock.resetCalls();

        await sweepUltrafixResumeCandidates(redis as never, () => logger as never);

        assert.equal(await loadRearmRetry(redis as never, OWNER, REPO, 115), null);
        assert.equal(mockOctokitRequest.mock.callCount(), 0);
        assert.equal(reviewJobs(115).length, 0);
    });

    test('red CI on a recovered loop posts one notice and is bounded by the CI wait timeout', async () => {
        const redis = await strandLoopAfterCiFailure(116);
        const posts = () => mockOctokitRequest.mock.calls.filter(call => String(call.arguments[0]).startsWith('POST'));
        mockOctokitRequest.mock.resetCalls();

        const first = await resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 116 }, redis as never, logger as never);
        assert.equal(first.deferred, true);
        assert.equal(posts().length, 1, 'one CI deferral notice');
        assert.match(String((posts()[0].arguments[1] as { body: string }).body), /waiting for CI/);
        await resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 116 }, redis as never, logger as never);
        assert.equal(posts().length, 1, 'no notice per poll');

        // The wait on this head started longer ago than the timeout.
        const waitKey = getUltrafixCiWaitKey(OWNER, REPO, 116);
        const wait = JSON.parse(redis.store.get(waitKey)!);
        redis.store.set(waitKey, JSON.stringify({ ...wait, since: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }));

        const timedOut = await resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 116 }, redis as never, logger as never);

        assert.equal(timedOut.reason, ULTRAFIX_CI_TIMEOUT_REASON);
        assert.equal(timedOut.outcome, 'failed');
        const state = await loadState(redis as never, OWNER, REPO, 116);
        assert.equal(state?.active, false);
        assert.equal(state?.completionReason, ULTRAFIX_CI_TIMEOUT_REASON);
        assert.equal(reviewJobs(116).length, 0);
    });

    test('a continuation whose next step is already queued reports it instead of continuing', async () => {
        const redis = await strandLoopAfterCiFailure(117);
        await checksTurnGreen(redis, 117);
        const [review] = reviewJobs(117);
        review.state = 'active';
        const workEpoch = review.data.ultrafixMeta.workEpoch;
        const fixId = getUltrafixStepJobId(OWNER, REPO, 117, { action: 'fix', workEpoch, stepNumber: 2 });
        queuedJobs.set(fixId, { id: fixId, name: 'processPullRequestComment', data: { pullRequestNumber: 117, commandMode: 'fix' }, opts: {}, state: 'delayed' });

        const next = await continueUltrafixLoop({
            owner: OWNER, repo: REPO, pullRequestNumber: 117, completedAction: 'review',
            ultrafixMeta: review.data.ultrafixMeta, redisClient: redis as never, correlatedLogger: logger as never,
            correlationId: 'resumed-review', currentJobId: review.id,
            currentReviewCommentIds: [701], currentReviewResultCount: 1,
        });

        assert.equal(next.continued, false);
        assert.equal(next.reason, 'next_step_already_queued');
        assert.equal(next.nextAction, 'fix');
    });

    test('a deferred resume whose step is already queued reports it instead of continuing', async () => {
        const redis = await strandLoopAfterCiFailure(118);
        await resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 118 }, redis as never, logger as never);
        const deferred = await loadDeferredContinuation(redis as never, OWNER, REPO, 118);
        assert.ok(deferred);
        const reviewId = getUltrafixStepJobId(OWNER, REPO, 118, { action: 'review', workEpoch: deferred.workEpoch!, stepNumber: 2 });
        queuedJobs.set(reviewId, { id: reviewId, name: 'processPullRequestComment', data: {}, opts: {}, state: 'delayed' });

        const result = await checksTurnGreen(redis, 118);

        assert.equal(result.continued, false);
        assert.equal(result.reason, 'next_step_already_queued');
    });
    test('a deferred final fix whose first queue insertion fails is retried, not dropped', async () => {
        // Five reviews and four fixes with maxCycles 5: the fifth fix is still permitted.
        const redis = createRedis();
        const { state } = await startLoop(redis as never, { owner: OWNER, repo: REPO, pr: 119, goal: 8, maxCycles: 5, pauseSeconds: 30 }, false);
        await saveState(redis as never, { ...state, lastAction: 'review', reviewCount: 5, fixCount: 4, cycleCount: 4 });
        await saveDeferredContinuation(redis as never, {
            owner: OWNER, repo: REPO, pr: 119, nextAction: 'fix',
            savedAt: new Date().toISOString(), reason: 'follow_up_jobs_active', workEpoch: state.workEpoch,
        });
        ciStatus = GREEN;
        mockQueueAdd.mock.mockImplementationOnce(async () => { throw new Error('queue unavailable'); });

        await assert.rejects(
            resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 119 }, redis as never, logger as never),
            /queue unavailable/,
        );
        const restored = await loadDeferredContinuation(redis as never, OWNER, REPO, 119);
        assert.equal(restored?.nextAction, 'fix', 'the claimed fix is put back');
        assert.equal(restored?.workEpoch, state.workEpoch);

        // The queue recovers; only the periodic sweep runs.
        const outcomes = await sweepUltrafixResumeCandidates(redis as never, () => logger as never);

        assert.deepEqual(outcomes.map(outcome => outcome.result.reason), ['deferred_resumed']);
        const fixes = [...queuedJobs.values()].filter(job => job.data.pullRequestNumber === 119 && job.data.commandMode === 'fix');
        assert.equal(fixes.length, 1, 'the permitted fifth fix is scheduled');
        const after = await loadState(redis as never, OWNER, REPO, 119);
        assert.equal(after?.active, true);
        assert.equal(after?.completionStatus ?? null, null, 'the loop is not failed as cycles-exhausted');
    });

    test('a late trigger while the re-armed review is queued backs its retry off', async () => {
        const redis = await strandLoopAfterCiFailure(120);
        await checksTurnGreen(redis, 120);
        assert.equal(reviewJobs(120).length, 1);

        // A late check_suite finds the loop's own current-epoch review outstanding.
        const late = await checksTurnGreen(redis, 120);
        assert.match(late.reason, /rearm_not_ready: follow_up_jobs_active/);
        const retry = await loadRearmRetry(redis as never, OWNER, REPO, 120);
        assert.ok(retry?.notBefore, 'the backstop retry is recorded with a delay');
        assert.ok(Date.parse(retry.notBefore) > Date.now() + IN_FLIGHT_STEP_RETRY_DELAY_MS - 60_000);

        mockQueueGetJobs.mock.resetCalls();
        const outcomes = await sweepUltrafixResumeCandidates(redis as never, () => logger as never);
        assert.deepEqual(outcomes, [], 'the sweep leaves a loop owned by its in-flight step alone');
        assert.equal(mockQueueGetJobs.mock.callCount(), 0);

        // Once due, the sweep runs it again.
        await redis.set(getUltrafixRearmRetryKey(OWNER, REPO, 120), JSON.stringify({ ...retry, notBefore: new Date(Date.now() - 1000).toISOString() }));
        const due = await sweepUltrafixResumeCandidates(redis as never, () => logger as never);
        assert.equal(due.length, 1);
    });

    test('an outstanding step from a fenced epoch still leaves an immediate retry', async () => {
        const redis = await strandLoopAfterCiFailure(121);
        // A review queued before the follow-up fenced its epoch: it will stop as superseded.
        const staleId = getUltrafixStepJobId(OWNER, REPO, 121, { action: 'review', workEpoch: 0, stepNumber: 2 });
        queuedJobs.set(staleId, {
            id: staleId, name: 'processPullRequestComment', opts: {}, state: 'delayed',
            data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: 121, commandMode: 'review', ultrafixMeta: { mode: 'ultrafix', workEpoch: 0 } },
        });

        const result = await checksTurnGreen(redis, 121);

        assert.match(result.reason, /rearm_not_ready: follow_up_jobs_active/);
        const retry = await loadRearmRetry(redis as never, OWNER, REPO, 121);
        assert.ok(retry);
        assert.equal(retry.notBefore, undefined);
    });

    test('a claim lost with no new holder still records a retry', async () => {
        const redis = await strandLoopAfterCiFailure(122);
        mockGetCheckRunsStatus.mock.mockImplementation(async () => {
            // The claim expires mid-readiness and nobody re-acquires it.
            redis.store.delete(getUltrafixResumeClaimKey(OWNER, REPO, 122));
            return GREEN;
        });

        const result = await checksTurnGreen(redis, 122);

        assert.equal(result.reason, 'resume_claim_lost');
        assert.equal(reviewJobs(122).length, 0);
        assert.ok(await loadRearmRetry(redis as never, OWNER, REPO, 122), 'the sweep can find the loop');

        mockGetCheckRunsStatus.mock.restore();
        await sweepUltrafixResumeCandidates(redis as never, () => logger as never);
        assert.equal(reviewJobs(122).length, 1);
        assert.equal(await loadRearmRetry(redis as never, OWNER, REPO, 122), null);
    });

    test('a process lost after a ready re-arm takes ownership leaves a retry the sweep honours', async () => {
        const redis = await strandLoopAfterCiFailure(124);
        const captured = captureAfterOwnership(redis);

        await checksTurnGreen(redis, 124);
        const atHandoff = captured();
        assert.ok(atHandoff, 'the re-arm took ownership');

        // The process dies before the review reaches the queue.
        const restarted = restartFrom(atHandoff, 124);
        assert.equal((await loadState(restarted as never, OWNER, REPO, 124))?.active, true);
        assert.equal(await loadDeferredContinuation(restarted as never, OWNER, REPO, 124), null);
        assert.ok(await loadRearmRetry(restarted as never, OWNER, REPO, 124), 'the obligation was persisted before ownership moved');

        const outcomes = await sweepUltrafixResumeCandidates(restarted as never, () => logger as never);

        assert.deepEqual(outcomes.map(outcome => outcome.result.reason), ['stranded_loop_rearmed']);
        assert.equal(reviewJobs(124).length, 1);
        assert.equal(await loadRearmRetry(restarted as never, OWNER, REPO, 124), null, 'released once the review is queued');
    });

    test('a process lost after a CI-deferred re-arm takes ownership leaves a retry the sweep honours', async () => {
        const redis = await strandLoopAfterCiFailure(125);
        const captured = captureAfterOwnership(redis);

        // CI on the follow-up head is still red: the re-arm turns into a deferral.
        await resumeDeferredContinuation({ owner: OWNER, repo: REPO, pr: 125 }, redis as never, logger as never);
        const atHandoff = captured();
        assert.ok(atHandoff, 'the re-arm took ownership');

        // The process dies before the deferred record is saved.
        const restarted = restartFrom(atHandoff, 125);
        assert.equal(await loadDeferredContinuation(restarted as never, OWNER, REPO, 125), null);
        assert.ok(await loadRearmRetry(restarted as never, OWNER, REPO, 125), 'the obligation was persisted before ownership moved');

        const outcomes = await sweepUltrafixResumeCandidates(restarted as never, () => logger as never);

        assert.match(outcomes[0]?.result.reason ?? '', /^rearm_deferred: checks_not_passing/);
        const epoch = await getUltrafixAutomaticWorkEpoch(restarted as never, OWNER, REPO, 125);
        assert.equal((await loadDeferredContinuation(restarted as never, OWNER, REPO, 125))?.workEpoch, epoch);
        assert.equal(await loadRearmRetry(restarted as never, OWNER, REPO, 125), null, 'released once the deferral is durable');
    });

    test('repositories whose names join to the same text keep separate step jobs', async () => {
        const step = { action: 'review' as const, workEpoch: 2, stepNumber: 2 };
        assert.notEqual(
            getUltrafixStepJobId('acme-tools', 'web', 42, step),
            getUltrafixStepJobId('acme', 'tools-web', 42, step),
        );

        const redis = createRedis();
        const enqueue = (owner: string, repo: string) => enqueueNextStep({
            owner, repo, pullRequestNumber: 42, completedAction: 'fix',
            ultrafixMeta: { mode: 'ultrafix', goal: 8, maxCycles: 5, pauseSeconds: 30, instructions: '', workEpoch: 2 },
            redisClient: redis as never, correlatedLogger: logger as never, correlationId: 'collision',
        }, 'review', 30_000, 2);

        assert.equal(await enqueue('acme-tools', 'web'), true);
        assert.equal(await enqueue('acme', 'tools-web'), true, 'the other repository is not reported as a duplicate');
        assert.deepEqual(
            [...queuedJobs.values()].map(job => `${job.data.repoOwner}/${job.data.repoName}`).sort(),
            ['acme-tools/web', 'acme/tools-web'],
        );
        assert.equal(await enqueue('acme', 'tools-web'), false, 'the same step of the same PR is still deduplicated');
    });

    test('a claim taken over by another trigger leaves the retry to that trigger', async () => {
        const redis = await strandLoopAfterCiFailure(123);
        mockGetCheckRunsStatus.mock.mockImplementation(async () => {
            redis.store.set(getUltrafixResumeClaimKey(OWNER, REPO, 123), 'trigger-b');
            return GREEN;
        });

        const result = await checksTurnGreen(redis, 123);

        assert.equal(result.reason, 'resume_claim_lost');
        assert.equal(await loadRearmRetry(redis as never, OWNER, REPO, 123), null);
    });
});
