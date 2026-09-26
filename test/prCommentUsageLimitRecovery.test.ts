import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import type { Job } from 'bullmq';
import type { CommentJobData, UnprocessedComment } from '@propr/core';

const jobs = new Map<string, Job<CommentJobData>>();
let returnAttemptedDataForDuplicate = false;
const queueAdd = mock.fn(async (_name: string, data: CommentJobData, options: { jobId?: string }) => {
    const jobId = options.jobId ?? `generated-${jobs.size}`;
    const existing = jobs.get(jobId);
    if (existing) {
        if (!returnAttemptedDataForDuplicate) return existing;
        return {
            id: jobId,
            data: structuredClone(data),
            getState: async () => 'delayed',
        } as Job<CommentJobData>;
    }
    const queued = {
        id: jobId,
        data: structuredClone(data),
        getState: async () => 'delayed',
    } as Job<CommentJobData>;
    jobs.set(jobId, queued);
    return queued;
});
const queueGetJob = mock.fn(async (jobId: string) => jobs.get(jobId));

await mock.module('@propr/core', {
    namedExports: {
        issueQueue: { add: queueAdd, getJob: queueGetJob },
    },
});

const { schedulePRCommentUsageLimitRetry } = await import('../src/jobs/prCommentUsageLimitRecovery.js');

function makeData(comments: UnprocessedComment[]): CommentJobData {
    return {
        pullRequestNumber: 42,
        repoOwner: 'acme',
        repoName: 'web',
        correlationId: 'correlation-1',
        branchName: 'feature',
        comments,
        prProcessingLockToken: 'live-predecessor-lease',
    };
}

describe('PR comment usage-limit recovery ownership', () => {
    beforeEach(() => {
        jobs.clear();
        returnAttemptedDataForDuplicate = false;
        queueAdd.mock.resetCalls();
        queueGetJob.mock.resetCalls();
    });

    test('reloads a duplicate retry before selecting a durable owner', async () => {
        const existingComment = { id: 700, body: 'existing', author: 'bob', type: 'issue' as const };
        const claimedComment = { id: 701, body: 'claimed', author: 'alice', type: 'issue' as const };
        const baseJobId = 'pr-comments-batch-acme-web-42-default-feature-ratelimit-retry';
        jobs.set(baseJobId, {
            id: baseJobId,
            data: makeData([existingComment]),
            getState: async () => 'delayed',
        } as Job<CommentJobData>);
        returnAttemptedDataForDuplicate = true;
        const sourceJob = {
            id: 'source-job-2',
            name: 'processPullRequestComment',
            data: makeData([claimedComment]),
        } as Job<CommentJobData>;

        const durableJobId = await schedulePRCommentUsageLimitRetry(
            sourceJob,
            [claimedComment],
            baseJobId,
            1000,
        );

        assert.equal(queueAdd.mock.callCount(), 2);
        assert.equal(queueGetJob.mock.callCount(), 2);
        assert.deepStrictEqual(jobs.get(baseJobId)?.data.comments?.map(comment => comment.id), [700]);
        const fallback = queueAdd.mock.calls[1].arguments;
        assert.match(fallback[2].jobId ?? '', new RegExp(`^${baseJobId}-[0-9a-f]{16}$`));
        assert.deepStrictEqual(fallback[1].comments?.map(comment => comment.id), [701]);
        assert.equal(fallback[1].prProcessingLockToken, undefined);
        assert.equal(durableJobId, fallback[2].jobId);
    });

    test('a delayed retry that hits the limit again cannot select itself as its next owner', async () => {
        const claimedComment = { id: 702, body: 'retry me again', author: 'alice', type: 'issue' as const };
        const baseJobId = 'pr-comments-batch-acme-web-42-default-feature-ratelimit-retry';
        const retryJob = {
            id: baseJobId,
            name: 'processPullRequestComment',
            data: makeData([claimedComment]),
            getState: async () => 'active',
        } as Job<CommentJobData>;
        jobs.set(baseJobId, retryJob);

        await schedulePRCommentUsageLimitRetry(
            retryJob,
            [claimedComment],
            baseJobId,
            1000,
        );

        assert.equal(queueAdd.mock.callCount(), 2);
        const nextJobId = queueAdd.mock.calls[1].arguments[2].jobId;
        assert.notEqual(nextJobId, retryJob.id);
        assert.deepStrictEqual(queueAdd.mock.calls[1].arguments[1].comments?.map(comment => comment.id), [702]);
        assert.equal(queueAdd.mock.calls[1].arguments[1].prProcessingLockToken, undefined);
    });
});
