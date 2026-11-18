import type { Job } from 'bullmq';
import type logger from '../utils/logger.js';
import { generateCorrelationId } from '../utils/logger.js';
import { getIssueQueue, COMMENT_BATCH_DELAY_MS, type CommentJobData } from '../queue/taskQueue.js';

type CorrelatedLogger = ReturnType<typeof logger.withCorrelation>;

export interface PendingCommentDrainContext {
    owner: string;
    repo: string;
    prNumber: number;
    /** When the pending list holding the stored comment stops being retained (epoch ms). */
    pendingRetainedUntil: number;
}

/**
 * A delayed job must start this long before the pending list expires to count
 * as its pickup: it still has to be taken by a worker and claim the list.
 * Mirrors PENDING_PICKUP_RETENTION_MARGIN_MS in src/jobs/prCommentQueuedPickup.ts.
 */
export const PENDING_PICKUP_RETENTION_MARGIN_MS = 60_000;

type IssueQueue = Awaited<ReturnType<typeof getIssueQueue>>;

/**
 * When a delayed job will run, read from BullMQ's delayed set: its score is the
 * run timestamp shifted left by 12 bits. The job's timestamp and delay fields
 * are not enough, because moving a job back to delayed (a PR-lock wait)
 * rewrites the delay relative to that moment but keeps the creation timestamp.
 * Undefined when the run time cannot be read.
 */
async function delayedJobRunsAt(queue: IssueQueue, jobId: string | undefined): Promise<number | undefined> {
    const delayedKey = (queue as { keys?: { delayed?: string } }).keys?.delayed;
    const client = (queue as { client?: Promise<{ zscore: (key: string, member: string) => Promise<string | null> }> }).client;
    if (!jobId || !delayedKey || !client) return undefined;
    try {
        const score = await (await client).zscore(delayedKey, jobId);
        if (score === null || score === undefined) return undefined;
        const runsAt = Math.floor(Number(score) / 0x1000);
        return Number.isFinite(runsAt) ? runsAt : undefined;
    } catch {
        return undefined;
    }
}

/**
 * When the pending comment list stops being retained. A list without an
 * expiry is retained indefinitely; one whose expiry cannot be read counts as
 * expiring now, so only a waiting job can count as its pickup.
 */
export async function pendingCommentsRetainedUntil(redisClient: { pttl: (key: string) => Promise<number> }, pendingCommentsKey: string): Promise<number> {
    try {
        const ttlMs = await redisClient.pttl(pendingCommentsKey);
        if (ttlMs === -1) return Number.POSITIVE_INFINITY;
        return Date.now() + Math.max(0, ttlMs);
    } catch {
        return Date.now();
    }
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
 * A waiting PR comment job, or a delayed one that runs before the list
 * expires, claims the pending list when it starts (and returns it whenever it
 * waits again), so it is enough. An active job is
 * not: it claimed the list when it started, and it only looks again at the
 * very end of its cleanup. A comment stored after that last look, or while
 * the job ended along a path that never looks, stayed on the list with no job
 * behind it until the list's TTL expired, and the request vanished without a
 * run or a comment. So when no such job exists, a drain job is
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
    // A delayed job counts only when it runs while the stored comment is still
    // retained: a usage-limit retry an hour or more away would find the list
    // expired, and its own payload holds only the comments it already claimed.
    let pickup = waitingJobs.find(job => isPRCommentJob(job, context));
    for (const job of pickup ? [] : delayedJobs.filter(job => isPRCommentJob(job, context))) {
        const runsAt = await delayedJobRunsAt(queue, job.id);
        if (runsAt !== undefined && runsAt <= context.pendingRetainedUntil - PENDING_PICKUP_RETENTION_MARGIN_MS) {
            pickup = job;
            break;
        }
    }
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
