/**
 * Intake wiring for Ultrafix recovery: each real entry point (check_run and
 * check_suite webhooks, and the polling reconciler) must reach
 * `resumeDeferredContinuation` and re-arm a stranded loop.
 */

import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
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
    invalidateUltrafixAutomaticWork,
    loadState,
    saveDeferredContinuation,
    saveState,
    startLoop,
} = await import('../src/jobs/ultrafixOrchestrationService.js');
const { reconcileUltrafixForPR } = await import('../src/polling/prCommentPolling.js');

after(async () => {
    setUltrafixCheckRunHook(null as never);
    await shutdownQueue();
    await closeConnection();
});

/** Redis mock executing the epoch, deferred-record, state and claim scripts. */
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
            if (script.includes("redis.call('PEXPIRE'")) return store.get(args[0]) === args[1] ? 1 : 0;
            if (script.includes("redis.call('DEL', KEYS[1])")) {
                return store.get(args[0]) === args[1] && store.delete(args[0]) ? 1 : 0;
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
        async llen() { return 0; },
    };
}

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
        assert.equal(reviews[0].data.ultrafixMeta.workEpoch, 1);
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
        assert.deepEqual(mockAreAllChecksPassing.mock.calls[0].arguments, [OWNER, REPO, 'listed-sha']);
    });

    test('the polling reconciler makes no GitHub calls for a labelled PR without a loop', async () => {
        const pr = { number: 204, title: 'Idle', labels: [{ name: 'ultrafix' }], head: { ref: 'feature', sha: 'idle-sha' } };

        await reconcileUltrafixForPR(pr, { owner: OWNER, repo: REPO, repoFullName: `${OWNER}/${REPO}`, correlationId: 'cid-poll' }, redis as never);

        assert.equal(mockAreAllChecksPassing.mock.callCount(), 0);
        assert.equal(mockGetCurrentPRHead.mock.callCount(), 0);
        assert.equal(mockOctokitRequest.mock.callCount(), 0);
        assert.equal(await loadState(redis as never, OWNER, REPO, 204), null);
    });

    test('the polling reconciler leaves a loop alone while its checks are red', async () => {
        await strandLoop(205);
        const pr = { number: 205, title: 'Red', labels: [{ name: 'ultrafix' }], head: { ref: 'feature', sha: 'red-sha' } };

        await reconcileUltrafixForPR(pr, { owner: OWNER, repo: REPO, repoFullName: `${OWNER}/${REPO}`, correlationId: 'cid-poll' }, redis as never);

        assert.equal(reviewJobs(205).length, 0);
        assert.equal((await loadState(redis as never, OWNER, REPO, 205))?.active, true);
    });
});
