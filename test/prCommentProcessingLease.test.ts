import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const add = mock.fn(async () => ({}));

await mock.module('@propr/core', {
    namedExports: { issueQueue: { add } },
});

const { requeuePRCommentJobWithoutLease } = await import('../src/jobs/prCommentProcessingLease.js');

test('lock-contention requeues use a stable ID and preserve execution options', async () => {
    const job = {
        id: 'pr-comments-integry-propr-1748-source',
        name: 'processPullRequestComment',
        data: {
            pullRequestNumber: 1748,
            repoOwner: 'integry',
            repoName: 'propr',
            correlationId: 'correlation',
            prProcessingLockToken: 'stale-token',
        },
        opts: {
            priority: 3,
            attempts: 4,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: 50,
            removeOnFail: false,
        },
    };

    await requeuePRCommentJobWithoutLease(job as never, 10_000);
    await requeuePRCommentJobWithoutLease(job as never, 10_000);

    assert.equal(add.mock.calls[0].arguments[2].jobId, 'pr-comments-integry-propr-1748-source-lease-requeue');
    assert.equal(add.mock.calls[1].arguments[2].jobId, add.mock.calls[0].arguments[2].jobId);
    assert.deepEqual(add.mock.calls[0].arguments[2], {
        jobId: 'pr-comments-integry-propr-1748-source-lease-requeue',
        delay: 10_000,
        priority: 3,
        attempts: 4,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 50,
        removeOnFail: false,
    });
    assert.equal('prProcessingLockToken' in add.mock.calls[0].arguments[1], false);
});
