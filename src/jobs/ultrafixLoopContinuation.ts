/**
 * Ultrafix Loop Continuation
 *
 * Called after review or fix job completion to decide whether
 * the ultrafix cycle should continue and enqueue the next step.
 */

import type { Logger } from 'pino';
import { recordUltrafixEscalationReview } from './ultrafixEscalation.js';
import type { Redis } from 'ioredis';
import {
    generateCorrelationId,
    getAuthenticatedOctokit,
    withRetry,
    retryConfigs,
    type UltrafixCommandMeta,
} from '@propr/core';
import {
    loadState,
    claimDeferredContinuation,
    recordAction,
    clearUltrafixStateIfCurrent,
    determineNextAction,
    recordReviewFindings,
    saveDeferredContinuation,
    clearDeferredContinuationIfCurrent,
    clearRearmRetry,
    getUltrafixAutomaticWorkEpoch,
    isUltrafixAutomaticWorkCurrent,
    listDeferredContinuationKeys,
    listRearmRetryKeys,
    parseDeferredKey,
    parseRearmRetryKey,
    saveRearmRetry,
} from './ultrafixOrchestrationService.js';
import type { UltrafixAction, UltrafixCheckStatus, UltrafixLoopState, UltrafixReadinessResult } from './ultrafixOrchestrationService.js';
import { fetchAllComments } from './prCommentJobUtils.js';
import { getPendingReviewState } from './reviewCommentGatherer.js';
import type { ReviewOutputStatus } from './reviewCommentGatherer.js';
import {
    enqueueNextStep,
    evaluateReadiness,
    finishUltrafixLoop,
    hasUltrafixLabel,
} from './ultrafixLoopContinuationHelpers.js';
import { applyUltrafixCiDeferral } from './ultrafixCiWait.js';
import { rearmStrandedUltrafixLoop } from './ultrafixStrandedLoopRearm.js';
import { getNextStepNumber, RESUME_CLAIM_LOST_REASON, withResumeClaim, type ResumeClaim } from './ultrafixResumeClaim.js';

export interface UltrafixContinuationParams {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    completedAction: UltrafixAction;
    userId?: string;
    ultrafixMeta?: UltrafixCommandMeta;
    redisClient: Redis;
    correlatedLogger: Logger;
    correlationId: string;
    /** The ID of the current job running this continuation, to exclude from queue checks */
    currentJobId?: string;
    /** Review comment IDs posted by the current job. Empty means the current review produced no usable output. */
    currentReviewCommentIds?: number[];
    /** Number of review results the current job attempted to post. */
    currentReviewResultCount?: number;
}

// --- Dependency injection for check_run status ---

export type ChecksPassingFn = (owner: string, repo: string, ref: string) => Promise<boolean>;
export type GetPRHeadFn = (owner: string, repo: string, pr: number) => Promise<string | null>;
export type GetCheckRunsStatusFn = (owner: string, repo: string, ref: string) => Promise<UltrafixCheckStatus>;

let _areAllChecksPassing: ChecksPassingFn | null = null;
let _getCurrentPRHead: GetPRHeadFn | null = null;
let _getCheckRunsStatus: GetCheckRunsStatusFn | null = null;

export function setCheckRunDeps(deps: {
    areAllChecksPassing: ChecksPassingFn;
    getCurrentPRHead: GetPRHeadFn;
    getCheckRunsStatus?: GetCheckRunsStatusFn;
}): void {
    _areAllChecksPassing = deps.areAllChecksPassing;
    _getCurrentPRHead = deps.getCurrentPRHead;
    _getCheckRunsStatus = deps.getCheckRunsStatus ?? null;
}

export type CheckRunDeps = Parameters<typeof evaluateReadiness>[2];

/** The step this continuation would enqueue is already queued or running; that job owns the loop. */
export const NEXT_STEP_ALREADY_QUEUED_REASON = 'next_step_already_queued';

function getCheckRunDeps(): CheckRunDeps {
    return {
        areAllChecksPassing: _areAllChecksPassing,
        getCurrentPRHead: _getCurrentPRHead,
        getCheckRunsStatus: _getCheckRunsStatus,
    };
}

export interface ContinuationResult {
    continued: boolean;
    reason: string;
    nextAction?: UltrafixAction;
    score?: number | null;
    cycleCount?: number;
    deferred?: boolean;
    outcome?: 'goal_reached' | 'cycles_exhausted' | 'stopped' | 'failed';
    goal?: number;
    maxCycles?: number;
    /** Blocking checks holding a deferred review back (non-blocking checks are never listed). */
    blockingChecks?: string[];
}

async function deferNextAction(
    input: {
        params: UltrafixContinuationParams;
        nextAction: UltrafixAction;
        readiness: UltrafixReadinessResult;
        latestScore: number | null;
        state: UltrafixLoopState;
    },
): Promise<ContinuationResult> {
    const { params, nextAction, readiness, readiness: { reasons }, latestScore, state, state: { cycleCount } } = input;
    const { owner, repo, pullRequestNumber, redisClient, correlatedLogger } = params;
    const saved = await saveDeferredContinuation(redisClient, {
        owner,
        repo,
        pr: pullRequestNumber,
        nextAction,
        savedAt: new Date().toISOString(),
        reason: reasons.join(', '),
        ...(params.userId ? { userId: params.userId } : {}),
        ultrafixMeta: params.ultrafixMeta,
        workEpoch: params.ultrafixMeta?.workEpoch,
    });
    if (!saved) return { continued: false, reason: 'ultrafix_superseded' };
    correlatedLogger.info(
        { pullRequestNumber, nextAction, blockingReasons: reasons },
        'Ultrafix loop: deferred continuation — waiting for readiness',
    );
    const ci = await applyUltrafixCiDeferral(params, readiness, { ...state, lastScore: latestScore });
    return ci.terminal ?? {
        continued: false, deferred: true,
        reason: `deferred: ${reasons.join(', ')}`,
        nextAction, score: latestScore, cycleCount, ...ci.extra,
    };
}

async function enqueueCurrentNextAction(
    input: {
        params: UltrafixContinuationParams;
        nextAction: UltrafixAction;
        decisionReason: string;
        latestScore: number | null;
        state: UltrafixLoopState;
    },
): Promise<ContinuationResult> {
    const { params, nextAction, decisionReason, latestScore, state, state: { cycleCount, pauseSeconds } } = input;
    const { owner, repo, pullRequestNumber, redisClient } = params;
    const cleared = await clearDeferredContinuationIfCurrent(
        redisClient,
        { owner, repo, pr: pullRequestNumber },
        params.ultrafixMeta?.workEpoch ?? 0,
    );
    if (!cleared) return { continued: false, reason: 'ultrafix_superseded' };
    const enqueued = await enqueueNextStep(params, nextAction, (pauseSeconds || 60) * 1000, getNextStepNumber(state, nextAction));
    if (!enqueued) {
        return { continued: false, reason: NEXT_STEP_ALREADY_QUEUED_REASON, nextAction, score: latestScore, cycleCount };
    }
    return {
        continued: true, reason: decisionReason,
        nextAction, score: latestScore, cycleCount,
    };
}

async function collectReviewOutput(
    params: UltrafixContinuationParams,
    goal: number,
): Promise<{ latestScore: number | null; reviewStatus: ReviewOutputStatus; isPartial: boolean }> {
    if (params.completedAction !== 'review') {
        return { latestScore: null, reviewStatus: 'invalid', isPartial: false };
    }
    const { owner, repo, pullRequestNumber, redisClient, correlatedLogger, correlationId } = params;
    try {
        const octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit_ultrafix_score',
        );
        const allComments = await fetchAllComments(octokit, owner, repo, pullRequestNumber);
        const pendingState = await getPendingReviewState(allComments, {
            repoOwner: owner, repoName: repo, pullRequestNumber, redisClient, correlatedLogger,
            currentReviewCommentIds: params.currentReviewCommentIds ?? [],
            currentReviewResultCount: params.currentReviewResultCount ?? 0,
        });
        if (pendingState.reviewStatus !== 'invalid') {
            await recordReviewFindings(redisClient, {
                owner,
                repo,
                pr: pullRequestNumber,
                workEpoch: params.ultrafixMeta?.workEpoch ?? 0,
                findings: pendingState.unprocessedComments.flatMap(comment =>
                    comment.actionableFindings.map(finding => ({
                        id: finding.id,
                        sourceCommentId: comment.id,
                        title: finding.title,
                    })),
                ),
            });
        }
        correlatedLogger.info(
            {
                pullRequestNumber,
                latestScore: pendingState.latestScore,
                reviewStatus: pendingState.reviewStatus,
                isPartial: pendingState.isPartial,
                goal,
            },
            'Ultrafix loop: parsed latest review output',
        );
        return {
            latestScore: pendingState.latestScore,
            reviewStatus: pendingState.reviewStatus,
            isPartial: pendingState.isPartial,
        };
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Ultrafix loop: failed to parse review output, scheduling a review retry',
        );
        return { latestScore: null, reviewStatus: 'invalid', isPartial: false };
    }
}

async function applyReviewEscalation(
    params: UltrafixContinuationParams,
    state: UltrafixLoopState,
    review: Awaited<ReturnType<typeof collectReviewOutput>>,
    decision: ReturnType<typeof determineNextAction>,
): Promise<UltrafixLoopState | null> {
    const { completedAction, redisClient } = params;
    const { latestScore, reviewStatus, isPartial } = review;
    // Existing goal, coverage, invalid-output, and overall cycle limits take precedence.
    if (completedAction === 'review' && latestScore !== null && !isPartial
        && reviewStatus !== 'invalid' && decision.action !== null) {
        const escalatedState = await recordUltrafixEscalationReview(redisClient, state, latestScore);
        if (!escalatedState) return null;
        state = escalatedState;
        if (state.escalation?.exhausted) {
            decision.action = null;
            decision.reason = 'Escalation exhausted: all available models and reasoning levels stalled';
        }
    }
    return state;
}

/**
 * Main continuation entry point. Call after a review or fix step completes
 * to decide whether to continue the ultrafix loop.
 *
 * Returns a ContinuationResult describing what happened.
 */
export async function continueUltrafixLoop(
    params: UltrafixContinuationParams,
): Promise<ContinuationResult> {
    const {
        owner, repo, pullRequestNumber, completedAction,
        redisClient, correlatedLogger,
    } = params;
    const workEpoch = params.ultrafixMeta?.workEpoch ?? 0;

    if (!await isUltrafixAutomaticWorkCurrent(
        redisClient,
        { owner, repo, pr: pullRequestNumber },
        workEpoch,
    )) {
        return { continued: false, reason: 'ultrafix_superseded', outcome: 'stopped' };
    }

    // 1. Load current loop state
    const state = await loadState(redisClient, owner, repo, pullRequestNumber);
    const stateWorkEpoch = typeof state?.workEpoch === 'number' ? state.workEpoch : 0;
    if (!state || !state.active || stateWorkEpoch !== workEpoch) {
        correlatedLogger.info(
            { pullRequestNumber, hasState: !!state },
            'Ultrafix loop: no active loop state, skipping continuation',
        );
        return {
            continued: false,
            reason: state && stateWorkEpoch !== workEpoch ? 'ultrafix_superseded' : 'no_active_loop',
            outcome: 'stopped',
        };
    }

    // 2. Record the completed action
    let updatedState = await recordAction(redisClient, {
        owner, repo, pr: pullRequestNumber, action: completedAction, workEpoch,
    });
    if (!updatedState) {
        // One epoch read decides both fields, so they cannot disagree when the
        // epoch moves between two separate Redis reads.
        const stillCurrent = await isUltrafixAutomaticWorkCurrent(
            redisClient,
            { owner, repo, pr: pullRequestNumber },
            workEpoch,
        );
        return stillCurrent
            ? { continued: false, reason: 'state_lost_after_record', outcome: 'failed' }
            : { continued: false, reason: 'ultrafix_superseded', outcome: 'stopped' };
    }

    correlatedLogger.info(
        { pullRequestNumber, completedAction, cycleCount: updatedState.cycleCount, goal: updatedState.goal },
        'Ultrafix loop: recorded completed action',
    );

    // 3. Check if ultrafix label is still present
    const labelPresent = await hasUltrafixLabel(owner, repo, pullRequestNumber, correlatedLogger);
    if (!labelPresent) {
        correlatedLogger.info({ pullRequestNumber }, 'Ultrafix loop: label removed, stopping loop');
        const stateCleared = await clearUltrafixStateIfCurrent(
            redisClient,
            { owner, repo, pr: pullRequestNumber },
            workEpoch,
        );
        if (!stateCleared) return { continued: false, reason: 'ultrafix_superseded' };
        await clearDeferredContinuationIfCurrent(
            redisClient,
            { owner, repo, pr: pullRequestNumber },
            workEpoch,
        );
        return { continued: false, reason: 'label_removed', cycleCount: updatedState.cycleCount,
            outcome: 'stopped', goal: updatedState.goal, maxCycles: updatedState.maxCycles };
    }

    // 4. Get the latest review score
    const { latestScore, reviewStatus, isPartial } = await collectReviewOutput(params, updatedState.goal);

    // 5. Determine next action
    const decision = determineNextAction(updatedState, latestScore, reviewStatus, isPartial);
    updatedState = await applyReviewEscalation(params, updatedState, { latestScore, reviewStatus, isPartial }, decision);
    if (!updatedState) return { continued: false, reason: 'ultrafix_superseded' };
    correlatedLogger.info(
        { pullRequestNumber, nextAction: decision.action, reason: decision.reason, latestScore, isPartial },
        'Ultrafix loop: next action decision',
    );

    // 6. If loop should stop, clean up
    if (decision.action === null) {
        return finishUltrafixLoop({
            params,
            state: updatedState,
            latestScore,
            reviewStatus,
            isPartial,
            decisionReason: decision.reason,
        });
    }

    // 7. Readiness gating — verify all conditions before enqueueing
    const readiness = await evaluateReadiness(params, decision.action, getCheckRunDeps());
    correlatedLogger.info(
        { pullRequestNumber, ready: readiness.ready, reasons: readiness.reasons },
        'Ultrafix loop: readiness check',
    );

    if (!readiness.ready) {
        return deferNextAction({
            params, nextAction: decision.action,
            readiness, latestScore, state: updatedState,
        });
    }

    return enqueueCurrentNextAction({
        params,
        nextAction: decision.action,
        decisionReason: decision.reason,
        latestScore,
        state: updatedState,
    });
}

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
        scheduled ||= result.continued;
        if (!scheduled || !leavesLoopWaiting(result.reason)) {
            await settleRearmRetry(prId, result, { redisClient, correlatedLogger, claim });
        }
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
        || reason === 'ultrafix_superseded';
}

/**
 * Record or release the durable retry obligation for this PR. A resume that
 * could not settle the loop (outstanding or unreadable work, a superseded
 * record, a failed enqueue) leaves one so the periodic sweep re-runs it
 * without waiting for another webhook; any settled outcome releases it.
 */
async function settleRearmRetry(
    prId: { owner: string; repo: string; pr: number },
    result: ContinuationResult,
    ctx: { redisClient: Redis; correlatedLogger: Logger; claim: ResumeClaim },
): Promise<void> {
    const { owner, repo, pr } = prId;
    const { redisClient, correlatedLogger, claim } = ctx;
    // The trigger that took the claim over owns the obligation now.
    if (result.reason === RESUME_CLAIM_LOST_REASON) return;
    try {
        if (!leavesLoopWaiting(result.reason)) {
            await clearRearmRetry(redisClient, owner, repo, pr);
            return;
        }
        if (!await claim.confirm()) return;
        await saveRearmRetry(redisClient, {
            owner, repo, pr,
            workEpoch: await getUltrafixAutomaticWorkEpoch(redisClient, owner, repo, pr),
            reason: result.reason,
            savedAt: new Date().toISOString(),
        });
        correlatedLogger.info({ pr, reason: result.reason }, 'Ultrafix resume: recorded retry for unsettled loop');
    } catch (err) {
        correlatedLogger.warn({ pr, error: (err as Error).message }, 'Ultrafix resume: failed to update retry obligation');
    }
}

/**
 * Periodic reconciliation: re-run every deferred continuation and every
 * recorded retry obligation, so a loop whose last trigger could not settle it
 * is retried without another webhook.
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
        if (parsed) candidates.set(`${parsed.owner}/${parsed.repo}#${parsed.pr}`, parsed);
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

    const state = await loadState(redisClient, owner, repo, pr);
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
        const saved = await saveDeferredContinuation(redisClient, { ...deferred, workEpoch });
        if (!saved) return { continued: false, reason: 'deferred_cancelled' };
        if (!await claim.confirm()) return { continued: false, reason: RESUME_CLAIM_LOST_REASON };
        const ci = await applyUltrafixCiDeferral(params, readiness, state);
        return ci.terminal ?? {
            continued: false,
            reason: `still_deferred: ${readiness.reasons.join(', ')}`,
            deferred: true, ...ci.extra,
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
    };
}
