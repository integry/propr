/**
 * Ultrafix Loop Continuation
 *
 * Called after review or fix job completion to decide whether
 * the ultrafix cycle should continue and enqueue the next step.
 */

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    issueQueue,
    generateCorrelationId,
    getAuthenticatedOctokit,
    withRetry,
    retryConfigs,
    safeRemoveLabel,
} from '@propr/core';
import type { UltrafixCommandMeta } from '@propr/core';
import { TaskStates, db } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import {
    getPendingPrCommentsKey,
} from '@propr/core';
import {
    loadState,
    loadDeferredContinuation,
    recordAction,
    clearState,
    determineNextAction,
    hasFollowUpJobsForPR,
    hasPendingBatchedComments,
    checkReadiness,
    saveDeferredContinuation,
    clearDeferredContinuation,
} from './ultrafixOrchestrationService.js';
import type { UltrafixAction } from './ultrafixOrchestrationService.js';
import { fetchAllComments } from './prCommentJobUtils.js';
import { getPendingReviewState } from './reviewCommentGatherer.js';

export interface UltrafixContinuationParams {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    completedAction: UltrafixAction;
    ultrafixMeta?: UltrafixCommandMeta;
    redisClient: Redis;
    correlatedLogger: Logger;
    correlationId: string;
}

// --- Dependency injection for check_run status ---

type ChecksPassingFn = (owner: string, repo: string, ref: string) => Promise<boolean>;
type GetPRHeadFn = (owner: string, repo: string, pr: number) => Promise<string | null>;

let _areAllChecksPassing: ChecksPassingFn | null = null;
let _getCurrentPRHead: GetPRHeadFn | null = null;

export function setCheckRunDeps(deps: {
    areAllChecksPassing: ChecksPassingFn;
    getCurrentPRHead: GetPRHeadFn;
}): void {
    _areAllChecksPassing = deps.areAllChecksPassing;
    _getCurrentPRHead = deps.getCurrentPRHead;
}

export interface ContinuationResult {
    continued: boolean;
    reason: string;
    nextAction?: UltrafixAction;
    score?: number | null;
    cycleCount?: number;
    deferred?: boolean;
}

/**
 * Check whether the `ultrafix` label is still on the PR.
 * If it has been removed, the loop should stop.
 */
async function hasUltrafixLabel(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    correlatedLogger: Logger,
): Promise<boolean> {
    try {
        const octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi },
            'get_authenticated_octokit_ultrafix_label_check',
        );
        const prData = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo,
            pull_number: pullRequestNumber,
        });
        return prData.data.labels.some((l: { name?: string }) => l.name === 'ultrafix');
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Failed to check ultrafix label, assuming removed for safety',
        );
        return false;
    }
}

/**
 * Remove the `ultrafix` label from the PR (called when loop finishes).
 */
async function removeUltrafixLabel(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    correlatedLogger: Logger,
): Promise<void> {
    try {
        const octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi },
            'get_authenticated_octokit_ultrafix_label_remove',
        );
        await safeRemoveLabel(
            { octokit, owner, repo, issueNumber: pullRequestNumber, logger: correlatedLogger },
            'ultrafix',
        );
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Failed to remove ultrafix label',
        );
    }
}

/**
 * Enqueue the next ultrafix step (review or fix) as a PR comment job.
 */
async function enqueueNextStep(
    params: UltrafixContinuationParams,
    nextAction: UltrafixAction,
    delayMs: number,
): Promise<void> {
    const { owner, repo, pullRequestNumber, ultrafixMeta, correlatedLogger } = params;
    const nextCorrelationId = generateCorrelationId();
    const jobId = `pr-comments-batch-${owner}-${repo}-${pullRequestNumber}-ultrafix-${Date.now()}`;

    const commandMode = nextAction === 'review' ? 'review' as const : 'fix' as const;
    const requestedModels = nextAction === 'review' && ultrafixMeta?.reviewModel
        ? [ultrafixMeta.reviewModel]
        : undefined;

    await issueQueue.add('processPullRequestComment', {
        pullRequestNumber,
        repoOwner: owner,
        repoName: repo,
        correlationId: nextCorrelationId,
        commandMode,
        commandInstructions: ultrafixMeta?.instructions || '',
        ultrafixMeta,
        comments: [{
            id: 0,
            body: `Ultrafix loop: auto-scheduled /${nextAction}`,
            author: 'propr-ultrafix',
            type: 'issue' as const,
            commandMode,
            ultrafixMeta,
        }],
        ...(requestedModels && { requestedModels }),
    }, {
        jobId,
        delay: delayMs,
    });

    correlatedLogger.info(
        { pullRequestNumber, nextAction, jobId, delayMs, nextCorrelationId },
        `Ultrafix loop: enqueued next ${nextAction} step`,
    );
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

    // 2. Record the completed action
    const updatedState = await recordAction(redisClient, {
        owner, repo, pr: pullRequestNumber, action: completedAction,
    });
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
        await clearState(redisClient, owner, repo, pullRequestNumber);
        return { continued: false, reason: 'label_removed', cycleCount: updatedState.cycleCount };
    }

    // 4. Get the latest review score
    let latestScore: number | null = null;
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
            });
            latestScore = pendingState.latestScore;
            correlatedLogger.info(
                { pullRequestNumber, latestScore, goal: updatedState.goal },
                'Ultrafix loop: fetched latest review score',
            );
        } catch (err) {
            correlatedLogger.warn(
                { error: (err as Error).message, pullRequestNumber },
                'Ultrafix loop: failed to fetch review score, continuing with null',
            );
        }
    }

    // 5. Determine next action
    const decision = determineNextAction(updatedState, latestScore);
    correlatedLogger.info(
        { pullRequestNumber, nextAction: decision.action, reason: decision.reason, latestScore },
        'Ultrafix loop: next action decision',
    );

    // 6. If loop should stop, clean up
    if (decision.action === null) {
        await clearState(redisClient, owner, repo, pullRequestNumber);
        await removeUltrafixLabel(owner, repo, pullRequestNumber, correlatedLogger);
        correlatedLogger.info(
            { pullRequestNumber, reason: decision.reason, cycleCount: updatedState.cycleCount },
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
    const readiness = await evaluateReadiness(params);
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
        });
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
    await clearDeferredContinuation(redisClient, owner, repo, pullRequestNumber);

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
    const deferred = await loadDeferredContinuation(redisClient, owner, repo, pr);
    if (!deferred) {
        return { continued: false, reason: 'no_deferred_continuation' };
    }

    const state = await loadState(redisClient, owner, repo, pr);
    if (!state || !state.active) {
        await clearDeferredContinuation(redisClient, owner, repo, pr);
        return { continued: false, reason: 'no_active_loop' };
    }

    const correlationId = generateCorrelationId();
    const params: UltrafixContinuationParams = {
        owner,
        repo,
        pullRequestNumber: pr,
        completedAction: state.lastAction ?? 'review',
        ultrafixMeta: undefined,
        redisClient,
        correlatedLogger,
        correlationId,
    };

    // Re-evaluate readiness
    const readiness = await evaluateReadiness(params);
    correlatedLogger.info(
        { pr, ready: readiness.ready, reasons: readiness.reasons },
        'Ultrafix deferred resume: readiness re-check',
    );

    if (!readiness.ready) {
        return {
            continued: false,
            reason: `still_deferred: ${readiness.reasons.join(', ')}`,
            deferred: true,
        };
    }

    // Ready — enqueue and clear deferred record
    await clearDeferredContinuation(redisClient, owner, repo, pr);
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

/** Build ultrafix history metadata from the current ultrafix state. */
export function buildUltrafixHistoryMeta(
    ultrafixMeta: UltrafixCommandMeta, ufState: { cycleCount?: number; goal?: string; maxCycles?: number } | null,
): Record<string, unknown> {
    return { ultrafixCycle: true, ultrafixGoal: ultrafixMeta.goal ?? ufState?.goal, ultrafixCycleCount: ufState?.cycleCount ?? 0, ultrafixMaxCycles: ultrafixMeta.maxCycles ?? ufState?.maxCycles };
}

/** Build continuation metadata from a ContinuationResult. */
export function buildContinuationMeta(r: ContinuationResult): Record<string, unknown> {
    return { ...(r.score != null && { ultrafixScore: r.score }), ...(r.cycleCount != null && { ultrafixCycleCount: r.cycleCount }), ...(r.nextAction && { ultrafixNextAction: r.nextAction }), ...(!r.continued && { ultrafixStopReason: r.reason }) };
}

/** Patch the COMPLETED history entry with ultrafix continuation metadata in both Redis and SQLite. */
export async function patchUltrafixContinuationMeta(
    stateManager: WorkerStateManager, taskId: string, continuationMeta: Record<string, unknown>, correlatedLogger: Logger,
): Promise<void> {
    try { await stateManager.updateHistoryMetadata(taskId, TaskStates.COMPLETED, continuationMeta); } catch (e) {
        correlatedLogger.warn({ error: (e as Error).message, taskId }, 'Failed to patch ultrafix metadata into Redis history entry');
    }
    try {
        const row = await db('task_history').where({ task_id: taskId, state: 'completed' }).orderBy('timestamp', 'desc').first();
        if (row) {
            const existing = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {});
            await db('task_history').where({ history_id: row.history_id }).update({ metadata: JSON.stringify({ ...existing, ...continuationMeta }) });
        }
    } catch (e) {
        correlatedLogger.warn({ error: (e as Error).message, taskId }, 'Failed to patch ultrafix metadata into SQLite history entry');
    }
}

/**
 * Evaluate all readiness conditions for the ultrafix loop.
 * Gathers external state and delegates to the pure `checkReadiness` helper.
 */
async function evaluateReadiness(
    params: UltrafixContinuationParams,
): Promise<import('./ultrafixOrchestrationService.js').UltrafixReadinessResult> {
    const { owner, repo, pullRequestNumber, redisClient, correlatedLogger } = params;

    // 1. CI checks passing (fail-closed: assume NOT passing if deps not wired or on error)
    let allChecksPassing = false;
    if (_areAllChecksPassing && _getCurrentPRHead) {
        try {
            const headSha = await _getCurrentPRHead(owner, repo, pullRequestNumber);
            if (headSha) {
                allChecksPassing = await _areAllChecksPassing(owner, repo, headSha);
            }
        } catch (err) {
            correlatedLogger.warn(
                { error: (err as Error).message, pullRequestNumber },
                'Ultrafix readiness: failed to check CI status, assuming NOT passing (fail-closed)',
            );
        }
    } else {
        correlatedLogger.warn(
            { pullRequestNumber },
            'Ultrafix readiness: check_run deps not wired, assuming checks NOT passing',
        );
    }

    // 2. Follow-up ultrafix jobs in queue
    let followUpJobsExist = false;
    try {
        followUpJobsExist = await hasFollowUpJobsForPR(
            owner, repo, pullRequestNumber,
            async () => {
                const jobs = await issueQueue.getJobs(['waiting', 'active', 'delayed']);
                return jobs as Array<{ data: { repoOwner?: string; repoName?: string; pullRequestNumber?: number; ultrafixMeta?: unknown } }>;
            },
        );
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Ultrafix readiness: failed to inspect queue, assuming no conflicts',
        );
    }

    // 3. Pending batched comments in Redis
    let pendingComments = false;
    try {
        const pendingKey = getPendingPrCommentsKey(owner, repo, pullRequestNumber);
        pendingComments = await hasPendingBatchedComments(redisClient, pendingKey);
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Ultrafix readiness: failed to check pending comments, assuming none',
        );
    }

    return checkReadiness({
        allChecksPassing,
        hasFollowUpJobs: followUpJobsExist,
        hasPendingComments: pendingComments,
    });
}
