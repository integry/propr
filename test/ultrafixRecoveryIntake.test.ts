/**
 * Intake wiring for Ultrafix recovery: each real entry point (check_run and
 * check_suite webhooks, and the polling reconciler) must reach
 * `resumeDeferredContinuation` and re-arm a stranded loop.
 */

import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createUltrafixRedis } from './fixtures/ultrafixRedisDouble.js';
import type { CheckRunEvent, CheckSuiteEvent } from '@octokit/webhooks-types';

const OWNER = 'acme';
const REPO = 'web';

// --- GitHub: one fake Octokit for the webhook handler and the Ultrafix jobs ---

let prLabels: string[] = ['ultrafix'];
const openPRsForCommit: Record<string, number[]> = {};
const mockOctokitRequest = mock.fn(async (route: string, params: Record<string, unknown> = {}) => {
    if (route.includes('/commits/{commit_sha}/pulls')) {
        const numbers = openPRsForCommit[String(params.commit_sha)] ?? [];
        return { data: numbers.map(number => ({ number, state: 'open' })) };
    }
    if (route.startsWith('GET') && route.includes('/pulls/{pull_number}')) {
        return {
            data: {
                labels: prLabels.map(name => ({ name })),
                draft: false,
                mergeable: true,
                mergeable_state: 'clean',
                base: { ref: 'main' },
                head: { ref: 'feature', sha: prHead, repo: { owner: { login: OWNER } } },
                body: '',
            },
        };
    }
    return { data: {} };
});
const octokit = { request: mockOctokitRequest };

// --- Modules behind the real check-run handler ---

await mock.module('simple-git', { namedExports: { simpleGit: mock.fn(() => ({})), SimpleGit: class {} } });
await mock.module('ioredis', {
    namedExports: {
        Redis: function Redis() {
            return {
                on: mock.fn(),
                get: mock.fn(async () => null),
                mget: mock.fn(async (...keys: string[]) => keys.map(() => null)),
                del: mock.fn(async () => 0),
                quit: mock.fn(async () => {}),
                disconnect: mock.fn(),
            };
        },
    },
});
await mock.module('bullmq', {
    namedExports: {
        ErrorCode: { JobNotExist: -1, JobNotInState: -3 },
        Queue: function Queue() { return { add: mock.fn(), close: mock.fn(), on: mock.fn() }; },
        QueueEvents: function QueueEvents() { return { waitUntilReady: mock.fn(async () => {}), close: mock.fn(async () => {}) }; },
        Worker: function Worker() { return { on: mock.fn(), close: mock.fn() }; },
    },
});
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
await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: { getAuthenticatedOctokit: mock.fn(async () => octokit) },
});
const silentLogger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };
const coreLogger = { ...silentLogger, withCorrelation: () => silentLogger };
await mock.module('../packages/core/src/utils/logger.js', { defaultExport: coreLogger });
await mock.module('../packages/core/src/config/planIssueManager.js', {
    namedExports: {
        PlanIssueStatus: { MERGED: 'merged' },
        findPlanIssueByRepoAndPR: async () => null,
        findPlanIssueByRepoAndNumber: async () => null,
        updatePlanIssueByPR: async () => {},
    },
});
await mock.module('../packages/core/src/webhook/planIssueTracking.js', {
    namedExports: { triggerNextPendingIssue: async () => {} },
});
await mock.module('../packages/core/src/services/taskExecutionService.js', {
    namedExports: { isEpicBranch: () => false, extractFirstIssueIdFromEpicBranch: () => null },
});

const {
    handleCheckRunEvent,
    handleCheckSuiteEvent,
    setUltrafixCheckRunHook,
    triggerUltrafixCheckRunHook,
} = await import('../packages/core/src/webhook/checkRunHandler.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
const { shutdownQueue } = await import('../packages/core/src/queue/taskQueue.js');

// --- Ultrafix jobs and polling see @propr/core through this mock ---

const queuedJobs = new Map<string, { id: string; data: Record<string, any>; opts: Record<string, any>; state: string }>();
const mockQueueAdd = mock.fn(async (_name: string, data: Record<string, any>, opts: Record<string, any> = {}) => {
    const id = String(opts.jobId);
    queuedJobs.set(id, { id, data, opts, state: 'delayed' });
    return {};
});
const fakeQueue = {
    add: mockQueueAdd,
    getJobs: async (states: string[] = []) => [...queuedJobs.values()].filter(job => states.includes(job.state)),
    getJob: async (id: string) => {
        const job = queuedJobs.get(id);
        return job ? { ...job, getState: async () => job.state, remove: async () => { queuedJobs.delete(id); } } : undefined;
    },
};

type CheckStatus = { count: number; allPassing: boolean; anyPending: boolean; anyFailed: boolean };
const RED: CheckStatus = { count: 1, allPassing: false, anyPending: false, anyFailed: true };
const GREEN: CheckStatus = { count: 1, allPassing: true, anyPending: false, anyFailed: false };
let ciStatus: CheckStatus = RED;
let prHead = 'head-sha';
const mockAreAllChecksPassing = mock.fn(async () => ciStatus.allPassing);
const mockGetCheckRunsStatusForRepo = mock.fn(async (_owner: string, _repo: string, _ref: string) => ciStatus);
const mockGetCurrentPRHead = mock.fn(async () => prHead);

await mock.module('@propr/core', {
    namedExports: {
        AgentRegistry: {},
        logger: coreLogger,
        handleError: () => {},
        COMMENT_BATCH_DELAY_MS: 0,
        filterCommentByAuthor: () => ({ shouldFilter: true }),
        checkCommentTrigger: () => ({ triggered: false }),
        extractLlmFromLabels: () => null,
        resolveModelAlias: (model: string) => model,
        hasValidTriggerLabel: () => false,
        areAllChecksPassing: mockAreAllChecksPassing,
        getCheckRunsStatusForRepo: mockGetCheckRunsStatusForRepo,
        getCurrentPRHead: mockGetCurrentPRHead,
        triggerUltrafixCheckRunHook,
        loadUltrafixEscalationSettings: async () => ({ enabled: false, models: [], patience: 3, maxReasoningLevels: 2 }),
        loadModelReasoningLevel: async () => '',
        DEFAULT_ULTRAFIX_CI_WAIT_TIMEOUT_MS: 2 * 60 * 60 * 1000,
        loadUltrafixCiWaitTimeoutMs: async () => 2 * 60 * 60 * 1000,
        resolveAgentModelReasoningLevel: () => undefined,
        resolveRuntimeModelReasoningLevel: () => null,
        resolveLlmLabel: async (model: string) => ({ agentAlias: model, model }),
        resolveConfiguredModel: async (model: string) => model,
        findPlanIssueByRepoAndPR: async () => null,
        gateAutoMergeArming: async () => ({ arm: false }),
        recoverCiFailureFollowups: async () => undefined,
        generateCorrelationId: () => 'intake-correlation-id',
        getAuthenticatedOctokit: async () => octokit,
        getIssueQueue: async () => fakeQueue,
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
            latestScore: 5, reviewStatus: 'valid_with_blockers', hasPendingReview: true, unprocessedComments: [], isPartial: false,
        }),
    },
});

const { resumeDeferredContinuation, setCheckRunDeps } = await import('../src/jobs/ultrafixLoopContinuation.js');
const {
    getUltrafixRearmRetryKey,
    invalidateUltrafixAutomaticWork,
    loadState,
    saveDeferredContinuation,
    saveState,
    startLoop,
} = await import('../src/jobs/ultrafixOrchestrationService.js');
const { hasUltrafixResumeCandidate } = await import('../src/jobs/ultrafixResumeClaim.js');
const { pollForPullRequestComments, reconcileUltrafixForPR } = await import('../src/polling/prCommentPolling.js');

after(async () => {
    setUltrafixCheckRunHook(null as never);
    await shutdownQueue();
    await closeConnection();
});

/** Redis double executing the epoch, deferred-record, state and claim scripts. */
const createRedis = createUltrafixRedis;

let redis = createRedis();

/** Active loop whose deferred review was dropped by a CI-failure follow-up. */
async function strandLoop(pr: number) {
    const { state } = await startLoop(redis as never, {
        owner: OWNER, repo: REPO, pr, goal: 8, maxCycles: 5, pauseSeconds: 30, instructions: 'Keep it small.',
    }, false);
    await saveState(redis as never, { ...state, lastAction: 'fix', reviewCount: 1, fixCount: 1, cycleCount: 1 });
    await saveDeferredContinuation(redis as never, {
        owner: OWNER, repo: REPO, pr, nextAction: 'review',
        savedAt: new Date().toISOString(), reason: 'checks_not_passing', workEpoch: state.workEpoch,
    });
    await invalidateUltrafixAutomaticWork(redis as never, OWNER, REPO, pr);
}

function reviewJobs(pr: number) {
    return [...queuedJobs.values()].filter(job => job.data.pullRequestNumber === pr && job.data.commandMode === 'review');
}

const repository = { full_name: `${OWNER}/${REPO}`, default_branch: 'main' };

function checkRunPayload(headSha: string): CheckRunEvent {
    return {
        action: 'completed',
        check_run: {
            name: 'build', head_sha: headSha, status: 'completed', conclusion: 'success',
            // Branch-push runs often arrive without PR numbers.
            pull_requests: [],
            check_suite: { id: 1, head_branch: 'feature' },
        },
        repository,
    } as unknown as CheckRunEvent;
}

function checkSuitePayload(headSha: string, pullRequests: number[] = []): CheckSuiteEvent {
    return {
        action: 'completed',
        check_suite: {
            id: 2, head_sha: headSha, head_branch: 'feature', status: 'completed', conclusion: 'success',
            pull_requests: pullRequests.map(number => ({ number, id: number })),
        },
        repository,
    } as unknown as CheckSuiteEvent;
}

describe('Ultrafix recovery through the real intake entry points', () => {
    beforeEach(() => {
        redis = createRedis();
        queuedJobs.clear();
        prLabels = ['ultrafix'];
        ciStatus = RED;
        prHead = 'head-sha';
        for (const key of Object.keys(openPRsForCommit)) delete openPRsForCommit[key];
        mockOctokitRequest.mock.resetCalls();
        mockAreAllChecksPassing.mock.resetCalls();
        mockGetCheckRunsStatusForRepo.mock.resetCalls();
        mockGetCurrentPRHead.mock.resetCalls();
        setCheckRunDeps({
            areAllChecksPassing: mockAreAllChecksPassing,
            getCurrentPRHead: mockGetCurrentPRHead,
            getCheckRunsStatus: async () => ciStatus,
        });
        // Same wiring as the daemon and API: the hook resumes the PR's loop.
        setUltrafixCheckRunHook(async (owner, repo, prNumber) => {
            await resumeDeferredContinuation({ owner, repo, pr: prNumber }, redis as never, silentLogger as never);
        });
    });

    test('a check_run without PR numbers is matched by commit and re-arms the loop', async () => {
        await strandLoop(201);
        prHead = 'fixed-sha';
        openPRsForCommit['fixed-sha'] = [201];
        ciStatus = GREEN;

        await handleCheckRunEvent(checkRunPayload('fixed-sha'), 'cid-run');

        const reviews = reviewJobs(201);
        assert.equal(reviews.length, 1);
        assert.equal(reviews[0].data.ultrafixMeta.workEpoch, 2, 'the re-arm reserves a fresh epoch');
        assert.equal(reviews[0].data.commandInstructions, 'Keep it small.');
    });

    test('a successful check_suite re-arms the loop', async () => {
        await strandLoop(202);
        prHead = 'suite-sha';
        ciStatus = GREEN;

        await handleCheckSuiteEvent(checkSuitePayload('suite-sha', [202]), 'cid-suite');

        assert.equal(reviewJobs(202).length, 1);
    });

    test('the polling reconciler re-arms the loop using the listed PR head', async () => {
        await strandLoop(203);
        ciStatus = GREEN;
        const pr = { number: 203, title: 'Fix', labels: [{ name: 'ultrafix' }], head: { ref: 'feature', sha: 'listed-sha' } };

        await reconcileUltrafixForPR(pr, { owner: OWNER, repo: REPO, repoFullName: `${OWNER}/${REPO}`, correlationId: 'cid-poll' }, redis as never);

        assert.equal(reviewJobs(203).length, 1);
        // The green-check gate uses the head the PR listing already carried.
        assert.deepEqual(mockGetCheckRunsStatusForRepo.mock.calls[0].arguments, [OWNER, REPO, 'listed-sha']);
    });

    test('the polling reconciler makes no GitHub calls for a labelled PR without a loop', async () => {
        const pr = { number: 204, title: 'Idle', labels: [{ name: 'ultrafix' }], head: { ref: 'feature', sha: 'idle-sha' } };

        await reconcileUltrafixForPR(pr, { owner: OWNER, repo: REPO, repoFullName: `${OWNER}/${REPO}`, correlationId: 'cid-poll' }, redis as never);

        assert.equal(mockGetCheckRunsStatusForRepo.mock.callCount(), 0);
        assert.equal(mockGetCurrentPRHead.mock.callCount(), 0);
        assert.equal(mockOctokitRequest.mock.callCount(), 0);
        assert.equal(await loadState(redis as never, OWNER, REPO, 204), null);
    });

    test('the polling reconciler wakes a loop on a head with no checks at all', async () => {
        // No CI: a manual `/fix` stranded the loop while follow-up work was active.
        await strandLoop(206);
        ciStatus = { count: 0, allPassing: true, anyPending: false, anyFailed: false };
        const pr = { number: 206, title: 'No CI', labels: [{ name: 'ultrafix' }], head: { ref: 'feature', sha: 'no-ci-sha' } };

        await reconcileUltrafixForPR(pr, { owner: OWNER, repo: REPO, repoFullName: `${OWNER}/${REPO}`, correlationId: 'cid-poll' }, redis as never);

        assert.equal(reviewJobs(206).length, 1, 'zero checks is ready, as for the loop itself');
        assert.equal(mockAreAllChecksPassing.mock.callCount(), 0, 'not the merge gate, which requires a check signal');
    });

    test('the polling reconciler makes no GitHub calls for a loop its current step owns', async () => {
        await startLoop(redis as never, { owner: OWNER, repo: REPO, pr: 207, goal: 8, maxCycles: 5, pauseSeconds: 30 }, false);
        ciStatus = GREEN;
        const pr = { number: 207, title: 'Busy', labels: [{ name: 'ultrafix' }], head: { ref: 'feature', sha: 'busy-sha' } };

        await reconcileUltrafixForPR(pr, { owner: OWNER, repo: REPO, repoFullName: `${OWNER}/${REPO}`, correlationId: 'cid-poll' }, redis as never);

        assert.equal(mockGetCheckRunsStatusForRepo.mock.callCount(), 0);
        assert.equal(mockOctokitRequest.mock.callCount(), 0);
        assert.equal(reviewJobs(207).length, 0);
    });

    test('a polling cycle reconciles every listed Ultrafix PR', async () => {
        await strandLoop(208);
        await strandLoop(209);
        ciStatus = GREEN;
        const listed = [
            { number: 208, title: 'One', labels: [{ name: 'ultrafix' }], head: { ref: 'one', sha: 'one-sha' } },
            { number: 209, title: 'Two', labels: [{ name: 'ultrafix' }], head: { ref: 'two', sha: 'two-sha' } },
            { number: 210, title: 'Plain', labels: [], head: { ref: 'plain', sha: 'plain-sha' } },
        ];
        // The first PR's CI lookup fails; polling still reaches the second.
        mockGetCheckRunsStatusForRepo.mock.mockImplementationOnce(async () => { throw new Error('GitHub 502'); });
        const paginate = mock.fn(async (route: string) => (route === 'GET /repos/{owner}/{repo}/pulls' ? listed : []));

        await pollForPullRequestComments({ paginate } as never, `${OWNER}/${REPO}`, 'cid-cycle', {
            redisClient: redis as never,
            PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
            MODEL_LABEL_PATTERN: '',
        });

        assert.equal(reviewJobs(208).length, 0, 'a failed reconcile leaves the loop for the next cycle');
        assert.equal((await loadState(redis as never, OWNER, REPO, 208))?.active, true);
        assert.equal(reviewJobs(209).length, 1);
        assert.deepEqual(
            mockGetCheckRunsStatusForRepo.mock.calls.map(call => call.arguments[2]),
            ['one-sha', 'two-sha'],
            'only labelled PRs are reconciled, against their listed heads',
        );
    });

    test('the polling reconciler skips a loop whose retry is still backing off, as the sweep does', async () => {
        const { state } = await startLoop(redis as never, { owner: OWNER, repo: REPO, pr: 211, goal: 8, maxCycles: 5, pauseSeconds: 30 }, false);
        ciStatus = GREEN;
        // A trigger found the loop held by its own in-flight step and backed its retry off.
        const retry = {
            owner: OWNER, repo: REPO, pr: 211, workEpoch: state.workEpoch, reason: 'rearm_not_ready: current_step_queued',
            savedAt: new Date().toISOString(), notBefore: new Date(Date.now() + 15 * 60_000).toISOString(),
        };
        redis.store.set(getUltrafixRearmRetryKey(OWNER, REPO, 211), JSON.stringify(retry));
        const pr = { number: 211, title: 'Backoff', labels: [{ name: 'ultrafix' }], head: { ref: 'feature', sha: 'backoff-sha' } };

        await reconcileUltrafixForPR(pr, { owner: OWNER, repo: REPO, repoFullName: `${OWNER}/${REPO}`, correlationId: 'cid-poll' }, redis as never);

        assert.equal(mockGetCheckRunsStatusForRepo.mock.callCount(), 0, 'no CI lookup until the backoff passes');
        assert.equal(mockOctokitRequest.mock.callCount(), 0);
        assert.equal(await hasUltrafixResumeCandidate(redis as never, { owner: OWNER, repo: REPO, pr: 211 }), true, 'check events still run it');

        // Once due, polling reconciles it again.
        redis.store.set(getUltrafixRearmRetryKey(OWNER, REPO, 211), JSON.stringify({ ...retry, notBefore: new Date(Date.now() - 1).toISOString() }));
        await reconcileUltrafixForPR(pr, { owner: OWNER, repo: REPO, repoFullName: `${OWNER}/${REPO}`, correlationId: 'cid-poll' }, redis as never);
        assert.equal(mockGetCheckRunsStatusForRepo.mock.callCount(), 1);
    });

    test('a polling cycle picks up every PR\'s comments before reconciling any loop', async () => {
        await strandLoop(212);
        await strandLoop(213);
        ciStatus = GREEN;
        const listed = [
            { number: 212, title: 'One', labels: [{ name: 'ultrafix' }], head: { ref: 'one', sha: 'one-sha' } },
            { number: 213, title: 'Two', labels: [{ name: 'ultrafix' }], head: { ref: 'two', sha: 'two-sha' } },
        ];
        const order: string[] = [];
        const paginate = mock.fn(async (route: string, options: { issue_number?: number; pull_number?: number }) => {
            if (route === 'GET /repos/{owner}/{repo}/pulls') return listed;
            order.push(`comments:${options.issue_number ?? options.pull_number}`);
            return [];
        });
        mockGetCheckRunsStatusForRepo.mock.mockImplementation(async (_owner: string, _repo: string, ref: string) => {
            order.push(`reconcile:${ref}`);
            return ciStatus;
        });
        try {
            await pollForPullRequestComments({ paginate } as never, `${OWNER}/${REPO}`, 'cid-order', {
                redisClient: redis as never,
                PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
                MODEL_LABEL_PATTERN: '',
            });
        } finally {
            mockGetCheckRunsStatusForRepo.mock.restore();
        }

        const firstReconcile = order.findIndex(event => event.startsWith('reconcile:'));
        assert.ok(firstReconcile > 0, 'loops are reconciled');
        assert.ok(order.slice(firstReconcile).every(event => event.startsWith('reconcile:')), `comments come first: ${order.join(', ')}`);
        assert.ok(order.includes('comments:213'));
        assert.equal(reviewJobs(212).length, 1);
        assert.equal(reviewJobs(213).length, 1);
    });

    test('the polling reconciler leaves a loop alone while its checks are red', async () => {
        await strandLoop(205);
        const pr = { number: 205, title: 'Red', labels: [{ name: 'ultrafix' }], head: { ref: 'feature', sha: 'red-sha' } };

        await reconcileUltrafixForPR(pr, { owner: OWNER, repo: REPO, repoFullName: `${OWNER}/${REPO}`, correlationId: 'cid-poll' }, redis as never);

        assert.equal(reviewJobs(205).length, 0);
        assert.equal((await loadState(redis as never, OWNER, REPO, 205))?.active, true);
    });
});
