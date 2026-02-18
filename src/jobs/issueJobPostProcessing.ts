import type { Logger } from 'pino';
import { setTimeout } from 'timers/promises';
import type { ClaudeCodeResponse } from '@gitfix/core';
import type { WorktreeInfo, CommitResult } from '@gitfix/core';
import { cleanupWorktree, commitChanges, pushBranch } from '@gitfix/core';
import { safeUpdateLabels } from '@gitfix/core';
import { generateCompletionComment } from '@gitfix/core';
import { executeClaudeCode } from '@gitfix/core';
import { validatePRCreation } from '@gitfix/core';
import { linkPRToPlanIssue } from '@gitfix/core';
import type { RepoValidationResult, PRValidationResult } from '@gitfix/core';
import type { IssueJobData } from '@gitfix/core';
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
}

export interface PostProcessResult {
    commitResult: CommitResult | null;
    postProcessingResult: PostProcessingResult | null;
}

export async function performPostProcessing(options: PostProcessOptions): Promise<PostProcessResult> {
    const { octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, modelName, repoValidation, repoUrl, githubToken, PR_LABEL, AI_PROCESSING_TAG, AI_DONE_TAG, jobId, correlatedLogger } = options;
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

        await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, { repoUrl, authToken: githubToken.token });

        correlatedLogger.debug('Waiting for branch propagation...');
        await setTimeout(3000);

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
    repoValidation: RepoValidation;
    githubToken: GitHubToken;
    modelName: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    correlationId: string;
    correlatedLogger: Logger;
    jobId: string | undefined;
}

export async function handlePRValidation(options: PRValidationOptions): Promise<PostProcessingResult | null> {
    const { claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, repoValidation, githubToken, modelName, AI_PROCESSING_TAG, AI_DONE_TAG, correlationId, correlatedLogger } = options;

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

    if (!finalPRValidation.isValid && claudeResult?.success) {
        await attemptEmergencyPRCreation({ worktreeInfo, issueRef, repoValidation, githubToken, modelName, correlationId, correlatedLogger });
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
    repoValidation: RepoValidation;
    githubToken: GitHubToken;
    modelName: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    localRepoPath: string;
    jobId: string | undefined;
    correlationId: string;
    correlatedLogger: Logger;
    PR_LABEL: string;
    repoUrl: string;
}

export async function performFinalValidation(options: FinalValidationOptions): Promise<void> {
    const { claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, repoValidation, githubToken, modelName, AI_PROCESSING_TAG, AI_DONE_TAG, localRepoPath, jobId, correlationId, correlatedLogger } = options;
    let resolvedPostProcessingResult = postProcessingResult;

    if (claudeResult?.success && worktreeInfo?.branchName) {
        try {
            resolvedPostProcessingResult = await handlePRValidation({ claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, repoValidation, githubToken, modelName, AI_PROCESSING_TAG, AI_DONE_TAG, correlationId, correlatedLogger, jobId });
        } catch (validationError) {
            correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (validationError as Error).message }, 'Final PR validation failed');
        }
    }

    await cleanupWorktreeIfExists({ worktreeInfo, localRepoPath, claudeResult, postProcessingResult: resolvedPostProcessingResult, jobId, issueRef, correlatedLogger });
}

interface EmergencyPROptions {
    worktreeInfo: WorktreeInfo;
    issueRef: IssueJobData;
    repoValidation: RepoValidation;
    githubToken: GitHubToken;
    modelName: string;
    correlationId: string;
    correlatedLogger: Logger;
}

async function attemptEmergencyPRCreation(options: EmergencyPROptions): Promise<void> {
    const { worktreeInfo, issueRef, repoValidation, githubToken, modelName, correlationId, correlatedLogger } = options;
    const emergencyPrompt = `The code changes for GitHub issue #${issueRef.number} have already been implemented and committed to branch ${worktreeInfo.branchName}.

**URGENT TASK: CREATE PULL REQUEST**

**REPOSITORY INFORMATION (USE EXACTLY):**
- Repository: ${issueRef.repoOwner}/${issueRef.repoName}
- Branch: ${worktreeInfo.branchName}
- Base Branch: ${repoValidation.repoData?.defaultBranch || 'main'}
- Issue: #${issueRef.number}

**CRITICAL INSTRUCTIONS:**
1. You are in directory: ${worktreeInfo.worktreePath}
2. The code changes are already committed
3. Your ONLY task is to create a pull request
4. Use: \`gh pr create --title "Fix issue #${issueRef.number}" --body "Resolves #${issueRef.number}"\`
5. DO NOT make any code changes
6. DO NOT commit anything
7. ONLY create the pull request`;

    const emergencyRetry = await executeClaudeCode({
        worktreePath: worktreeInfo.worktreePath,
        issueRef: { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName },
        githubToken: githubToken.token,
        customPrompt: emergencyPrompt,
        isRetry: true,
        retryReason: 'Emergency PR creation - main implementation complete',
        branchName: worktreeInfo.branchName,
        modelName
    });

    if (emergencyRetry.success) {
        const emergencyValidation: PRValidation = await validatePRCreation({
            owner: issueRef.repoOwner, repoName: issueRef.repoName,
            branchName: worktreeInfo.branchName, expectedPrNumber: undefined, correlationId
        });

        if (emergencyValidation.isValid && emergencyValidation.pr) {
            correlatedLogger.info({ issueNumber: issueRef.number, prNumber: emergencyValidation.pr.number }, 'Emergency PR creation successful');

            // Link PR to plan issue after emergency creation
            const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
            await linkPRToPlanIssue(repository, issueRef.number, emergencyValidation.pr.number);
            correlatedLogger.info({ repository, issueNumber: issueRef.number, prNumber: emergencyValidation.pr.number }, 'Linked PR to plan issue (emergency creation)');
        }
    }
}
