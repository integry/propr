import type { Logger } from 'pino';
import {
    findPlanIssueByRepoAndPR,
    generateCorrelationId,
    getAuthenticatedOctokit,
    getPendingPrCommentsKey,
    issueQueue,
    retryConfigs,
    safeRemoveLabel,
    withRetry,
} from '@propr/core';
import { enableAutoMerge } from '../github/autoMergeOperations.js';
import {
    checkReadiness,
    areChecksReadyForUltrafix,
    clearDeferredContinuationIfCurrent,
    clearUltrafixStateIfCurrent,
    completeLoop,
    hasReviewReachedGoal,
    hasFollowUpJobsForPR,
    hasPendingBatchedComments,
    isUltrafixAutomaticWorkCurrent,
    withUltrafixLabelTransition,
    type UltrafixLoopState,
    type UltrafixReadinessResult,
} from './ultrafixOrchestrationService.js';
import type { UltrafixAction } from './ultrafixOrchestrationService.js';
import { requiresPassingChecks } from './ultrafixReadinessPolicy.js';
import type { ReviewOutputStatus } from './reviewCommentGatherer.js';
import type {
    ContinuationResult,
    UltrafixContinuationParams,
    ChecksPassingFn,
    GetPRHeadFn,
    GetCheckRunsStatusFn,
} from './ultrafixLoopContinuation.js';

export async function hasUltrafixLabel(
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
        return prData.data.labels.some((label: { name?: string }) => label.name === 'ultrafix');
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Failed to check ultrafix label, assuming removed for safety',
        );
        return false;
    }
}

export async function removeUltrafixLabel(
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

export async function postPrComment(options: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    body: string;
    correlatedLogger: Logger;
}): Promise<void> {
    const { owner, repo, pullRequestNumber, body, correlatedLogger } = options;
    try {
        const octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi },
            'get_authenticated_octokit_ultrafix_comment',
        );
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo,
            issue_number: pullRequestNumber,
            body,
        });
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message, pullRequestNumber }, 'Failed to post ultrafix status comment');
    }
}

export async function maybeEnableAutoMerge(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    correlatedLogger: Logger,
): Promise<void> {
    try {
        const repository = `${owner}/${repo}`;
        const planIssue = await findPlanIssueByRepoAndPR(repository, pullRequestNumber);
        if (!planIssue) return;

        const octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi },
            'get_authenticated_octokit_ultrafix_issue_labels',
        );
        const issueResponse = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner,
            repo,
            issue_number: planIssue.issue_number,
        });
        const labels = (issueResponse.data.labels as Array<{ name?: string } | string>)
            .map((label) => typeof label === 'string' ? label : (label.name || ''));
        if (!labels.includes('auto-merge')) return;

        const result = await enableAutoMerge({ owner, repoName: repo, prNumber: pullRequestNumber });
        if (!result.success) {
            correlatedLogger.warn({ pullRequestNumber, error: result.error }, 'Failed to enable auto-merge after ultrafix success');
        }
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message, pullRequestNumber }, 'Failed to evaluate auto-merge re-enable after ultrafix success');
    }
}

/** Finish a loop without allowing an older automatic job to clean up newer work. */
export async function finishUltrafixLoop(input: {
    params: UltrafixContinuationParams;
    state: UltrafixLoopState;
    latestScore: number | null;
    reviewStatus: ReviewOutputStatus;
    decisionReason: string;
}): Promise<ContinuationResult> {
    const { params, state, latestScore, reviewStatus, decisionReason } = input;
    const { owner, repo, pullRequestNumber, completedAction, redisClient, correlatedLogger } = params;
    const workEpoch = params.ultrafixMeta?.workEpoch ?? 0;
    const identity = { owner, repo, pr: pullRequestNumber };

    const goalReached = completedAction === 'review'
        && hasReviewReachedGoal(reviewStatus, latestScore, state.goal);
    const finishResult = await withUltrafixLabelTransition(redisClient, identity, async () => {
        if (!await isUltrafixAutomaticWorkCurrent(redisClient, identity, workEpoch)) return false;
        const completedState = await completeLoop(redisClient, {
            ...identity,
            completionStatus: goalReached ? 'succeeded' : 'failed',
            completionReason: decisionReason,
            finalScore: latestScore,
            workEpoch,
        });
        if (!completedState) return false;
        if (!goalReached) return true;

        const stateCleared = await clearUltrafixStateIfCurrent(redisClient, identity, workEpoch);
        if (!stateCleared) return false;
        await clearDeferredContinuationIfCurrent(redisClient, identity, workEpoch);
        await removeUltrafixLabel(owner, repo, pullRequestNumber, correlatedLogger);
        return true;
    });
    if (!finishResult) return { continued: false, reason: 'ultrafix_superseded' };

    if (goalReached) {
        await maybeEnableAutoMerge(owner, repo, pullRequestNumber, correlatedLogger);
    } else {
        const cleanReviewMissedGoal = completedAction === 'review' && reviewStatus === 'valid_clean';
        const manualReason = cleanReviewMissedGoal
            ? 'The review has no actionable blockers, so no fix was scheduled. Manual review and merge are now required.'
            : 'Max cycles were exhausted, so manual review and merge are now required.';
        await postPrComment({
            owner,
            repo,
            pullRequestNumber,
            body: `⚠️ **Ultrafix stopped before reaching its goal.** Requested goal: ${state.goal}/10. Last score: ${latestScore ?? 'unknown'}. ${manualReason}`,
            correlatedLogger,
        });
    }

    correlatedLogger.info(
        { pullRequestNumber, reason: decisionReason, cycleCount: state.cycleCount, goalReached },
        'Ultrafix loop: loop finished',
    );
    return {
        continued: false,
        reason: decisionReason,
        score: latestScore,
        cycleCount: state.cycleCount,
    };
}

export async function enqueueNextStep(
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
            body: `/${nextAction}\nTriggered automatically by the ultrafix loop.`,
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

export async function evaluateCIChecksPassing(
    params: Pick<UltrafixContinuationParams, 'owner' | 'repo' | 'pullRequestNumber' | 'completedAction' | 'correlatedLogger'> & {
        nextAction: UltrafixAction;
    },
    deps: {
        areAllChecksPassing: ChecksPassingFn | null;
        getCurrentPRHead: GetPRHeadFn | null;
        getCheckRunsStatus: GetCheckRunsStatusFn | null;
    },
): Promise<boolean> {
    const { owner, repo, pullRequestNumber, completedAction, nextAction, correlatedLogger } = params;
    if (!requiresPassingChecks(nextAction)) {
        correlatedLogger.debug(
            { pullRequestNumber, completedAction, nextAction },
            'Ultrafix readiness: allowing fix transition without passing CI checks',
        );
        return true;
    }
    if (!deps.getCurrentPRHead) {
        correlatedLogger.warn({ pullRequestNumber }, 'Ultrafix readiness: check_run deps not wired, assuming checks NOT passing');
        return false;
    }

    try {
        const headSha = await deps.getCurrentPRHead(owner, repo, pullRequestNumber);
        if (!headSha) return false;
        if (deps.getCheckRunsStatus) {
            const status = await deps.getCheckRunsStatus(owner, repo, headSha);
            correlatedLogger.debug({ pullRequestNumber, ...status, completedAction }, 'Ultrafix readiness: check runs status');
            return areChecksReadyForUltrafix(status);
        }
        return deps.areAllChecksPassing ? deps.areAllChecksPassing(owner, repo, headSha) : false;
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message, pullRequestNumber }, 'Ultrafix readiness: failed to check CI status, assuming NOT passing (fail-closed)');
        return false;
    }
}

export async function evaluateReadiness(
    params: UltrafixContinuationParams,
    nextAction: UltrafixAction,
    deps: {
        areAllChecksPassing: ChecksPassingFn | null;
        getCurrentPRHead: GetPRHeadFn | null;
        getCheckRunsStatus: GetCheckRunsStatusFn | null;
    },
): Promise<UltrafixReadinessResult> {
    const { owner, repo, pullRequestNumber, redisClient, correlatedLogger, currentJobId, completedAction } = params;
    const allChecksPassing = await evaluateCIChecksPassing(
        { owner, repo, pullRequestNumber, completedAction, nextAction, correlatedLogger },
        deps,
    );

    let followUpJobsExist = false;
    try {
        followUpJobsExist = await hasFollowUpJobsForPR(owner, repo, pullRequestNumber, async () => {
            const jobs = await issueQueue.getJobs(['waiting', 'active', 'delayed']);
            const filtered = currentJobId ? jobs.filter((job) => job.id !== currentJobId) : jobs;
            return filtered as Array<{ data: { repoOwner?: string; repoName?: string; pullRequestNumber?: number; ultrafixMeta?: unknown } }>;
        });
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message, pullRequestNumber }, 'Ultrafix readiness: failed to inspect queue, assuming no conflicts');
    }

    let pendingComments = false;
    try {
        pendingComments = await hasPendingBatchedComments(redisClient, getPendingPrCommentsKey(owner, repo, pullRequestNumber));
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message, pullRequestNumber }, 'Ultrafix readiness: failed to check pending comments, assuming none');
    }

    return checkReadiness({
        allChecksPassing,
        hasFollowUpJobs: followUpJobsExist,
        hasPendingComments: pendingComments,
    });
}
