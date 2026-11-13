/**
 * The `auto_merge.require_up_to_date` retry set. A candidate the feature defers
 * (waiting for another PR's update turn or merge ownership, for its own branch
 * update, its rate limit, or a base comparison) may get no further check event,
 * and need not be a plan PR the auto-merge sweep already selects. Each deferral
 * is recorded here so the sweep re-evaluates it through the guarded merge path.
 */
import { getUltrafixStateRedis } from './checkRunHelpers.js';
import type { UpToDateRedis } from './autoMergeUpToDate.js';

/**
 * A deferred candidate that has not been deferred again for this long is
 * dropped from the retry set (its re-evaluations keep failing before the gate).
 * Every re-evaluation that defers it again refreshes it.
 */
export const DEFERRED_RETRY_MAX_AGE_MS = 24 * 60 * 60_000;
const DEFERRED_KEY = 'auto-merge:up-to-date:deferred';

/** Remove a deferred candidate unless it was deferred again after the given time. */
const SETTLE_DEFERRED_SCRIPT = `
local score = redis.call('zscore', KEYS[1], ARGV[1])
if score and tonumber(score) <= tonumber(ARGV[2]) then
    return redis.call('zrem', KEYS[1], ARGV[1])
end
return 0
`;

interface RetryDependencies {
    redis?: UpToDateRedis;
    now?: () => number;
}

const redisOf = (deps: RetryDependencies): UpToDateRedis => deps.redis ?? (getUltrafixStateRedis() as unknown as UpToDateRedis);
const deferredMember = (owner: string, repo: string, prNumber: number) => `${owner}/${repo}#${prNumber}`;

/** Record that this candidate waits on `require_up_to_date`, so the sweep re-evaluates it. */
export async function deferForRetry(redis: UpToDateRedis, target: { owner: string; repo: string; prNumber: number }, now: number): Promise<void> {
    await redis.zadd(DEFERRED_KEY, now, deferredMember(target.owner, target.repo, target.prNumber));
}

export interface DeferredUpToDateCandidate {
    repository: string;
    prNumber: number;
    /** When the candidate was last deferred; pass it back to {@link settleDeferredUpToDateCandidate}. */
    deferredAt: number;
}

/**
 * Candidates `require_up_to_date` deferred, including PRs without a plan, for
 * the auto-merge sweep to re-evaluate. Entries not deferred again for a day are dropped.
 */
export async function loadDeferredUpToDateCandidates(deps: RetryDependencies = {}): Promise<DeferredUpToDateCandidate[]> {
    const redis = redisOf(deps);
    const now = (deps.now ?? Date.now)();
    const flat = await redis.zrange(DEFERRED_KEY, 0, -1, 'WITHSCORES');
    const candidates: DeferredUpToDateCandidate[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
        const member = flat[i];
        const deferredAt = Number(flat[i + 1]);
        const match = /^([^/#]+\/[^/#]+)#(\d+)$/.exec(member);
        if (!match || !Number.isFinite(deferredAt) || now - deferredAt > DEFERRED_RETRY_MAX_AGE_MS) {
            // Token-checked like a settle: an entry deferred again meanwhile stays.
            await redis.eval(SETTLE_DEFERRED_SCRIPT, 1, DEFERRED_KEY, member, Number.isFinite(deferredAt) ? deferredAt : Number.MAX_SAFE_INTEGER);
            continue;
        }
        candidates.push({ repository: match[1], prNumber: Number(match[2]), deferredAt });
    }
    return candidates;
}

/**
 * Called after a deferred candidate was re-evaluated: it leaves the retry set
 * unless that (or a concurrent) evaluation deferred it again. A merged or closed
 * PR is settled this way once the sweep finds it no longer open.
 */
export async function settleDeferredUpToDateCandidate(candidate: DeferredUpToDateCandidate, deps: RetryDependencies = {}): Promise<void> {
    const [owner, repo] = candidate.repository.split('/');
    await redisOf(deps).eval(SETTLE_DEFERRED_SCRIPT, 1, DEFERRED_KEY, deferredMember(owner, repo, candidate.prNumber), candidate.deferredAt);
}
