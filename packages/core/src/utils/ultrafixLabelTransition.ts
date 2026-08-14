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

export interface LabelTransitionLease {
    identity: Readonly<{ owner: string; repo: string; pr: number }>;
    /** Verify and renew ownership before an irreversible transition step. */
    assertOwned: () => Promise<void>;
}

export class LabelTransitionLeaseError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'LabelTransitionLeaseError';
    }
}

function getLabelTransitionLockKey(identity: { owner: string; repo: string; pr: number }): string {
    return `${LABEL_TRANSITION_LOCK_KEY_PREFIX}:${identity.owner}:${identity.repo}:${identity.pr}`;
}

/** Serialize all label-transition work for one owner/repository/PR. */
export async function withLabelTransitionLease<T>(
    redis: Pick<Redis, 'set' | 'eval'>,
    identity: { owner: string; repo: string; pr: number },
    operation: (lease: LabelTransitionLease) => Promise<T>,
    timing: LabelTransitionTiming = {
        ttlMs: LABEL_TRANSITION_LOCK_TTL_MS,
        renewIntervalMs: LABEL_TRANSITION_RENEW_INTERVAL_MS,
        waitMs: LABEL_TRANSITION_WAIT_MS,
    },
): Promise<T> {
    const key = getLabelTransitionLockKey(identity);
    const token = randomUUID();
    const deadline = Date.now() + timing.waitMs;
    let acquired = false;
    while (!acquired) {
        try {
            acquired = await redis.set(key, token, 'PX', timing.ttlMs, 'NX') === 'OK';
        } catch (error) {
            throw new LabelTransitionLeaseError('Failed to acquire PR label transition lease', { cause: error });
        }
        if (acquired) break;
        if (Date.now() >= deadline) throw new LabelTransitionLeaseError('Timed out waiting for PR label transition lease');
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
    const assertOwned = async (): Promise<void> => {
        await renewal;
        if (!leaseLost) {
            try {
                const stillOwned = await redis.eval(
                    RENEW_LABEL_TRANSITION_LOCK_SCRIPT,
                    1,
                    key,
                    token,
                    String(timing.ttlMs),
                );
                if (Number(stillOwned) !== 1) leaseLost = true;
            } catch {
                leaseLost = true;
            }
        }
        if (leaseLost) throw new LabelTransitionLeaseError('PR label transition lease was lost');
    };
    try {
        const result = await operation({ identity, assertOwned });
        // Stop new heartbeats, wait for one already in flight, then verify that
        // this transition still owns the lease before publishing success.
        clearInterval(renewalTimer);
        await assertOwned();
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

/** Serialize the shared GitHub label with epoch state publication and cleanup. */
export const withUltrafixLabelTransition = withLabelTransitionLease;

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
