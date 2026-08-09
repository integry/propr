import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const LABEL_TRANSITION_LOCK_KEY_PREFIX = 'ultrafix:label-transition';
const LABEL_TRANSITION_LOCK_TTL_MS = 30 * 60 * 1000;
const LABEL_TRANSITION_RENEW_INTERVAL_MS = 30 * 1000;
const LABEL_TRANSITION_WAIT_MS = 60 * 1000;

const RELEASE_LABEL_TRANSITION_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
`;

const RENEW_LABEL_TRANSITION_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export interface LabelTransitionTiming {
    ttlMs: number;
    renewIntervalMs: number;
    waitMs: number;
}

function getLabelTransitionLockKey(identity: { owner: string; repo: string; pr: number }): string {
    return `${LABEL_TRANSITION_LOCK_KEY_PREFIX}:${identity.owner}:${identity.repo}:${identity.pr}`;
}

/** Serialize the shared GitHub label with epoch state publication and cleanup. */
export async function withUltrafixLabelTransition<T>(
    redis: Pick<Redis, 'set' | 'eval'>,
    identity: { owner: string; repo: string; pr: number },
    operation: () => Promise<T>,
    timing: LabelTransitionTiming = {
        ttlMs: LABEL_TRANSITION_LOCK_TTL_MS,
        renewIntervalMs: LABEL_TRANSITION_RENEW_INTERVAL_MS,
        waitMs: LABEL_TRANSITION_WAIT_MS,
    },
): Promise<T> {
    const key = getLabelTransitionLockKey(identity);
    const token = randomUUID();
    const deadline = Date.now() + timing.waitMs;
    while (await redis.set(key, token, 'PX', timing.ttlMs, 'NX') !== 'OK') {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for Ultrafix label transition');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    let renewal: Promise<void> | null = null;
    let leaseLost = false;
    const renew = (): void => {
        if (renewal || leaseLost) return;
        renewal = redis.eval(
            RENEW_LABEL_TRANSITION_LOCK_SCRIPT,
            1,
            key,
            token,
            String(timing.ttlMs),
        ).then(result => {
            if (Number(result) !== 1) leaseLost = true;
        }).catch(() => {
            leaseLost = true;
        }).finally(() => {
            renewal = null;
        });
    };
    const renewalTimer = setInterval(renew, timing.renewIntervalMs);
    renewalTimer.unref();
    try {
        const result = await operation();
        // Stop new heartbeats, wait for one already in flight, then verify that
        // this transition still owns the lease before publishing success.
        clearInterval(renewalTimer);
        await renewal;
        const stillOwned = await redis.eval(
            RENEW_LABEL_TRANSITION_LOCK_SCRIPT,
            1,
            key,
            token,
            String(timing.ttlMs),
        );
        if (Number(stillOwned) !== 1) leaseLost = true;
        if (leaseLost) throw new Error('Ultrafix label transition lease was lost');
        return result;
    } finally {
        clearInterval(renewalTimer);
        await renewal;
        // The bounded lease is the fallback if Redis becomes unavailable only
        // for release; never reinterpret a completed transition as a failure.
        try {
            await redis.eval(RELEASE_LABEL_TRANSITION_LOCK_SCRIPT, 1, key, token);
        } catch {
            // Lease expiry safely releases the completed transition.
        }
    }
}

export type UltrafixLabelRemovalResult = 'cleared' | 'label_present' | 'unverified';

/** Clear loop state only when the live label is still absent under the transition lease. */
export async function clearUltrafixStateForLabelRemoval(
    redis: Pick<Redis, 'set' | 'eval'>,
    identity: { owner: string; repo: string; pr: number },
    isLabelPresent: () => Promise<boolean>,
    clearState: () => Promise<void>,
): Promise<UltrafixLabelRemovalResult> {
    return withUltrafixLabelTransition(redis, identity, async () => {
        try {
            if (await isLabelPresent()) return 'label_present';
        } catch {
            return 'unverified';
        }
        await clearState();
        return 'cleared';
    });
}
