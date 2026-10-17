import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { JobResult, UnprocessedComment } from '@propr/core';
import { acquirePRProcessingLock, releasePRProcessingLock } from './prProcessingLock.js';
import { findOpenFollowupHandoff } from './followupHandoffStore.js';
import type { ExecuteProcessingParams } from './prPublicationRecovery.js';

export interface AcquireCurrentPRLockParams {
    redisClient: Redis;
    lockKey: string;
    lockToken: string;
    correlatedLogger: Logger;
}

/**
 * Acquires the lease for the PR a request currently maps to. Adoption may have
 * become visible while the lease was being acquired; no work runs under a
 * continuation's own lease, so the source is re-resolved until it is stable.
 */
export async function acquireCurrentPRLock(
    { redisClient, lockKey, lockToken, correlatedLogger }: AcquireCurrentPRLockParams,
    resolveLockKey: () => Promise<string>,
): Promise<string | null> {
    for (;;) {
        if (!await acquirePRProcessingLock(redisClient, lockKey, lockToken)) {
            correlatedLogger.info({ lockKey }, 'PR is currently being processed by another execution. Rescheduling...');
            return null;
        }
        correlatedLogger.debug({ lockKey }, 'PR lock acquired');
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

/**
 * Adopts and finalizes a predecessor's interrupted follow-up, when its durable
 * handoff record is open. The recovery module and its publication graph are
 * loaded only in that case, which keeps every ordinary request on the fast path.
 */
export async function recoverFollowupHandoffIfPresent(
    params: ExecuteProcessingParams,
    options: { redisClient: Redis; pickedUpComments: UnprocessedComment[] },
): Promise<JobResult | undefined> {
    if (!await findOpenFollowupHandoff(params.context)) return undefined;
    const { recoverInterruptedFollowupHandoff } = await import('./followupHandoffRecovery.js');
    return recoverInterruptedFollowupHandoff(params, options);
}
