/**
 * Ultrafix Step Enqueue Marker
 *
 * Remembers the last step job an Ultrafix loop handed to the queue, so the
 * stranded-loop sweep can tell a loop whose next step was just enqueued (and
 * may still be delayed, waiting for agent or repository capacity, or running)
 * from one that truly has nothing driving it.
 *
 * A queue scan alone is not enough: a job moves between queue states while it
 * waits for capacity or a PR lock, and a scan taken at the wrong moment, or
 * one that misses a state, reports the loop as idle. Re-arming then supersedes
 * a perfectly healthy step under a new epoch.
 */

import type { Redis } from 'ioredis';
import { getIssueQueue } from '@propr/core';

const STEP_ENQUEUE_KEY_PREFIX = 'ultrafix:step-enqueued';

/** Long enough to outlive any grace period; the marker is only advisory. */
const STEP_ENQUEUE_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long after its enqueue delay a step whose job cannot be found is still
 * presumed alive. Covers normal agent and repository capacity waits and PR
 * lock contention while several loops run at once.
 */
export const ULTRAFIX_STEP_ENQUEUE_GRACE_MS = 10 * 60_000;

/** Every BullMQ state in which a job has not finished yet. */
export const LIVE_QUEUE_JOB_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused'] as const;

/** Outstanding-work reason when the loop's current step was enqueued recently and has not finished. */
export const STEP_RECENTLY_ENQUEUED_REASON = 'step_recently_enqueued';

export interface UltrafixStepEnqueueMarker {
    jobId: string;
    workEpoch: number;
    enqueuedAt: number;
    delayMs: number;
}

type PrRef = { owner: string; repo: string; pr: number };

export function getUltrafixStepEnqueueKey(owner: string, repo: string, pr: number): string {
    return `${STEP_ENQUEUE_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

/** Best effort: a lost marker only falls back to the queue scan. */
export async function recordUltrafixStepEnqueue(
    redis: Redis,
    prId: PrRef,
    marker: Omit<UltrafixStepEnqueueMarker, 'enqueuedAt'> & { enqueuedAt?: number },
): Promise<void> {
    const value: UltrafixStepEnqueueMarker = { ...marker, enqueuedAt: marker.enqueuedAt ?? Date.now() };
    try {
        await redis.set(getUltrafixStepEnqueueKey(prId.owner, prId.repo, prId.pr), JSON.stringify(value), 'EX', STEP_ENQUEUE_TTL_SECONDS);
    } catch {
        // Advisory only.
    }
}

export async function loadUltrafixStepEnqueue(redis: Redis, prId: PrRef): Promise<UltrafixStepEnqueueMarker | null> {
    const raw = await redis.get(getUltrafixStepEnqueueKey(prId.owner, prId.repo, prId.pr));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<UltrafixStepEnqueueMarker>;
        if (typeof parsed.jobId !== 'string' || typeof parsed.workEpoch !== 'number' || typeof parsed.enqueuedAt !== 'number') return null;
        return { jobId: parsed.jobId, workEpoch: parsed.workEpoch, enqueuedAt: parsed.enqueuedAt, delayMs: Number(parsed.delayMs ?? 0) };
    } catch {
        return null;
    }
}

type QueueLike = { getJob(id: string): Promise<{ getState(): Promise<string> } | undefined | null> };

/**
 * Whether the loop's current-epoch step is still owed by the queue: the last
 * enqueued job is in a live state, or it cannot be found (a scan between
 * state moves, or a removed record) while its enqueue is within the grace
 * period. A step that finished (`completed` or `failed`) is not held: its own
 * continuation, or its failure record, decides what happens next.
 *
 * Returns how long to wait before looking again, or null when nothing holds
 * the loop. Fails closed (holds) when the queue cannot be read within grace.
 */
export async function findLiveCurrentEpochStep(
    redis: Redis,
    prId: PrRef,
    currentEpoch: number,
    options: { now?: number; graceMs?: number; queue?: QueueLike } = {},
): Promise<{ retryDelayMs: number; jobState: string } | null> {
    const marker = await loadUltrafixStepEnqueue(redis, prId).catch(() => null);
    if (!marker || marker.workEpoch !== currentEpoch) return null;
    const now = options.now ?? Date.now();
    const graceMs = options.graceMs ?? ULTRAFIX_STEP_ENQUEUE_GRACE_MS;
    const graceEndsAt = marker.enqueuedAt + marker.delayMs + graceMs;
    let jobState: string;
    try {
        const queue = options.queue ?? await getIssueQueue() as unknown as QueueLike;
        const job = await queue.getJob(marker.jobId);
        jobState = job ? await job.getState() : 'unknown';
    } catch {
        jobState = 'unreadable';
    }
    if (jobState === 'completed' || jobState === 'failed') return null;
    if ((LIVE_QUEUE_JOB_STATES as readonly string[]).includes(jobState)) {
        // Live: its continuation owns the loop. Look again after the grace period at the latest.
        return { retryDelayMs: Math.max(graceEndsAt - now, graceMs), jobState };
    }
    if (now >= graceEndsAt) return null;
    return { retryDelayMs: graceEndsAt - now, jobState };
}
