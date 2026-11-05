import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export const PR_PROCESSING_LOCK_TTL_SECONDS = 60 * 60;
export const PR_PROCESSING_LOCK_RENEW_INTERVAL_MS = 30 * 1000;

export type PRProcessingLockRedisClient = Pick<Redis, 'set' | 'eval'>;

export class PRProcessingLeaseLostError extends Error {
    constructor(message = 'PR processing attempt lost its lock') {
        super(message);
        this.name = 'PRProcessingLeaseLostError';
    }
}

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

// Succeeds when the lease is free, or still carries the exact predecessor token
// without a recent heartbeat renewal. A renewing owner keeps its TTL near the
// full lease length, so a TTL above the freshness floor proves it is alive and
// the takeover is refused; a different owner's lease is never touched.
const ADOPT_LOCK_SCRIPT = `
local current = redis.call('get', KEYS[1])
if current == false then
    redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
    return 1
end
if current ~= ARGV[1] then
    return 0
end
if redis.call('ttl', KEYS[1]) > tonumber(ARGV[4]) then
    return -1
end
redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
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

export async function ensurePRProcessingLockToken(
    data: { prProcessingLockToken?: string },
    correlationId: string,
    persist: () => Promise<void>,
): Promise<string> {
    if (data.prProcessingLockToken) return data.prProcessingLockToken;
    data.prProcessingLockToken = createPRProcessingLockToken(correlationId);
    await persist();
    return data.prProcessingLockToken;
}

export async function acquirePRProcessingLock(
    redisClient: PRProcessingLockRedisClient,
    lockKey: string,
    lockToken: string,
    ttlSeconds = PR_PROCESSING_LOCK_TTL_SECONDS,
): Promise<boolean> {
    const result = await redisClient.set(lockKey, lockToken, 'EX', ttlSeconds, 'NX');
    if (result === 'OK') return true;

    // A worker can exit after acquiring the lease but before releasing it.
    // BullMQ redelivery of that same logical execution must be able to resume
    // immediately with its persisted token, while a different token remains
    // excluded even when it shares the same correlation ID.
    return renewPRProcessingLock(redisClient, lockKey, lockToken, ttlSeconds);
}

export type PRProcessingLockAdoption = 'adopted' | 'live_owner' | 'other_owner';

/** How much lease TTL a heartbeating owner is allowed to have consumed and still count as live. */
export const PR_PROCESSING_LOCK_FRESHNESS_SECONDS = 4 * (PR_PROCESSING_LOCK_RENEW_INTERVAL_MS / 1000);

/**
 * Takes durable successor ownership of a lease whose recorded owner stopped
 * renewing it. The swap only happens while the lease is free or still carries
 * the predecessor's exact stale token; a renewing owner reports `live_owner`
 * and a different owner's lease is never deleted.
 */
export async function adoptPRProcessingLock(
    redisClient: PRProcessingLockRedisClient,
    lockKey: string,
    { predecessorToken, successorToken }: { predecessorToken: string; successorToken: string },
    options: { ttlSeconds?: number; freshnessSeconds?: number } = {},
): Promise<PRProcessingLockAdoption> {
    const ttlSeconds = options.ttlSeconds ?? PR_PROCESSING_LOCK_TTL_SECONDS;
    const freshnessSeconds = options.freshnessSeconds ?? PR_PROCESSING_LOCK_FRESHNESS_SECONDS;
    const result = Number(await redisClient.eval(
        ADOPT_LOCK_SCRIPT, 1, lockKey, predecessorToken, successorToken, ttlSeconds, ttlSeconds - freshnessSeconds,
    ));
    if (result === 1) return 'adopted';
    return result === -1 ? 'live_owner' : 'other_owner';
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

export interface CurrentPRLockParams {
    lockKey: string;
    lockToken: string;
    onContended: (lockKey: string) => void;
}

/**
 * Acquires the lease the pull request currently resolves to. Adoption may
 * become visible while acquiring; no work runs under a continuation's own
 * lease, so the source lease is re-resolved and re-acquired until they match.
 * Returns the held lock key, or null when another execution holds it.
 */
export async function acquireCurrentPRProcessingLock(
    redisClient: PRProcessingLockRedisClient,
    { lockKey, lockToken, onContended }: CurrentPRLockParams,
    resolveLockKey: () => Promise<string>,
): Promise<string | null> {
    for (;;) {
        if (!await acquirePRProcessingLock(redisClient, lockKey, lockToken)) {
            onContended(lockKey);
            return null;
        }
        let resolvedLockKey: string;
        try {
            resolvedLockKey = await resolveLockKey();
        } catch (error) {
            await releasePRProcessingLock(redisClient, lockKey, lockToken);
            throw error;
        }
        if (resolvedLockKey === lockKey) return lockKey;
        await releasePRProcessingLock(redisClient, lockKey, lockToken);
        lockKey = resolvedLockKey;
    }
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
