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
    syncStateWorkEpoch,
} from './ultrafixResumeClaim.js';
import type { ResumeClaim, StrandedLoopRearmDecision, UltrafixPrId, UltrafixStateSnapshot } from './ultrafixResumeClaim.js';

/** Bound on re-evaluations when the loop state changes underneath a re-arm. */
const MAX_REARM_ATTEMPTS = 3;

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
    const outstanding = await findOutstandingUltrafixWork(owner, repo, pr, redisClient);
    if (outstanding.length > 0) {
        correlatedLogger.info({ pr, outstanding }, 'Ultrafix re-arm: Ultrafix work outstanding, leaving loop to it');
        return { continued: false, reason: `rearm_not_ready: ${outstanding.join(', ')}` };
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
 * Hand the snapshot's loop to the current epoch. Startup reserves its epoch and
 * commits its state under the label transition lease, so taking ownership
 * under it never lands in between.
 */
function takeOwnership({ prId, ctx, snapshot, currentEpoch }: RearmAttempt) {
    return withUltrafixLabelTransition(
        ctx.redisClient,
        prId,
        async () => (await ctx.claim.confirm() ? syncStateWorkEpoch(ctx.redisClient, snapshot, currentEpoch) : CLAIM_LOST),
    );
}

function buildRearmParams({ prId, ctx, snapshot, currentEpoch }: RearmAttempt): UltrafixContinuationParams {
    const { state } = snapshot;
    return {
        owner: prId.owner,
        repo: prId.repo,
        pullRequestNumber: prId.pr,
        completedAction: state.lastAction ?? 'review',
        ultrafixMeta: {
            mode: 'ultrafix',
            goal: state.goal,
            maxCycles: state.maxCycles,
            pauseSeconds: state.pauseSeconds,
            reviewModel: state.reviewModel || undefined,
            instructions: '',
            workEpoch: currentEpoch,
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
    const params = buildRearmParams(attempt);
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
    const params = buildRearmParams(attempt);
    const readiness = await evaluateReadiness(params, 'review', ctx.checkRunDeps);
    ctx.correlatedLogger.info(
        { pr, ready: readiness.ready, reasons: readiness.reasons },
        'Ultrafix re-arm: readiness check for stranded loop',
    );
    if (!readiness.ready) {
        return { continued: false, reason: `rearm_not_ready: ${readiness.reasons.join(', ')}` };
    }

    const owned = await takeOwnership(attempt);
    if (owned === CLAIM_LOST) return claimLost();
    if (!owned) return STATE_CHANGED;
    if (!await ctx.claim.confirm()) return claimLost();

    const enqueued = await enqueueNextStep(
        params,
        'review',
        (owned.pauseSeconds || 60) * 1000,
        getNextStepNumber(owned, 'review'),
    );
    if (!enqueued) return { continued: false, reason: 'rearm_duplicate' };

    ctx.correlatedLogger.info(
        { pr, workEpoch: currentEpoch, previousWorkEpoch: snapshot.state.workEpoch },
        'Ultrafix re-arm: enqueued review for stranded loop',
    );
    return {
        continued: true,
        reason: 'stranded_loop_rearmed',
        nextAction: 'review',
        cycleCount: owned.cycleCount,
    };
}
