import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from 'bullmq';
import type { CommentJobData } from '@propr/core';

await mock.module('@propr/core', {
    namedExports: {
        areAllChecksPassing: mock.fn(async () => true),
        getCurrentPRHead: mock.fn(async () => 'head-sha'),
    },
});

await mock.module('../src/jobs/ultrafixLoopContinuation.js', {
    namedExports: { continueUltrafixLoop: mock.fn() },
});

await mock.module('../src/jobs/ultrafixContinuationMeta.js', {
    namedExports: {
        buildContinuationMeta: mock.fn(),
        buildUltrafixHistoryMeta: mock.fn(),
        patchUltrafixContinuationMeta: mock.fn(),
    },
});

const { isUltrafixJobCurrent } = await import('../src/jobs/ultrafixJobHelpers.js');

function makeJob(workEpoch?: number): Job<CommentJobData> {
    return {
        data: {
            pullRequestNumber: 42,
            repoOwner: 'acme',
            repoName: 'web',
            correlationId: 'test-correlation',
            ...(workEpoch === undefined
                ? {}
                : { ultrafixMeta: { mode: 'ultrafix' as const, instructions: '', workEpoch } }),
        },
    } as Job<CommentJobData>;
}

function makeRedis(currentEpoch: number) {
    return {
        async get() { return String(currentEpoch); },
    };
}

describe('Ultrafix queued-work epoch guard', () => {
    const params = {
        repoOwner: 'acme',
        repoName: 'web',
        pullRequestNumber: 42,
    };

    test('allows manual jobs that do not carry automatic loop metadata', async () => {
        const current = await isUltrafixJobCurrent(
            makeJob(),
            { ...params, redisClient: makeRedis(3) as never },
        );

        assert.equal(current, true);
    });

    test('allows only automatic jobs from the current epoch', async () => {
        assert.equal(await isUltrafixJobCurrent(
            makeJob(3),
            { ...params, redisClient: makeRedis(3) as never },
        ), true);
        assert.equal(await isUltrafixJobCurrent(
            makeJob(2),
            { ...params, redisClient: makeRedis(3) as never },
        ), false);
    });
});
