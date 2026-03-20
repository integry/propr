import type { Logger } from 'pino';
import {
    generateCompletionComment,
    db,
    getModelShortName,
    withRetry,
    retryConfigs
} from '@propr/core';
export { localizeContentImages, cleanupIssueAssets, type LocalizeContentImagesOptions } from './contentUtils.js';
export {
    calculateUsageLimitDelay,
    handleSimpleUsageLimitError,
    handleUsageLimitError,
    handleGenericError,
    type UsageLimitError
} from './issueJobErrorHandlers.js';
import type { IssueJobData, JobResult, WorkerStateManager, ClaudeCodeResponse, WorktreeInfo, CommitResult, RepoValidationResult } from '@propr/core';

export type RepoValidation = RepoValidationResult;

export const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || String(5 * 60 * 1000), 10);
export const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || String(2 * 60 * 1000), 10);

// Re-export getModelShortName for consumers that import from this file
export { getModelShortName };

export interface PostProcessingResult {
    success: boolean;
    pr: {
        number: number;
        url: string;
        title: string;
    } | null;
    updatedLabels: string[];
    error?: string;
}

interface CreatePROptions { commitResult: CommitResult | null; claudeResult: ClaudeCodeResponse | null; modelName: string; repoValidation: RepoValidation; PR_LABEL: string; correlatedLogger: Logger; issueTitle: string; }

type Octokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
};

export async function updateTaskTitleInStorage(
    taskId: string,
    issueRef: IssueJobData,
    stateManager: WorkerStateManager,
    correlatedLogger: Logger
): Promise<void> {
    try {
        await db('tasks')
            .where({ task_id: taskId })
            .update({ initial_job_data: JSON.stringify(issueRef) });
        correlatedLogger.info({ taskId, title: issueRef.title }, 'Updated task with title/subtitle in DB');
    } catch (dbError) {
        correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to update task with title/subtitle in DB');
    }
    try {
        const state = await stateManager.getTaskState(taskId);
        if (state) {
            state.issueRef = { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName };
            await stateManager.updateTaskState(taskId, state.state, {
                reason: 'Updated task title/subtitle',
                historyMetadata: { title: issueRef.title, subtitle: issueRef.subtitle }
            });
            correlatedLogger.info({ taskId, title: issueRef.title }, 'Updated task with title/subtitle in Redis');
        }
    } catch (redisError) {
        correlatedLogger.warn({ taskId, error: (redisError as Error).message }, 'Failed to update task with title/subtitle in Redis');
    }
}

export async function createPullRequest(
    octokit: Octokit,
    issueRef: IssueJobData,
    worktreeInfo: WorktreeInfo,
    options: CreatePROptions
): Promise<PostProcessingResult> {
    const { commitResult, claudeResult, modelName, repoValidation, PR_LABEL, correlatedLogger, issueTitle } = options;
    const jobId = `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}`;

    const modelShortName = getModelShortName(modelName);
    // New format: [412 by Claude Opus] Title
    const prTitle = '[' + issueRef.number + ' by ' + modelShortName + '] ' + issueTitle;

    const completionComment = await generateCompletionComment(claudeResult, { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName });
    const prBody = `## AI Implementation Summary

${commitResult ? `Closes #${issueRef.number}` : `Addresses #${issueRef.number}`}

**Branch:** \`${worktreeInfo.branchName}\`
**Commits:** ${commitResult ? `✅ Changes committed (${commitResult.commitHash.substring(0, 7)})` : '❌ No changes made'}

---

${completionComment}

---

### 💡 Need changes?

Comment on this PR to request refinements — the AI agent monitors comments and will update the implementation based on your feedback. Keep iterating until you're satisfied!`;

    try {
        const prResponse = await octokit.request<{ data: { number: number; html_url: string; title: string } }>('POST /repos/{owner}/{repo}/pulls', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            title: prTitle,
            head: worktreeInfo.branchName,
            base: issueRef.baseBranch || repoValidation.repoData?.defaultBranch || 'main',
            body: prBody,
            draft: false
        });

        correlatedLogger.info({
            jobId,
            issueNumber: issueRef.number,
            prNumber: prResponse.data.number,
            prUrl: prResponse.data.html_url
        }, 'PR created successfully');

        // Only add PR_LABEL to PRs (baseLabel/modelLabel are for issues only)
        try {
            await withRetry(
                () => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    issue_number: prResponse.data.number,
                    labels: [PR_LABEL]
                }),
                retryConfigs.githubApi,
                `add_pr_label_${prResponse.data.number}`
            );
            correlatedLogger.info({ prNumber: prResponse.data.number, label: PR_LABEL }, 'Added PR label to new PR');
        } catch (labelError) {
            correlatedLogger.warn({ prNumber: prResponse.data.number, label: PR_LABEL, error: (labelError as Error).message }, 'Failed to add PR label to new PR after retries');
        }

        return {
            success: true,
            pr: {
                number: prResponse.data.number,
                url: prResponse.data.html_url,
                title: prResponse.data.title
            },
            updatedLabels: []
        };

    } catch (prError) {
        correlatedLogger.warn({
            jobId,
            issueNumber: issueRef.number,
            branchName: worktreeInfo.branchName,
            error: (prError as Error).message
        }, 'Direct PR creation failed, checking if PR already exists...');

        return await findExistingPR({ octokit, issueRef, worktreeInfo, prError: prError as Error, correlatedLogger, PR_LABEL });
    }
}

interface FindExistingPROptions {
    octokit: Octokit;
    issueRef: IssueJobData;
    worktreeInfo: WorktreeInfo;
    prError: Error;
    correlatedLogger: Logger;
    PR_LABEL: string;
}

async function findExistingPR(options: FindExistingPROptions): Promise<PostProcessingResult> {
    const { octokit, issueRef, worktreeInfo, prError, correlatedLogger, PR_LABEL } = options;
    try {
        const existingPRs = await octokit.request<{ data: Array<{ number: number; html_url: string; title: string; base: { ref: string } }> }>('GET /repos/{owner}/{repo}/pulls', { owner: issueRef.repoOwner, repo: issueRef.repoName, head: `${issueRef.repoOwner}:${worktreeInfo.branchName}`, state: 'open' });
        if (existingPRs.data.length > 0) {
            const existingPR = existingPRs.data[0];
            correlatedLogger.info({ issueNumber: issueRef.number, prNumber: existingPR.number, prUrl: existingPR.html_url, currentBase: existingPR.base.ref }, 'Found existing PR for branch');

            // Check if the PR base branch is correct, update if needed
            const expectedBase = issueRef.baseBranch;
            if (expectedBase && existingPR.base.ref !== expectedBase) {
                correlatedLogger.info({ prNumber: existingPR.number, currentBase: existingPR.base.ref, expectedBase }, 'PR has wrong base branch, updating...');
                try {
                    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        pull_number: existingPR.number,
                        base: expectedBase
                    });
                    correlatedLogger.info({ prNumber: existingPR.number, newBase: expectedBase }, 'Updated PR base branch');
                } catch (updateError) {
                    correlatedLogger.warn({ prNumber: existingPR.number, error: (updateError as Error).message }, 'Failed to update PR base branch');
                }
            }

            // Add PR label to the existing PR (only PR_LABEL, not issue labels like baseLabel/modelLabel)
            try {
                await withRetry(
                    () => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        issue_number: existingPR.number,
                        labels: [PR_LABEL]
                    }),
                    retryConfigs.githubApi,
                    `add_pr_label_existing_${existingPR.number}`
                );
                correlatedLogger.info({ prNumber: existingPR.number, label: PR_LABEL }, 'Added PR label to existing PR');
            } catch (labelError) {
                correlatedLogger.warn({ prNumber: existingPR.number, error: (labelError as Error).message }, 'Failed to add PR label to existing PR after retries');
            }

            return { success: true, pr: { number: existingPR.number, url: existingPR.html_url, title: existingPR.title }, updatedLabels: [] };
        }
        throw prError;
    } catch { throw prError; }
}

interface FinalResultResults { worktreeInfo: WorktreeInfo | undefined; claudeResult: ClaudeCodeResponse | null; postProcessingResult: PostProcessingResult | null; commitResult: CommitResult | null; }

function determineResultStatus(claudeResult: ClaudeCodeResponse | null, postProcessingResult: PostProcessingResult | null): string {
    if (!claudeResult?.success) return 'claude_processing_failed';
    if (postProcessingResult?.pr) return 'complete_with_pr';
    return 'claude_success_no_changes';
}

function buildClaudeResultSection(claudeResult: ClaudeCodeResponse | null): { success: boolean } {
    return {
        success: claudeResult?.success ?? false,
        executionTime: claudeResult?.executionTime ?? 0,
        modifiedFiles: claudeResult?.modifiedFiles ?? [],
        conversationLog: claudeResult?.conversationLog ?? [],
        error: claudeResult?.error ?? null,
        sessionId: claudeResult?.sessionId ?? null,
        conversationId: claudeResult?.conversationId ?? null,
        model: claudeResult?.model ?? null,
        tokenUsage: claudeResult?.tokenUsage ?? null
    } as { success: boolean };
}

function buildPostProcessingSection(postProcessingResult: PostProcessingResult | null): { success: boolean; pr: PostProcessingResult['pr']; updatedLabels: string[] } {
    return {
        success: !!postProcessingResult,
        pr: postProcessingResult?.pr ?? null,
        updatedLabels: postProcessingResult?.updatedLabels ?? []
    };
}

export function buildFinalResult(issueRef: IssueJobData, localRepoPath: string, results: FinalResultResults): JobResult {
    const { worktreeInfo, claudeResult, postProcessingResult } = results;
    return {
        status: determineResultStatus(claudeResult, postProcessingResult),
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        gitSetup: { localRepoPath, worktreeCreated: !!worktreeInfo, branchName: worktreeInfo?.branchName },
        claudeResult: buildClaudeResultSection(claudeResult),
        postProcessing: buildPostProcessingSection(postProcessingResult)
    };
}
