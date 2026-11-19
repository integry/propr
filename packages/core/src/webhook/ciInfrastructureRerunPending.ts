/**
 * Re-runs of runner-problem failures that wait for their workflow run to
 * finish (ciFailureInfrastructureRerun). Each is kept per workflow run in one
 * Redis hash, so a second deferred run never replaces the first one's
 * obligation; the pull request's notice (ciInfrastructureNotice) is only the
 * latest event's summary. An entry is released only after its re-run was
 * sent, refused, or given up on, and a per-run lock keeps the check-run hook,
 * ordinary failure recovery and the daemon sweep from sending it twice.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export const CI_INFRASTRUCTURE_PENDING_RERUNS_KEY = 'propr:ci-infra-rerun-pending';
const LOCK_PREFIX = 'propr:ci-infra-rerun-lock:';
const LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * A run still unfinished this long after its re-run was deferred is not
 * coming back on its own: the pending re-run is dropped and the pull request
 * says the job failed on a runner problem and has to be re-run by a person.
 */
export const CI_INFRASTRUCTURE_PENDING_RERUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const COMPARE_AND_DELETE_KEY = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
`;

const COMPARE_AND_DELETE_FIELD = `
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
    return redis.call('HDEL', KEYS[1], ARGV[1])
end
return 0
`;

/** The Lua scripts this module evaluates, exported so fakes can match them by identity. */
export const CI_INFRASTRUCTURE_PENDING_SCRIPTS = {
    compareAndDeleteKey: COMPARE_AND_DELETE_KEY,
    compareAndDeleteField: COMPARE_AND_DELETE_FIELD,
} as const;

export type PendingRerunRedis = Pick<Redis, 'set' | 'hset' | 'hget' | 'hgetall' | 'eval'>;

export interface PendingInfrastructureRerun {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    job: string;
    runId: number;
    runAttempt: number;
    deferredAt: number;
}

/** A pending entry together with the exact stored value it was read from. */
export interface PendingRerunSnapshot {
    entry: PendingInfrastructureRerun;
    raw: string;
}

export function pendingRerunField(repository: string, runId: number): string {
    return `${repository.toLowerCase()}:${runId}`;
}

function parseEntry(raw: string | null | undefined): PendingInfrastructureRerun | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<PendingInfrastructureRerun>;
        if (typeof value.owner !== 'string' || typeof value.repo !== 'string' || typeof value.headSha !== 'string') return null;
        if (typeof value.prNumber !== 'number' || typeof value.runId !== 'number' || typeof value.job !== 'string') return null;
        return {
            owner: value.owner, repo: value.repo, prNumber: value.prNumber, headSha: value.headSha, job: value.job, runId: value.runId,
            runAttempt: typeof value.runAttempt === 'number' ? value.runAttempt : 1,
            deferredAt: typeof value.deferredAt === 'number' ? value.deferredAt : 0,
        };
    } catch {
        return null;
    }
}

export async function recordPendingRerun(redis: PendingRerunRedis, entry: PendingInfrastructureRerun): Promise<void> {
    await redis.hset(CI_INFRASTRUCTURE_PENDING_RERUNS_KEY, pendingRerunField(`${entry.owner}/${entry.repo}`, entry.runId), JSON.stringify(entry));
}

export async function readPendingRerun(redis: PendingRerunRedis, repository: string, runId: number): Promise<PendingRerunSnapshot | null> {
    const raw = await redis.hget(CI_INFRASTRUCTURE_PENDING_RERUNS_KEY, pendingRerunField(repository, runId));
    const entry = parseEntry(raw);
    return entry && raw ? { entry, raw } : null;
}

/** Every pending re-run; unreadable entries are left for {@link releasePendingRerun} by field. */
export async function listPendingReruns(redis: PendingRerunRedis): Promise<Array<PendingRerunSnapshot & { field: string }>> {
    const all = await redis.hgetall(CI_INFRASTRUCTURE_PENDING_RERUNS_KEY) ?? {};
    return Object.entries(all).flatMap(([field, raw]) => {
        const entry = parseEntry(raw);
        return entry ? [{ field, entry, raw }] : [];
    });
}

/** Releases the obligation only if it is still the exact entry that was acted on. */
export async function releasePendingRerun(redis: PendingRerunRedis, snapshot: PendingRerunSnapshot): Promise<void> {
    const field = pendingRerunField(`${snapshot.entry.owner}/${snapshot.entry.repo}`, snapshot.entry.runId);
    await redis.eval(COMPARE_AND_DELETE_FIELD, 1, CI_INFRASTRUCTURE_PENDING_RERUNS_KEY, field, snapshot.raw);
}

/**
 * Runs `work` while holding the run's lock, or returns null without running
 * it when another caller holds it. The lock is released by token only.
 */
export async function withPendingRerunLock<T>(
    redis: PendingRerunRedis, entry: Pick<PendingInfrastructureRerun, 'owner' | 'repo' | 'runId'>, work: () => Promise<T>,
): Promise<T | null> {
    const key = `${LOCK_PREFIX}${pendingRerunField(`${entry.owner}/${entry.repo}`, entry.runId)}`;
    const token = randomUUID();
    if (await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX') !== 'OK') return null;
    try {
        return await work();
    } finally {
        await redis.eval(COMPARE_AND_DELETE_KEY, 1, key, token).catch(() => undefined);
    }
}
