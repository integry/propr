import logger from '../utils/logger.js';
import { findPlanIssueByRepoAndPR, findPlanIssueByRepoAndNumber, updatePlanIssueByPR, PlanIssueStatus } from '../config/planIssueManager.js';
import { isEpicBranch, extractFirstIssueIdFromEpicBranch } from '../services/taskExecutionService.js';
import { triggerNextPendingIssue } from './planIssueTracking.js';
import {
    mergePR,
    deleteBranch,
    getFirstCommitMessage,
    getCurrentPRHead,
    areAllChecksPassing,
    getPRAutoMergeInfo,
    linkedIssueHasAutoMergeLabel,
    hasActiveTasksForPR,
    findPRsForCommit,
    type MergePROptions,
    type MergePRResult,
    type PRAutoMergeInfo
} from './checkRunHelpers.js';
import type { CheckRunEvent } from '@octokit/webhooks-types';

export interface StatusEventPayload {
    sha: string;
    state: string;
    repository: { full_name: string };
    context?: string;
    [key: string]: unknown;
}

export { mergePR, type MergePROptions, type MergePRResult };

// Export types and internal functions for testing
export type { PRMergeContext };

// --- Ultrafix check_run hook ---

type UltrafixCheckRunHook = (owner: string, repo: string, prNumber: number, headSha: string) => Promise<void>;

let _ultrafixCheckRunHook: UltrafixCheckRunHook | null = null;

/**
 * Register a callback that fires when a check_run completes successfully.
 * Used by the ultrafix system to wake deferred continuations.
 */
export function setUltrafixCheckRunHook(hook: UltrafixCheckRunHook): void {
    _ultrafixCheckRunHook = hook;
}

// Dedupe ultrafix hook invocations per PR+SHA to avoid redundant wake-ups
// when multiple check_run/status events arrive for the same CI completion.
const _recentHookCalls = new Map<string, number>();
const HOOK_DEDUPE_TTL_MS = 30_000;

function shouldFireUltrafixHook(owner: string, repo: string, prNumber: number, headSha: string): boolean {
    const key = `${owner}/${repo}#${prNumber}@${headSha}`;
    const now = Date.now();
    const lastFired = _recentHookCalls.get(key);
    if (lastFired && now - lastFired < HOOK_DEDUPE_TTL_MS) {
        return false;
    }
    _recentHookCalls.set(key, now);
    if (_recentHookCalls.size > 1000) {
        for (const [k, ts] of _recentHookCalls) {
            if (now - ts > HOOK_DEDUPE_TTL_MS) _recentHookCalls.delete(k);
        }
    }
    return true;
}

interface PRContext {
    owner: string;
    repoName: string;
    prNumber: number;
    log: ReturnType<typeof logger.withCorrelation>;
}

interface PRMergeContext extends PRContext {
    headSha: string;
    prInfo: PRAutoMergeInfo;
}

/**
 * Handles epic PR check completion by triggering the next pending issue.
 */
async function handleEpicPRCheckCompletion(ctx: PRContext, epicBranchName: string): Promise<void> {
    const { owner, repoName, log } = ctx;
    try {
        const firstIssueId = extractFirstIssueIdFromEpicBranch(epicBranchName);
        if (!firstIssueId) {
            log.warn({ owner, repoName, epicBranchName }, 'Could not extract first issue ID from epic branch name');
            return;
        }

        const repository = `${owner}/${repoName}`;
        const planIssue = await findPlanIssueByRepoAndNumber(repository, firstIssueId);
        if (!planIssue || !planIssue.draft_id) {
            log.debug({ owner, repoName, firstIssueId, epicBranchName }, 'No plan issue found for epic branch first issue');
            return;
        }

        const epicLabel = `base-${epicBranchName}`;
        await triggerNextPendingIssue(planIssue.draft_id, repository, epicLabel, log);
        log.info({ owner, repoName, epicBranchName, draftId: planIssue.draft_id }, 'Triggered next pending issue after epic PR checks passed');
    } catch (error) {
        log.error({ owner, repoName, epicBranchName, error: (error as Error).message }, 'Failed to handle epic PR check completion');
    }
}

/**
 * Handles epic PRs that don't have auto-merge label - triggers next issue if checks pass.
 */
async function handleEpicPRWithoutAutoMerge(ctx: PRMergeContext): Promise<void> {
    const { owner, repoName, prNumber, headSha, prInfo, log } = ctx;
    const currentPrHead = await getCurrentPRHead(owner, repoName, prNumber);
    if (currentPrHead !== headSha) return;

    const allChecksPassing = await areAllChecksPassing(owner, repoName, headSha);
    if (allChecksPassing) {
        log.info({ owner, repoName, prNumber, headBranch: prInfo.headBranch }, 'Epic PR checks passed, triggering next pending issue');
        await handleEpicPRCheckCompletion(ctx, prInfo.headBranch);
    }
    log.debug({ owner, repoName, prNumber, headBranch: prInfo.headBranch }, 'Epic PR does not have auto-merge label, skipping merge');
}

/**
 * Determines if a PR should be auto-merged based on labels.
 */
export async function shouldAutoMergePR(ctx: PRMergeContext): Promise<boolean> {
    const { owner, repoName, prNumber, prInfo, log } = ctx;

    if (isEpicBranch(prInfo.headBranch)) {
        if (!prInfo.hasLabel) {
            await handleEpicPRWithoutAutoMerge(ctx);
            return false;
        }
        return true;
    }

    const issueHasLabel = await linkedIssueHasAutoMergeLabel(owner, repoName, prNumber);
    if (!prInfo.hasLabel && !issueHasLabel) {
        log.debug({ owner, repoName, prNumber }, 'PR does not have auto-merge label, skipping');
        return false;
    }

    return true;
}

/**
 * Performs the actual merge of a PR and post-merge actions.
 */
async function performMergeAndPostActions(ctx: PRMergeContext): Promise<void> {
    const { owner, repoName, prNumber, prInfo, log } = ctx;
    let commitTitle: string | undefined;
    let commitMessage: string | undefined;

    if (isEpicBranch(prInfo.baseBranch)) {
        const firstCommit = await getFirstCommitMessage(owner, repoName, prNumber);
        if (firstCommit) {
            commitTitle = firstCommit.title;
            commitMessage = firstCommit.message;
            log.debug({ owner, repoName, prNumber, commitTitle }, 'Using first commit message for epic branch merge');
        }
    }

    const mergeResult = await mergePR({ owner, repoName, prNumber, mergeMethod: 'squash', commitTitle, commitMessage });

    if (mergeResult.success && mergeResult.merged) {
        log.info({ owner, repoName, prNumber, sha: mergeResult.sha }, 'PR auto-merged successfully');
        await deleteBranch(owner, repoName, prNumber, log);

        const repository = `${owner}/${repoName}`;
        const planIssue = await findPlanIssueByRepoAndPR(repository, prNumber);
        if (planIssue) {
            await updatePlanIssueByPR(repository, prNumber, { status: PlanIssueStatus.MERGED });
            log.info({ repository, prNumber }, 'Updated plan issue status to merged');
        }
    } else {
        log.warn({ owner, repoName, prNumber, error: mergeResult.error }, 'Failed to auto-merge PR');
    }
}

/**
 * Processes a single PR for potential auto-merge.
 */
async function processPRAutoMerge(ctx: PRContext, headSha: string): Promise<void> {
    const { owner, repoName, prNumber, log } = ctx;
    const prInfo = await getPRAutoMergeInfo(owner, repoName, prNumber);

    if (prInfo.isDraft) {
        log.debug({ owner, repoName, prNumber }, 'PR is a draft, skipping auto-merge');
        return;
    }

    const mergeCtx: PRMergeContext = { ...ctx, headSha, prInfo };

    const shouldMerge = await shouldAutoMergePR(mergeCtx);
    if (!shouldMerge) return;

    const currentPrHead = await getCurrentPRHead(owner, repoName, prNumber);
    if (currentPrHead !== headSha) {
        log.debug({ owner, repoName, prNumber, checkRunSha: headSha, currentPrHead }, 'Check run SHA does not match current PR head, skipping');
        return;
    }

    const allChecksPassing = await areAllChecksPassing(owner, repoName, headSha);
    if (!allChecksPassing) {
        log.debug({ owner, repoName, prNumber }, 'Not all checks are passing yet, skipping merge');
        return;
    }

    // Check for active tasks (e.g., followup processing) before merging
    const repository = `${owner}/${repoName}`;
    const { hasActive, activeTasks } = await hasActiveTasksForPR(repository, prNumber);
    if (hasActive) {
        log.info({
            owner,
            repoName,
            prNumber,
            activeTasks
        }, 'Skipping auto-merge - active tasks in progress for this PR');
        return;
    }

    log.info({ owner, repoName, prNumber, headSha }, 'All checks passing for auto-merge PR, attempting to merge');
    await performMergeAndPostActions(mergeCtx);
}

/**
 * Handles check_run webhook events.
 * When a check run completes successfully, checks if the PR should be auto-merged.
 */
export async function handleCheckRunEvent(
    payload: CheckRunEvent,
    correlationId: string
): Promise<void> {
    const log = logger.withCorrelation(correlationId);
    const [owner, repoName] = payload.repository.full_name.split('/');

    log.debug({
        owner,
        repoName,
        action: payload.action,
        conclusion: payload.check_run.conclusion,
        checkRunName: payload.check_run.name,
        prCount: payload.check_run.pull_requests?.length ?? 0,
    }, 'check_run event received');

    if (payload.action !== 'completed') return;

    const conclusion = payload.check_run.conclusion;
    if (conclusion !== 'success' && conclusion !== 'skipped') {
        log.debug({ owner, repoName, conclusion }, 'check_run skipped: not success/skipped');
        return;
    }

    const pullRequests = payload.check_run.pull_requests;
    if (!pullRequests || pullRequests.length === 0) {
        log.debug({ owner, repoName }, 'check_run skipped: no associated PRs');
        return;
    }

    for (const pr of pullRequests) {
        const prNumber = pr.number;
        const headSha = payload.check_run.head_sha;

        log.debug({
            owner,
            repoName,
            prNumber,
            checkRunName: payload.check_run.name,
            conclusion
        }, 'Processing check run completion for PR');

        try {
            const ctx: PRContext = { owner, repoName, prNumber, log };
            await processPRAutoMerge(ctx, headSha);
        } catch (error) {
            log.error({ owner, repoName, prNumber, error: (error as Error).message }, 'Error processing auto-merge for PR');
        }

        // Wake any deferred ultrafix continuation for this PR (only on success).
        // Dedupe by PR+SHA so fan-out from multiple check_runs doesn't fire redundantly.
        if (_ultrafixCheckRunHook && shouldFireUltrafixHook(owner, repoName, prNumber, headSha)) {
            try {
                await _ultrafixCheckRunHook(owner, repoName, prNumber, headSha);
            } catch (error) {
                log.warn({ owner, repoName, prNumber, error: (error as Error).message }, 'Ultrafix check_run hook failed');
            }
        }
    }
}

/**
 * Handles legacy commit `status` webhook events.
 * When a commit status reports success, looks up associated open PRs
 * and fires the ultrafix hook so deferred continuations can resume.
 */
export async function handleStatusEvent(
    payload: StatusEventPayload,
    correlationId: string
): Promise<void> {
    const log = logger.withCorrelation(correlationId);
    const [owner, repoName] = payload.repository.full_name.split('/');

    log.debug({ owner, repoName, state: payload.state, sha: payload.sha, context: payload.context }, 'status event received');

    if (payload.state !== 'success') return;

    if (!_ultrafixCheckRunHook) return;

    const prs = await findPRsForCommit(owner, repoName, payload.sha);
    if (prs.length === 0) {
        log.debug({ owner, repoName, sha: payload.sha }, 'status event: no open PRs for commit');
        return;
    }

    for (const pr of prs) {
        if (!shouldFireUltrafixHook(owner, repoName, pr.number, payload.sha)) continue;
        try {
            await _ultrafixCheckRunHook(owner, repoName, pr.number, payload.sha);
        } catch (error) {
            log.warn({ owner, repoName, prNumber: pr.number, error: (error as Error).message }, 'Ultrafix status hook failed');
        }
    }
}
