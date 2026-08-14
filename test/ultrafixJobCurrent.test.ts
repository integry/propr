import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from 'bullmq';
import type { CommentJobData } from '@propr/core';

const mockIssueQueueAdd = mock.fn(async () => ({}));
let mockActiveQueueJobs: Array<Job<CommentJobData>> = [];
let mockWaitingQueueJobs: Array<Job<CommentJobData>> = [];
let mockDelayedQueueJobs: Array<Job<CommentJobData>> = [];
await mock.module('@propr/core', {
    namedExports: {
        areAllChecksPassing: mock.fn(async () => true),
        getCurrentPRHead: mock.fn(async () => 'head-sha'),
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending-pr-comments:${owner}:${repo}:${pr}`,
        getUnprocessedCommentIdentity: (comment: { type: string; id: number; updatedAt?: string; createdAt?: string }) =>
            `${comment.type}:${comment.id}:${comment.updatedAt ?? comment.createdAt ?? ''}`,
        dedupeUnprocessedComments: (comments: Array<{ type: string; id: number; updatedAt?: string; createdAt?: string }>) =>
            comments.filter((comment, index) => comments.findIndex(candidate =>
                `${candidate.type}:${candidate.id}:${candidate.updatedAt ?? candidate.createdAt ?? ''}`
                === `${comment.type}:${comment.id}:${comment.updatedAt ?? comment.createdAt ?? ''}`) === index),
        restorePendingCommentsIdempotently: async (redisClient: { lpush: (key: string, ...values: string[]) => Promise<number>; expire: (key: string, ttl: number) => Promise<number> }, key: string, comments: unknown[]) => {
            if (comments.length === 0) return 0;
            await redisClient.lpush(key, ...comments.map(comment => JSON.stringify(comment)).reverse());
            await redisClient.expire(key, 3600);
            return comments.length;
        },
        issueQueue: {
            add: mockIssueQueueAdd,
            getActive: async () => mockActiveQueueJobs,
            getWaiting: async () => mockWaitingQueueJobs,
            getDelayed: async () => mockDelayedQueueJobs,
        },
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

const { isUltrafixJobCurrent, restorePendingCommentsIfUltrafixJobSuperseded } = await import('../src/jobs/ultrafixJobHelpers.js');
const { pickUpPendingCommentsWithClaim } = await import('../src/jobs/prPendingComments.js');

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

    test('a stale job that wins pending pickup restores an ordinary comment for the takeover job', async () => {
        const pendingKey = 'pending-pr-comments:acme:web:42';
        const lists = new Map<string, string[]>([[pendingKey, [JSON.stringify({
            id: 700,
            body: 'also update the documentation',
            author: 'alice',
            type: 'issue',
        })]]]);
        const redis = {
            async get() { return '1'; },
            async lrange(key: string, start: number, stop: number) {
                return (lists.get(key) ?? []).slice(start, stop === -1 ? undefined : stop + 1);
            },
            async del(key: string) { return lists.delete(key) ? 1 : 0; },
            async lpush(key: string, ...values: string[]) {
                const list = lists.get(key) ?? [];
                for (const value of values) list.unshift(value);
                lists.set(key, list);
                return list.length;
            },
            async expire() { return 1; },
        };
        const correlatedLogger = { info: mock.fn(), warn: mock.fn() };
        const pickupOptions = { ...params, correlatedLogger, redisClient: redis as never };

        const stalePickup = await pickUpPendingCommentsWithClaim([{
            id: -1,
            body: '/fix',
            author: 'propr-ultrafix',
            type: 'issue',
        }], pickupOptions);
        assert.strictEqual(lists.has(pendingKey), false, 'stale automatic job won the destructive pickup race');

        const staleJob = makeJob(0);
        const originalUltrafixMeta = staleJob.data.ultrafixMeta;
        assert.strictEqual(await restorePendingCommentsIfUltrafixJobSuperseded(
            staleJob,
            { ...params, redisClient: redis as never },
            stalePickup.pickedUpComments,
            originalUltrafixMeta,
        ), true);

        const takeoverPickup = await pickUpPendingCommentsWithClaim([{
            id: 701,
            body: 'apply the manual fix',
            author: 'bob',
            type: 'issue',
        }], pickupOptions);

        assert.deepStrictEqual(
            takeoverPickup.commentsToProcess.map(comment => comment.id),
            [701, 700],
        );
        assert.strictEqual(
            takeoverPickup.commentsToProcess[1].body,
            'also update the documentation',
            'durable takeover eventually processes the unrelated pending comment',
        );
        assert.strictEqual(lists.has(pendingKey), false);
        assert.strictEqual(mockIssueQueueAdd.mock.callCount(), 1, 'restored comments get a durable follow-up job');
    });

    test('does not let pending model overrides erase stale automatic provenance', async () => {
        for (const commandMode of ['switch', 'use'] as const) {
            const staleJob = makeJob(0);
            const originalUltrafixMeta = staleJob.data.ultrafixMeta;
            staleJob.data.ultrafixMeta = undefined;
            staleJob.data.commandMode = commandMode;

            assert.strictEqual(await restorePendingCommentsIfUltrafixJobSuperseded(
                staleJob,
                { ...params, redisClient: makeRedis(1) as never },
                [],
                originalUltrafixMeta,
            ), true);
        }
    });

    test('allows an accepted pending manual takeover to replace a stale automatic job', async () => {
        for (const commandMode of ['fix', 'review'] as const) {
            const staleJob = makeJob(0);
            const originalUltrafixMeta = staleJob.data.ultrafixMeta;
            staleJob.data.ultrafixMeta = undefined;
            staleJob.data.commandMode = commandMode;

            assert.strictEqual(await restorePendingCommentsIfUltrafixJobSuperseded(
                staleJob,
                { ...params, redisClient: makeRedis(1) as never },
                [],
                originalUltrafixMeta,
            ), false);
        }
    });

    test('does not let a stale automatic job steal pending work from a current manual owner', async () => {
        mockIssueQueueAdd.mock.resetCalls();
        const restored: string[] = [];
        const staleJob = makeJob(0);
        staleJob.id = 'stale-automatic-job';
        staleJob.name = 'processPullRequestComment';
        const originalUltrafixMeta = staleJob.data.ultrafixMeta;
        staleJob.data.ultrafixMeta = undefined;
        staleJob.data.commandMode = 'fix';
        mockActiveQueueJobs = [{
            id: 'current-manual-owner',
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'acme',
                repoName: 'web',
                correlationId: 'manual-owner',
                commandMode: 'fix',
            },
        } as Job<CommentJobData>];
        const redis = {
            async get() { return '1'; },
            async lpush(_key: string, ...values: string[]) { restored.push(...values); return restored.length; },
            async expire() { return 1; },
        };
        const pending = [{ id: 702, body: 'later manual fix', author: 'alice', type: 'issue' as const }];

        try {
            assert.strictEqual(await restorePendingCommentsIfUltrafixJobSuperseded(
                staleJob,
                { ...params, redisClient: redis as never },
                pending,
                originalUltrafixMeta,
            ), true);
            assert.strictEqual(restored.length, 1);
            assert.strictEqual(JSON.parse(restored[0]).id, 702);
            assert.strictEqual(mockIssueQueueAdd.mock.callCount(), 1);
        } finally {
            mockActiveQueueJobs = [];
            mockWaitingQueueJobs = [];
            mockDelayedQueueJobs = [];
        }
    });
});
