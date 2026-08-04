import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { readBoundedIntegerEnv } from '../config/numericEnv.js';

export const PR_PROCESSING_LOCK_RENEW_INTERVAL_MS = 30 * 1000;
export const DEFAULT_PR_PROCESSING_LOCK_TTL_SECONDS = 2 * 60;
export const MINIMUM_PR_PROCESSING_LOCK_TTL_SECONDS = Math.ceil(
    (PR_PROCESSING_LOCK_RENEW_INTERVAL_MS * 3) / 1000,
);
export const MAXIMUM_PR_PROCESSING_LOCK_TTL_SECONDS = 24 * 60 * 60;

function readLockTtlSeconds(): number {
    return readBoundedIntegerEnv('PR_PROCESSING_LOCK_TTL_SECONDS', {
        fallback: DEFAULT_PR_PROCESSING_LOCK_TTL_SECONDS,
        min: MINIMUM_PR_PROCESSING_LOCK_TTL_SECONDS,
        max: MAXIMUM_PR_PROCESSING_LOCK_TTL_SECONDS,
    });
}

/**
 * A short renewable lease. If a worker disappears, another attempt can make
 * progress within minutes instead of waiting for the previous one-hour TTL.
 */
export const PR_PROCESSING_LOCK_TTL_SECONDS = readLockTtlSeconds();

export type PRProcessingLockRedisClient = Pick<Redis, 'set' | 'eval'>;

interface LockHeartbeatOptions {
    redisClient: PRProcessingLockRedisClient;
    lockKey: string;
    lockToken: string;
    ttlSeconds?: number;
    intervalMs?: number;
    onLockLost?: () => void;
    onError?: (error: unknown) => void;
}

const RENEW_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('expire', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
`;

export function createPRProcessingLockToken(correlationId: string): string {
    return `${correlationId}:${randomUUID()}`;
}

export async function acquirePRProcessingLock(
    redisClient: PRProcessingLockRedisClient,
    lockKey: string,
    lockToken: string,
    ttlSeconds = PR_PROCESSING_LOCK_TTL_SECONDS,
): Promise<boolean> {
    const result = await redisClient.set(lockKey, lockToken, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
}

export async function renewPRProcessingLock(
    redisClient: PRProcessingLockRedisClient,
    lockKey: string,
    lockToken: string,
    ttlSeconds = PR_PROCESSING_LOCK_TTL_SECONDS,
): Promise<boolean> {
    const result = await redisClient.eval(RENEW_LOCK_SCRIPT, 1, lockKey, lockToken, ttlSeconds);
    return Number(result) === 1;
}

export async function releasePRProcessingLock(
    redisClient: PRProcessingLockRedisClient,
    lockKey: string,
    lockToken: string,
): Promise<boolean> {
    const result = await redisClient.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken);
    return Number(result) === 1;
}

export function startPRProcessingLockHeartbeat(options: LockHeartbeatOptions): () => Promise<void> {
    const {
        redisClient,
        lockKey,
        lockToken,
        ttlSeconds = PR_PROCESSING_LOCK_TTL_SECONDS,
        intervalMs = PR_PROCESSING_LOCK_RENEW_INTERVAL_MS,
        onLockLost,
        onError,
    } = options;
    let stopped = false;
    let renewalPromise: Promise<void> | null = null;

    const renew = (): void => {
        if (stopped || renewalPromise) return;
        renewalPromise = renewPRProcessingLock(redisClient, lockKey, lockToken, ttlSeconds)
            .then(renewed => {
                if (!renewed && !stopped) onLockLost?.();
            })
            .catch(error => {
                if (!stopped) onError?.(error);
            })
            .finally(() => {
                renewalPromise = null;
            });
    };

    const timer = setInterval(renew, intervalMs);
    timer.unref();

    return async () => {
        stopped = true;
        clearInterval(timer);
        await renewalPromise;
    };
}
