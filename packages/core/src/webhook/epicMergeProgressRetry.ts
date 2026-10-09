import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import logger from '../utils/logger.js';

/**
 * Epic merge progress updates that could not be completed (plan unreadable,
 * GitHub request failed, or another update held the epic). The last child
 * merge has no successor to refresh the tracking comment, so the obligation is
 * kept here and retried by the daemon sweep until an update succeeds.
 */
export const EPIC_PROGRESS_RETRY_KEY = 'epic:merge-progress-retry';
const EPIC_PROGRESS_LOCK_PREFIX = 'epic:merge-progress-lock:';
const EPIC_PROGRESS_LOCK_TTL_MS = 2 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 60 * 1000;
const RETRY_MAX_DELAY_MS = 30 * 60 * 1000;
/** A failure lasting this long is no longer transient; the obligation is dropped. */
export const EPIC_PROGRESS_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const COMPARE_AND_DELETE_FIELD = `
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
    return redis.call('HDEL', KEYS[1], ARGV[1])
end
return 0
`;

const COMPARE_AND_DELETE_KEY = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
`;

export type EpicProgressRetryRedis = Pick<Redis, 'hget' | 'hset' | 'hgetall' | 'set' | 'eval'>;

export interface EpicProgressTarget {
    owner: string;
    repo: string;
    epicBranch: string;
    epicPrNumber: number;
    mergedChildPrNumber: number;
}

export interface EpicProgressRetry extends EpicProgressTarget {
    attempts: number;
    firstFailedAt: number;
    nextAttemptAt: number;
}

export type EpicProgressUpdateOutcome = 'updated' | 'retry_scheduled';

export interface EpicProgressUpdateOptions {
    redis: EpicProgressRetryRedis;
    /** Performs the update; returns false when it cannot be completed yet (e.g. plan unavailable). */
    update: () => Promise<boolean>;
    now?: () => number;
    log?: ReturnType<typeof logger.withCorrelation>;
}

export function epicProgressRetryField(owner: string, repo: string, epicBranch: string): string {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}#${epicBranch}`;
}

function parseRetry(value: string | null | undefined): EpicProgressRetry | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Partial<EpicProgressRetry>;
        if (typeof parsed.owner !== 'string' || typeof parsed.repo !== 'string' || typeof parsed.epicBranch !== 'string'
            || typeof parsed.epicPrNumber !== 'number' || typeof parsed.mergedChildPrNumber !== 'number') return null;
        return {
            owner: parsed.owner, repo: parsed.repo, epicBranch: parsed.epicBranch,
            epicPrNumber: parsed.epicPrNumber, mergedChildPrNumber: parsed.mergedChildPrNumber,
            attempts: Number(parsed.attempts) || 0,
            firstFailedAt: Number(parsed.firstFailedAt) || 0,
            nextAttemptAt: Number(parsed.nextAttemptAt) || 0,
        };
    } catch {
        return null;
    }
}

async function recordRetry(redis: EpicProgressRetryRedis, target: EpicProgressTarget, now: number): Promise<void> {
    const field = epicProgressRetryField(target.owner, target.repo, target.epicBranch);
    const previous = parseRetry(await redis.hget(EPIC_PROGRESS_RETRY_KEY, field));
    const attempts = (previous?.attempts ?? 0) + 1;
    const retry: EpicProgressRetry = {
        ...target,
        attempts,
        firstFailedAt: previous?.firstFailedAt || now,
        nextAttemptAt: now + Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempts - 1)),
    };
    await redis.hset(EPIC_PROGRESS_RETRY_KEY, field, JSON.stringify(retry));
}

/**
 * Runs one epic progress update under a per-epic lease, so a retry and a
 * webhook never post the completion notice twice. A pending obligation is
 * released only if it is still the one observed before the update started;
 * one recorded meanwhile describes a later failure and is kept. Any failure,
 * including a busy lease, leaves an obligation for the retry sweep.
 */
export async function runEpicProgressUpdate(
    target: EpicProgressTarget,
    { redis, update, now = Date.now, log = logger.withCorrelation('epic-merge-progress') }: EpicProgressUpdateOptions,
): Promise<EpicProgressUpdateOutcome> {
    const field = epicProgressRetryField(target.owner, target.repo, target.epicBranch);
    const lockKey = `${EPIC_PROGRESS_LOCK_PREFIX}${field}`;
    const token = randomUUID();
    let pending: string | null = null;
    let locked = false;
    try {
        pending = await redis.hget(EPIC_PROGRESS_RETRY_KEY, field);
        if (await redis.set(lockKey, token, 'PX', EPIC_PROGRESS_LOCK_TTL_MS, 'NX') !== 'OK') {
            await recordRetry(redis, target, now());
            log.info({ ...target }, 'Epic progress update already running, scheduled a retry');
            return 'retry_scheduled';
        }
        locked = true;
    } catch (error) {
        // Without Redis neither the lease nor a retry is available; update unguarded.
        log.warn({ ...target, error: (error as Error).message }, 'Epic progress retry state unavailable');
    }

    try {
        let completed = false;
        try {
            completed = await update();
        } catch (error) {
            log.warn({ ...target, error: (error as Error).message }, 'Failed to update Epic PR merge progress');
        }
        try {
            if (!completed) {
                await recordRetry(redis, target, now());
                return 'retry_scheduled';
            }
            if (pending) await redis.eval(COMPARE_AND_DELETE_FIELD, 1, EPIC_PROGRESS_RETRY_KEY, field, pending);
        } catch (error) {
            log.error({ ...target, error: (error as Error).message }, 'Failed to persist Epic PR merge progress retry state');
        }
        return completed ? 'updated' : 'retry_scheduled';
    } finally {
        if (locked) {
            try {
                await redis.eval(COMPARE_AND_DELETE_KEY, 1, lockKey, token);
            } catch (error) {
                log.warn({ ...target, error: (error as Error).message }, 'Failed to release Epic PR merge progress lease');
            }
        }
    }
}

export interface EpicProgressRetrySweepOptions {
    redis: EpicProgressRetryRedis;
    /** Re-runs the update for one recorded epic. */
    retry: (target: EpicProgressTarget) => Promise<EpicProgressUpdateOutcome>;
    now?: () => number;
    log?: ReturnType<typeof logger.withCorrelation>;
}

/** Retries every due epic progress obligation; returns how many were updated. */
export async function sweepEpicProgressRetries(
    { redis, retry, now = Date.now, log = logger.withCorrelation('epic-merge-progress') }: EpicProgressRetrySweepOptions,
): Promise<number> {
    const entries = await redis.hgetall(EPIC_PROGRESS_RETRY_KEY);
    let updated = 0;
    for (const [field, value] of Object.entries(entries)) {
        const pending = parseRetry(value);
        const current = now();
        if (!pending || current - pending.firstFailedAt > EPIC_PROGRESS_RETRY_MAX_AGE_MS) {
            log.error({ field, pending }, 'Dropping Epic PR merge progress retry that could not be completed');
            await redis.eval(COMPARE_AND_DELETE_FIELD, 1, EPIC_PROGRESS_RETRY_KEY, field, value);
            continue;
        }
        if (pending.nextAttemptAt > current) continue;
        const { owner, repo, epicBranch, epicPrNumber, mergedChildPrNumber } = pending;
        if (await retry({ owner, repo, epicBranch, epicPrNumber, mergedChildPrNumber }) === 'updated') updated++;
    }
    return updated;
}
