import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from 'bullmq';
import type { CommentJobData } from '@propr/core';

await mock.module('@propr/core', {
    namedExports: {
        getCheckRunsStatus: mock.fn(),
        getCurrentPRHead: mock.fn(),
    },
});

await mock.module('../src/jobs/ultrafixOrchestrationService.js', {
    namedExports: {
        saveDeferredContinuation: mock.fn(),
    },
});

const { isUltrafixReviewExecutionReady } = await import('../src/jobs/ultrafixReviewExecutionGate.js');

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

function makeDeps(status: { count: number; allPassing: boolean; anyPending: boolean; anyFailed: boolean }) {
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
});
