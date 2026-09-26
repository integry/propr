import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import { issueQueue, type CommentJobData, type UnprocessedComment } from '@propr/core';

function retryContainsComments(
    retryJob: Job<CommentJobData>,
    comments: UnprocessedComment[],
): boolean {
    const storedCommentIds = new Set(retryJob.data.comments?.map(comment => comment.id) ?? []);
    return comments.every(comment => storedCommentIds.has(comment.id));
}

async function isDurableRetryOwner(
    retryJob: Job<CommentJobData> | undefined,
    currentJob: Job<CommentJobData>,
    comments: UnprocessedComment[],
): Promise<boolean> {
    if (!retryJob) return false;
    if (retryJob.id !== undefined && String(retryJob.id) === String(currentJob.id)) return false;
    if (!retryContainsComments(retryJob, comments)) return false;
    if (typeof retryJob.getState !== 'function') return true;
    const state = await retryJob.getState();
    return state !== 'completed' && state !== 'failed' && state !== 'unknown';
}

function buildRetryFallbackJobId(
    baseJobId: string,
    job: Job<CommentJobData>,
    comments: UnprocessedComment[],
): string {
    const fingerprint = createHash('sha256')
        .update(JSON.stringify({
            sourceJobId: job.id ?? job.data.correlationId,
            commentIds: comments.map(comment => comment.id).sort((a, b) => a - b),
        }))
        .digest('hex')
        .slice(0, 16);
    return `${baseJobId}-${fingerprint}`;
}

/** Give a usage-limit claim a queued owner even when BullMQ returns a duplicate ID. */
export async function schedulePRCommentUsageLimitRetry(
    job: Job<CommentJobData>,
    comments: UnprocessedComment[],
    baseJobId: string,
    delay: number,
): Promise<string> {
    const retryJobData = { ...job.data };
    delete retryJobData.prProcessingLockToken;
    const retryData: CommentJobData = { ...retryJobData, comments };
    const initialRetry = await issueQueue.add(job.name, retryData, {
        jobId: baseJobId,
        delay,
    }) as Job<CommentJobData>;
    const initialRetryJobId = String(initialRetry.id ?? baseJobId);
    const persistedInitialRetry = await issueQueue.getJob(initialRetryJobId) as Job<CommentJobData> | undefined;
    if (await isDurableRetryOwner(persistedInitialRetry, job, comments)) {
        return initialRetryJobId;
    }

    // A duplicate add may not persist the attempted payload. Give this claim a
    // distinct, stable owner rather than silently dropping data.
    const fallbackJobId = buildRetryFallbackJobId(baseJobId, job, comments);
    const fallbackRetry = await issueQueue.add(job.name, retryData, {
        jobId: fallbackJobId,
        delay,
    }) as Job<CommentJobData>;
    const persistedFallbackRetry = await issueQueue.getJob(String(fallbackRetry.id ?? fallbackJobId)) as Job<CommentJobData> | undefined;
    if (!await isDurableRetryOwner(persistedFallbackRetry, job, comments)) {
        throw new Error(`Unable to persist usage-limit retry comments in job ${fallbackJobId}`);
    }
    return String(persistedFallbackRetry?.id ?? fallbackJobId);
}
