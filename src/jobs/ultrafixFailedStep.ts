/**
 * Ultrafix Failed Step
 *
 * A step job that fails for good (its attempts exhausted) runs no
 * continuation, so its loop stays active, owned by the current epoch, with no
 * deferred record and nothing queued. No trigger would look at it again. This
 * records a retry obligation for such a loop so the resume sweep re-arms it,
 * and counts the failure on the loop so repeated failures trip a breaker.
 */

import type { Redis } from 'ioredis';
import type { UltrafixCommandMeta } from '@propr/core';
import {
    getUltrafixAutomaticWorkEpoch,
    getUltrafixAutomaticWorkEpochKey,
    getUltrafixRearmRetryKey,
    getUltrafixStateKey,
    loadRearmRetryRaw,
} from './ultrafixOrchestrationService.js';
import type { UltrafixRearmRetry } from './ultrafixOrchestrationService.js';
import { REARM_RETRY_TTL_SECONDS } from './ultrafixDeferredContinuationStore.js';
import { loadStateSnapshot, recordFailedStepInState } from './ultrafixResumeClaim.js';
import { indexUltrafixResumeCandidate } from './ultrafixResumeIndex.js';

/** Reason recorded on the retry obligation left by a step job that failed for good. */
export const FAILED_STEP_RETRY_REASON = 'step_job_failed';

/** Bound on re-reads when the loop or its obligation changes underneath. */
const MAX_RECORD_ATTEMPTS = 3;

// Marked so test doubles can tell it apart from the other conditional writes.
const RECORD_FAILED_STEP_SCRIPT = `
-- record failed ultrafix step
if (redis.call('GET', KEYS[1]) or '0') ~= ARGV[1] then
    return 0
end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then
    return 0
end
if (redis.call('GET', KEYS[3]) or '') ~= ARGV[4] then
    return 0
end
redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[5], 'EX', ARGV[6])
return 1
`;

export interface FailedStepJobData {
    repoOwner?: string;
    repoName?: string;
    pullRequestNumber?: number;
    ultrafixMeta?: Pick<UltrafixCommandMeta, 'workEpoch'> | null;
}

/**
 * Record the obligation only for a step that still owned its active loop: a
 * step fenced by a newer epoch was replaced by whatever fenced it. The
 * obligation only requests another resume attempt; every action that attempt
 * takes stays fenced by the loop's epoch and state snapshot.
 *
 * The failure is recorded even when an obligation already exists (e.g. the
 * handoff of a resume whose enqueue has not been acknowledged yet): the
 * obligation is replaced by a new version, keeping any claimed step it
 * carries, so that settling the handoff cannot release it. The loop's
 * failure streak is written in the same atomic step.
 */
export async function recordFailedUltrafixStep(redis: Redis, data: FailedStepJobData): Promise<boolean> {
    const { repoOwner: owner, repoName: repo, pullRequestNumber: pr, ultrafixMeta } = data;
    if (!ultrafixMeta || !owner || !repo || typeof pr !== 'number') return false;
    const workEpoch = ultrafixMeta.workEpoch ?? 0;
    for (let attempt = 1; attempt <= MAX_RECORD_ATTEMPTS; attempt++) {
        const snapshot = await loadStateSnapshot(redis, owner, repo, pr);
        if (!snapshot?.state.active || (snapshot.state.workEpoch ?? 0) !== workEpoch) return false;
        if (await getUltrafixAutomaticWorkEpoch(redis, owner, repo, pr) !== workEpoch) return false;
        const existingRaw = await loadRearmRetryRaw(redis, owner, repo, pr);
        const existing = existingRaw ? JSON.parse(existingRaw) as UltrafixRearmRetry : null;
        const retry: UltrafixRearmRetry = {
            owner, repo, pr, workEpoch,
            reason: FAILED_STEP_RETRY_REASON,
            savedAt: new Date().toISOString(),
            failureVersion: (existing?.failureVersion ?? 0) + 1,
            ...(existing?.claimedStep ? { claimedStep: existing.claimedStep } : {}),
        };
        const recorded = await redis.eval(
            RECORD_FAILED_STEP_SCRIPT,
            3,
            getUltrafixAutomaticWorkEpochKey(owner, repo, pr),
            getUltrafixStateKey(owner, repo, pr),
            getUltrafixRearmRetryKey(owner, repo, pr),
            String(workEpoch),
            snapshot.raw,
            JSON.stringify(recordFailedStepInState(snapshot.state)),
            existingRaw ?? '',
            JSON.stringify(retry),
            String(REARM_RETRY_TTL_SECONDS),
        );
        if (Number(recorded) === 1) {
            await indexUltrafixResumeCandidate(redis, retry);
            return true;
        }
    }
    return false;
}
