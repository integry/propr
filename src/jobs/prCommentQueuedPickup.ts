import type { CommentJobData } from '@propr/core';

type QueuedJob = { id?: string; name?: string; data?: unknown } | undefined;

type QueueReader = {
    getWaiting: () => Promise<QueuedJob[]>;
    getDelayed: () => Promise<QueuedJob[]>;
    /** BullMQ's queue connection and keys, read to learn when a delayed job runs. */
    client?: Promise<{ zscore: (key: string, member: string) => Promise<string | null> }>;
    keys?: { delayed?: string };
};

type RetentionReader = { pttl: (key: string) => Promise<number> };

/**
 * A delayed job must start this long before the pending list expires to count
 * as its pickup: it still has to be taken by a worker and claim the list.
 */
export const PENDING_PICKUP_RETENTION_MARGIN_MS = 60_000;

/**
 * When the pending comment list stops being retained. A list without an expiry
 * is retained indefinitely; one whose expiry cannot be read counts as expiring
 * now, so only a job that is already waiting can count as its pickup.
 */
export async function pendingCommentsRetainedUntil(redisClient: RetentionReader, pendingCommentsKey: string): Promise<number> {
    try {
        const ttlMs = await redisClient.pttl(pendingCommentsKey);
        if (ttlMs === -1) return Number.POSITIVE_INFINITY;
        return Date.now() + Math.max(0, ttlMs);
    } catch {
        return Date.now();
    }
}

/**
 * When a delayed job will run, read from BullMQ's delayed set: its score is
 * the run timestamp shifted left by 12 bits. The job's own timestamp and delay
 * fields are not enough, because moving a job back to delayed (a PR-lock wait)
 * rewrites the delay relative to that moment but keeps the creation timestamp.
 * Undefined when the run time cannot be read.
 */
async function delayedJobRunsAt(queue: QueueReader, jobId: string | undefined): Promise<number | undefined> {
    if (!jobId || !queue.client || !queue.keys?.delayed) return undefined;
    const score = await (await queue.client).zscore(queue.keys.delayed, jobId);
    if (score === null || score === undefined) return undefined;
    const runsAt = Math.floor(Number(score) / 0x1000);
    return Number.isFinite(runsAt) ? runsAt : undefined;
}

/**
 * Whether a waiting or delayed PR comment job will claim the PR's pending
 * comment list while that list is still retained. Intake queues such a drain
 * job for a comment it stores behind a running job (#3686). A delayed job that
 * runs after the list expires (such as a usage-limit retry an hour or more
 * away) does not count: the comments it would claim are gone by then. A queue
 * that cannot be read, or a delayed job whose run time cannot be read, counts
 * as no pickup, so the caller queues one rather than risk leaving the list
 * unread.
 */
export async function hasQueuedPRCommentPickup(
    queue: QueueReader,
    ref: { repoOwner: string; repoName: string; pullRequestNumber: number },
    pendingList: { redisClient: RetentionReader; pendingCommentsKey: string },
): Promise<boolean> {
    const isPRCommentJob = (job: QueuedJob): boolean => {
        const data = job?.data as Partial<CommentJobData> | undefined;
        return job?.name === 'processPullRequestComment'
            && data?.pullRequestNumber === ref.pullRequestNumber && data?.repoOwner === ref.repoOwner && data?.repoName === ref.repoName;
    };
    try {
        if ((await queue.getWaiting()).some(isPRCommentJob)) return true;
        const pendingRetainedUntil = await pendingCommentsRetainedUntil(pendingList.redisClient, pendingList.pendingCommentsKey);
        for (const job of (await queue.getDelayed()).filter(isPRCommentJob)) {
            const runsAt = await delayedJobRunsAt(queue, job?.id);
            if (runsAt !== undefined && runsAt <= pendingRetainedUntil - PENDING_PICKUP_RETENTION_MARGIN_MS) return true;
        }
        return false;
    } catch {
        return false;
    }
}
