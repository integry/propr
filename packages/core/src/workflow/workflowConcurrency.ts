import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getExecutionOwnershipContext, runWithExecutionAbortSignal } from '../claude/docker/dockerExecutionOwnership.js';

// One shared admission decision across workers, branches, issues and PR follow-ups.
// Every active run participates, including repositories without a workflow file.
export const ACQUIRE_WORKFLOW_SLOT = `
local now = tonumber(redis.call('TIME')[1])
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
for _, member in ipairs(expired) do redis.call('HDEL', KEYS[2], member) end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local limit = tonumber(ARGV[2])
for _, value in ipairs(redis.call('HVALS', KEYS[2])) do
    local other = tonumber(value)
    if other > 0 and (limit == 0 or other < limit) then limit = other end
end
if limit > 0 and redis.call('ZCARD', KEYS[1]) >= limit then return 0 end
redis.call('ZADD', KEYS[1], now + 120, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], 180)
redis.call('EXPIRE', KEYS[2], 180)
return 1
`;

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

export async function withRepositoryWorkflowSlot<T>(options: {
    redis: Redis;
    repository: string;
    limit?: number;
    checkCancelled: () => Promise<void>;
    onLeaseError: (error: unknown) => void;
}, execute: () => Promise<T>): Promise<T> {
    const key = `propr:workflow:slots:{${options.repository.toLowerCase()}}`;
    const limitsKey = `${key}:limits`;
    const token = randomUUID();
    const parent = getExecutionOwnershipContext();
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([parent.signal, controller.signal]) : controller.signal;
    let confirmedDeadline: number;
    while (true) {
        signal.throwIfAborted();
        await options.checkCancelled();
        signal.throwIfAborted();
        const requestedAt = performance.now();
        if (await options.redis.eval(ACQUIRE_WORKFLOW_SLOT, 2, key, limitsKey, token, options.limit ?? 0) === 1) {
            confirmedDeadline = requestedAt + CONFIRMED_LEASE_MS;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const loseOwnership = () => controller.abort(new Error('Repository workflow capacity lease lost'));
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
    try {
        checkOwnership();
        await options.checkCancelled();
        checkOwnership();
        const result = await runWithExecutionAbortSignal(signal, execute, parent?.attemptGeneration);
        checkOwnership();
        return result;
    } finally {
        // Await execution (including its abort teardown) before releasing capacity.
        // In-flight renewals cannot recreate a removed member or rearm this guard.
        finished = true;
        clearInterval(heartbeat);
        clearTimeout(watchdog!);
        await options.redis.eval(`redis.call('ZREM', KEYS[1], ARGV[1]); redis.call('HDEL', KEYS[2], ARGV[1])`, 2, key, limitsKey, token)
            .catch(options.onLeaseError);
    }
}
