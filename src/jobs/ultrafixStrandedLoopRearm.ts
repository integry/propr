/**
 * Ultrafix Stranded Loop Re-arming
 *
 * Re-arms an active Ultrafix loop whose deferred continuation was cleared or
 * superseded, so a green check run cannot leave the loop stranded.
 */

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { generateCorrelationId, withUltrafixLabelTransition } from '@propr/core';
import {
    clearDeferredContinuationIfCurrent,
    clearUltrafixStateIfUnchanged,
    getUltrafixAutomaticWorkEpoch,
} from './ultrafixAutomaticWorkEpoch.js';
import { saveDeferredContinuation, type UltrafixReadinessResult } from './ultrafixOrchestrationService.js';
import { applyUltrafixCiDeferral } from './ultrafixCiWait.js';
import {
    enqueueNextStep,
    evaluateReadiness,
    findOutstandingUltrafixWork,
    finishUltrafixLoop,
    hasUltrafixLabel,
} from './ultrafixLoopContinuationHelpers.js';
import type { CheckRunDeps, ContinuationResult, UltrafixContinuationParams } from './ultrafixLoopContinuation.js';
import {
    evaluateStrandedLoopRearm,
    getNextStepNumber,
    loadStateSnapshot,
    RESUME_CLAIM_LOST_REASON,
    reserveStateWorkEpoch,
} from './ultrafixResumeClaim.js';
import type { ResumeClaim, StrandedLoopRearmDecision, UltrafixPrId, UltrafixStateSnapshot } from './ultrafixResumeClaim.js';

/** Bound on re-evaluations when the loop state changes underneath a re-arm. */
const MAX_REARM_ATTEMPTS = 3;

/**
 * Sweep cadence for a loop held only by its own in-flight step. That step's
 * continuation owns the loop, so the retry is just a backstop in case the step
 * never settles it, not something to re-run every sweep.
 */
export const IN_FLIGHT_STEP_RETRY_DELAY_MS = 15 * 60_000;

const STATE_CHANGED = Symbol('state_changed');
const CLAIM_LOST = Symbol('claim_lost');

function claimLost(): ContinuationResult {
    return { continued: false, reason: RESUME_CLAIM_LOST_REASON };
}

/** Dependencies of one re-arm attempt, run under a held resume claim. */
export interface StrandedLoopRearmContext {
    redisClient: Redis;
    correlatedLogger: Logger;
    checkRunDeps: CheckRunDeps;
    claim: ResumeClaim;
}

/**
 * Re-arm an active loop whose deferred continuation was cleared or superseded.
 * The caller must hold the resume claim (see `withResumeClaim`).
 *
 * Nothing is decided while Ultrafix work is still queued, running, or batched:
 * that work's own continuation owns the loop, including its terminal
 * bookkeeping. Every circuit breaker still applies: the loop must be active
 * and labelled, within its cycle budget, and short of its goal. A review is
 * only scheduled when the PR is idle (no Ultrafix job in flight, no pending
 * batched comments) and its head checks are green. If the loop state changes
 * while this is being decided, the decision is discarded and recomputed from
 * the new state.
 */
export async function rearmStrandedUltrafixLoop(
    prId: UltrafixPrId,
    ctx: StrandedLoopRearmContext,
): Promise<ContinuationResult> {
    for (let attempt = 1; attempt <= MAX_REARM_ATTEMPTS; attempt++) {
        const result = await rearmFromSnapshot(prId, ctx);
        if (result !== STATE_CHANGED) return result;
        ctx.correlatedLogger.info({ pr: prId.pr, attempt }, 'Ultrafix re-arm: loop state changed, re-evaluating');
    }
    return { continued: false, reason: 'ultrafix_superseded' };
}

type RearmAttemptResult = ContinuationResult | typeof STATE_CHANGED;

/** One snapshot-bound attempt: every write it makes is conditional on `snapshot`. */
interface RearmAttempt {
    prId: UltrafixPrId;
    ctx: StrandedLoopRearmContext;
    snapshot: UltrafixStateSnapshot;
    currentEpoch: number;
}

async function rearmFromSnapshot(prId: UltrafixPrId, ctx: StrandedLoopRearmContext): Promise<RearmAttemptResult> {
    const { owner, repo, pr } = prId;
    const { redisClient, correlatedLogger } = ctx;
    const snapshot = await loadStateSnapshot(redisClient, owner, repo, pr);
    const decision = evaluateStrandedLoopRearm(snapshot?.state ?? null);
    if (!snapshot || decision.action === 'skip') return { continued: false, reason: 'no_active_loop' };

    // A queued or running step (e.g. a permitted final fix) is not stranded:
    // finishing or clearing the loop here would cut that continuation off.
    const { reasons: outstanding, currentStepsOnly } = await findOutstandingUltrafixWork(owner, repo, pr, redisClient);
    if (outstanding.length > 0) {
        correlatedLogger.info({ pr, outstanding }, 'Ultrafix re-arm: Ultrafix work outstanding, leaving loop to it');
        return {
            continued: false,
            reason: `rearm_not_ready: ${outstanding.join(', ')}`,
            ...(currentStepsOnly ? { retryDelayMs: IN_FLIGHT_STEP_RETRY_DELAY_MS } : {}),
        };
    }

    const attempt: RearmAttempt = {
        prId, ctx, snapshot,
        currentEpoch: await getUltrafixAutomaticWorkEpoch(redisClient, owner, repo, pr),
    };
    if (!await hasUltrafixLabel(owner, repo, pr, correlatedLogger)) return clearUnlabelledLoop(attempt);
    if (decision.action === 'complete') return completeStrandedLoop(attempt, decision);
    return enqueueRearmReview(attempt);
}

/**
 * Hand the snapshot's loop to a freshly reserved epoch (the returned state
 * carries it), so the re-armed step is fenced like any other automatic step.
 * Startup reserves its epoch and commits its state under the label transition
 * lease, so taking ownership under it never lands in between.
 */
function takeOwnership({ prId, ctx, snapshot, currentEpoch }: RearmAttempt) {
    return withUltrafixLabelTransition(
        ctx.redisClient,
        prId,
        async () => (await ctx.claim.confirm() ? reserveStateWorkEpoch(ctx.redisClient, snapshot, currentEpoch) : CLAIM_LOST),
    );
}

function buildRearmParams({ prId, ctx, snapshot }: RearmAttempt, workEpoch: number): UltrafixContinuationParams {
    const { state } = snapshot;
    return {
        owner: prId.owner,
        repo: prId.repo,
        pullRequestNumber: prId.pr,
        completedAction: state.lastAction ?? 'review',
        ...(state.userId ? { userId: state.userId } : {}),
        ultrafixMeta: {
            mode: 'ultrafix',
            goal: state.goal,
            maxCycles: state.maxCycles,
            pauseSeconds: state.pauseSeconds,
            reviewModel: state.reviewModel || undefined,
            // The deferred record that carried them is gone; the loop state keeps them.
            instructions: state.instructions ?? '',
            workEpoch,
        },
        redisClient: ctx.redisClient,
        correlatedLogger: ctx.correlatedLogger,
        correlationId: generateCorrelationId(),
    };
}

async function clearUnlabelledLoop({ prId, ctx, snapshot, currentEpoch }: RearmAttempt): Promise<RearmAttemptResult> {
    const { redisClient } = ctx;
    const { state } = snapshot;
    ctx.correlatedLogger.info({ pr: prId.pr }, 'Ultrafix re-arm: label removed, clearing stranded loop');
    const cleared = await withUltrafixLabelTransition(
        redisClient,
        prId,
        async () => (await ctx.claim.confirm()
            ? clearUltrafixStateIfUnchanged(redisClient, prId, { workEpoch: currentEpoch, rawState: snapshot.raw })
            : CLAIM_LOST),
    );
    if (cleared === CLAIM_LOST) return claimLost();
    if (!cleared) return STATE_CHANGED;
    await clearDeferredContinuationIfCurrent(redisClient, prId, currentEpoch);
    return {
        continued: false, reason: 'label_removed', outcome: 'stopped',
        cycleCount: state.cycleCount, goal: state.goal, maxCycles: state.maxCycles,
    };
}

async function completeStrandedLoop(
    attempt: RearmAttempt,
    decision: Extract<StrandedLoopRearmDecision, { action: 'complete' }>,
): Promise<RearmAttemptResult> {
    // Take ownership first so terminal bookkeeping passes the epoch fence.
    const owned = await takeOwnership(attempt);
    if (owned === CLAIM_LOST) return claimLost();
    if (!owned) return STATE_CHANGED;
    if (!await attempt.ctx.claim.confirm()) return claimLost();
    attempt.ctx.correlatedLogger.info(
        { pr: attempt.prId.pr, completionStatus: decision.completionStatus, reason: decision.reason },
        'Ultrafix re-arm: circuit breaker tripped, finishing loop',
    );
    const params = buildRearmParams(attempt, owned.workEpoch);
    const succeeded = decision.completionStatus === 'succeeded';
    return finishUltrafixLoop({
        params: { ...params, completedAction: succeeded ? 'review' : params.completedAction },
        state: owned,
        latestScore: owned.finalScore,
        reviewStatus: succeeded ? 'valid_clean' : 'invalid',
        isPartial: false,
        decisionReason: decision.reason,
    });
}

async function enqueueRearmReview(attempt: RearmAttempt): Promise<RearmAttemptResult> {
    const { prId: { pr }, ctx, snapshot, currentEpoch } = attempt;
    const readiness = await evaluateReadiness(buildRearmParams(attempt, currentEpoch), 'review', ctx.checkRunDeps);
    ctx.correlatedLogger.info(
        { pr, ready: readiness.ready, reasons: readiness.reasons },
        'Ultrafix re-arm: readiness check for stranded loop',
    );
    if (!readiness.ready) {
        if (readiness.reasons.every(reason => reason === 'checks_not_passing')) {
            return deferRearmedReview(attempt, readiness);
        }
        return { continued: false, reason: `rearm_not_ready: ${readiness.reasons.join(', ')}` };
    }

    const owned = await takeOwnership(attempt);
    if (owned === CLAIM_LOST) return claimLost();
    if (!owned) return STATE_CHANGED;
    if (!await ctx.claim.confirm()) return claimLost();

    const enqueued = await enqueueNextStep(
        buildRearmParams(attempt, owned.workEpoch),
        'review',
        (owned.pauseSeconds || 60) * 1000,
        getNextStepNumber(owned, 'review'),
    );
    if (!enqueued) return { continued: false, reason: 'rearm_duplicate' };

    ctx.correlatedLogger.info(
        { pr, workEpoch: owned.workEpoch, previousWorkEpoch: snapshot.state.workEpoch },
        'Ultrafix re-arm: enqueued review for stranded loop',
    );
    return {
        continued: true,
        reason: 'stranded_loop_rearmed',
        nextAction: 'review',
        cycleCount: owned.cycleCount,
    };
}

/**
 * The loop is idle and only CI holds the review back: take ownership and turn
 * it back into an ordinary deferred review under its reserved epoch. The CI
 * wait then applies exactly as for any deferral — one notice per head, and
 * the loop stops with "CI did not settle" once `ultrafix_ci_wait_timeout_ms`
 * elapses — and the deferred record keeps the review durable for the sweep.
 */
async function deferRearmedReview(
    attempt: RearmAttempt,
    readiness: UltrafixReadinessResult,
): Promise<RearmAttemptResult> {
    const { prId, ctx } = attempt;
    const owned = await takeOwnership(attempt);
    if (owned === CLAIM_LOST) return claimLost();
    if (!owned) return STATE_CHANGED;
    if (!await ctx.claim.confirm()) return claimLost();
    const { workEpoch } = owned;
    const params = buildRearmParams(attempt, workEpoch);

    const reasons = readiness.reasons.join(', ');
    const saved = await saveDeferredContinuation(ctx.redisClient, {
        owner: prId.owner,
        repo: prId.repo,
        pr: prId.pr,
        nextAction: 'review',
        savedAt: new Date().toISOString(),
        reason: reasons,
        ...(params.userId ? { userId: params.userId } : {}),
        ultrafixMeta: params.ultrafixMeta,
        workEpoch,
    });
    if (!saved) return { continued: false, reason: 'ultrafix_superseded' };
    ctx.correlatedLogger.info({ pr: prId.pr, workEpoch, reasons }, 'Ultrafix re-arm: CI not green, review deferred under its reserved epoch');

    if (!await ctx.claim.confirm()) return claimLost();
    const ci = await applyUltrafixCiDeferral(params, readiness, owned);
    return ci.terminal ?? {
        continued: false,
        deferred: true,
        reason: `rearm_deferred: ${reasons}`,
        nextAction: 'review',
        cycleCount: owned.cycleCount,
        ...ci.extra,
    };
}
