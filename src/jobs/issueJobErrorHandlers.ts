import { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
    safeRemoveLabel,
    safeAddLabel,
    formatRetryTime,
    hoursUntil,
    issueQueue,
    recordLLMMetrics
} from '@propr/core';
import type { ClaudeCodeResponse, IssueJobData, JobResult, WorkerStateManager, WorktreeInfo, ClaudeResult } from '@propr/core';

function toClaudeResult(response: ClaudeCodeResponse): ClaudeResult {
    return {
        model: response.model,
        success: response.success,
        executionTime: response.executionTime,
        sessionId: response.sessionId,
        conversationId: response.conversationId,
        finalResult: response.finalResult,
        conversationLog: response.conversationLog as ClaudeResult['conversationLog'],
        error: response.error,
        tokenUsage: response.tokenUsage
    };
}

type Octokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
};

export interface UsageLimitError extends Error {
    resetTimestamp?: number;
    rawErrorMessage?: string;
}

interface UsageLimitErrorOptions {
    octokit: Octokit;
    correlatedLogger: Logger;
    stateManager: WorkerStateManager;
    taskId: string;
    AI_PROCESSING_TAG?: string;
    AI_WAITING_TAG?: string;
}

interface GenericErrorOptions extends UsageLimitErrorOptions {
    claudeResult: ClaudeCodeResponse | null;
    worktreeInfo: WorktreeInfo | undefined;
    AI_PROCESSING_TAG: string;
}

interface PostErrorCommentOptions {
    octokit: Octokit;
    errorCategory: string;
    claudeResult: ClaudeCodeResponse | null;
    worktreeInfo: WorktreeInfo | undefined;
    AI_PROCESSING_TAG: string;
    correlatedLogger: Logger;
}

export function calculateUsageLimitDelay(error: UsageLimitError): number {
    // Use reset timestamp + 2 minutes for known reset times
    // The timestamp already includes the 2-minute buffer from parseResetTimeFromMessage
    const resetTimeMs = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000);
    // Add a small random jitter (0-60 seconds) to avoid thundering herd
    const jitter = Math.floor(Math.random() * 60 * 1000);
    return Math.max(0, (resetTimeMs - Date.now()) + jitter);
}

export async function handleSimpleUsageLimitError(
    error: UsageLimitError,
    job: Job<IssueJobData>,
    correlatedLogger: Logger,
    repository: string
): Promise<JobResult> {
    correlatedLogger.warn({ repository, resetTimestamp: error.resetTimestamp }, 'Claude usage limit hit during processing. Requeueing job.');
    const delay = calculateUsageLimitDelay(error);
    await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });
    return { status: 'requeued', repository, delay };
}

function formatRateLimitComment(
    error: UsageLimitError,
    retryTimestamp: number
): string {
    const rawMessage = error.rawErrorMessage || 'Usage limit reached';
    const resetTimeStr = error.resetTimestamp ? formatRetryTime(error.resetTimestamp) : 'Unknown';
    const retryTimeStr = formatRetryTime(retryTimestamp);
    const hoursRemaining = error.resetTimestamp ? hoursUntil(error.resetTimestamp) : 1;
    const hoursText = hoursRemaining < 1
        ? 'less than an hour'
        : `approximately ${Math.ceil(hoursRemaining)} hour${Math.ceil(hoursRemaining) > 1 ? 's' : ''}`;

    return `⌛ **Rate Limit Reached**

**Error from agent:**
> ${rawMessage}

**Reset time:** ${resetTimeStr} (in ${hoursText})
**Next retry:** ${retryTimeStr}

---
*The task will automatically resume after the rate limit resets. No action needed.*`;
}

export async function handleUsageLimitError(
    error: UsageLimitError,
    job: Job<IssueJobData>,
    issueRef: IssueJobData,
    options: UsageLimitErrorOptions
): Promise<void> {
    const { octokit, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG, AI_WAITING_TAG } = options;
    const jobId = job.id;

    correlatedLogger.warn({
        jobId,
        issueNumber: issueRef.number,
        resetTimestamp: error.resetTimestamp,
        rawErrorMessage: error.rawErrorMessage
    }, 'Claude usage limit hit during issue processing. Requeueing job with AI-waiting label.');

    const delay = calculateUsageLimitDelay(error);
    const retryTimestamp = Math.floor((Date.now() + delay) / 1000);

    // Update labels: remove AI-processing, add AI-waiting
    if (octokit && AI_PROCESSING_TAG && AI_WAITING_TAG) {
        try {
            await safeRemoveLabel(
                { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
                AI_PROCESSING_TAG
            );
            await safeAddLabel(
                { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
                AI_WAITING_TAG
            );
            correlatedLogger.info({ issueNumber: issueRef.number, AI_PROCESSING_TAG, AI_WAITING_TAG }, 'Swapped processing label to waiting label');
        } catch (labelError) {
            correlatedLogger.warn({ error: (labelError as Error).message }, 'Failed to update labels for rate limit');
        }
    }

    // Post enhanced comment with error details and retry time
    if (octokit) {
        try {
            const commentBody = formatRateLimitComment(error, retryTimestamp);
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
                body: commentBody
            });
        } catch (commentError) {
            correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post usage limit delay comment to issue.');
        }
    }

    // Requeue job with isRetryFromRateLimit flag
    const requeuedJobData: IssueJobData = {
        ...job.data,
        isRetryFromRateLimit: true
    };
    await issueQueue.add(job.name, requeuedJobData, { delay: Math.max(0, delay) });

    // Keep task in processing state - don't mark as failed
    // The task will continue when the retry runs
    try {
        await stateManager.updateTaskState(taskId, 'processing', {
            reason: 'Rate limit reached - waiting for retry',
            historyMetadata: {
                rateLimitError: true,
                resetTimestamp: error.resetTimestamp,
                retryTimestamp,
                rawErrorMessage: error.rawErrorMessage
            }
        });
    } catch (stateError) {
        correlatedLogger.warn({ error: (stateError as Error).message }, 'Failed to update task state for rate limit wait');
    }
}

function categorizeError(errorMessage: string | undefined): string {
    if (errorMessage?.includes('authentication')) return 'auth_error';
    if (errorMessage?.includes('network')) return 'network_error';
    if (errorMessage?.includes('git')) return 'git_error';
    if (errorMessage?.includes('GitHub')) return 'github_api_error';
    if (errorMessage?.includes('timeout')) return 'timeout_error';
    return 'unknown_error';
}

async function postCancellationNotice(
    issueRef: IssueJobData,
    octokit: Octokit,
    AI_PROCESSING_TAG: string,
    correlatedLogger: Logger
): Promise<void> {
    try {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            issue_number: issueRef.number,
            body: `🛑 **Execution Cancelled**\n\nThe task processing was stopped by user request.\n\nYou can re-add the AI label to restart processing.`
        });
        await safeRemoveLabel(
            { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
            AI_PROCESSING_TAG
        );
    } catch (commentError) {
        correlatedLogger.warn({ error: (commentError as Error).message }, 'Failed to post cancellation notice');
    }
}

export async function handleGenericError(
    error: Error,
    job: Job<IssueJobData>,
    issueRef: IssueJobData,
    options: GenericErrorOptions
): Promise<void> {
    const { octokit, claudeResult, worktreeInfo, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG } = options;
    const errorCategory = categorizeError(error.message);
    const isUserCancelled = error.message?.includes('aborted by user');

    correlatedLogger.error({
        jobId: job.id,
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        correlationId: issueRef.correlationId,
        taskId,
        errMessage: error.message,
        stack: error.stack,
        status: 'system_error',
        resolution: 'failed',
        failureCategory: errorCategory,
        claudeAttempted: !!claudeResult,
        claudeSuccess: claudeResult?.success || false,
        worktreeCreated: !!worktreeInfo,
        timestamp: new Date().toISOString(),
        systemVersion: process.env.npm_package_version || 'unknown'
    }, 'Error processing GitHub issue job - enhanced error metrics logged');

    if (claudeResult) {
        try {
            await recordLLMMetrics(toClaudeResult(claudeResult), { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName }, { jobType: 'issue', correlationId: issueRef.correlationId, taskId });
            correlatedLogger.info({ correlationId: issueRef.correlationId, issueNumber: issueRef.number }, 'LLM metrics recorded for failed job');
        } catch (metricsError) {
            correlatedLogger.error({ error: (metricsError as Error).message, correlationId: issueRef.correlationId }, 'Failed to record LLM metrics for failed job');
        }
    }

    if (octokit && !isUserCancelled) {
        await postErrorComment(issueRef, error, { octokit, errorCategory, claudeResult, worktreeInfo, AI_PROCESSING_TAG, correlatedLogger });
    } else if (octokit && isUserCancelled) {
        await postCancellationNotice(issueRef, octokit, AI_PROCESSING_TAG, correlatedLogger);
    }

    try {
        // Check if task is already in a terminal state (e.g., already cancelled by stop endpoint)
        const currentState = await stateManager.getTaskState(taskId);
        const TERMINAL_STATES = ['completed', 'failed', 'cancelled'];
        if (currentState && TERMINAL_STATES.includes(currentState.state)) {
            correlatedLogger.info({ taskId, currentState: currentState.state }, 'Task already in terminal state, skipping error handler state update');
            return;
        }

        if (isUserCancelled) {
            await stateManager.markTaskCancelled(taskId, 'user', { historyMetadata: { originalError: error.message } });
            correlatedLogger.info({ taskId }, 'Task marked as cancelled due to user abort');
        } else {
            await stateManager.markTaskFailed(taskId, error, { errorCategory });
        }
    } catch (stateError) {
        correlatedLogger.warn({ error: (stateError as Error).message }, 'Failed to update task state');
    }
}

async function postErrorComment(issueRef: IssueJobData, error: Error, options: PostErrorCommentOptions): Promise<void> {
    const { octokit, errorCategory, claudeResult, worktreeInfo, AI_PROCESSING_TAG, correlatedLogger } = options;
    try {
        const categoryHints: Record<string, string> = {
            git_error: 'This appears to be a Git-related issue. The system may have encountered a corrupted repository or git operation failure. The issue will be automatically retried, and any corrupted repositories will be cleaned up.\n\n',
            auth_error: 'This is an authentication issue. Please ensure the GitHub token has proper permissions.\n\n',
            network_error: 'This is a network connectivity issue. The system will automatically retry.\n\n'
        };
        const errorMessage = `❌ **Failed to process this issue**\n\n**Error Category:** ${errorCategory.replace('_', ' ')}\n**Error Message:** ${error.message}\n\n${categoryHints[errorCategory] || ''}**Processing Stage:** ${claudeResult ? 'Post-processing (after AI analysis)' : 'Pre-processing (before AI analysis)'}\n${worktreeInfo ? `**Branch:** ${worktreeInfo.branchName}\n` : ''}\n<details><summary>Technical Details</summary>\n\n\`\`\`\n${error.stack || error.message}\n\`\`\`\n</details>\n\n---\n*The system will automatically retry this task. If the issue persists, please contact support.*`;
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number, body: errorMessage });
        await safeRemoveLabel({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, AI_PROCESSING_TAG);
    } catch (commentError) {
        correlatedLogger.error({ error: (commentError as Error).message, issueNumber: issueRef.number }, 'Failed to post error comment to GitHub issue');
    }
}
