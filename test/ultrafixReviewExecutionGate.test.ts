import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from 'bullmq';
import type { CommentJobData } from '@propr/core';

await mock.module('@propr/core', {
    namedExports: {
        getCheckRunsStatusForRepo: mock.fn(),
        getCurrentPRHead: mock.fn(),
    },
});

await mock.module('../src/jobs/ultrafixOrchestrationService.js', {
    namedExports: {
        saveDeferredContinuation: mock.fn(),
    },
});

const { evaluateUltrafixReviewExecution, isUltrafixReviewExecutionReady, ultrafixReviewDeferralUpdate } = await import('../src/jobs/ultrafixReviewExecutionGate.js');

function makeJob(commandMode: CommentJobData['commandMode'], automatic = true): Job<CommentJobData> {
    return {
        data: {
            pullRequestNumber: 42,
            repoOwner: 'acme',
            repoName: 'web',
            correlationId: 'gate-test',
            commandMode,
            ...(automatic ? { ultrafixMeta: { mode: 'ultrafix' as const, instructions: '' } } : {}),
        },
    } as Job<CommentJobData>;
}

const logger = {
    info: mock.fn(),
    warn: mock.fn(),
} as never;

function makeDeps(status: { count: number; allPassing: boolean; anyPending: boolean; anyFailed: boolean; blockingFailed?: string[]; blockingPending?: string[] }) {
    const save = mock.fn(async () => undefined);
    return {
        save,
        deps: {
            getCurrentPRHead: mock.fn(async () => 'head-sha'),
            getCheckRunsStatus: mock.fn(async () => status),
            saveDeferredContinuation: save,
        },
    };
}

describe('Ultrafix automatic review execution gate', () => {
    test('does not gate automatic fixes or manual reviews', async () => {
        const { deps, save } = makeDeps({ count: 1, allPassing: false, anyPending: true, anyFailed: false });

        assert.equal(await isUltrafixReviewExecutionReady(
            makeJob('fix'),
            { redisClient: {} as never, correlatedLogger: logger },
            deps,
        ), true);
        assert.equal(await isUltrafixReviewExecutionReady(
            makeJob('review', false),
            { redisClient: {} as never, correlatedLogger: logger },
            deps,
        ), true);
        assert.equal(save.mock.callCount(), 0);
    });

    test('allows an automatic review only when exact-head checks are ready', async () => {
        const { deps, save } = makeDeps({ count: 4, allPassing: true, anyPending: false, anyFailed: false });

        assert.equal(await isUltrafixReviewExecutionReady(
            makeJob('review'),
            { redisClient: {} as never, correlatedLogger: logger },
            deps,
        ), true);
        assert.equal(save.mock.callCount(), 0);
    });

    test('defers a waking automatic review while exact-head checks are pending', async () => {
        const redisClient = {} as never;
        const { deps, save } = makeDeps({ count: 4, allPassing: false, anyPending: true, anyFailed: false });

        assert.equal(await isUltrafixReviewExecutionReady(
            makeJob('review'),
            { redisClient, correlatedLogger: logger },
            deps,
        ), false);
        assert.equal(save.mock.callCount(), 1);
        assert.equal(save.mock.calls[0].arguments[0], redisClient);
        assert.deepEqual(save.mock.calls[0].arguments[1], {
            owner: 'acme',
            repo: 'web',
            pr: 42,
            nextAction: 'review',
            savedAt: save.mock.calls[0].arguments[1].savedAt,
            reason: 'pre_execution_checks_not_passing',
            ultrafixMeta: { mode: 'ultrafix', instructions: '' },
        });
    });

    test('hands a CI deferral to the notice/timeout handler with the blocking checks', async () => {
        const redisClient = {} as never;
        const status = {
            count: 5, allPassing: false, anyPending: false, anyFailed: true,
            blockingFailed: ['Run Full Test Suite'], blockingPending: [],
        };
        const { deps, save } = makeDeps(status);
        const handleCiDeferral = mock.fn(async () => ({ stopped: false, waitedMs: 0, blockingChecks: ['Run Full Test Suite'] }));
        const job = makeJob('review');
        job.data.ultrafixMeta = { mode: 'ultrafix', instructions: '', workEpoch: 7, goal: 8 };

        const deferral = await evaluateUltrafixReviewExecution(
            job, { redisClient, correlatedLogger: logger }, { ...deps, handleCiDeferral },
        );
        assert.deepEqual(deferral, { reason: 'pre_execution_checks_not_passing', blockingChecks: ['Run Full Test Suite'] });
        assert.equal(save.mock.callCount(), 1);
        assert.equal(handleCiDeferral.mock.callCount(), 1);
        const input = (handleCiDeferral.mock.calls[0].arguments as unknown as [Record<string, unknown>])[0];
        assert.equal(input.workEpoch, 7);
        assert.equal(input.goal, 8);
        assert.deepEqual(input.ci, { headSha: 'head-sha', status });

        const update = ultrafixReviewDeferralUpdate(deferral!);
        assert.equal(update.reason, 'Ultrafix review deferred until exact-head checks pass: waiting for Run Full Test Suite');
        assert.equal(update.historyMetadata.ultrafixDeferred, true);
        assert.deepEqual(update.historyMetadata.ultrafixBlockingChecks, ['Run Full Test Suite']);
    });

    test('reports a CI timeout stop and clears the CI wait once checks pass', async () => {
        const { deps } = makeDeps({ count: 2, allPassing: false, anyPending: true, anyFailed: false, blockingPending: ['Build'] });
        const handleCiDeferral = mock.fn(async () => ({ stopped: true, waitedMs: 1, blockingChecks: ['Build'] }));
        const stopped = await evaluateUltrafixReviewExecution(
            makeJob('review'), { redisClient: {} as never, correlatedLogger: logger }, { ...deps, handleCiDeferral },
        );
        assert.equal(stopped?.stopped, true);
        assert.equal(ultrafixReviewDeferralUpdate(stopped!).historyMetadata.ultrafixStopReason, 'CI did not settle');

        const passing = makeDeps({ count: 2, allPassing: true, anyPending: false, anyFailed: false });
        const clearCiWait = mock.fn(async () => undefined);
        assert.equal(await isUltrafixReviewExecutionReady(
            makeJob('review'), { redisClient: {} as never, correlatedLogger: logger }, { ...passing.deps, clearCiWait },
        ), true);
        assert.deepEqual(clearCiWait.mock.calls[0].arguments.slice(1), ['acme', 'web', 42]);
    });

    test('a notice failure never fails the deferral', async () => {
        const { deps, save } = makeDeps({ count: 1, allPassing: false, anyPending: true, anyFailed: false });
        const handleCiDeferral = mock.fn(async () => { throw new Error('github down'); });
        const deferral = await evaluateUltrafixReviewExecution(
            makeJob('review'), { redisClient: {} as never, correlatedLogger: logger }, { ...deps, handleCiDeferral },
        );
        assert.deepEqual(deferral, { reason: 'pre_execution_checks_not_passing' });
        assert.equal(save.mock.callCount(), 1);
    });
});
