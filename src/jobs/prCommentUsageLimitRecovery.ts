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
    // Queue IDs also identify terminal worker state. Deduplicate within the
    // source attempt without inheriting cancellation from an earlier request or
    // a removed retry in the same request (which shares its correlation ID).
    const attempt = createHash('sha256')
        .update(JSON.stringify({ correlationId: job.data.correlationId, sourceJobId: job.id }))
        .digest('hex').slice(0, 16);
    const attemptJobId = `${baseJobId}-${attempt}`;
    const retryJobData = { ...job.data };
    delete retryJobData.prProcessingLockToken;
    delete retryJobData.prLockWaitAttempts;
    const retryData: CommentJobData = { ...retryJobData, comments };
    const initialRetry = await issueQueue.add(job.name, retryData, {
        jobId: attemptJobId,
        delay,
    }) as Job<CommentJobData>;
    const initialRetryJobId = String(initialRetry.id ?? attemptJobId);
    const persistedInitialRetry = await issueQueue.getJob(initialRetryJobId) as Job<CommentJobData> | undefined;
    if (await isDurableRetryOwner(persistedInitialRetry, job, comments)) {
        return initialRetryJobId;
    }

    // A duplicate add may not persist the attempted payload. Give this claim a
    // distinct, stable owner rather than silently dropping data.
    const fallbackJobId = buildRetryFallbackJobId(attemptJobId, job, comments);
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
