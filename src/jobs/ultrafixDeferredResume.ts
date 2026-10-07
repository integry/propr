/**
 * Ultrafix Deferred Resume
 *
 * Resumes a deferred Ultrafix continuation (or re-arms a stranded loop) when
 * CI events or the periodic sweep indicate the loop may be able to proceed.
 */

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { generateCorrelationId } from '@propr/core';
import {
    claimDeferredContinuation,
    saveDeferredContinuation,
    getUltrafixAutomaticWorkEpoch,
    isUltrafixAutomaticWorkCurrent,
    listDeferredContinuationKeys,
    listRearmRetryKeys,
    loadDeferredContinuation,
    loadRearmRetry,
    parseDeferredKey,
    parseRearmRetryKey,
} from './ultrafixOrchestrationService.js';
import type { UltrafixDeferredContinuation, UltrafixLoopState } from './ultrafixOrchestrationService.js';
import { enqueueNextStep, evaluateReadiness } from './ultrafixLoopContinuationHelpers.js';
import { applyUltrafixCiDeferral } from './ultrafixCiWait.js';
import { rearmStrandedUltrafixLoop } from './ultrafixStrandedLoopRearm.js';
import { restoreDeferredContinuationIfUnchanged } from './ultrafixAutomaticWorkEpoch.js';
import { getCheckRunDeps } from './ultrafixCheckRunDeps.js';
import {
    getNextStepNumber,
    loadStateSnapshot,
    RESUME_CLAIM_LOST_REASON,
    withResumeClaim,
    type ResumeClaim,
    type UltrafixStateSnapshot,
} from './ultrafixResumeClaim.js';
import type { ContinuationResult, UltrafixContinuationParams } from './ultrafixLoopContinuation.js';

/** Reason recorded on the retry obligation that covers a claimed deferred record. */
export const DEFERRED_CLAIM_RETRY_REASON = 'deferred_claim_pending';

/** The step this continuation would enqueue is already queued or running; that job owns the loop. */
export const NEXT_STEP_ALREADY_QUEUED_REASON = 'next_step_already_queued';

/**
 * Resume a deferred ultrafix continuation. Called when a check_run event
 * indicates that checks may now be green for a PR with a waiting loop.
 *
 * Re-evaluates readiness. If ready, enqueues the next step and clears the
 * deferred record. If still not ready, leaves the deferred record in place.
 *
 * When the deferred record is gone or belongs to a superseded epoch (e.g. a
 * CI-failure follow-up or manual command fenced it) an active loop would
 * otherwise be stranded, so the loop is re-armed with a fresh review.
 */
export async function resumeDeferredContinuation(
    prId: { owner: string; repo: string; pr: number },
    redisClient: Redis,
    correlatedLogger: Logger,
): Promise<ContinuationResult> {
    // Both branches decide and enqueue under one per-PR claim, so a trigger
    // resuming the deferred step and one re-arming the loop cannot interleave.
    // Set once a pass schedules the next step: that step owns the loop, so a
    // later re-check pass that finds it outstanding must not record a retry.
    let scheduled = false;
    return withResumeClaim(prId, redisClient, correlatedLogger, async claim => {
        let result: ContinuationResult;
        try {
            result = await resumeClaimedContinuation(prId, redisClient, correlatedLogger, claim);
        } catch (err) {
            // e.g. the queue failed after the deferred record was claimed: keep a retry.
            await settleRearmRetry(prId, { continued: false, reason: `resume_failed: ${(err as Error).message}` }, { redisClient, correlatedLogger, claim });
            throw err;
        }
        if (!scheduled || !leavesLoopWaiting(result.reason)) {
            result = await settleRearmRetry(prId, result, { redisClient, correlatedLogger, claim });
        }
        scheduled ||= result.continued;
        return result;
    });
}

/**
 * Outcomes after which an active loop may be left with no deferred record, no
 * queued step and no further CI event to wake it.
 */
function leavesLoopWaiting(reason: string): boolean {
    return reason.startsWith('rearm_not_ready')
        || reason.startsWith('resume_failed')
        || reason === 'deferred_cancelled'
        || reason === 'ultrafix_superseded'
        || reason === RESUME_CLAIM_LOST_REASON;
}

/**
 * Record or release the durable retry obligation for this PR. A resume that
 * could not settle the loop (outstanding or unreadable work, a superseded
 * record, a failed enqueue) leaves one so the periodic sweep re-runs it
 * without waiting for another webhook; any settled outcome releases it.
 *
 * Returns the outcome as settled: a step handed off under an epoch that was
 * invalidated meanwhile (e.g. a manual command while the enqueue was
 * outstanding) will not continue the loop, so it is reported as superseded.
 */
async function settleRearmRetry(
    prId: { owner: string; repo: string; pr: number },
    result: ContinuationResult,
    ctx: { redisClient: Redis; correlatedLogger: Logger; claim: ResumeClaim },
): Promise<ContinuationResult> {
    const { owner, repo, pr } = prId;
    const { redisClient, correlatedLogger, claim } = ctx;
    let settled = result;
    try {
        if (!leavesLoopWaiting(result.reason)) {
            // Only the current holder may release it: a takeover may have
            // recorded a newer obligation this outcome knows nothing about.
            const cleared = await claim.clearRetry(result.workEpoch);
            if (cleared === 'claim_not_held') {
                correlatedLogger.info({ pr, reason: result.reason }, 'Ultrafix resume: resume claim no longer held, leaving retry obligation in place');
            }
            if (cleared !== 'superseded') return result;
            correlatedLogger.info(
                { pr, reason: result.reason, workEpoch: result.workEpoch },
                'Ultrafix resume: handed-off step superseded before settlement, keeping retry obligation',
            );
            settled = { continued: false, reason: 'ultrafix_superseded', cycleCount: result.cycleCount };
        }
        // A trigger that took the claim over owns the obligation now.
        const saved = await claim.saveRetry({
            owner, repo, pr,
            workEpoch: await getUltrafixAutomaticWorkEpoch(redisClient, owner, repo, pr),
            reason: settled.reason,
            savedAt: new Date().toISOString(),
            ...(settled.retryDelayMs
                ? { notBefore: new Date(Date.now() + settled.retryDelayMs).toISOString() }
                : {}),
        });
        if (saved) {
            correlatedLogger.info({ pr, reason: settled.reason, retryDelayMs: settled.retryDelayMs }, 'Ultrafix resume: recorded retry for unsettled loop');
        }
    } catch (err) {
        correlatedLogger.warn({ pr, error: (err as Error).message }, 'Ultrafix resume: failed to update retry obligation');
    }
    return settled;
}

/**
 * Periodic reconciliation: re-run every deferred continuation and every
 * recorded retry obligation that is due, so a loop whose last trigger could
 * not settle it is retried without another webhook.
 */
export async function sweepUltrafixResumeCandidates(
    redisClient: Redis,
    createLogger: () => Logger,
): Promise<Array<{ prId: { owner: string; repo: string; pr: number }; result: ContinuationResult }>> {
    const candidates = new Map<string, { owner: string; repo: string; pr: number }>();
    for (const key of await listDeferredContinuationKeys(redisClient)) {
        const parsed = parseDeferredKey(key);
        if (parsed) candidates.set(`${parsed.owner}/${parsed.repo}#${parsed.pr}`, parsed);
    }
    for (const key of await listRearmRetryKeys(redisClient)) {
        const parsed = parseRearmRetryKey(key);
        if (!parsed) continue;
        const retry = await loadRearmRetry(redisClient, parsed.owner, parsed.repo, parsed.pr);
        if (retry?.notBefore && Date.parse(retry.notBefore) > Date.now()) continue;
        candidates.set(`${parsed.owner}/${parsed.repo}#${parsed.pr}`, parsed);
    }
    const outcomes: Array<{ prId: { owner: string; repo: string; pr: number }; result: ContinuationResult }> = [];
    for (const prId of candidates.values()) {
        const log = createLogger();
        try {
            outcomes.push({ prId, result: await resumeDeferredContinuation(prId, redisClient, log) });
        } catch (err) {
            log.warn({ ...prId, error: (err as Error).message }, '[ultrafix] resume sweep failed for PR');
        }
    }
    return outcomes;
}

async function resumeClaimedContinuation(
    prId: { owner: string; repo: string; pr: number },
    redisClient: Redis,
    correlatedLogger: Logger,
    claim: ResumeClaim,
): Promise<ContinuationResult> {
    const { owner, repo, pr } = prId;
    // Claiming the deferred record removes it. A process lost before this
    // attempt settles (which no error handler can observe) would leave an
    // active loop that nothing durable names, so the retry obligation is
    // persisted first; settling the attempt releases or replaces it.
    if (await loadDeferredContinuation(redisClient, owner, repo, pr)) {
        const saved = await claim.saveRetry({
            owner, repo, pr,
            workEpoch: await getUltrafixAutomaticWorkEpoch(redisClient, owner, repo, pr),
            reason: DEFERRED_CLAIM_RETRY_REASON,
            savedAt: new Date().toISOString(),
        });
        if (!saved) return { continued: false, reason: RESUME_CLAIM_LOST_REASON };
    }
    // Atomically claim the deferred record so concurrent check_run events
    // for the same PR cannot double-enqueue the next step.
    const deferred = await claimDeferredContinuation(redisClient, owner, repo, pr);
    if (!deferred) {
        return rearmStrandedUltrafixLoop(prId, { redisClient, correlatedLogger, checkRunDeps: getCheckRunDeps(), claim });
    }

    const workEpoch = deferred.workEpoch ?? deferred.ultrafixMeta?.workEpoch;
    if (!await isUltrafixAutomaticWorkCurrent(redisClient, { owner, repo, pr }, workEpoch)) {
        return rearmStrandedUltrafixLoop(prId, { redisClient, correlatedLogger, checkRunDeps: getCheckRunDeps(), claim });
    }

    // The claimed record is the only copy of an already-authorized step (e.g. a
    // permitted final fix). If this attempt stops without handing it to the
    // queue or re-saving it, put it back so the retry resumes the same step
    // instead of falling through to stranded-loop recovery. The step is derived
    // from this snapshot, which also decides whether it may still be put back.
    const claimed = { ...deferred, workEpoch };
    const snapshot = await loadStateSnapshot(redisClient, owner, repo, pr);
    let result: ContinuationResult;
    try {
        result = await resumeClaimedDeferredStep(prId, claimed, { redisClient, correlatedLogger, claim, state: snapshot?.state ?? null });
    } catch (err) {
        await restoreClaimedDeferred(prId, claimed, snapshot, { redisClient, correlatedLogger });
        throw err;
    }
    if (result.reason === RESUME_CLAIM_LOST_REASON) {
        await restoreClaimedDeferred(prId, claimed, snapshot, { redisClient, correlatedLogger });
    }
    return result;
}

/**
 * Put the claimed step back only while the loop is exactly as it was when the
 * step was claimed: same epoch, same state and no newer deferred record. An
 * enqueue that failed may still have reached the queue, and that step may have
 * run and advanced the loop (recorded its action, deferred its successor)
 * before the error surfaced here; the claimed step is then already done and
 * restoring it would overwrite the successor and schedule it again. A step
 * still waiting in the queue leaves the loop unchanged, and its job ID makes
 * the restored record's next attempt a no-op duplicate.
 */
async function restoreClaimedDeferred(
    prId: { owner: string; repo: string; pr: number },
    deferred: UltrafixDeferredContinuation,
    snapshot: UltrafixStateSnapshot | null,
    ctx: { redisClient: Redis; correlatedLogger: Logger },
): Promise<void> {
    if (!snapshot) return;
    try {
        const restored = await restoreDeferredContinuationIfUnchanged(
            ctx.redisClient,
            prId,
            { workEpoch: deferred.workEpoch ?? 0, rawState: snapshot.raw },
            JSON.stringify(deferred),
        );
        ctx.correlatedLogger.info({ pr: prId.pr, nextAction: deferred.nextAction, restored }, 'Ultrafix deferred resume: put the claimed step back');
    } catch (err) {
        ctx.correlatedLogger.warn({ pr: prId.pr, error: (err as Error).message }, 'Ultrafix deferred resume: failed to put the claimed step back');
    }
}

async function resumeClaimedDeferredStep(
    prId: { owner: string; repo: string; pr: number },
    deferred: UltrafixDeferredContinuation,
    ctx: { redisClient: Redis; correlatedLogger: Logger; claim: ResumeClaim; state: UltrafixLoopState | null },
): Promise<ContinuationResult> {
    const { owner, repo, pr } = prId;
    const { redisClient, correlatedLogger, claim, state } = ctx;
    const { workEpoch } = deferred;
    if (!state || !state.active) {
        return { continued: false, reason: 'no_active_loop' };
    }

    const correlationId = generateCorrelationId();
    const ultrafixMeta = {
        ...(deferred.ultrafixMeta ?? {
        mode: 'ultrafix' as const,
        goal: state.goal,
        maxCycles: state.maxCycles,
        pauseSeconds: state.pauseSeconds,
        reviewModel: state.reviewModel || undefined,
        instructions: state.instructions ?? '',
        }),
        workEpoch,
    };
    const params: UltrafixContinuationParams = {
        owner,
        repo,
        pullRequestNumber: pr,
        completedAction: state.lastAction ?? 'review',
        userId: deferred.userId ?? state.userId,
        ultrafixMeta,
        redisClient,
        correlatedLogger,
        correlationId,
    };

    const readiness = await evaluateReadiness(params, deferred.nextAction, getCheckRunDeps());
    correlatedLogger.info(
        { pr, ready: readiness.ready, reasons: readiness.reasons },
        'Ultrafix deferred resume: readiness re-check',
    );

    if (!readiness.ready) {
        // Not ready yet — re-save so a future check_run can try again
        if (!await claim.confirm()) return { continued: false, reason: RESUME_CLAIM_LOST_REASON };
        const saved = await saveDeferredContinuation(redisClient, deferred);
        if (!saved) return { continued: false, reason: 'deferred_cancelled' };
        if (!await claim.confirm()) return { continued: false, reason: RESUME_CLAIM_LOST_REASON };
        const ci = await applyUltrafixCiDeferral(params, readiness, state);
        return ci.terminal ?? {
            continued: false,
            reason: `still_deferred: ${readiness.reasons.join(', ')}`,
            deferred: true, workEpoch: workEpoch ?? 0, ...ci.extra,
        };
    }

    if (!await isUltrafixAutomaticWorkCurrent(redisClient, { owner, repo, pr }, workEpoch)) {
        return { continued: false, reason: 'deferred_cancelled' };
    }
    if (!await claim.confirm()) return { continued: false, reason: RESUME_CLAIM_LOST_REASON };

    const delayMs = (state.pauseSeconds || 60) * 1000;
    const enqueued = await enqueueNextStep(params, deferred.nextAction, delayMs, getNextStepNumber(state, deferred.nextAction));
    if (!enqueued) {
        return { continued: false, reason: NEXT_STEP_ALREADY_QUEUED_REASON, nextAction: deferred.nextAction, cycleCount: state.cycleCount };
    }

    correlatedLogger.info(
        { pr, nextAction: deferred.nextAction },
        'Ultrafix deferred resume: enqueued next step',
    );

    return {
        continued: true,
        reason: 'deferred_resumed',
        nextAction: deferred.nextAction,
        cycleCount: state.cycleCount,
        workEpoch: workEpoch ?? 0,
    };
}
