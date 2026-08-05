import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

await mock.module('@propr/core', {
    namedExports: {
        getModelName: (value: string) => value,
        getProcessedReviewCommentsKey: () => 'processed-review-comments',
    },
});

const { markReviewCommentsProcessed } = await import('../src/jobs/reviewCommentGatherer.js');

test('marks review comments in the same Redis operation that verifies the live lease', async () => {
    const evalMock = mock.fn(async () => 1);
    await markReviewCommentsProcessed([10, 20], {
        repoOwner: 'integry',
        repoName: 'propr',
        pullRequestNumber: 1748,
        redisClient: { eval: evalMock },
        correlatedLogger: { info: mock.fn() },
        prProcessingLockKey: 'lock:pr:integry:propr:1748',
        prProcessingLockToken: 'attempt-token',
        assertLease: async () => {},
    } as never);

    assert.deepEqual(evalMock.mock.calls[0].arguments.slice(1), [
        2,
        'lock:pr:integry:propr:1748',
        'processed-review-comments',
        'attempt-token',
        30 * 24 * 3600,
        '10',
        '20',
    ]);
});

test('propagates canonical lease loss when the atomic review-comment fence fails', async () => {
    const leaseLost = new Error('lease lost');
    await assert.rejects(
        markReviewCommentsProcessed([10], {
            repoOwner: 'integry',
            repoName: 'propr',
            pullRequestNumber: 1748,
            redisClient: { eval: async () => 0 },
            correlatedLogger: { info: mock.fn() },
            prProcessingLockKey: 'lock:pr:integry:propr:1748',
            prProcessingLockToken: 'stale-token',
            assertLease: async () => { throw leaseLost; },
        } as never),
        error => error === leaseLost,
    );
});
