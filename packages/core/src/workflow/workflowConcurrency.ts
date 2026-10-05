import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getExecutionOwnershipContext, runWithExecutionAbortSignal } from '../claude/docker/dockerExecutionOwnership.js';

// One shared admission decision across workers, branches, issues and PR follow-ups.
// Every active run participates, including repositories without a workflow file.
// A refused caller may join the repository's waiting list (KEYS[3], scored by its
// first refusal) so a released slot wakes the longest-waiting jobs first instead
// of leaving them to compete on backoff. KEYS[4] holds each waiter's lapse time:
// longer than the 5-minute maximum deferral, refreshed on every refusal.
export const ACQUIRE_WORKFLOW_SLOT = `
local now = tonumber(redis.call('TIME')[1])
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
for _, member in ipairs(expired) do redis.call('HDEL', KEYS[2], member) end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local lapsed = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now)
for _, member in ipairs(lapsed) do redis.call('ZREM', KEYS[3], member) end
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
local limit = tonumber(ARGV[2])
for _, value in ipairs(redis.call('HVALS', KEYS[2])) do
    local other = tonumber(value)
    if other > 0 and (limit == 0 or other < limit) then limit = other end
end
if limit > 0 and redis.call('ZCARD', KEYS[1]) >= limit then
    if ARGV[3] ~= '' then
        redis.call('ZADD', KEYS[3], 'NX', now, ARGV[3])
        redis.call('ZADD', KEYS[4], now + 360, ARGV[3])
        redis.call('EXPIRE', KEYS[3], 360)
        redis.call('EXPIRE', KEYS[4], 360)
    end
    return 0
end
if ARGV[3] ~= '' then
    redis.call('ZREM', KEYS[3], ARGV[3])
    redis.call('ZREM', KEYS[4], ARGV[3])
end
redis.call('ZADD', KEYS[1], now + 120, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], 180)
redis.call('EXPIRE', KEYS[2], 180)
return 1
`;

// Releases a slot. Returns how many waiters may now fit (by the smallest cap,
// including the released run's own, or a few when no run was capped), followed by
// the longest-waiting candidates, with spares in case some can no longer be woken.
export const RELEASE_WORKFLOW_SLOT = `
local now = tonumber(redis.call('TIME')[1])
local limit = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or 0)
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
local lapsed = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now)
for _, member in ipairs(lapsed) do redis.call('ZREM', KEYS[3], member) end
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
for _, value in ipairs(redis.call('HVALS', KEYS[2])) do
    local other = tonumber(value)
    if other > 0 and (limit == 0 or other < limit) then limit = other end
end
local free = 10
if limit > 0 then free = math.min(free, limit - redis.call('ZCARD', KEYS[1])) end
if free <= 0 then return {} end
local candidates = redis.call('ZRANGE', KEYS[3], 0, free + 4)
if #candidates == 0 then return {} end
table.insert(candidates, 1, free)
return candidates
`;

/** Redis keys of one repository's capacity; the hash tag keeps them in one cluster slot. */
export function repositoryWorkflowSlotKeys(repository: string): [string, string, string, string] {
    const key = `propr:workflow:slots:{${repository.toLowerCase()}}`;
    return [key, `${key}:limits`, `${key}:waiters`, `${key}:waiting`];
}

/** Drops a waiter that can no longer be woken (for example, its job was removed). */
export async function forgetRepositoryWorkflowWaiter(redis: Redis, repository: string, waiter: string): Promise<void> {
    const [, , waiters, waiting] = repositoryWorkflowSlotKeys(repository);
    await redis.eval(`redis.call('ZREM', KEYS[1], ARGV[1]); redis.call('ZREM', KEYS[2], ARGV[1])`, 2, waiters, waiting, waiter);
}

// Redis TIME above is rounded down to seconds. Use a monotonic, request-start
// deadline so neither clock skew nor delayed Redis replies extend local ownership.
const CONFIRMED_LEASE_MS = 119_000;
const STOP_MARGIN_MS = 30_000;

export const RENEW_WORKFLOW_SLOT = `
local now = tonumber(redis.call('TIME')[1])
local deadline = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1]))
if not deadline or deadline <= now then return 0 end
redis.call('ZADD', KEYS[1], now + 120, ARGV[1])
redis.call('EXPIRE', KEYS[1], 180)
redis.call('EXPIRE', KEYS[2], 180)
return 1
`;

/** Admission refusal is retryable scheduling, never an in-processor wait. */
export class RepositoryWorkflowCapacityError extends Error {
    constructor() { super('Repository workflow capacity is currently full'); }
}

/** Ownership of an admitted slot was lost (renewal failed or stalled); never a user cancellation. */
export class RepositoryWorkflowLeaseLostError extends Error {
    constructor() {
        super('Repository workflow capacity lease lost');
        this.name = 'RepositoryWorkflowLeaseLostError';
    }
}

const activeSlot = new AsyncLocalStorage<{ release(): Promise<void> }>();

/**
 * Ends the current slot once its agent container has exited. Capacity bounds
 * container execution; later publication and terminal-state writes must neither
 * hold it nor fail because its lease can no longer be renewed. Rejects, after
 * releasing, when ownership was already lost while the container ran.
 * Idempotent, and a no-op outside a slot.
 */
export async function releaseRepositoryWorkflowSlot(): Promise<void> {
    await activeSlot.getStore()?.release();
}

export async function withRepositoryWorkflowSlot<T>(options: {
    redis: Redis;
    repository: string;
    limit?: number;
    checkCancelled: () => Promise<void>;
    onLeaseError: (error: unknown) => void;
    /** Stable identity of the caller across deferrals; joins the waiting list when refused. */
    waiter?: string;
    /** Receives the longest-waiting candidates, oldest first, and how many of them may fit once this slot is released. */
    onReleased?: (waiters: string[], free: number) => void;
}, execute: () => Promise<T>): Promise<T> {
    const keys = repositoryWorkflowSlotKeys(options.repository);
    const [key, limitsKey] = keys;
    const token = randomUUID();
    const parent = getExecutionOwnershipContext();
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([parent.signal, controller.signal]) : controller.signal;
    let confirmedDeadline: number;
    signal.throwIfAborted();
    await options.checkCancelled();
    signal.throwIfAborted();
    const requestedAt = performance.now();
    const acquired = await options.redis.eval(ACQUIRE_WORKFLOW_SLOT, 4, ...keys, token, options.limit ?? 0, options.waiter ?? '');
    if (acquired !== 1) {
        signal.throwIfAborted();
        await options.checkCancelled();
        signal.throwIfAborted();
        throw new RepositoryWorkflowCapacityError();
    }
    confirmedDeadline = requestedAt + CONFIRMED_LEASE_MS;
    const loseOwnership = () => controller.abort(new RepositoryWorkflowLeaseLostError());
    const checkOwnership = () => {
        if (performance.now() >= confirmedDeadline - STOP_MARGIN_MS) loseOwnership();
        signal.throwIfAborted();
    };
    let watchdog: ReturnType<typeof setTimeout>;
    const armWatchdog = () => {
        clearTimeout(watchdog);
        // Independent of Redis: a hung renewal must still stop the container,
        // leaving time for teardown before another worker can reclaim its slot.
        watchdog = setTimeout(loseOwnership, Math.max(0, confirmedDeadline - STOP_MARGIN_MS - performance.now()));
        watchdog.unref();
    };
    armWatchdog();
    let finished = false;
    let renewing = false;
    const heartbeat = setInterval(() => {
        if (finished || signal.aborted || renewing) return;
        renewing = true;
        void (async () => {
            checkOwnership();
            const requestedAt = performance.now();
            const renewed = await options.redis.eval(RENEW_WORKFLOW_SLOT, 2, key, limitsKey, token);
            if (finished || signal.aborted) return;
            // A late reply cannot revive ownership after our stop deadline.
            checkOwnership();
            if (renewed !== 1) { loseOwnership(); return; }
            confirmedDeadline = requestedAt + CONFIRMED_LEASE_MS;
            armWatchdog();
        })().catch(options.onLeaseError).finally(() => { renewing = false; });
    }, 30_000);
    heartbeat.unref();
    let released: Promise<void> | undefined;
    // In-flight renewals cannot recreate a removed member or rearm this guard.
    const release = () => released ??= (async () => {
        finished = true;
        clearInterval(heartbeat);
        clearTimeout(watchdog!);
        try {
            const released = await options.redis.eval(RELEASE_WORKFLOW_SLOT, 4, ...keys, token);
            if (Array.isArray(released) && released.length > 1) options.onReleased?.(released.slice(1).map(String), Number(released[0]));
        } catch (error) { options.onLeaseError(error); }
    })();
    const releaseAfterExecution = async () => {
        // Ownership must still have covered the execution that just ended.
        if (!released && performance.now() >= confirmedDeadline - STOP_MARGIN_MS) loseOwnership();
        await release();
        signal.throwIfAborted();
    };
    try {
        checkOwnership();
        await options.checkCancelled();
        checkOwnership();
        const result = await activeSlot.run({ release: releaseAfterExecution }, () => runWithExecutionAbortSignal(signal, execute, parent?.attemptGeneration));
        // Once released early, a later lease deadline no longer concerns the work that followed.
        if (released) signal.throwIfAborted();
        else checkOwnership();
        return result;
    } finally {
        // Await execution (including its abort teardown) before releasing capacity.
        await release();
    }
}
