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
    clearStateWithLease,
    completeLoop,
    determineNextAction,
    hasReviewReachedGoal,
    recordReviewFindings,
    saveDeferredContinuation,
    clearDeferredContinuationWithLease,
} from './ultrafixOrchestrationService.js';
import type { UltrafixAction } from './ultrafixOrchestrationService.js';
import type { UltrafixMutationLease } from './ultrafixLeaseTransitions.js';
import { fetchAllComments } from './prCommentJobUtils.js';
import { getPendingReviewState } from './reviewCommentGatherer.js';
import type { ReviewOutputStatus } from './reviewCommentGatherer.js';
import {
    enqueueNextStep,
    evaluateReadiness,
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
    /** Stable publication task identifier used to make continuation recovery idempotent. */
    continuationId?: string;
    /** Live PR lease used to atomically fence the completed-action transition. */
    mutationLease?: UltrafixMutationLease;
    assertLease?: () => Promise<void>;
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

async function assertContinuationLease(params: UltrafixContinuationParams): Promise<void> {
    if (params.assertLease) await params.assertLease();
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
        redisClient, correlatedLogger, correlationId,
    } = params;

    // 1. Load current loop state
    const state = await loadState(redisClient, owner, repo, pullRequestNumber);
    if (!state || !state.active) {
        correlatedLogger.info(
            { pullRequestNumber, hasState: !!state },
            'Ultrafix loop: no active loop state, skipping continuation',
        );
        return { continued: false, reason: 'no_active_loop' };
    }
    if (!params.mutationLease) {
        throw new Error('Ultrafix continuation mutations require a live PR lease');
    }
    const mutationLease = params.mutationLease;

    // 2. Record the completed action
    const updatedState = await recordAction(redisClient, {
        owner, repo, pr: pullRequestNumber, action: completedAction,
        continuationId: params.continuationId,
    }, mutationLease);
    if (!updatedState) {
        return { continued: false, reason: 'state_lost_after_record' };
    }

    correlatedLogger.info(
        { pullRequestNumber, completedAction, cycleCount: updatedState.cycleCount, goal: updatedState.goal },
        'Ultrafix loop: recorded completed action',
    );

    // 3. Check if ultrafix label is still present
    const labelPresent = await hasUltrafixLabel(owner, repo, pullRequestNumber, correlatedLogger);
    if (!labelPresent) {
        correlatedLogger.info({ pullRequestNumber }, 'Ultrafix loop: label removed, stopping loop');
        const prId = { owner, repo, pr: pullRequestNumber };
        await clearDeferredContinuationWithLease(redisClient, prId, mutationLease);
        await clearStateWithLease(redisClient, prId, mutationLease);
        return { continued: false, reason: 'label_removed', cycleCount: updatedState.cycleCount };
    }

    // 4. Get the latest review score
    let latestScore: number | null = null;
    let reviewStatus: ReviewOutputStatus = 'invalid';
    if (completedAction === 'review') {
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
            latestScore = pendingState.latestScore;
            reviewStatus = pendingState.reviewStatus;
            if (reviewStatus !== 'invalid') {
                await recordReviewFindings(redisClient, {
                    owner,
                    repo,
                    pr: pullRequestNumber,
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
                { pullRequestNumber, latestScore, reviewStatus, goal: updatedState.goal },
                'Ultrafix loop: parsed latest review output',
            );
        } catch (err) {
            correlatedLogger.warn(
                { error: (err as Error).message, pullRequestNumber },
                'Ultrafix loop: failed to parse review output, scheduling a review retry',
            );
        }
    }

    // 5. Determine next action
    const decision = determineNextAction(updatedState, latestScore, reviewStatus);
    correlatedLogger.info(
        { pullRequestNumber, nextAction: decision.action, reason: decision.reason, latestScore },
        'Ultrafix loop: next action decision',
    );

    // 6. If loop should stop, clean up
    if (decision.action === null) {
        const goalReached = completedAction === 'review'
            && hasReviewReachedGoal(reviewStatus, latestScore, updatedState.goal);
        await completeLoop(redisClient, {
            owner,
            repo,
            pr: pullRequestNumber,
            completionStatus: goalReached ? 'succeeded' : 'failed',
            completionReason: decision.reason,
            finalScore: latestScore,
        }, mutationLease);
        if (goalReached) {
            await assertContinuationLease(params);
            await removeUltrafixLabel(owner, repo, pullRequestNumber, correlatedLogger);
            const prId = { owner, repo, pr: pullRequestNumber };
            await clearDeferredContinuationWithLease(redisClient, prId, mutationLease);
            await clearStateWithLease(redisClient, prId, mutationLease);
            await assertContinuationLease(params);
            await maybeEnableAutoMerge(owner, repo, pullRequestNumber, correlatedLogger);
        } else {
            await assertContinuationLease(params);
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
    const readiness = await evaluateReadiness(params, {
        areAllChecksPassing: _areAllChecksPassing,
        getCurrentPRHead: _getCurrentPRHead,
        getCheckRunsStatus: _getCheckRunsStatus,
    });
    correlatedLogger.info(
        { pullRequestNumber, ready: readiness.ready, reasons: readiness.reasons },
        'Ultrafix loop: readiness check',
    );

    if (!readiness.ready) {
        // Defer the continuation — a check_run event can wake it later
        await saveDeferredContinuation(redisClient, {
            owner,
            repo,
            pr: pullRequestNumber,
            nextAction: decision.action,
            savedAt: new Date().toISOString(),
            reason: readiness.reasons.join(', '),
            continuationId: params.continuationId,
            ultrafixMeta: params.ultrafixMeta,
        }, mutationLease);
        correlatedLogger.info(
            { pullRequestNumber, nextAction: decision.action, blockingReasons: readiness.reasons },
            'Ultrafix loop: deferred continuation — waiting for readiness',
        );
        return {
            continued: false,
            reason: `deferred: ${readiness.reasons.join(', ')}`,
            nextAction: decision.action,
            score: latestScore,
            cycleCount: updatedState.cycleCount,
            deferred: true,
        };
    }

    // Clear any stale deferred record before proceeding
    await clearDeferredContinuationWithLease(
        redisClient,
        { owner, repo, pr: pullRequestNumber },
        mutationLease,
    );

    // 8. Enqueue the next step with configured pause
    const delayMs = (updatedState.pauseSeconds || 60) * 1000;
    await enqueueNextStep(params, decision.action, delayMs);

    return {
        continued: true,
        reason: decision.reason,
        nextAction: decision.action,
        score: latestScore,
        cycleCount: updatedState.cycleCount,
    };
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

    const state = await loadState(redisClient, owner, repo, pr);
    if (!state || !state.active) {
        return { continued: false, reason: 'no_active_loop' };
    }

    const correlationId = generateCorrelationId();
    const ultrafixMeta = deferred.ultrafixMeta ?? {
        mode: 'ultrafix' as const,
        goal: state.goal,
        maxCycles: state.maxCycles,
        pauseSeconds: state.pauseSeconds,
        reviewModel: state.reviewModel || undefined,
        instructions: '',
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
        continuationId: deferred.continuationId ?? `deferred-${deferred.savedAt}`,
    };

    const readiness = await evaluateReadiness(params, {
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
        await saveDeferredContinuation(redisClient, deferred);
        return {
            continued: false,
            reason: `still_deferred: ${readiness.reasons.join(', ')}`,
            deferred: true,
        };
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
