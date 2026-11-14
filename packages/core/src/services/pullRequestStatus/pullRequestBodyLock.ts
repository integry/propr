import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/** The body lock needs set/eval. */
export type PullRequestBodyLockRedis = Pick<Redis, 'set' | 'eval'>;

/** The holder of a pull request's body lock, handed to the protected work. */
export interface PullRequestBodyLease {
    /**
     * Confirms this holder still owns the lock, and extends it, immediately
     * before a body write. Throws PullRequestBodyLockLostError when the lock
     * expired or another writer took it, so a stale read is never written.
     */
    assertHeld(): Promise<void>;
}

export class PullRequestBodyLockLostError extends Error {
    constructor(key: string) {
        super(`Lost the pull request body lock of ${key} before writing; the body was not changed`);
        this.name = 'PullRequestBodyLockLostError';
    }
}

const DEFAULT_TIMING = { ttlMs: 30_000, renewMs: 10_000, waitMs: 20_000, pollMs: 150 };
let timing = { ...DEFAULT_TIMING };

/** Test hook: shortens the lock lease, renewal, wait and poll intervals; null restores them. */
export function setPullRequestBodyLockTimingForTests(overrides: Partial<typeof DEFAULT_TIMING> | null): void {
    timing = { ...DEFAULT_TIMING, ...(overrides ?? {}) };
}

const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const RENEW_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
const localChains = new Map<string, Promise<unknown>>();
const unguarded: PullRequestBodyLease = { assertHeld: async () => undefined };

export function pullRequestBodyKey(repository: string, prNumber: number): string {
    return `${repository.toLowerCase()}#${prNumber}`;
}

/**
 * A held Redis lease: renewed in the background for as long as the work
 * runs, and lost for good once a renewal finds another owner or the lease
 * lapsed before a renewal succeeded.
 */
function holdLease(redis: PullRequestBodyLockRedis, held: { lockKey: string; token: string; key: string; acquiredAt: number }) {
    const { lockKey, token, key, acquiredAt } = held;
    let lost = false;
    let expiresAt = acquiredAt + timing.ttlMs;
    const renew = async (): Promise<boolean> => {
        if (lost) return false;
        const startedAt = Date.now();
        try {
            const renewed = await redis.eval(RENEW_SCRIPT, 1, lockKey, token, String(timing.ttlMs));
            if (Number(renewed) === 1) expiresAt = startedAt + timing.ttlMs;
            else lost = true;
        } catch {
            // A failed renewal proves nothing yet; the lease is lost once it lapses.
        }
        if (Date.now() >= expiresAt) lost = true;
        return !lost;
    };
    const timer = setInterval(() => { void renew(); }, timing.renewMs);
    timer.unref?.();
    const lease: PullRequestBodyLease = {
        assertHeld: async () => {
            if (!await renew()) throw new PullRequestBodyLockLostError(key);
        },
    };
    return { lease, stop: () => clearInterval(timer) };
}

/**
 * Runs `work` while holding the pull request's body lock, so two transitions
 * (or a transition and another body writer) cannot interleave their
 * read-modify-write of the body. Serialized in-process and across processes.
 *
 * The Redis lease is renewed while the work runs, and the work must call
 * `lease.assertHeld()` right before it writes the body. The write itself is a
 * GitHub request, which Redis cannot fence: only a lease lost during that one
 * request (renewals failing for a whole TTL) remains unguarded.
 */
export async function withPullRequestBodyLock<T>(
    repository: string, prNumber: number, redis: PullRequestBodyLockRedis | null, work: (lease: PullRequestBodyLease) => Promise<T>,
): Promise<T> {
    const key = pullRequestBodyKey(repository, prNumber);
    const previous = localChains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
        if (!redis) return await work(unguarded);
        const lockKey = `propr:pr-status:lock:${key}`;
        const token = randomUUID();
        const deadline = Date.now() + timing.waitMs;
        let acquiredAt = Date.now();
        while (await redis.set(lockKey, token, 'PX', timing.ttlMs, 'NX') !== 'OK') {
            if (Date.now() > deadline) throw new Error(`Timed out waiting for the pull request body lock of ${key}`);
            await new Promise(resolve => setTimeout(resolve, timing.pollMs));
            acquiredAt = Date.now();
        }
        const held = holdLease(redis, { lockKey, token, key, acquiredAt });
        try {
            return await work(held.lease);
        } finally {
            held.stop();
            await redis.eval(RELEASE_SCRIPT, 1, lockKey, token).catch(() => undefined);
        }
    });
    localChains.set(key, run);
    try {
        return await run;
    } finally {
        if (localChains.get(key) === run) localChains.delete(key);
    }
}
