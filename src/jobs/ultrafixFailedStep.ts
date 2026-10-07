/**
 * Ultrafix Failed Step
 *
 * A step job that fails for good (its attempts exhausted) runs no
 * continuation, so its loop stays active, owned by the current epoch, with no
 * deferred record and nothing queued. No trigger would look at it again. This
 * records a retry obligation for such a loop so the resume sweep re-arms it.
 */

import type { Redis } from 'ioredis';
import type { UltrafixCommandMeta } from '@propr/core';
import { getUltrafixAutomaticWorkEpoch, loadState, saveRearmRetryIfAbsent } from './ultrafixOrchestrationService.js';

/** Reason recorded on the retry obligation left by a step job that failed for good. */
export const FAILED_STEP_RETRY_REASON = 'step_job_failed';

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
 */
export async function recordFailedUltrafixStep(redis: Redis, data: FailedStepJobData): Promise<boolean> {
    const { repoOwner: owner, repoName: repo, pullRequestNumber: pr, ultrafixMeta } = data;
    if (!ultrafixMeta || !owner || !repo || typeof pr !== 'number') return false;
    const workEpoch = ultrafixMeta.workEpoch ?? 0;
    const state = await loadState(redis, owner, repo, pr);
    if (!state?.active || (state.workEpoch ?? 0) !== workEpoch) return false;
    if (await getUltrafixAutomaticWorkEpoch(redis, owner, repo, pr) !== workEpoch) return false;
    return saveRearmRetryIfAbsent(redis, {
        owner, repo, pr, workEpoch,
        reason: FAILED_STEP_RETRY_REASON,
        savedAt: new Date().toISOString(),
    });
}
