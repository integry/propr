import type { Logger } from 'pino';
import { setTimeout } from 'timers/promises';
import type { ClaudeCodeResponse } from '@propr/core';
import type { WorktreeInfo, CommitResult, WorkerStateManager } from '@propr/core';
import { cleanupWorktree, commitChanges, pushBranch, TaskStates } from '@propr/core';
import { safeUpdateLabels } from '@propr/core';
import { generateCompletionComment } from '@propr/core';
import { validatePRCreation } from '@propr/core';
import { linkPRToPlanIssue, findPlanIssueByRepoAndNumber, getPlanIssuesByDraft, updatePlanIssueStatus, PlanIssueStatus } from '@propr/core';
import { getAuthenticatedOctokit, getPrimaryProcessingLabels } from '@propr/core';
import type { RepoValidationResult, PRValidationResult } from '@propr/core';
import type { IssueJobData } from '@propr/core';
import { createPullRequest, type PostProcessingResult } from './issueJobHelpers.js';
import { enableAutoMerge } from '../github/autoMergeOperations.js';

type RepoValidation = RepoValidationResult;
type PRValidation = PRValidationResult;

type Octokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
};

interface GitHubToken {
    token: string;
}

export interface PostProcessOptions {
    octokit: Octokit;
    issueRef: IssueJobData;
    worktreeInfo: WorktreeInfo;
    currentIssueData: { data: { title: string; labels: Array<{ name: string }> } };
    claudeResult: ClaudeCodeResponse;
    modelName: string;
    repoValidation: RepoValidation;
    repoUrl: string;
    githubToken: GitHubToken;
    PR_LABEL: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    jobId: string | undefined;
    correlatedLogger: Logger;
    taskId?: string;
    stateManager?: WorkerStateManager;
}

export interface PostProcessResult {
    commitResult: CommitResult | null;
    postProcessingResult: PostProcessingResult | null;
}

export async function performPostProcessing(options: PostProcessOptions): Promise<PostProcessResult> {
    const { octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, modelName, repoValidation, repoUrl, githubToken, PR_LABEL, AI_PROCESSING_TAG, AI_DONE_TAG, jobId, correlatedLogger, taskId, stateManager } = options;
    let commitResult: CommitResult | null = null;
    let postProcessingResult: PostProcessingResult | null = null;

    try {
        let commitMessage = `fix(ai): Resolve issue #${issueRef.number} - ${currentIssueData.data.title.substring(0, 50)}\n\nImplemented by Claude Code using ${modelName} model.\n\n${claudeResult?.success ? 'Implementation completed successfully.' : 'Implementation attempted - see PR comments for details.'}`;

        if (claudeResult?.commitMessage) {
            commitMessage = claudeResult.commitMessage;
        }

        commitResult = await commitChanges(
            worktreeInfo.worktreePath, commitMessage,
            { name: 'Claude Code', email: 'claude-code@anthropic.com' },
            { issueNumber: issueRef.number, issueTitle: currentIssueData.data.title }
        );

        // Handle the case where no code changes were needed (work already complete)
        if (commitResult === null && claudeResult?.success) {
            correlatedLogger.info({ issueNumber: issueRef.number }, 'No code changes needed - work was already complete');

            await safeUpdateLabels(
                { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
                [AI_PROCESSING_TAG], [AI_DONE_TAG]
            );

            const completionComment = await generateCompletionComment(claudeResult, { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName });
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
                body: `✅ **No code changes needed - the implementation was already complete.**\n\n${completionComment}`,
            });

            // Trigger the next pending issue in the plan (if this is part of a plan)
            await triggerNextPlanIssueIfNeeded(issueRef, currentIssueData, correlatedLogger);

            postProcessingResult = { success: true, pr: null, updatedLabels: [AI_DONE_TAG] };
            return { commitResult, postProcessingResult };
        }

        await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, { repoUrl, authToken: githubToken.token });

        correlatedLogger.debug('Waiting for branch propagation...');
        await setTimeout(3000);

        // Check for cancellation before creating PR
        if (taskId && stateManager) {
            const currentState = await stateManager.getTaskState(taskId);
            if (currentState?.state === TaskStates.CANCELLED) {
                correlatedLogger.info({ taskId }, 'Task was cancelled by user, skipping PR creation');
                throw new Error('Execution aborted by user request');
            }
        }

        postProcessingResult = await createPullRequest(
            octokit, issueRef, worktreeInfo,
            { commitResult, claudeResult, modelName, repoValidation, PR_LABEL, correlatedLogger, issueTitle: currentIssueData.data.title }
        );

        // Update plan issue status to 'under_review' if PR was created successfully
        if (postProcessingResult?.pr?.number) {
            const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
            await linkPRToPlanIssue(repository, issueRef.number, postProcessingResult.pr.number);
            correlatedLogger.info({ repository, issueNumber: issueRef.number, prNumber: postProcessingResult.pr.number }, 'Linked PR to plan issue');

            // Check for auto-merge label and enable auto-merge on the PR
            const currentLabels = currentIssueData.data.labels.map(label => label.name);
            const hasAutoMergeLabel = currentLabels.some(label => label === 'auto-merge');
            if (hasAutoMergeLabel) {
                correlatedLogger.info({ prNumber: postProcessingResult.pr.number }, 'Auto-merge label detected, enabling auto-merge on PR');
                const autoMergeResult = await enableAutoMerge({
                    owner: issueRef.repoOwner,
                    repoName: issueRef.repoName,
                    prNumber: postProcessingResult.pr.number
                });
                if (autoMergeResult.success) {
                    correlatedLogger.info({ prNumber: postProcessingResult.pr.number, autoMergeEnabled: autoMergeResult.autoMergeEnabled }, 'Auto-merge enabled successfully');
                } else {
                    correlatedLogger.warn({ prNumber: postProcessingResult.pr.number, error: autoMergeResult.error }, 'Failed to enable auto-merge on PR');
                }
            }
        }

        await safeUpdateLabels(
            { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
            [AI_PROCESSING_TAG], [AI_DONE_TAG]
        );

    } catch (postProcessingError) {
        correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (postProcessingError as Error).message }, 'Deterministic post-processing failed');

        try {
            await safeUpdateLabels({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, [AI_PROCESSING_TAG], [AI_DONE_TAG]);
            const completionComment = await generateCompletionComment(claudeResult, { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName });
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
                body: `⚠️ **Post-processing encountered an error, but Claude analysis was completed.**\n\n${completionComment}`,
            });
            postProcessingResult = { success: false, pr: null, updatedLabels: [AI_DONE_TAG], error: (postProcessingError as Error).message };
        } catch (fallbackError) {
            correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (fallbackError as Error).message }, 'Fallback post-processing also failed');
            postProcessingResult = { success: false, pr: null, updatedLabels: [], error: (postProcessingError as Error).message };
        }
    }

    return { commitResult, postProcessingResult };
}

export interface PRValidationOptions {
    claudeResult: ClaudeCodeResponse | null;
    worktreeInfo: WorktreeInfo | undefined;
    issueRef: IssueJobData;
    octokit: Octokit;
    postProcessingResult: PostProcessingResult | null;
    commitResult: CommitResult | null;
    repoValidation: RepoValidation;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    correlationId: string;
    correlatedLogger: Logger;
    jobId: string | undefined;
}

export async function handlePRValidation(options: PRValidationOptions): Promise<PostProcessingResult | null> {
    const { claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, commitResult, repoValidation, AI_PROCESSING_TAG, AI_DONE_TAG, correlationId, correlatedLogger } = options;

    if (!worktreeInfo) return postProcessingResult;

    const finalPRValidation: PRValidation = await validatePRCreation({
        owner: issueRef.repoOwner, repoName: issueRef.repoName,
        branchName: worktreeInfo.branchName, expectedPrNumber: postProcessingResult?.pr?.number, correlationId
    });

    if (finalPRValidation.isValid && !postProcessingResult?.pr) {
        await safeUpdateLabels({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, [AI_PROCESSING_TAG], [AI_DONE_TAG]);

        // Link PR to plan issue if found during validation
        if (finalPRValidation.pr?.number) {
            const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
            await linkPRToPlanIssue(repository, issueRef.number, finalPRValidation.pr.number);
            correlatedLogger.info({ repository, issueNumber: issueRef.number, prNumber: finalPRValidation.pr.number }, 'Linked PR to plan issue (found during validation)');
        }

        return { success: true, pr: finalPRValidation.pr ? { number: finalPRValidation.pr.number, url: finalPRValidation.pr.url, title: finalPRValidation.pr.title } : null, updatedLabels: postProcessingResult?.updatedLabels || [] };
    }

    // Only retry PR creation if:
    // 1. PR validation failed (no PR found)
    // 2. Claude execution was successful
    // 3. There were actual commits (commitResult !== null means changes were made and a PR is expected)
    if (!finalPRValidation.isValid && claudeResult?.success && commitResult !== null) {
        await retryPRCreationViaAPI({ worktreeInfo, issueRef, repoValidation, correlatedLogger });
    } else if (!finalPRValidation.isValid && claudeResult?.success && commitResult === null) {
        correlatedLogger.info({ issueNumber: issueRef.number }, 'No PR validation needed - no code changes were made');
    }
    return postProcessingResult;
}

export interface CleanupOptions {
    worktreeInfo: WorktreeInfo | undefined;
    localRepoPath: string;
    claudeResult: ClaudeCodeResponse | null | undefined;
    postProcessingResult: PostProcessingResult | null;
    jobId: string | undefined;
    issueRef: IssueJobData;
    correlatedLogger: Logger;
}

export async function cleanupWorktreeIfExists(options: CleanupOptions): Promise<void> {
    const { worktreeInfo, localRepoPath, claudeResult, postProcessingResult, jobId, issueRef, correlatedLogger } = options;
    if (!worktreeInfo) return;

    try {
        const wasSuccessful = claudeResult?.success && postProcessingResult?.pr;
        await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
            deleteBranch: !wasSuccessful, success: !!wasSuccessful,
            retentionStrategy: process.env.WORKTREE_RETENTION_STRATEGY || 'always_delete'
        });
    } catch (cleanupError) {
        correlatedLogger.warn({ jobId, issueNumber: issueRef.number, error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
    }
}

export interface FinalValidationOptions {
    claudeResult: ClaudeCodeResponse | undefined;
    worktreeInfo: WorktreeInfo | undefined;
    issueRef: IssueJobData;
    octokit: Octokit;
    postProcessingResult: PostProcessingResult | null;
    commitResult: CommitResult | null;
    repoValidation: RepoValidation;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    localRepoPath: string;
    jobId: string | undefined;
    correlationId: string;
    correlatedLogger: Logger;
}

export async function performFinalValidation(options: FinalValidationOptions): Promise<void> {
    const { claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, commitResult, repoValidation, AI_PROCESSING_TAG, AI_DONE_TAG, localRepoPath, jobId, correlationId, correlatedLogger } = options;
    let resolvedPostProcessingResult = postProcessingResult;

    if (claudeResult?.success && worktreeInfo?.branchName) {
        try {
            resolvedPostProcessingResult = await handlePRValidation({ claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, commitResult, repoValidation, AI_PROCESSING_TAG, AI_DONE_TAG, correlationId, correlatedLogger, jobId });
        } catch (validationError) {
            correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (validationError as Error).message }, 'Final PR validation failed');
        }
    }

    await cleanupWorktreeIfExists({ worktreeInfo, localRepoPath, claudeResult, postProcessingResult: resolvedPostProcessingResult, jobId, issueRef, correlatedLogger });
}

interface RetryPRCreationOptions {
    worktreeInfo: WorktreeInfo;
    issueRef: IssueJobData;
    repoValidation: RepoValidation;
    correlatedLogger: Logger;
}

/**
 * Retries PR creation via GitHub API when the initial PR creation failed.
 * This is a fallback that uses direct API calls instead of having Claude create the PR.
 */
async function retryPRCreationViaAPI(options: RetryPRCreationOptions): Promise<void> {
    const { worktreeInfo, issueRef, repoValidation, correlatedLogger } = options;

    const targetBaseBranch = issueRef.baseBranch || repoValidation.repoData?.defaultBranch || 'main';

    correlatedLogger.info({
        issueNumber: issueRef.number,
        branchName: worktreeInfo.branchName,
        baseBranch: targetBaseBranch
    }, 'Retrying PR creation via GitHub API');

    try {
        const octokit = await getAuthenticatedOctokit();

        const prResponse = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            title: `Fix issue #${issueRef.number}`,
            head: worktreeInfo.branchName,
            base: targetBaseBranch,
            body: `Resolves #${issueRef.number}\n\n_PR created via retry mechanism_`
        });

        const prNumber = prResponse.data.number;
        correlatedLogger.info({ issueNumber: issueRef.number, prNumber }, 'PR creation retry successful');

        // Link PR to plan issue
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        await linkPRToPlanIssue(repository, issueRef.number, prNumber);
        correlatedLogger.info({ repository, issueNumber: issueRef.number, prNumber }, 'Linked PR to plan issue (retry creation)');

    } catch (error) {
        const err = error as Error & { status?: number };

        // If PR already exists (422), try to find it
        if (err.status === 422) {
            correlatedLogger.info({ issueNumber: issueRef.number }, 'PR already exists, searching for it');

            const octokit = await getAuthenticatedOctokit();
            const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                head: `${issueRef.repoOwner}:${worktreeInfo.branchName}`,
                state: 'open'
            });

            if (existingPRs.data.length > 0) {
                const existingPR = existingPRs.data[0];
                correlatedLogger.info({ issueNumber: issueRef.number, prNumber: existingPR.number }, 'Found existing PR');

                const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
                await linkPRToPlanIssue(repository, issueRef.number, existingPR.number);
            }
        } else {
            correlatedLogger.error({
                issueNumber: issueRef.number,
                branchName: worktreeInfo.branchName,
                error: err.message,
                status: err.status
            }, 'PR creation retry failed');
        }
    }
}

/**
 * Triggers the next pending issue in a plan when the current issue completes without needing a PR.
 * This handles the case where work was already complete and no code changes were needed.
 */
async function triggerNextPlanIssueIfNeeded(
    issueRef: IssueJobData,
    currentIssueData: { data: { title: string; labels: Array<{ name: string }> } },
    log: Logger
): Promise<void> {
    try {
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;

        // Check if this issue is part of a plan
        const planIssue = await findPlanIssueByRepoAndNumber(repository, issueRef.number);
        if (!planIssue || !planIssue.draft_id) {
            log.debug({ issueNumber: issueRef.number }, 'Issue is not part of a plan, skipping next issue trigger');
            return;
        }

        // Check if the issue has auto-merge label (indicates it's part of auto-processing flow)
        const labels = currentIssueData.data.labels.map(l => l.name);
        const hasAutoMerge = labels.includes('auto-merge');
        if (!hasAutoMerge) {
            log.debug({ issueNumber: issueRef.number }, 'Issue does not have auto-merge label, skipping next issue trigger');
            return;
        }

        // Mark the current issue as completed (since no PR was needed)
        await updatePlanIssueStatus(repository, issueRef.number, PlanIssueStatus.MERGED);
        log.info({ repository, issueNumber: issueRef.number }, 'Marked plan issue as merged (no changes needed)');

        // Find the next pending issue in the plan
        const planIssues = await getPlanIssuesByDraft(planIssue.draft_id);

        // Check if there are any issues currently in progress (processing or under_review)
        // These statuses indicate an active PR or processing that hasn't completed yet
        const inProgressStatuses = ['processing', 'under_review', 'in_refinement', 'refinement_processing'];
        const hasInProgressIssue = planIssues.some(issue =>
            inProgressStatuses.includes(issue.status) && issue.issue_number !== issueRef.number
        );
        if (hasInProgressIssue) {
            const inProgressIssues = planIssues.filter(issue =>
                inProgressStatuses.includes(issue.status) && issue.issue_number !== issueRef.number
            );
            log.debug({
                draftId: planIssue.draft_id,
                inProgressIssues: inProgressIssues.map(i => ({ number: i.issue_number, status: i.status }))
            }, 'Skipping next issue trigger - there are issues still in progress');
            return;
        }

        const nextPending = planIssues.find(issue => issue.status === 'pending');
        if (!nextPending) {
            log.debug({ draftId: planIssue.draft_id }, 'No more pending issues in plan');
            return;
        }

        // Get the epic label if present
        const epicLabel = labels.find(label => label.startsWith('base-'));

        // Build labels to add to the next issue
        const processingLabels = getPrimaryProcessingLabels();
        const primaryLabel = processingLabels[0] || 'AI';
        const labelsToAdd = [primaryLabel, 'auto-merge'];
        if (epicLabel) {
            labelsToAdd.push(epicLabel);
        }

        log.info({
            draftId: planIssue.draft_id,
            nextIssueNumber: nextPending.issue_number,
            labels: labelsToAdd
        }, 'Triggering next pending issue in plan (no-changes case)');

        const octokit = await getAuthenticatedOctokit();
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            issue_number: nextPending.issue_number,
            labels: labelsToAdd
        });

        log.info({
            draftId: planIssue.draft_id,
            issueNumber: nextPending.issue_number,
            labels: labelsToAdd
        }, 'Added processing labels to next pending issue');

    } catch (error) {
        log.warn({
            issueNumber: issueRef.number,
            error: (error as Error).message
        }, 'Failed to trigger next pending issue');
    }
}
