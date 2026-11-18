import type { Job } from 'bullmq';
import type logger from '../utils/logger.js';
import { generateCorrelationId } from '../utils/logger.js';
import { getIssueQueue, COMMENT_BATCH_DELAY_MS, type CommentJobData } from '../queue/taskQueue.js';

type CorrelatedLogger = ReturnType<typeof logger.withCorrelation>;

export interface PendingCommentDrainContext {
    owner: string;
    repo: string;
    prNumber: number;
}

export type PendingCommentDrainOutcome =
    | { state: 'pickup_queued'; jobId?: string }
    | { state: 'drain_queued'; jobId: string };

function isPRCommentJob(job: Job<CommentJobData> | undefined, context: PendingCommentDrainContext): job is Job<CommentJobData> {
    return job?.name === 'processPullRequestComment'
        && job.data?.pullRequestNumber === context.prNumber
        && job.data?.repoOwner === context.owner
        && job.data?.repoName === context.repo;
}

/**
 * Guarantees that a comment just stored on the PR's pending list has a job
 * that will pick it up.
 *
 * A waiting or delayed PR comment job claims the pending list when it starts
 * (and returns it whenever it waits again), so it is enough. An active job is
 * not: it claimed the list when it started, and it only looks again at the
 * very end of its cleanup. A comment stored after that last look, or while
 * the job ended along a path that never looks, stayed on the list with no job
 * behind it until the list's TTL expired, and the request vanished without a
 * run or a comment. So when no waiting or delayed job exists, a drain job is
 * queued; it waits for the PR lock like any other follow-up and then claims
 * the list.
 */
export async function ensurePendingCommentDrain(
    context: PendingCommentDrainContext,
    correlatedLogger: CorrelatedLogger,
): Promise<PendingCommentDrainOutcome> {
    const queue = await getIssueQueue();
    const [activeJobs, waitingJobs, delayedJobs] = await Promise.all([
        queue.getActive(),
        queue.getWaiting(),
        queue.getDelayed(),
    ]) as Array<Array<Job<CommentJobData>>>;
    const pickup = [...waitingJobs, ...delayedJobs].find(job => isPRCommentJob(job, context));
    if (pickup) {
        correlatedLogger.info({ pullRequestNumber: context.prNumber, pickupJobId: pickup.id }, 'Stored follow-up comment will be picked up by the queued job for this PR');
        return { state: 'pickup_queued', ...(pickup.id ? { jobId: pickup.id } : {}) };
    }

    const template = activeJobs.find(job => isPRCommentJob(job, context))?.data;
    const jobId = `pr-comments-batch-${context.owner}-${context.repo}-${context.prNumber}-${Date.now()}`;
    await queue.add('processPullRequestComment', {
        pullRequestNumber: context.prNumber,
        comments: [],
        repoOwner: context.owner,
        repoName: context.repo,
        branchName: template?.branchName,
        llm: template?.llm ?? null,
        correlationId: generateCorrelationId(),
        ...(template?.reasoningLevel ? { reasoningLevel: template.reasoningLevel } : {}),
    }, {
        jobId,
        delay: COMMENT_BATCH_DELAY_MS,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
    });
    correlatedLogger.info({ pullRequestNumber: context.prNumber, jobId, activeJobId: activeJobs.find(job => isPRCommentJob(job, context))?.id }, 'Queued a drain job for the follow-up comment stored behind the active job');
    return { state: 'drain_queued', jobId };
}
