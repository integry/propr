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
import {
    loadState,
    recordAction,
    clearState,
    determineNextAction,
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

export interface ContinuationResult {
    continued: boolean;
    reason: string;
    nextAction?: UltrafixAction;
    score?: number | null;
    cycleCount?: number;
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

    // 7. Enqueue the next step with configured pause
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
