import { setTimeout as delay } from 'node:timers/promises';
import type { Redis } from 'ioredis';
import {
    acquirePRProcessingLock,
    createPRProcessingLockToken,
    releasePRProcessingLock,
    startPRProcessingLockHeartbeat,
} from './prProcessingLock.js';

const TRANSITION_LEASE_TTL_SECONDS = 30;
const TRANSITION_LEASE_RENEW_INTERVAL_MS = 10_000;
const TRANSITION_LEASE_WAIT_TIMEOUT_MS = 45_000;
const TRANSITION_LEASE_RETRY_MS = 50;

interface UltrafixIdentity {
    owner: string;
    repo: string;
    pr: number;
}

export function getUltrafixTransitionLeaseKey(identity: UltrafixIdentity): string {
    return `lock:ultrafix-transition:${identity.owner}:${identity.repo}:${identity.pr}`;
}

/** Serialize generation takeover with terminal label and auto-merge side effects. */
export async function withUltrafixTransitionLease<T>(
    redisClient: Redis,
    identity: UltrafixIdentity,
    correlationId: string,
    operation: () => Promise<T>,
): Promise<T> {
    const lockKey = getUltrafixTransitionLeaseKey(identity);
    const lockToken = createPRProcessingLockToken(correlationId);
    const deadline = Date.now() + TRANSITION_LEASE_WAIT_TIMEOUT_MS;
    while (!await acquirePRProcessingLock(
        redisClient, lockKey, lockToken, TRANSITION_LEASE_TTL_SECONDS,
    )) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for Ultrafix transition lease for PR #${identity.pr}`);
        }
        await delay(TRANSITION_LEASE_RETRY_MS);
    }

    let leaseLost = false;
    const stopHeartbeat = startPRProcessingLockHeartbeat({
        redisClient,
        lockKey,
        lockToken,
        ttlSeconds: TRANSITION_LEASE_TTL_SECONDS,
        intervalMs: TRANSITION_LEASE_RENEW_INTERVAL_MS,
        onLockLost: () => { leaseLost = true; },
    });
    let heartbeatStopped = false;
    try {
        const result = await operation();
        await stopHeartbeat();
        heartbeatStopped = true;
        if (leaseLost) throw new Error(`Lost Ultrafix transition lease for PR #${identity.pr}`);
        return result;
    } finally {
        if (!heartbeatStopped) await stopHeartbeat();
        await releasePRProcessingLock(redisClient, lockKey, lockToken);
    }
}
