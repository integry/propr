/**
 * Ultrafix Failed Step
 *
 * A step job that fails for good (its attempts exhausted) runs no
 * continuation, so its loop stays active, owned by the current epoch, with no
 * deferred record and nothing queued. No trigger would look at it again. This
 * records a retry obligation for such a loop so the resume sweep re-arms it,
 * and counts the failure on the loop so repeated failures trip a breaker.
 *
 * A step refused at admission for disk pressure is recorded as a wait
 * instead (`recordUltrafixDiskPressureRefusal`): not counted, and retried on
 * the backoff of `ultrafixDiskPressureWait.ts`.
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
import type { UltrafixAction, UltrafixLoopState, UltrafixRearmRetry } from './ultrafixOrchestrationService.js';
import { REARM_RETRY_TTL_SECONDS } from './ultrafixDeferredContinuationStore.js';
import { loadStateSnapshot, recordFailedStepInState } from './ultrafixResumeClaim.js';
import { indexUltrafixResumeCandidate } from './ultrafixResumeIndex.js';
import { DISK_PRESSURE_RETRY_REASON, getDiskPressureWait, recordDiskPressureRefusalInState } from './ultrafixDiskPressureWait.js';
import type { UltrafixDiskPressureWait } from './ultrafixDiskPressureWait.js';

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
    commandMode?: string;
}

/** How one exhausted step changes the loop state, and what the sweep is asked to do about it. */
interface StepFailureTransition {
    reason: string;
    nextState(state: UltrafixLoopState): UltrafixLoopState;
    /** When the sweep may act on the obligation; absent: at once. */
    notBefore?(state: UltrafixLoopState): string | undefined;
}

const FAILED_STEP_TRANSITION: StepFailureTransition = {
    reason: FAILED_STEP_RETRY_REASON,
    nextState: recordFailedStepInState,
};

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
    return await recordStepFailure(redis, data, FAILED_STEP_TRANSITION) !== null;
}

function stepActionOf(data: FailedStepJobData): UltrafixAction | null {
    return data.commandMode === 'review' || data.commandMode === 'fix' ? data.commandMode : null;
}

/**
 * Record an Ultrafix step refused at worker admission for disk pressure: a
 * wait, not a failed step. The failed-step streak is left alone; the
 * obligation asks the sweep to retry the same step once its backoff has
 * passed, or (retries used up) to stop the loop with the real reason.
 * Returns the recorded wait, or null when the job was no current Ultrafix step.
 */
export async function recordUltrafixDiskPressureRefusal(
    redis: Redis,
    data: FailedStepJobData,
    now = Date.now(),
    details: string | null = null,
): Promise<UltrafixDiskPressureWait | null> {
    const action = stepActionOf(data);
    if (!action) return null;
    const recorded = await recordStepFailure(redis, data, {
        reason: DISK_PRESSURE_RETRY_REASON,
        nextState: state => recordDiskPressureRefusalInState(state, action, now, details),
        notBefore: state => {
            const wait = getDiskPressureWait(state);
            return wait && !wait.exhausted ? wait.retryAt : undefined;
        },
    });
    return recorded?.diskPressureWait ?? null;
}

/**
 * The obligation is replaced by a new version, keeping any claimed step it
 * carries, so that settling a handoff recorded before cannot release it.
 */
function buildFailureRetry(
    target: { owner: string; repo: string; pr: number; workEpoch: number },
    transition: StepFailureTransition,
    nextState: UltrafixLoopState,
    existing: UltrafixRearmRetry | null,
): UltrafixRearmRetry {
    const notBefore = transition.notBefore?.(nextState);
    return {
        ...target,
        reason: transition.reason,
        savedAt: new Date().toISOString(),
        ...(notBefore ? { notBefore } : {}),
        failureVersion: (existing?.failureVersion ?? 0) + 1,
        ...(existing?.claimedStep ? { claimedStep: existing.claimedStep } : {}),
    };
}

async function recordStepFailure(
    redis: Redis,
    data: FailedStepJobData,
    transition: StepFailureTransition,
): Promise<UltrafixLoopState | null> {
    const { repoOwner: owner, repoName: repo, pullRequestNumber: pr, ultrafixMeta } = data;
    if (!ultrafixMeta || !owner || !repo || typeof pr !== 'number') return null;
    const workEpoch = ultrafixMeta.workEpoch ?? 0;
    for (let attempt = 1; attempt <= MAX_RECORD_ATTEMPTS; attempt++) {
        const snapshot = await loadStateSnapshot(redis, owner, repo, pr);
        if (!snapshot?.state.active || (snapshot.state.workEpoch ?? 0) !== workEpoch) return null;
        if (await getUltrafixAutomaticWorkEpoch(redis, owner, repo, pr) !== workEpoch) return null;
        const existingRaw = await loadRearmRetryRaw(redis, owner, repo, pr);
        const existing = existingRaw ? JSON.parse(existingRaw) as UltrafixRearmRetry : null;
        const nextState = transition.nextState(snapshot.state);
        const retry = buildFailureRetry({ owner, repo, pr, workEpoch }, transition, nextState, existing);
        const recorded = await redis.eval(
            RECORD_FAILED_STEP_SCRIPT,
            3,
            getUltrafixAutomaticWorkEpochKey(owner, repo, pr),
            getUltrafixStateKey(owner, repo, pr),
            getUltrafixRearmRetryKey(owner, repo, pr),
            String(workEpoch),
            snapshot.raw,
            JSON.stringify(nextState),
            existingRaw ?? '',
            JSON.stringify(retry),
            String(REARM_RETRY_TTL_SECONDS),
        );
        if (Number(recorded) === 1) {
            await indexUltrafixResumeCandidate(redis, retry);
            return nextState;
        }
    }
    return null;
}
