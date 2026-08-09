/**
 * Ultrafix Loop Continuation
 *
 * Called after review or fix job completion to decide whether
 * the ultrafix cycle should continue and enqueue the next step.
 */

import type { Logger } from 'pino';
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
    completeLoop,
    determineNextAction,
    hasReviewReachedGoal,
    recordReviewFindings,
    saveDeferredContinuation,
    clearDeferredContinuationIfCurrent,
    isUltrafixAutomaticWorkCurrent,
} from './ultrafixOrchestrationService.js';
import type { UltrafixAction } from './ultrafixOrchestrationService.js';
import { fetchAllComments } from './prCommentJobUtils.js';
import { getPendingReviewState } from './reviewCommentGatherer.js';
import type { ReviewOutputStatus } from './reviewCommentGatherer.js';
import {
    enqueueNextStep,
    evaluateReadiness,
    ensureUltrafixLabel,
    hasUltrafixLabel,
    maybeEnableAutoMerge,
    postPrComment,
    removeUltrafixLabel,
} from './ultrafixLoopContinuationHelpers.js';

export interface UltrafixContinuationParams {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    completedAction: UltrafixAction;
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
export type GetCheckRunsStatusFn = (owner: string, repo: string, ref: string) => Promise<{ count: number; allPassing: boolean; anyPending: boolean; anyFailed: boolean }>;

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

export interface ContinuationResult {
    continued: boolean;
    reason: string;
    nextAction?: UltrafixAction;
    score?: number | null;
    cycleCount?: number;
    deferred?: boolean;
}

async function deferNextAction(
    input: {
        params: UltrafixContinuationParams;
        nextAction: UltrafixAction;
        reasons: string[];
        latestScore: number | null;
        cycleCount: number;
    },
): Promise<ContinuationResult> {
    const { params, nextAction, reasons, latestScore, cycleCount } = input;
    const { owner, repo, pullRequestNumber, redisClient, correlatedLogger } = params;
    const saved = await saveDeferredContinuation(redisClient, {
        owner,
        repo,
        pr: pullRequestNumber,
        nextAction,
        savedAt: new Date().toISOString(),
        reason: reasons.join(', '),
        ultrafixMeta: params.ultrafixMeta,
        workEpoch: params.ultrafixMeta?.workEpoch,
    });
    if (!saved) return { continued: false, reason: 'ultrafix_superseded' };
    correlatedLogger.info(
        { pullRequestNumber, nextAction, blockingReasons: reasons },
        'Ultrafix loop: deferred continuation — waiting for readiness',
    );
    return {
        continued: false,
        reason: `deferred: ${reasons.join(', ')}`,
        nextAction,
        score: latestScore,
        cycleCount,
        deferred: true,
    };
}

async function enqueueCurrentNextAction(
    input: {
        params: UltrafixContinuationParams;
        nextAction: UltrafixAction;
        decisionReason: string;
        latestScore: number | null;
        cycleCount: number;
        pauseSeconds: number;
    },
): Promise<ContinuationResult> {
    const { params, nextAction, decisionReason, latestScore, cycleCount, pauseSeconds } = input;
    const { owner, repo, pullRequestNumber, redisClient } = params;
    const cleared = await clearDeferredContinuationIfCurrent(
        redisClient,
        { owner, repo, pr: pullRequestNumber },
        params.ultrafixMeta?.workEpoch ?? 0,
    );
    if (!cleared) return { continued: false, reason: 'ultrafix_superseded' };
    await enqueueNextStep(params, nextAction, (pauseSeconds || 60) * 1000);
    return {
        continued: true,
        reason: decisionReason,
        nextAction,
        score: latestScore,
        cycleCount,
    };
}

async function collectReviewOutput(
    params: UltrafixContinuationParams,
    goal: number,
): Promise<{ latestScore: number | null; reviewStatus: ReviewOutputStatus }> {
    if (params.completedAction !== 'review') {
        return { latestScore: null, reviewStatus: 'invalid' };
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
                goal,
            },
            'Ultrafix loop: parsed latest review output',
        );
        return {
            latestScore: pendingState.latestScore,
            reviewStatus: pendingState.reviewStatus,
        };
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Ultrafix loop: failed to parse review output, scheduling a review retry',
        );
        return { latestScore: null, reviewStatus: 'invalid' };
    }
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
        return { continued: false, reason: 'ultrafix_superseded' };
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
        };
    }

    // 2. Record the completed action
    const updatedState = await recordAction(redisClient, {
        owner, repo, pr: pullRequestNumber, action: completedAction, workEpoch,
    });
    if (!updatedState) {
        return {
            continued: false,
            reason: await isUltrafixAutomaticWorkCurrent(
                redisClient,
                { owner, repo, pr: pullRequestNumber },
                workEpoch,
            ) ? 'state_lost_after_record' : 'ultrafix_superseded',
        };
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
        return { continued: false, reason: 'label_removed', cycleCount: updatedState.cycleCount };
    }

    // 4. Get the latest review score
    const { latestScore, reviewStatus } = await collectReviewOutput(params, updatedState.goal);

    // 5. Determine next action
    const decision = determineNextAction(updatedState, latestScore, reviewStatus);
    correlatedLogger.info(
        { pullRequestNumber, nextAction: decision.action, reason: decision.reason, latestScore },
        'Ultrafix loop: next action decision',
    );

    // 6. If loop should stop, clean up
    if (decision.action === null) {
        if (!await isUltrafixAutomaticWorkCurrent(
            redisClient,
            { owner, repo, pr: pullRequestNumber },
            workEpoch,
        )) {
            return { continued: false, reason: 'ultrafix_superseded' };
        }
        const goalReached = completedAction === 'review'
            && hasReviewReachedGoal(reviewStatus, latestScore, updatedState.goal);
        const completedState = await completeLoop(redisClient, {
            owner,
            repo,
            pr: pullRequestNumber,
            completionStatus: goalReached ? 'succeeded' : 'failed',
            completionReason: decision.reason,
            finalScore: latestScore,
            workEpoch,
        });
        if (!completedState) return { continued: false, reason: 'ultrafix_superseded' };
        if (goalReached) {
            await removeUltrafixLabel(owner, repo, pullRequestNumber, correlatedLogger);
            const stateCleared = await clearUltrafixStateIfCurrent(
                redisClient,
                { owner, repo, pr: pullRequestNumber },
                workEpoch,
            );
            if (!stateCleared) {
                await ensureUltrafixLabel(owner, repo, pullRequestNumber, correlatedLogger);
                return { continued: false, reason: 'ultrafix_superseded' };
            }
            await clearDeferredContinuationIfCurrent(
                redisClient,
                { owner, repo, pr: pullRequestNumber },
                workEpoch,
            );
            await maybeEnableAutoMerge(owner, repo, pullRequestNumber, correlatedLogger);
        } else {
            const stoppedBecauseCleanReviewMissedGoal = completedAction === 'review'
                && reviewStatus === 'valid_clean';
            const manualReason = stoppedBecauseCleanReviewMissedGoal
                ? 'The review has no actionable blockers, so no fix was scheduled. Manual review and merge are now required.'
                : 'Max cycles were exhausted, so manual review and merge are now required.';
            await postPrComment({
                owner,
                repo,
                pullRequestNumber,
                body: `⚠️ **Ultrafix stopped before reaching its goal.** Requested goal: ${updatedState.goal}/10. Last score: ${latestScore ?? 'unknown'}. ${manualReason}`,
                correlatedLogger,
            });
        }
        correlatedLogger.info(
            { pullRequestNumber, reason: decision.reason, cycleCount: updatedState.cycleCount, goalReached },
            'Ultrafix loop: loop finished',
        );
        return {
            continued: false,
            reason: decision.reason,
            score: latestScore,
            cycleCount: updatedState.cycleCount,
        };
    }

    // 7. Readiness gating — verify all conditions before enqueueing
    const readiness = await evaluateReadiness(params, decision.action, {
        areAllChecksPassing: _areAllChecksPassing,
        getCurrentPRHead: _getCurrentPRHead,
        getCheckRunsStatus: _getCheckRunsStatus,
    });
    correlatedLogger.info(
        { pullRequestNumber, ready: readiness.ready, reasons: readiness.reasons },
        'Ultrafix loop: readiness check',
    );

    if (!readiness.ready) {
        return deferNextAction({
            params,
            nextAction: decision.action,
            reasons: readiness.reasons,
            latestScore,
            cycleCount: updatedState.cycleCount,
        });
    }

    return enqueueCurrentNextAction({
        params,
        nextAction: decision.action,
        decisionReason: decision.reason,
        latestScore,
        cycleCount: updatedState.cycleCount,
        pauseSeconds: updatedState.pauseSeconds,
    });
}

/**
 * Resume a deferred ultrafix continuation. Called when a check_run event
 * indicates that checks may now be green for a PR with a waiting loop.
 *
 * Re-evaluates readiness. If ready, enqueues the next step and clears the
 * deferred record. If still not ready, leaves the deferred record in place.
 */
export async function resumeDeferredContinuation(
    prId: { owner: string; repo: string; pr: number },
    redisClient: Redis,
    correlatedLogger: Logger,
): Promise<ContinuationResult> {
    const { owner, repo, pr } = prId;
    // Atomically claim the deferred record so concurrent check_run events
    // for the same PR cannot double-enqueue the next step.
    const deferred = await claimDeferredContinuation(redisClient, owner, repo, pr);
    if (!deferred) {
        return { continued: false, reason: 'no_deferred_continuation' };
    }

    const workEpoch = deferred.workEpoch ?? deferred.ultrafixMeta?.workEpoch;
    if (!await isUltrafixAutomaticWorkCurrent(
        redisClient,
        { owner, repo, pr },
        workEpoch,
    )) {
        return { continued: false, reason: 'deferred_cancelled' };
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
        instructions: '',
        }),
        workEpoch,
    };
    const params: UltrafixContinuationParams = {
        owner,
        repo,
        pullRequestNumber: pr,
        completedAction: state.lastAction ?? 'review',
        ultrafixMeta,
        redisClient,
        correlatedLogger,
        correlationId,
    };

    const readiness = await evaluateReadiness(params, deferred.nextAction, {
        areAllChecksPassing: _areAllChecksPassing,
        getCurrentPRHead: _getCurrentPRHead,
        getCheckRunsStatus: _getCheckRunsStatus,
    });
    correlatedLogger.info(
        { pr, ready: readiness.ready, reasons: readiness.reasons },
        'Ultrafix deferred resume: readiness re-check',
    );

    if (!readiness.ready) {
        // Not ready yet — re-save so a future check_run can try again
        const saved = await saveDeferredContinuation(redisClient, {
            ...deferred,
            workEpoch,
        });
        if (!saved) {
            return { continued: false, reason: 'deferred_cancelled' };
        }
        return {
            continued: false,
            reason: `still_deferred: ${readiness.reasons.join(', ')}`,
            deferred: true,
        };
    }

    if (!await isUltrafixAutomaticWorkCurrent(
        redisClient,
        { owner, repo, pr },
        workEpoch,
    )) {
        return { continued: false, reason: 'deferred_cancelled' };
    }

    const delayMs = (state.pauseSeconds || 60) * 1000;
    await enqueueNextStep(params, deferred.nextAction, delayMs);

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
