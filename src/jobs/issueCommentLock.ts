/**
 * A short lock around a read-then-write of one issue's comments or retry
 * queue (a failure comment and its count, a start or cancel notice, the
 * issue run's pending usage-limit retry), so concurrent tasks on any worker
 * act one at a time on what the previous one wrote.
 *
 * Callers on one process chain locally; across workers a Redis lease (set
 * at worker start) is held, renewed while the work runs, and confirmed with
 * `lease.assertHeld()` right before each write. A live holder that keeps the
 * lock for the whole wait makes the waiter throw rather than act unlocked.
 */
import { randomUUID } from 'node:crypto';

export interface IssueCommentLockRedis {
    set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<unknown>;
    eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface IssueCommentLease {
    /** Throws IssueCommentLockLostError when another holder took the lock. */
    assertHeld(): Promise<void>;
}

export class IssueCommentLockTimeoutError extends Error {
    constructor(key: string) {
        super(`Timed out waiting for the issue comment lock ${key}`);
        this.name = 'IssueCommentLockTimeoutError';
    }
}

export class IssueCommentLockLostError extends Error {
    constructor(key: string) {
        super(`Lost the issue comment lock ${key} before writing`);
        this.name = 'IssueCommentLockLostError';
    }
}

/** The wait exceeds the TTL, so only a live, renewing holder can make a waiter time out. */
const DEFAULT_TIMING = { ttlMs: 30_000, renewMs: 10_000, waitMs: 45_000, pollMs: 100 };
let timing = { ...DEFAULT_TIMING };
let sharedRedis: IssueCommentLockRedis | null = null;

/** Worker start: the Redis connection that makes the lock hold across workers. */
export function setIssueCommentLockRedis(redis: IssueCommentLockRedis | null): void {
    sharedRedis = redis;
}

/** Test hook: shortens the lease, renewal, wait and poll intervals; null restores them. */
export function setIssueCommentLockTimingForTests(overrides: Partial<typeof DEFAULT_TIMING> | null): void {
    timing = { ...DEFAULT_TIMING, ...(overrides ?? {}) };
}

const RENEW_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const localChains = new Map<string, Promise<unknown>>();
const unguarded: IssueCommentLease = { assertHeld: async () => undefined };

/** Lock key of one issue (or pull request) and purpose, case-insensitive in the repository. */
export function issueCommentLockKey(target: { owner: string; repo: string; issueNumber: number }, purpose: string): string {
    return `${target.owner}/${target.repo}`.toLowerCase() + `#${target.issueNumber}:${purpose}`;
}

async function acquire(redis: IssueCommentLockRedis, lockKey: string, token: string, key: string): Promise<number> {
    const deadline = Date.now() + timing.waitMs;
    for (;;) {
        const acquiredAt = Date.now();
        if (await redis.set(lockKey, token, 'PX', timing.ttlMs, 'NX') === 'OK') return acquiredAt;
        if (Date.now() >= deadline) throw new IssueCommentLockTimeoutError(key);
        await new Promise(resolve => setTimeout(resolve, timing.pollMs));
    }
}

function holdLease(redis: IssueCommentLockRedis, held: { lockKey: string; token: string; key: string; acquiredAt: number }) {
    const { lockKey, token, key, acquiredAt } = held;
    let lost = false;
    let expiresAt = acquiredAt + timing.ttlMs;
    const renew = async (): Promise<boolean> => {
        if (lost) return false;
        const startedAt = Date.now();
        try {
            if (Number(await redis.eval(RENEW_SCRIPT, 1, lockKey, token, String(timing.ttlMs))) === 1) expiresAt = startedAt + timing.ttlMs;
            else lost = true;
        } catch {
            // A failed renewal proves nothing yet; the lease is lost once it lapses.
        }
        if (Date.now() >= expiresAt) lost = true;
        return !lost;
    };
    const timer = setInterval(() => { void renew(); }, timing.renewMs);
    timer.unref?.();
    const lease: IssueCommentLease = {
        assertHeld: async () => {
            if (!await renew()) throw new IssueCommentLockLostError(key);
        },
    };
    return { lease, stop: () => clearInterval(timer) };
}

export async function withIssueCommentLock<T>(
    key: string,
    work: (lease: IssueCommentLease) => Promise<T>,
    options: { redis?: IssueCommentLockRedis | null } = {},
): Promise<T> {
    const redis = options.redis === undefined ? sharedRedis : options.redis;
    const previous = localChains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
        if (!redis) return await work(unguarded);
        const lockKey = `propr:issue-comment-lock:${key}`;
        const token = randomUUID();
        const acquiredAt = await acquire(redis, lockKey, token, key);
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
