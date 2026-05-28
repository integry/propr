import type { Logger } from 'pino';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
    generateCorrelationId, handleError, getAuthenticatedOctokit, cleanupWorktree,
    formatResetTime, recordLLMMetrics, issueQueue, TaskStates, getDefaultModel,
    resolveModelAlias, getPendingPrCommentsKey,
    type WorktreeInfo, type ClaudeCodeResponse, type ClaudeResult,
    type CommentJobData, type UnprocessedComment, type WorkerStateManager,
} from '@propr/core';
import { sanitizeErrorMessage } from './errorSanitizer.js';
import { getFixEnvironmentRepairInstructions } from './environmentRepairPrompt.js';

export function toClaudeResult(response: ClaudeCodeResponse): ClaudeResult {
    return {
        model: response.model,
        success: response.success,
        executionTime: response.executionTime,
        sessionId: response.sessionId,
        conversationId: response.conversationId,
        finalResult: response.finalResult,
        conversationLog: response.conversationLog as ClaudeResult['conversationLog'],
        error: response.error,
        tokenUsage: response.tokenUsage,
        usageMetrics: response.usageMetrics ?? undefined
    };
}

const DEFAULT_MODEL_NAME: string | null = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel() || null;
const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || String(5 * 60 * 1000), 10);
const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || String(2 * 60 * 1000), 10);
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-(.+)$';

interface PRComment {
    id: number;
    body: string;
    body_html?: string;  // HTML with signed image URLs
    user: { login: string; type?: string };
    created_at: string;
    pull_request_review_id?: number;
}

export interface CombinedCommentResult {
    combinedCommentBody: string;
    combinedBodyHtml?: string;  // Combined HTML with signed image URLs
    commentAuthors: string[];
}

export function buildCombinedComment(unprocessedComments: UnprocessedComment[]): CombinedCommentResult {
    let combinedCommentBody: string;
    let combinedBodyHtml: string | undefined;
    let commentAuthors: string[] = [];

    if (unprocessedComments.length === 1) {
        combinedCommentBody = unprocessedComments[0].body;
        combinedBodyHtml = unprocessedComments[0].body_html;
        commentAuthors = [unprocessedComments[0].author];
    } else {
        combinedCommentBody = unprocessedComments.map((comment, index) => `**Comment ${index + 1}** (by @${comment.author}):\n${comment.body}`).join('\n\n---\n\n');
        // Combine HTML content too (for signed image URLs)
        const htmlParts = unprocessedComments.filter(c => c.body_html).map(c => c.body_html);
        combinedBodyHtml = htmlParts.length > 0 ? htmlParts.join('\n') : undefined;
        commentAuthors = [...new Set(unprocessedComments.map(c => c.author))];
    }
    return { combinedCommentBody, combinedBodyHtml, commentAuthors };
}

export function extractModelFromLabels(labels: Array<{ name: string }>, currentLlm: string | null | undefined, pullRequestNumber: number, correlatedLogger: Logger): string | null {
    if (labels && Array.isArray(labels)) {
        const modelLabelRegex = new RegExp(MODEL_LABEL_PATTERN);
        for (const label of labels) {
            const labelName = typeof label === 'string' ? label : label.name;
            const match = labelName.match(modelLabelRegex);
            if (match) {
                const resolvedModel = resolveModelAlias(match[1]);
                correlatedLogger.info({ pullRequestNumber, label: labelName, resolvedModel }, 'Using model from PR label');
                return resolvedModel;
            }
        }
    }
    return currentLlm || null;
}

async function paginateComments(octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>, url: string, params: Record<string, unknown>): Promise<PRComment[]> {
    const results: PRComment[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
        const resp = await octokit.request(url, { ...params, per_page: 100, page, mediaType: { format: 'full' } });
        results.push(...(resp.data as PRComment[]));
        const linkHeader = (resp.headers as Record<string, string | undefined>).link;
        hasMore = Boolean(linkHeader && linkHeader.includes('rel="next"'));
        page++;
    }
    return results;
}

export async function fetchAllComments(octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>, repoOwner: string, repoName: string, pullRequestNumber: number): Promise<PRComment[]> {
    const issueComments = await paginateComments(octokit, 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner: repoOwner, repo: repoName, issue_number: pullRequestNumber });
    const reviewComments = await paginateComments(octokit, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', { owner: repoOwner, repo: repoName, pull_number: pullRequestNumber, sort: 'created', direction: 'desc' });
    return [...issueComments, ...reviewComments];
}

export interface CommitMessageOptions {
    changesSummary: string; unprocessedComments: UnprocessedComment[];
    pullRequestNumber: number; claudeResult: ClaudeCodeResponse;
    llm: string | null | undefined; authorsText: string;
}

export function buildCommitMessage(options: CommitMessageOptions): string {
    const { changesSummary, unprocessedComments, pullRequestNumber, claudeResult, llm, authorsText } = options;

    const commentReferences = unprocessedComments.map(c => `Comment by: @${c.author} (ID: ${c.id})`).join('\n');
    return `feat(ai): ${changesSummary ? changesSummary.split('\n')[0] : 'Apply follow-up changes from PR comment'}

${changesSummary ? changesSummary : `Implemented changes requested by ${authorsText}`}

PR: #${pullRequestNumber}
${commentReferences}
Model: ${claudeResult.model || llm || DEFAULT_MODEL_NAME || 'unconfigured'}`;
}

export interface PromptOptions {
    pullRequestNumber: number; combinedCommentBody: string; commentHistory: string;
    originalTaskSpec: string; worktreeInfo: WorktreeInfo;
    repoOwner: string; repoName: string; commentCount: number;
    commandMode?: string;
    /** Formatted section of AI review comments gathered for /fix */
    reviewCommentsSection?: string;
}

export function buildPrompt(options: PromptOptions): string {
    const { pullRequestNumber, combinedCommentBody, commentHistory, originalTaskSpec, worktreeInfo, repoOwner, repoName, commentCount, commandMode, reviewCommentsSection } = options;
    const environmentRepairInstructions = getFixEnvironmentRepairInstructions(commandMode);
    return `You are working on pull request #${pullRequestNumber} to apply follow-up changes.

**New Request${commentCount > 1 ? 's' : ''}:**
${combinedCommentBody.replace(/^/gm, '> ')}
${reviewCommentsSection ? `\n${reviewCommentsSection}\n` : ''}
${commentHistory}${originalTaskSpec}

**CRITICAL INSTRUCTIONS:**
- You are in directory: ${worktreeInfo.worktreePath}
- Analyze the existing code on this branch and the comment history provided above.
- Implement ONLY the changes requested in the **New Request(s)** section${reviewCommentsSection ? ' and the **AI Review Comments** section' : ''}.
- DO NOT commit your changes - the system will handle the commit for you
- DO NOT create a new pull request
- The repository is ${repoOwner}/${repoName}
${environmentRepairInstructions}

**Context:**
- This is a follow-up to an existing pull request #${pullRequestNumber}.
- Make sure your changes are compatible with the existing modifications on this branch.`;
}

export interface JobErrorOptions {
    pullRequestNumber: number; repoOwner: string; repoName: string; authorsText: string;
    unprocessedComments: UnprocessedComment[];
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
    startingWorkComment: { data: { id: number } } | null;
    claudeResult: ClaudeCodeResponse | null; correlationId: string;
    correlatedLogger: Logger; stateManager: WorkerStateManager; taskId: string;
}

export class UsageLimitError extends Error {
    resetTimestamp?: number;
    constructor(message: string, resetTimestamp?: number) {
        super(message);
        this.name = 'UsageLimitError';
        this.resetTimestamp = resetTimestamp;
    }
}

interface CancellationCommentParams {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    repoOwner: string;
    repoName: string;
    commentId: number;
    correlatedLogger: Logger;
}

async function postCancellationComment(params: CancellationCommentParams): Promise<void> {
    const { octokit, repoOwner, repoName, commentId, correlatedLogger } = params;
    try {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: repoOwner, repo: repoName, comment_id: commentId,
            body: `🛑 **Execution Cancelled**\n\nThe task processing was stopped by user request.\n\nYou can post a new comment to restart processing.`,
        });
    } catch (commentError) {
        correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post cancellation comment');
    }
}

async function handleUsageLimitError(error: UsageLimitError, job: Job<CommentJobData>, options: JobErrorOptions): Promise<void> {
    const { pullRequestNumber, repoOwner, repoName, authorsText, octokit, correlatedLogger } = options;
    correlatedLogger.warn({ pullRequestNumber, resetTimestamp: error.resetTimestamp }, 'Claude usage limit hit during PR comment processing. Requeueing job.');

    const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000);
    const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);
    const readableResetTime = formatResetTime(error.resetTimestamp);

    // Use deterministic jobId to prevent duplicate jobs if requeue is triggered multiple times
    const llmSlug = (job.data.llm || 'default').replace(/[^a-zA-Z0-9-]/g, '-');
    const branchSlug = (job.data.branchName || 'main').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 30);
    const requeueJobId = `pr-comments-batch-${repoOwner}-${repoName}-${pullRequestNumber}-${llmSlug}-${branchSlug}-ratelimit-retry`;

    if (octokit) {
        try {
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
                body: `⌛ **Processing Delayed:** Claude's usage limit was reached while processing requests from ${authorsText}.\n\nThe job has been automatically rescheduled and will restart ${readableResetTime}.\n\n---\n*Job ID: ${requeueJobId} will run again after delay.*`
            });
        } catch (commentError) {
            correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post usage limit delay comment to PR.');
        }
    }

    await issueQueue.add(job.name, job.data, { jobId: requeueJobId, delay: Math.max(0, delay) });
}

async function handleUserCancellation(options: JobErrorOptions, errorMessage: string): Promise<void> {
    const { repoOwner, repoName, octokit, startingWorkComment, correlatedLogger, stateManager, taskId } = options;
    await stateManager.updateTaskState(taskId, TaskStates.CANCELLED, { reason: 'Task cancelled by user', error: { message: errorMessage } });
    correlatedLogger.info({ taskId }, 'Task marked as cancelled due to user abort');
    if (octokit && startingWorkComment) {
        await postCancellationComment({ octokit, repoOwner, repoName, commentId: startingWorkComment.data.id, correlatedLogger });
    }
}

async function handleGenericError(error: Error, options: JobErrorOptions): Promise<void> {
    const { pullRequestNumber, repoOwner, repoName, authorsText, unprocessedComments, octokit, startingWorkComment, claudeResult, correlationId, correlatedLogger, stateManager, taskId } = options;
    handleError(error, 'Failed to process PR comment job', { correlationId });
    const sanitizedMessage = sanitizeErrorMessage(error.message);
    await stateManager.updateTaskState(taskId, TaskStates.FAILED, { reason: 'PR comment processing failed', error: { message: sanitizedMessage } });
    if (claudeResult) {
        try {
            await recordLLMMetrics(toClaudeResult(claudeResult), { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'pr_comment', correlationId, taskId });
        } catch (metricsError) {
            correlatedLogger.error({ error: (metricsError as Error).message, correlationId }, 'Failed to record LLM metrics for failed PR comment job');
        }
    }
    if (octokit && startingWorkComment) {
        try {
            await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner: repoOwner, repo: repoName, comment_id: startingWorkComment.data.id,
                body: `❌ **Failed to apply follow-up changes** requested by ${authorsText}\n\nAn error occurred while processing your request:\n\n\`\`\`\n${sanitizedMessage}\n\`\`\`\n\n---\nComment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}\nPlease check the logs for more details.`,
            });
        } catch (commentError) {
            correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post error comment');
        }
    }
}

export async function handleJobError(error: Error, job: Job<CommentJobData>, options: JobErrorOptions): Promise<void> {
    const { repoOwner, repoName, octokit, startingWorkComment, correlatedLogger, stateManager, taskId } = options;

    const isUserCancelled = error.message?.includes('aborted by user');
    const isUsageLimit = error.name === 'UsageLimitError' || error.message?.includes('usage limit');

    const TERMINAL_STATES: string[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
    const currentState = await stateManager.getTaskState(taskId);

    if (currentState && TERMINAL_STATES.includes(currentState.state)) {
        correlatedLogger.info({ taskId, currentState: currentState.state }, 'Task already in terminal state, skipping error handler state update');
        if (currentState.state === TaskStates.CANCELLED && octokit && startingWorkComment) {
            await postCancellationComment({ octokit, repoOwner, repoName, commentId: startingWorkComment.data.id, correlatedLogger });
            correlatedLogger.info({ taskId, commentId: startingWorkComment.data.id }, 'Updated GitHub comment for cancelled task');
        }
        return;
    }

    if (isUsageLimit) {
        await handleUsageLimitError(error as UsageLimitError, job, options);
    } else if (isUserCancelled) {
        await handleUserCancellation(options, error.message);
    } else {
        await handleGenericError(error, options);
    }
}

export interface CleanupOptions {
    stateManager: WorkerStateManager; lockKey: string; correlationId: string;
    localRepoPath: string | undefined; worktreeInfo: WorktreeInfo | undefined;
    repoOwner: string; repoName: string; pullRequestNumber: number;
    jobBranchName: string | undefined; jobLlm: string | null | undefined;
    correlatedLogger: Logger; redisClient: Redis;
}

export async function cleanupJob(options: CleanupOptions): Promise<void> {
    const { lockKey, correlationId, localRepoPath, worktreeInfo, repoOwner, repoName, pullRequestNumber, jobBranchName, jobLlm, correlatedLogger, redisClient } = options;
    const lockOwner = await redisClient.get(lockKey);
    if (lockOwner === correlationId) {
        await redisClient.del(lockKey);
        correlatedLogger.debug('Released PR processing lock');
    }

    if (localRepoPath && worktreeInfo) {
        try {
            await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, { deleteBranch: false, success: true });
        } catch (cleanupError) {
            correlatedLogger.warn({ error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
        }
    }

    try {
        const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);
        const remainingPendingComments = await redisClient.llen(pendingCommentsKey);
        if (remainingPendingComments > 0) {
            correlatedLogger.info({ pullRequestNumber, pendingCount: remainingPendingComments }, 'Found pending comments that arrived during processing, queuing follow-up job');

            const followUpJobId = `pr-comments-batch-${repoOwner}-${repoName}-${pullRequestNumber}-${Date.now()}`;
            await issueQueue.add('processPullRequestComment', {
                pullRequestNumber, comments: [], repoOwner, repoName,
                branchName: jobBranchName, llm: jobLlm, correlationId: generateCorrelationId(),
            }, { jobId: followUpJobId, delay: 3000 });

            correlatedLogger.info({ jobId: followUpJobId, pullRequestNumber }, 'Queued follow-up job for pending comments');
        }
    } catch (pendingCheckError) {
        correlatedLogger.warn({ error: (pendingCheckError as Error).message }, 'Failed to check/queue pending comments');
    }
}

export { buildMetricsSection } from './prCommentMetrics.js';

export function parsePendingComment(commentJson: string, correlatedLogger: Logger): UnprocessedComment | null {
    try {
        return JSON.parse(commentJson) as UnprocessedComment;
    } catch (parseError) {
        correlatedLogger.warn({ error: (parseError as Error).message }, 'Failed to parse pending comment');
        return null;
    }
}

export function processPendingComments(commentsToProcess: UnprocessedComment[], pendingComments: string[], correlatedLogger: Logger): void {
    for (const commentJson of pendingComments) {
        const pendingComment = parsePendingComment(commentJson, correlatedLogger);
        if (pendingComment && !commentsToProcess.some(c => c.id === pendingComment.id)) {
            commentsToProcess.push(pendingComment);
        }
    }
}

export async function pickUpPendingComments(commentsToProcess: UnprocessedComment[], options: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis }): Promise<UnprocessedComment[]> {
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient } = options;
    const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);
    try {
        const pendingComments = await redisClient.lrange(pendingCommentsKey, 0, -1);
        if (pendingComments.length > 0) {
            await redisClient.del(pendingCommentsKey);
            processPendingComments(commentsToProcess, pendingComments, correlatedLogger);
            correlatedLogger.info({ pullRequestNumber, pendingCount: pendingComments.length, totalCount: commentsToProcess.length }, 'Picked up pending comments from Redis');
        }
    } catch (redisError) {
        correlatedLogger.warn({ error: (redisError as Error).message }, 'Failed to fetch pending comments from Redis');
    }
    return commentsToProcess;
}

export { buildCompletionComment } from './prCompletionComment.js';
export type { CommentContext, UndoLinkContext } from './prCompletionComment.js';
export type { PRFile } from './prFileUtils.js';
export { fetchPRFiles, fetchPRFileContents, formatPRDiff, formatFileContents, agentResultToClaudeResponse } from './prFileUtils.js';
export { applyPendingCommentCommandContext } from './prCommentCommandContext.js';
