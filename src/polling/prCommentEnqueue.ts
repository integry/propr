import { logger } from '@propr/core';
import { generateCorrelationId } from '@propr/core';
import { handleError } from '@propr/core';
import { getIssueQueue, COMMENT_BATCH_DELAY_MS, type CommentJobData, type UnprocessedComment } from '@propr/core';
import type { Redis } from 'ioredis';

/**
 * Turns a PR's newly discovered trigger comments into one batched
 * `processPullRequestComment` job, then marks them processed. The tracking keys
 * are written only after the job is durably queued, so a comment is never
 * marked processed without a recoverable job obligation.
 */

export interface EnqueueJobDetails {
    unprocessedComments: UnprocessedComment[];
    selectedLlm: string | null;
    userId?: string;
    pr: { number: number; head: { ref: string } };
    owner: string;
    repo: string;
}

export interface EnqueueOptions {
    repoFullName: string;
    correlationId: string;
    redisClient: Redis;
    /**
     * The Routing resume resync: queue and tracking failures propagate, and an
     * existing job for the PR counts only when it already carries every new
     * comment. Otherwise the family stays partial and is retried.
     */
    strict?: boolean;
}

export function commentTrackingKey(owner: string, repo: string, prNumber: number, commentId: number): string {
    return `pr-comment-processed:${owner}:${repo}:${prNumber}:${commentId}`;
}

/** Comment IDs a queued comment job will act on. */
function jobCommentIds(data: CommentJobData): Set<number> {
    const ids = new Set((data.comments ?? []).map(comment => comment.id));
    if (typeof data.commentId === 'number') ids.add(data.commentId);
    return ids;
}

/**
 * Strict only: the job a recovered comment was handed to, written before that
 * job is added. It outlives the job's completion, so a retry after a failed
 * tracking write recognizes the first admission instead of queueing the
 * comment again under a new timestamp-named job.
 */
export function commentAdmissionKey(owner: string, repo: string, prNumber: number, commentId: number): string {
    return `pr-comment-admitted:${owner}:${repo}:${prNumber}:${commentId}`;
}

const TRACKING_TTL_SECONDS = 86400;

/**
 * Strict markers never expire: an unfinished resync rescans from its original
 * recovery start however long it stays unfinished (retries, restarts, inherited
 * gaps), so admission evidence must not lapse while that window still covers
 * the comment. Only recovered trigger comments get them.
 */
async function writeKeys(redisClient: Redis, entries: Array<[key: string, value: string]>, what: string, strict?: boolean): Promise<void> {
    const pipeline = redisClient.pipeline();
    for (const [key, value] of entries) {
        if (strict) pipeline.set(key, value);
        else pipeline.setex(key, TRACKING_TTL_SECONDS, value);
    }
    const results = await pipeline.exec();
    if (!strict) return;
    // A pipeline reports per-command failures in its results instead of throwing.
    const failed = results === null ? entries.length : results.filter(([error]) => error).length;
    if (failed > 0) throw new Error(`Failed to record ${failed} ${what} marker(s)`);
}

async function writeTrackingKeys(redisClient: Redis, keys: string[], strict?: boolean): Promise<void> {
    const now = Date.now().toString();
    await writeKeys(redisClient, keys.map(key => [key, now]), 'processed PR comment', strict);
}

type IssueQueue = Awaited<ReturnType<typeof getIssueQueue>>;

/**
 * Strict: the comments an earlier attempt already handed to a job that still
 * exists in any state, including completed or failed. A recorded admission
 * whose job is gone never reached the queue, so that comment is admitted again.
 */
async function previouslyAdmitted(issueQueue: IssueQueue, redisClient: Redis, comments: UnprocessedComment[], key: (id: number) => string): Promise<Set<number>> {
    if (comments.length === 0) return new Set();
    const jobIds = await redisClient.mget(...comments.map(comment => key(comment.id)));
    const admitted = new Set<number>();
    for (const [index, jobId] of jobIds.entries()) {
        if (jobId && await issueQueue.getJob(jobId)) admitted.add(comments[index].id);
    }
    return admitted;
}

export async function enqueuePRCommentJob(
    jobDetails: EnqueueJobDetails,
    options: EnqueueOptions
): Promise<void> {
    const { selectedLlm, userId, pr, owner, repo } = jobDetails;
    const { repoFullName, correlationId, redisClient, strict } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const trackingKey = (commentId: number) => commentTrackingKey(owner, repo, pr.number, commentId);
    const admissionKey = (commentId: number) => commentAdmissionKey(owner, repo, pr.number, commentId);

    const issueQueue = await getIssueQueue();
    let unprocessedComments = jobDetails.unprocessedComments;
    if (strict) {
        const admitted = await previouslyAdmitted(issueQueue, redisClient, unprocessedComments, admissionKey);
        if (admitted.size > 0) {
            // Durable in that job; record them like the first attempt meant to.
            await writeTrackingKeys(redisClient, [...admitted].map(trackingKey), true);
            unprocessedComments = unprocessedComments.filter(comment => !admitted.has(comment.id));
            if (unprocessedComments.length === 0) return;
        }
    }
    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const delayedJobs = await issueQueue.getDelayed();
    const existingJobs = [...activeJobs, ...waitingJobs, ...delayedJobs].filter(job =>
        job.name === 'processPullRequestComment' &&
        (job.data as CommentJobData).pullRequestNumber === pr.number &&
        (job.data as CommentJobData).repoOwner === owner &&
        (job.data as CommentJobData).repoName === repo
    );

    if (existingJobs.length > 0) {
        if (strict) {
            const covered = new Set(existingJobs.flatMap(job => [...jobCommentIds(job.data as CommentJobData)]));
            const uncovered = unprocessedComments.filter(comment => !covered.has(comment.id));
            if (uncovered.length > 0) {
                throw new Error(`PR #${pr.number} has a comment job in flight that does not carry ${uncovered.length} newly discovered comment(s); retrying after it settles`);
            }
            // Already durable in the existing job; record them like an enqueue would.
            await writeTrackingKeys(redisClient, unprocessedComments.map(comment => trackingKey(comment.id)), true);
            return;
        }
        correlatedLogger.info({
            pullRequestNumber: pr.number,
            repository: repoFullName
        }, 'A job for this PR is already active, waiting, or delayed, skipping new job creation.');
        return;
    }

    const jobData: CommentJobData = {
        ...(userId ? { userId } : {}),
        pullRequestNumber: pr.number,
        comments: unprocessedComments,
        repoOwner: owner,
        repoName: repo,
        branchName: pr.head.ref,
        llm: selectedLlm,
        correlationId: generateCorrelationId(),
    };

    const timestamp = Date.now();
    const jobId = `pr-comments-batch-${owner}-${repo}-${pr.number}-${timestamp}`;

    try {
        if (strict) await writeKeys(redisClient, unprocessedComments.map(comment => [admissionKey(comment.id), jobId]), 'PR comment admission', true);
        await issueQueue.add('processPullRequestComment', jobData, {
            jobId,
            delay: COMMENT_BATCH_DELAY_MS
        });

        await writeTrackingKeys(redisClient, unprocessedComments.map(comment => trackingKey(comment.id)), strict);

        correlatedLogger.info({
            jobId,
            pullRequestNumber: pr.number,
            commentsCount: unprocessedComments.length,
            commentIds: unprocessedComments.map(c => c.id),
            commentTypes: unprocessedComments.map(c => c.type),
            delayMs: COMMENT_BATCH_DELAY_MS
        }, `Successfully added batch PR comments job (${unprocessedComments.length} comments)`);
    } catch (error) {
        if (strict) throw error;
        const err = error as Error;
        if (err.message?.includes('Job already exists')) {
            correlatedLogger.debug({
                pullRequestNumber: pr.number,
                commentsCount: unprocessedComments.length,
            }, 'PR comments batch job already in queue, skipping');
        } else {
            handleError(error, `Failed to add PR comments batch to queue`, { correlationId });
        }
    }
}
