/**
 * Ultrafix Resume Index
 *
 * A Redis set naming every PR that may have a deferred record or a retry
 * obligation, so the periodic resume sweep reads one set instead of walking
 * the whole keyspace twice a minute. Writers add the PR after writing its
 * record; the sweep prunes a PR only atomically with confirming that neither
 * record exists, so a record written concurrently keeps (or re-adds) its
 * entry. The index is best-effort: a record whose writer died before indexing
 * it is found by the sweep's periodic full scan.
 */

import type { Redis } from 'ioredis';
import { getUltrafixDeferredKey } from './ultrafixAutomaticWorkEpoch.js';

export const ULTRAFIX_RESUME_INDEX_KEY = 'ultrafix:resume-index';
export const ULTRAFIX_RESUME_SWEEP_LEASE_KEY = 'ultrafix:resume-sweep-lease';
export const REARM_RETRY_KEY_PREFIX = 'ultrafix:rearm-retry';

const PRUNE_RESUME_INDEX_SCRIPT = `
-- prune resume index entry
if redis.call('EXISTS', KEYS[2]) == 0 and redis.call('EXISTS', KEYS[3]) == 0 then
    return redis.call('SREM', KEYS[1], ARGV[1])
end
return 0
`;

export type UltrafixPrRef = { owner: string; repo: string; pr: number };

export function getUltrafixRearmRetryKey(owner: string, repo: string, pr: number): string {
    return `${REARM_RETRY_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

function toMember({ owner, repo, pr }: UltrafixPrRef): string {
    return JSON.stringify([owner, repo, pr]);
}

function fromMember(member: string): UltrafixPrRef | null {
    try {
        const [owner, repo, pr] = JSON.parse(member) as [unknown, unknown, unknown];
        return typeof owner === 'string' && typeof repo === 'string' && typeof pr === 'number' ? { owner, repo, pr } : null;
    } catch {
        return null;
    }
}

/** Add the PR to the index. Never fails the write it follows; the full scan covers a miss. */
export async function indexUltrafixResumeCandidate(redis: Redis, ref: UltrafixPrRef): Promise<void> {
    try {
        await redis.sadd(ULTRAFIX_RESUME_INDEX_KEY, toMember(ref));
    } catch {
        // Best-effort: the sweep's periodic full scan finds an unindexed record.
    }
}

/** The indexed PRs, or null when the index cannot be read (the caller then scans). */
export async function listIndexedUltrafixResumeCandidates(redis: Redis): Promise<UltrafixPrRef[] | null> {
    try {
        const members = await redis.smembers(ULTRAFIX_RESUME_INDEX_KEY);
        return members.map(fromMember).filter((ref): ref is UltrafixPrRef => ref !== null);
    } catch {
        return null;
    }
}

/** Drop the PR from the index only while it has neither a deferred record nor a retry obligation. */
export async function pruneUltrafixResumeCandidate(redis: Redis, ref: UltrafixPrRef): Promise<boolean> {
    try {
        const removed = await redis.eval(
            PRUNE_RESUME_INDEX_SCRIPT,
            3,
            ULTRAFIX_RESUME_INDEX_KEY,
            getUltrafixDeferredKey(ref.owner, ref.repo, ref.pr),
            getUltrafixRearmRetryKey(ref.owner, ref.repo, ref.pr),
            toMember(ref),
        );
        return Number(removed) === 1;
    } catch {
        return false;
    }
}

/**
 * Take the cluster-wide lease for one periodic sweep. Every process that
 * sweeps (API server, daemon) ticks on its own timer; the lease lets one of
 * them sweep per period instead of each re-evaluating every deferred loop
 * (each evaluation may call GitHub). A lease slightly shorter than the
 * period lets its holder take it again on its next tick, and another
 * process takes over within a period once the holder stops sweeping. A
 * lease that cannot be read fails open: an extra sweep only costs calls,
 * and the per-PR resume claim still serializes the two.
 */
export async function acquireUltrafixResumeSweepLease(redis: Redis, ttlMs: number): Promise<boolean> {
    try {
        return await redis.set(ULTRAFIX_RESUME_SWEEP_LEASE_KEY, String(process.pid), 'PX', ttlMs, 'NX') === 'OK';
    } catch {
        return true;
    }
}
