import type { Logger } from 'pino';
import type { Job } from 'bullmq';
import { generateCorrelationId } from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { cleanupWorktree } from '../git/repoManager.js';
import type { WorktreeInfo } from '../git/repoManager.js';
import { formatResetTime } from '../utils/scheduling.js';
import type { ClaudeCodeResponse } from '../claude/claudeService.js';
import { recordLLMMetrics } from '../utils/llmMetrics.js';
import { issueQueue, type CommentJobData, type UnprocessedComment } from '../queue/taskQueue.js';
import { TaskStates } from '../utils/workerStateManager.js';
import type { WorkerStateManager } from '../utils/workerStateManager.js';
import { getDefaultModel, resolveModelAlias } from '../config/modelAliases.js';
import { getPendingPrCommentsKey } from '../utils/constants.js';
import type { Redis } from 'ioredis';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();
const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || String(5 * 60 * 1000), 10);
const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || String(2 * 60 * 1000), 10);
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';

interface PRComment {
    id: number;
    body: string;
    user: { login: string; type?: string };
    created_at: string;
    pull_request_review_id?: number;
}

export interface CombinedCommentResult {
    combinedCommentBody: string;
    commentAuthors: string[];
}

export function buildCombinedComment(unprocessedComments: UnprocessedComment[]): CombinedCommentResult {
    let combinedCommentBody: string;
    let commentAuthors: string[] = [];

    if (unprocessedComments.length === 1) {
        combinedCommentBody = unprocessedComments[0].body;
        commentAuthors = [unprocessedComments[0].author];
    } else {
        combinedCommentBody = unprocessedComments.map((comment, index) => `**Comment ${index + 1}** (by @${comment.author}):\n${comment.body}`).join('\n\n---\n\n');
        commentAuthors = [...new Set(unprocessedComments.map(c => c.author))];
    }
    return { combinedCommentBody, commentAuthors };
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

export async function fetchAllComments(octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>, repoOwner: string, repoName: string, pullRequestNumber: number): Promise<PRComment[]> {
    const issueComments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner: repoOwner, repo: repoName, issue_number: pullRequestNumber, per_page: 100 }) as PRComment[];
    const reviewComments = await octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', { owner: repoOwner, repo: repoName, pull_number: pullRequestNumber, per_page: 100 }) as PRComment[];
    return [...issueComments, ...reviewComments];
}

export interface CommitMessageOptions {
    changesSummary: string;
    unprocessedComments: UnprocessedComment[];
    pullRequestNumber: number;
    claudeResult: ClaudeCodeResponse;
    llm: string | null | undefined;
    authorsText: string;
}

export function buildCommitMessage(options: CommitMessageOptions): string {
    const { changesSummary, unprocessedComments, pullRequestNumber, claudeResult, llm, authorsText } = options;
    let commitDetails = '';
    if (changesSummary) {
        const lines = changesSummary.split('\n');
        const changeLines = lines.filter(line => line.trim().startsWith('-') || line.trim().startsWith('*') || line.trim().startsWith('•') || line.match(/^\d+\./)).slice(0, 10);
        if (changeLines.length > 0) {
            commitDetails = '\n\nKey changes:\n' + changeLines.join('\n');
        }
    }

    const commentReferences = unprocessedComments.map(c => `Comment by: @${c.author} (ID: ${c.id})`).join('\n');

    return `feat(ai): ${changesSummary ? changesSummary.split('\n')[0] : 'Apply follow-up changes from PR comment'}

${changesSummary ? changesSummary : `Implemented changes requested by ${authorsText}`}${commitDetails}

PR: #${pullRequestNumber}
${commentReferences}
Model: ${claudeResult.model || llm || DEFAULT_MODEL_NAME}`;
}

export interface PromptOptions {
    pullRequestNumber: number;
    combinedCommentBody: string;
    commentHistory: string;
    originalTaskSpec: string;
    worktreeInfo: WorktreeInfo;
    repoOwner: string;
    repoName: string;
    commentCount: number;
}

export function buildPrompt(options: PromptOptions): string {
    const { pullRequestNumber, combinedCommentBody, commentHistory, originalTaskSpec, worktreeInfo, repoOwner, repoName, commentCount } = options;
    return `You are working on pull request #${pullRequestNumber} to apply follow-up changes.

**New Request${commentCount > 1 ? 's' : ''}:**
${combinedCommentBody.replace(/^/gm, '> ')}

${commentHistory}${originalTaskSpec}

**CRITICAL INSTRUCTIONS:**
- You are in directory: ${worktreeInfo.worktreePath}
- Analyze the existing code on this branch and the comment history provided above.
- Implement ONLY the changes requested in the **New Request(s)** section.
- DO NOT commit your changes - the system will handle the commit for you
- DO NOT create a new pull request
- The repository is ${repoOwner}/${repoName}

**Context:**
- This is a follow-up to an existing pull request #${pullRequestNumber}.
- Make sure your changes are compatible with the existing modifications on this branch.`;
}

export interface JobErrorOptions {
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    authorsText: string;
    unprocessedComments: UnprocessedComment[];
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
    startingWorkComment: { data: { id: number } } | null;
    claudeResult: ClaudeCodeResponse | null;
    correlationId: string;
    correlatedLogger: Logger;
    stateManager: WorkerStateManager;
    taskId: string;
}

export class UsageLimitError extends Error {
    resetTimestamp?: number;
    constructor(message: string, resetTimestamp?: number) {
        super(message);
        this.name = 'UsageLimitError';
        this.resetTimestamp = resetTimestamp;
    }
}

export async function handleJobError(error: Error, job: Job<CommentJobData>, options: JobErrorOptions): Promise<void> {
    const { pullRequestNumber, repoOwner, repoName, authorsText, unprocessedComments, octokit, startingWorkComment, claudeResult, correlationId, correlatedLogger, stateManager, taskId } = options;
    if (error.name === 'UsageLimitError' || error.message?.includes('usage limit')) {
        const usageLimitError = error as UsageLimitError;
        correlatedLogger.warn({ pullRequestNumber, resetTimestamp: usageLimitError.resetTimestamp }, 'Claude usage limit hit during PR comment processing. Requeueing job.');

        const resetTimeUTC = usageLimitError.resetTimestamp ? (usageLimitError.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000);
        const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);
        const readableResetTime = formatResetTime(usageLimitError.resetTimestamp);

        if (octokit) {
            try {
                await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
                    body: `⌛ **Processing Delayed:** Claude's usage limit was reached while processing requests from ${authorsText}.\n\nThe job has been automatically rescheduled and will restart ${readableResetTime}.\n\n---\n*Job ID: ${job.id} will run again after delay.*`
                });
            } catch (commentError) {
                correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post usage limit delay comment to PR.');
            }
        }

        await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });
    } else {
        handleError(error, 'Failed to process PR comment job', { correlationId });

        await stateManager.updateTaskState(taskId, TaskStates.FAILED, { reason: 'PR comment processing failed', error: { message: error.message } });

        if (claudeResult) {
            try {
                await recordLLMMetrics(claudeResult as unknown as Parameters<typeof recordLLMMetrics>[0], { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'pr_comment', correlationId, taskId });
            } catch (metricsError) {
                correlatedLogger.error({ error: (metricsError as Error).message, correlationId }, 'Failed to record LLM metrics for failed PR comment job');
            }
        }

        if (octokit && startingWorkComment) {
            try {
                await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                    owner: repoOwner, repo: repoName, comment_id: startingWorkComment.data.id,
                    body: `❌ **Failed to apply follow-up changes** requested by ${authorsText}\n\nAn error occurred while processing your request:\n\n\`\`\`\n${error.message}\n\`\`\`\n\n---\nComment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}\nPlease check the logs for more details.`,
                });
            } catch (commentError) {
                correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post error comment');
            }
        }
    }
}

export interface CleanupOptions {
    stateManager: WorkerStateManager;
    lockKey: string;
    correlationId: string;
    localRepoPath: string | undefined;
    worktreeInfo: WorktreeInfo | undefined;
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    jobBranchName: string | undefined;
    jobLlm: string | null | undefined;
    correlatedLogger: Logger;
    redisClient: Redis;
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
