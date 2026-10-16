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

async function writeTrackingKeys(redisClient: Redis, keys: string[], strict?: boolean): Promise<void> {
    const pipeline = redisClient.pipeline();
    for (const key of keys) pipeline.setex(key, 86400, Date.now().toString());
    const results = await pipeline.exec();
    if (!strict) return;
    // A pipeline reports per-command failures in its results instead of throwing.
    const failed = results === null ? keys.length : results.filter(([error]) => error).length;
    if (failed > 0) throw new Error(`Failed to record ${failed} processed PR comment marker(s)`);
}

export async function enqueuePRCommentJob(
    jobDetails: EnqueueJobDetails,
    options: EnqueueOptions
): Promise<void> {
    const { unprocessedComments, selectedLlm, userId, pr, owner, repo } = jobDetails;
    const { repoFullName, correlationId, redisClient, strict } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);

    const issueQueue = await getIssueQueue();
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
            await writeTrackingKeys(redisClient, unprocessedComments.map(comment => commentTrackingKey(owner, repo, pr.number, comment.id)), true);
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
        await issueQueue.add('processPullRequestComment', jobData, {
            jobId,
            delay: COMMENT_BATCH_DELAY_MS
        });

        await writeTrackingKeys(redisClient, unprocessedComments.map(comment => commentTrackingKey(owner, repo, pr.number, comment.id)), strict);

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
