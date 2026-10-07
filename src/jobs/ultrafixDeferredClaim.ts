/**
 * Ultrafix Deferred Claim
 *
 * Claiming a deferred step removes it from Redis. These helpers make the
 * retry obligation carry a copy of the claimed step first, so a process lost
 * before the attempt settles (which no error handler can observe) does not
 * lose an already-authorized step such as a permitted final fix.
 */

import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    claimDeferredContinuationIfUnchanged,
    getUltrafixAutomaticWorkEpoch,
    loadDeferredContinuationSnapshot,
    loadRearmRetry,
} from './ultrafixOrchestrationService.js';
import type { UltrafixDeferredContinuation } from './ultrafixOrchestrationService.js';
import { restoreDeferredContinuationIfUnchanged } from './ultrafixAutomaticWorkEpoch.js';
import { loadStateSnapshot, type ResumeClaim, type UltrafixPrId } from './ultrafixResumeClaim.js';
import { indexUltrafixResumeCandidate } from './ultrafixResumeIndex.js';

/** Reason recorded on the retry obligation that covers a claimed deferred record. */
export const DEFERRED_CLAIM_RETRY_REASON = 'deferred_claim_pending';

/** Bound on claim attempts when the deferred record keeps changing underneath. */
const MAX_CLAIM_ATTEMPTS = 3;

export type DeferredStepClaim =
    | { kind: 'claimed'; deferred: UltrafixDeferredContinuation }
    | { kind: 'none' }
    | { kind: 'claim_lost' }
    | { kind: 'contended' };

interface DeferredClaimContext {
    redisClient: Redis;
    correlatedLogger: Logger;
    claim: ResumeClaim;
}

export function digestUltrafixState(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

/**
 * Claim the PR's deferred step. The retry obligation is persisted first and
 * names the exact record being claimed and the loop state it was claimed
 * against; the claim then removes that record only if it is still unchanged,
 * so the obligation always describes the step that was actually removed.
 * Settling the attempt releases or replaces the obligation.
 */
export async function claimDeferredStep(prId: UltrafixPrId, ctx: DeferredClaimContext): Promise<DeferredStepClaim> {
    const { owner, repo, pr } = prId;
    const { redisClient, claim } = ctx;
    for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
        const pending = await loadDeferredContinuationSnapshot(redisClient, owner, repo, pr);
        if (!pending) return { kind: 'none' };
        const snapshot = await loadStateSnapshot(redisClient, owner, repo, pr);
        const saved = await claim.saveRetry({
            owner, repo, pr,
            workEpoch: await getUltrafixAutomaticWorkEpoch(redisClient, owner, repo, pr),
            reason: DEFERRED_CLAIM_RETRY_REASON,
            savedAt: new Date().toISOString(),
            ...(snapshot ? { claimedStep: { deferred: pending.deferred, stateDigest: digestUltrafixState(snapshot.raw) } } : {}),
        });
        if (!saved) return { kind: 'claim_lost' };
        if (await claimDeferredContinuationIfUnchanged(redisClient, prId, pending.raw)) {
            return { kind: 'claimed', deferred: pending.deferred };
        }
    }
    return { kind: 'contended' };
}

/**
 * Put back a step that an interrupted resume claimed but never settled. Only
 * while its identity still holds: the loop state is exactly the one it was
 * claimed against and the step's epoch is still current (both re-checked
 * atomically on write), and no newer deferred record exists. A step that
 * reached the queue and ran has changed the loop state, and a superseded
 * step has lost its epoch; those fall through to stranded-loop recovery.
 */
export async function restoreInterruptedClaim(prId: UltrafixPrId, ctx: DeferredClaimContext): Promise<boolean> {
    const { owner, repo, pr } = prId;
    const { redisClient, correlatedLogger, claim } = ctx;
    const step = (await loadRearmRetry(redisClient, owner, repo, pr))?.claimedStep;
    if (!step) return false;
    const snapshot = await loadStateSnapshot(redisClient, owner, repo, pr);
    if (!snapshot || digestUltrafixState(snapshot.raw) !== step.stateDigest) {
        correlatedLogger.info({ pr, nextAction: step.deferred.nextAction }, 'Ultrafix deferred resume: interrupted step no longer matches the loop, not restoring it');
        return false;
    }
    if (!await claim.confirm()) return false;
    const workEpoch = step.deferred.workEpoch ?? step.deferred.ultrafixMeta?.workEpoch ?? 0;
    const restored = await restoreDeferredContinuationIfUnchanged(
        redisClient,
        prId,
        { workEpoch, rawState: snapshot.raw },
        JSON.stringify(step.deferred),
    );
    if (restored) await indexUltrafixResumeCandidate(redisClient, prId);
    correlatedLogger.info({ pr, nextAction: step.deferred.nextAction, workEpoch, restored }, 'Ultrafix deferred resume: restoring step claimed by an interrupted resume');
    return restored;
}
