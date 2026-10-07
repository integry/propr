import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import {
    findPlanIssueByRepoAndPR,
    generateCorrelationId,
    getAuthenticatedOctokit,
    getIssueQueue,
    getPendingPrCommentsKey,
    retryConfigs,
    safeRemoveLabel,
    withUltrafixLabelTransition,
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
    getUltrafixAutomaticWorkEpoch,
    hasFollowUpJobsForPR,
    hasPendingBatchedComments,
    isUltrafixAutomaticWorkCurrent,
    type UltrafixCiObservation,
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

async function fetchUltrafixLabelPresence(owner: string, repo: string, pullRequestNumber: number): Promise<boolean> {
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
}

export async function hasUltrafixLabel(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    correlatedLogger: Logger,
): Promise<boolean> {
    try {
        return await fetchUltrafixLabelPresence(owner, repo, pullRequestNumber);
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Failed to check ultrafix label, assuming removed for safety',
        );
        return false;
    }
}

/** `unverified` when GitHub could not be asked: the label may well still be there. */
export type UltrafixLabelState = 'present' | 'absent' | 'unverified';

/**
 * Like `hasUltrafixLabel`, but a failed lookup is reported as `unverified`
 * rather than as a removed label, for callers that must not tear a loop down
 * on a transient GitHub error.
 */
export async function getUltrafixLabelState(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    correlatedLogger: Logger,
): Promise<UltrafixLabelState> {
    try {
        return await fetchUltrafixLabelPresence(owner, repo, pullRequestNumber) ? 'present' : 'absent';
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Failed to check ultrafix label; leaving the loop untouched',
        );
        return 'unverified';
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
    isPartial: boolean;
    decisionReason: string;
}): Promise<ContinuationResult> {
    const { params, state, latestScore, reviewStatus, isPartial, decisionReason } = input;
    const { owner, repo, pullRequestNumber, completedAction, redisClient, correlatedLogger } = params;
    const workEpoch = params.ultrafixMeta?.workEpoch ?? 0;
    const identity = { owner, repo, pr: pullRequestNumber };

    const goalReached = completedAction === 'review'
        && hasReviewReachedGoal(reviewStatus, latestScore, state.goal, isPartial);
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
        if (!goalReached) {
            const cleanReviewMissedGoal = completedAction === 'review' && reviewStatus === 'valid_clean';
            const cleanPartialReview = cleanReviewMissedGoal && isPartial;
            const manualReason = state.escalation?.exhausted
                ? 'All available escalation models and reasoning levels stalled. Manual review and merge are now required.'
                : cleanPartialReview
                ? 'The latest review had partial diff coverage, so it cannot establish merge readiness. Manual review and merge are now required.'
                : cleanReviewMissedGoal
                ? 'The review has no actionable blockers, so no fix was scheduled. Manual review and merge are now required.'
                : 'Max cycles were exhausted, so manual review and merge are now required.';
            await postPrComment({
                owner,
                repo,
                pullRequestNumber,
                body: `⚠️ **Ultrafix stopped before reaching its goal.** Requested goal: ${state.goal}/10. Last score: ${latestScore ?? 'unknown'}. ${manualReason}`,
                correlatedLogger,
            });
            return true;
        }

        const stateCleared = await clearUltrafixStateIfCurrent(redisClient, identity, workEpoch);
        if (!stateCleared) return false;
        await clearDeferredContinuationIfCurrent(redisClient, identity, workEpoch);
        await removeUltrafixLabel(owner, repo, pullRequestNumber, correlatedLogger);
        await maybeEnableAutoMerge(owner, repo, pullRequestNumber, correlatedLogger);
        return true;
    });
    if (!finishResult) return { continued: false, reason: 'ultrafix_superseded' };

    correlatedLogger.info(
        { pullRequestNumber, reason: decisionReason, cycleCount: state.cycleCount, goalReached },
        'Ultrafix loop: loop finished',
    );
    return {
        continued: false,
        reason: decisionReason,
        score: latestScore,
        cycleCount: state.cycleCount,
        outcome: goalReached ? 'goal_reached' : state.escalation?.exhausted ? 'failed' : 'cycles_exhausted',
        goal: state.goal,
        maxCycles: state.maxCycles,
    };
}

/**
 * Deterministic queue identity for one Ultrafix step. The epoch scopes it to the
 * owning automatic work and the step number separates later cycles in that epoch,
 * so concurrent resume triggers for the same step collapse into one job.
 *
 * The readable prefix is joined with `-`, which owner and repository names may
 * also contain (`acme-tools/web` vs `acme/tools-web`), so the suffix hashes the
 * structured tuple to keep one PR's step from matching another repository's.
 */
export function getUltrafixStepJobId(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    step: { action: UltrafixAction; workEpoch: number; stepNumber: number },
): string {
    const identity = createHash('sha256')
        .update(JSON.stringify([owner, repo, pullRequestNumber, step.action, step.workEpoch, step.stepNumber]))
        .digest('hex')
        .slice(0, 32);
    return `pr-comments-batch-${owner}-${repo}-${pullRequestNumber}-ultrafix-${step.action}-${step.workEpoch}-${step.stepNumber}-${identity}`;
}

function isDuplicateJobError(err: unknown): boolean {
    const error = err as { name?: string; message?: string } | null;
    return error?.name === 'JobAlreadyExistsError' || /already exists/i.test(error?.message ?? '');
}

/**
 * Enqueue the next Ultrafix step. `stepNumber` is the ordinal of the step
 * being enqueued for its action (completed count + 1).
 *
 * Returns false when the same step is already queued or running.
 */
export async function enqueueNextStep(
    params: UltrafixContinuationParams,
    nextAction: UltrafixAction,
    delayMs: number,
    stepNumber: number,
): Promise<boolean> {
    const { owner, repo, pullRequestNumber, ultrafixMeta, correlatedLogger } = params;
    const nextCorrelationId = generateCorrelationId();
    const jobId = getUltrafixStepJobId(owner, repo, pullRequestNumber, {
        action: nextAction,
        workEpoch: ultrafixMeta?.workEpoch ?? 0,
        stepNumber,
    });
    const commandMode = nextAction === 'review' ? 'review' as const : 'fix' as const;
    const requestedModels = nextAction === 'review' && ultrafixMeta?.reviewModel
        ? [ultrafixMeta.reviewModel]
        : undefined;

    const issueQueue = await getIssueQueue();
    // BullMQ silently ignores an add whose ID is retained in any state. A
    // finished attempt of this step never recorded its action, so it must not
    // block the retry; a pending one is the duplicate we want to skip.
    const existing = await issueQueue.getJob(jobId);
    if (existing) {
        const existingState = await existing.getState();
        if (existingState === 'completed' || existingState === 'failed') {
            await existing.remove();
        } else if (existingState !== 'unknown') {
            correlatedLogger.info(
                { pullRequestNumber, nextAction, jobId, existingState },
                'Ultrafix loop: next step already queued, skipping duplicate',
            );
            return false;
        }
        // 'unknown': the job vanished after getJob, so nothing holds the ID.
    }

    try {
        await issueQueue.add('processPullRequestComment', {
            ...(params.userId ? { userId: params.userId } : {}),
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
    } catch (err) {
        if (!isDuplicateJobError(err)) throw err;
        correlatedLogger.info(
            { pullRequestNumber, nextAction, jobId },
            'Ultrafix loop: next step already queued, skipping duplicate',
        );
        return false;
    }

    correlatedLogger.info(
        { pullRequestNumber, nextAction, jobId, delayMs, nextCorrelationId },
        `Ultrafix loop: enqueued next ${nextAction} step`,
    );
    return true;
}

export interface UltrafixCIEvaluation {
    passing: boolean;
    /** Present when an exact-head check status was read and blocking checks are not passing. */
    ci?: UltrafixCiObservation;
}

export async function evaluateCIChecks(
    params: Pick<UltrafixContinuationParams, 'owner' | 'repo' | 'pullRequestNumber' | 'completedAction' | 'correlatedLogger'> & {
        nextAction: UltrafixAction;
    },
    deps: {
        areAllChecksPassing: ChecksPassingFn | null;
        getCurrentPRHead: GetPRHeadFn | null;
        getCheckRunsStatus: GetCheckRunsStatusFn | null;
    },
): Promise<UltrafixCIEvaluation> {
    const { owner, repo, pullRequestNumber, completedAction, nextAction, correlatedLogger } = params;
    if (!requiresPassingChecks(nextAction)) {
        correlatedLogger.debug(
            { pullRequestNumber, completedAction, nextAction },
            'Ultrafix readiness: allowing fix transition without passing CI checks',
        );
        return { passing: true };
    }
    if (!deps.getCurrentPRHead) {
        correlatedLogger.warn({ pullRequestNumber }, 'Ultrafix readiness: check_run deps not wired, assuming checks NOT passing');
        return { passing: false };
    }

    try {
        const headSha = await deps.getCurrentPRHead(owner, repo, pullRequestNumber);
        if (!headSha) return { passing: false };
        if (deps.getCheckRunsStatus) {
            // Wired to getCheckRunsStatusForRepo: nonBlockingChecks never gate the loop.
            const status = await deps.getCheckRunsStatus(owner, repo, headSha);
            correlatedLogger.debug({ pullRequestNumber, ...status, completedAction }, 'Ultrafix readiness: check runs status');
            const passing = areChecksReadyForUltrafix(status);
            return passing ? { passing } : { passing, ci: { headSha, status } };
        }
        return { passing: deps.areAllChecksPassing ? await deps.areAllChecksPassing(owner, repo, headSha) : false };
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message, pullRequestNumber }, 'Ultrafix readiness: failed to check CI status, assuming NOT passing (fail-closed)');
        return { passing: false };
    }
}

export async function evaluateCIChecksPassing(
    params: Parameters<typeof evaluateCIChecks>[0],
    deps: Parameters<typeof evaluateCIChecks>[1],
): Promise<boolean> {
    return (await evaluateCIChecks(params, deps)).passing;
}

/**
 * Ultrafix work for the PR that is still queued, running, or batched. Unlike
 * readiness this fails closed: when the queue or pending comments cannot be
 * read, the work is reported as unknown so no terminal decision is made blind.
 *
 * `currentStepsOnly` is set when the only outstanding work is Ultrafix steps of
 * the current epoch: their own continuation owns the loop. Steps of a fenced
 * epoch do not count, since their continuation will stop as superseded.
 */
export async function findOutstandingUltrafixWork(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    redisClient: UltrafixContinuationParams['redisClient'],
): Promise<{ reasons: string[]; currentStepsOnly: boolean }> {
    const outstanding: string[] = [];
    let currentSteps = false;
    try {
        const issueQueue = await getIssueQueue();
        const jobs = await issueQueue.getJobs(['waiting', 'active', 'delayed']) as Array<{ data: { repoOwner?: string; repoName?: string; pullRequestNumber?: number; ultrafixMeta?: { workEpoch?: number } } }>;
        const steps = jobs.filter(job => job.data.repoOwner === owner
            && job.data.repoName === repo
            && job.data.pullRequestNumber === pullRequestNumber
            && job.data.ultrafixMeta != null);
        if (steps.length > 0) {
            outstanding.push('follow_up_jobs_active');
            // Read after the scan: a step at this epoch was current once the scan saw it.
            const currentEpoch = await getUltrafixAutomaticWorkEpoch(redisClient, owner, repo, pullRequestNumber)
                .catch(() => null);
            currentSteps = currentEpoch !== null
                && steps.every(job => (job.data.ultrafixMeta?.workEpoch ?? 0) === currentEpoch);
        }
    } catch {
        outstanding.push('follow_up_jobs_unknown');
    }
    try {
        if (await hasPendingBatchedComments(redisClient, getPendingPrCommentsKey(owner, repo, pullRequestNumber))) {
            outstanding.push('pending_comments_exist');
        }
    } catch {
        outstanding.push('pending_comments_unknown');
    }
    return { reasons: outstanding, currentStepsOnly: currentSteps && outstanding.length === 1 };
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
    const ciEvaluation = await evaluateCIChecks(
        { owner, repo, pullRequestNumber, completedAction, nextAction, correlatedLogger },
        deps,
    );

    let followUpJobsExist = false;
    try {
        followUpJobsExist = await hasFollowUpJobsForPR(owner, repo, pullRequestNumber, async () => {
            const issueQueue = await getIssueQueue();
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

    const readiness = checkReadiness({
        allChecksPassing: ciEvaluation.passing,
        hasFollowUpJobs: followUpJobsExist,
        hasPendingComments: pendingComments,
    });
    return ciEvaluation.ci ? { ...readiness, ci: ciEvaluation.ci } : readiness;
}
