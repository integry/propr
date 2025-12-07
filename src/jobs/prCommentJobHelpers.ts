import logger from '../utils/logger.js';
import type { Logger } from 'pino';
import fs from 'fs-extra';
import type { Redis } from 'ioredis';
import { TaskStates } from '../utils/workerStateManager.js';
import type { WorkerStateManager } from '../utils/workerStateManager.js';
import { getUsageStats, type ClaudeResult as TokenClaudeResult } from '../utils/tokenCalculation.js';
import { db, isEnabled as isDbEnabled } from '../db/postgres.js';
import { filterCommentByAuthor } from '../utils/commentFilters.js';
import type { UnprocessedComment, CommentJobData } from '../queue/taskQueue.js';
import type { ClaudeCodeResponse } from '../claude/claudeService.js';
import type { CommitResult } from '../git/repoManager.js';

interface ValidationComment {
    id: number;
    body?: string;
    updated_at?: string;
}

interface PRData {
    data: {
        body: string | null;
        user: { login: string };
    };
}

interface PRComment {
    user: { login: string; type?: string };
    body: string | null;
    created_at: string;
    pull_request_review_id?: number;
}

interface RepoContext {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
}

interface FetchLinkedIssueOptions {
    correlationId: string;
    correlatedLogger: Logger;
}

interface SessionIdOptions {
    llm: string;
    stateManager: WorkerStateManager;
    correlatedLogger: Logger;
    redisClient: InstanceType<typeof Redis>;
}

interface PRContext {
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
}

interface CommentContext {
    changesSummary: string;
    commitMessage: string;
    llm: string | null | undefined;
    authorsText: string;
}

type Octokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
    paginate: <T>(endpoint: string, options: Record<string, unknown>) => Promise<T[]>;
};

export async function validateAndFilterComments(
    commentsToProcess: UnprocessedComment[],
    allCommentsForValidation: ValidationComment[],
    pullRequestNumber: number,
    correlatedLogger: Logger
): Promise<UnprocessedComment[]> {
    const validatedComments: UnprocessedComment[] = [];
    for (const comment of commentsToProcess) {
        const currentComment = allCommentsForValidation.find(c => c.id === comment.id);

        if (!currentComment) {
            correlatedLogger.warn({ pullRequestNumber, commentId: comment.id, commentAuthor: comment.author }, 'Comment has been deleted, skipping');
            continue;
        }

        const commentWasEditedAfterQueuing = (comment as unknown as { updated_at?: string }).updated_at && currentComment.updated_at !== (comment as unknown as { updated_at?: string }).updated_at;

        if (commentWasEditedAfterQueuing) {
            correlatedLogger.info({ pullRequestNumber, commentId: comment.id, commentAuthor: comment.author }, 'Comment has been edited since job was queued, using updated content');
            validatedComments.push({ ...comment, body: currentComment.body || comment.body });
        } else {
            validatedComments.push(comment);
        }
    }
    return validatedComments;
}

interface FilterOptions {
    pullRequestNumber: number;
    correlatedLogger: Logger;
}

export function filterUnprocessedComments(
    commentsToProcess: UnprocessedComment[],
    prCommentsForValidation: PRComment[],
    botUsername: string,
    options: FilterOptions
): UnprocessedComment[] {
    const { pullRequestNumber, correlatedLogger } = options;
    return commentsToProcess.filter(comment => {
        const alreadyProcessed = prCommentsForValidation.some(prComment => {
            const isBotComment = prComment.user.login === botUsername;
            if (!isBotComment) return false;
            return prComment.body?.includes(`${String(comment.id)}✓`);
        });

        if (alreadyProcessed) {
            correlatedLogger.debug({ pullRequestNumber, commentId: comment.id, commentAuthor: comment.author }, 'Comment already processed, filtering out');
        }

        return !alreadyProcessed;
    });
}

export async function fetchLinkedIssueContext(
    octokit: Octokit,
    prData: PRData,
    repoContext: RepoContext,
    options: FetchLinkedIssueOptions
): Promise<string> {
    const { repoOwner, repoName, pullRequestNumber } = repoContext;
    const { correlationId, correlatedLogger } = options;
    let originalTaskSpec = '';
    const linkedIssueMatch = prData.data.body?.match(/(?:closes|fixes|resolves|addresses)\s+#(\d+)/i);

    if (!linkedIssueMatch) return originalTaskSpec;

    const linkedIssueNumber = parseInt(linkedIssueMatch[1], 10);
    correlatedLogger.info({ pullRequestNumber, linkedIssueNumber }, 'Found linked issue in PR body');

    try {
        const linkedIssueData = await octokit.request<{ data: { title: string; body: string; user: { login: string } } }>('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner: repoOwner, repo: repoName, issue_number: linkedIssueNumber
        });

        const linkedIssueComments = await octokit.paginate<{ user: { login: string; type?: string }; body: string }>('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: linkedIssueNumber, per_page: 100
        });

        const clarifyingComments = linkedIssueComments.filter(comment => {
            const filterResult = filterCommentByAuthor(comment.user.login, comment.user.type, correlationId);
            return !filterResult.shouldFilter;
        });

        originalTaskSpec += `Here is the original task specification (GitHub Issue #${linkedIssueNumber}):\n\n`;
        originalTaskSpec += `---\n**Issue Title:** ${linkedIssueData.data.title}\n**Author:** @${linkedIssueData.data.user.login}\n**Body:**\n${formatCommentForPrompt(linkedIssueData.data.body)}\n---\n`;

        if (clarifyingComments.length > 0) {
            originalTaskSpec += `\n**Clarifying Comments on Issue #${linkedIssueNumber}:**\n\n`;
            for (const comment of clarifyingComments) {
                originalTaskSpec += `---\n**Author:** @${comment.user.login}\n**Comment:**\n${formatCommentForPrompt(comment.body)}\n---\n`;
            }
        }
        originalTaskSpec += '\n';

    } catch (issueError) {
        correlatedLogger.warn({ pullRequestNumber, linkedIssueNumber, error: (issueError as Error).message }, 'Failed to fetch linked issue data, continuing without it');
    }

    return originalTaskSpec;
}

export function formatCommentForPrompt(body: string | null): string {
    if (!body) return '[Empty comment]';
    const maxLength = 1000;
    return body.length > maxLength ? body.substring(0, maxLength) + '... (comment truncated)' : body;
}

export function buildCommentHistory(commentsByTime: PRComment[], prData: PRData, correlationId: string): string {
    let commentHistory = '';
    const reversedComments = [...commentsByTime].reverse();

    if (reversedComments.length > 0 || prData.data.body) {
        commentHistory += 'Here is the recent comment history on this PR (newest first) for context:\n\n';
    }

    if (reversedComments.length > 0) {
        for (const comment of reversedComments) {
            const filterResult = filterCommentByAuthor(comment.user.login, comment.user.type, correlationId);
            if (filterResult.shouldFilter) continue;

            const author = comment.user.login;
            const body = formatCommentForPrompt(comment.body);
            const commentType = comment.pull_request_review_id ? 'Review Comment' : 'General Comment';
            commentHistory += `---\n**Author:** @${author} (${commentType})\n**Comment:**\n${body}\n---\n`;
        }
    }

    if (prData.data.body) {
        const author = prData.data.user.login;
        const body = formatCommentForPrompt(prData.data.body);
        commentHistory += `---\n**Author:** @${author} (Original Task Description)\n**Comment:**\n${body}\n---\n`;
    }

    if (commentHistory) commentHistory += '\n';
    return commentHistory;
}

export function createSessionIdCallbackForPR(
    taskId: string,
    prContext: PRContext,
    options: SessionIdOptions
): (sessionId: string, conversationId?: string) => Promise<void> {
    const { pullRequestNumber, repoOwner, repoName } = prContext;
    const { llm, stateManager, correlatedLogger, redisClient } = options;
    return async (sessionId: string, conversationId?: string): Promise<void> => {
        try {
            await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
                reason: 'Claude execution started',
                claudeResult: { success: false, sessionId, conversationId },
                historyMetadata: { sessionId, conversationId, model: llm }
            });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logDir = '/tmp/claude-logs';
            await fs.ensureDir(logDir);

            const filePrefix = `issue-${pullRequestNumber}-${timestamp}`;
            const conversationPath = `${logDir}/${filePrefix}-conversation.json`;

            await fs.writeFile(conversationPath, JSON.stringify({
                sessionId, conversationId, timestamp: new Date().toISOString(),
                issueNumber: pullRequestNumber, repository: `${repoOwner}/${repoName}`,
                messages: [], _streaming: true
            }, null, 2));

            const logData = {
                files: { conversation: conversationPath },
                issueNumber: pullRequestNumber, repository: `${repoOwner}/${repoName}`,
                timestamp, sessionId, conversationId
            };

            if (sessionId) await redisClient.set(`execution:logs:session:${sessionId}`, JSON.stringify(logData), 'EX', 86400 * 30);
            if (conversationId) await redisClient.set(`execution:logs:conversation:${conversationId}`, JSON.stringify(logData), 'EX', 86400 * 30);
        } catch (error) {
            correlatedLogger.warn({ error: (error as Error).message, taskId, sessionId }, 'Failed to update task state with early sessionId');
        }
    };
}

export function createContainerIdCallbackForPR(
    taskId: string,
    stateManager: WorkerStateManager
): (containerId: string, containerName: string) => Promise<void> {
    return async (containerId: string, containerName: string): Promise<void> => {
        try {
            await stateManager.updateHistoryMetadata(taskId, 'claude_execution', { containerId, containerName });
            logger.info({ taskId, containerId, containerName }, 'Docker container info added to task state');
        } catch (err) {
            logger.warn({ taskId, error: (err as Error).message }, 'Failed to update state with container info');
        }
    };
}

interface UpdateTaskTitleOptions {
    taskId: string;
    jobData: CommentJobData;
    stateManager: WorkerStateManager;
    correlatedLogger: Logger;
    redisClient?: InstanceType<typeof Redis>;
}

export async function updateTaskTitleForPR(options: UpdateTaskTitleOptions): Promise<void> {
    const { taskId, jobData, stateManager, correlatedLogger, redisClient } = options;
    if (isDbEnabled && db) {
        try {
            await db('tasks').where({ task_id: taskId }).update({ initial_job_data: JSON.stringify(jobData) });
            correlatedLogger.info({ taskId, title: jobData.title, subtitle: jobData.subtitle }, 'Updated task with title/subtitle in DB');
        } catch (dbError) {
            correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to update task with title/subtitle in DB');
        }
    }
    if (redisClient) {
        try {
            const state = await stateManager.getTaskState(taskId);
            if (state) {
                state.issueRef = { number: jobData.pullRequestNumber, repoOwner: jobData.repoOwner, repoName: jobData.repoName };
                await redisClient.setex(stateManager.getTaskKey(taskId), 7 * 24 * 3600, JSON.stringify(state));
                correlatedLogger.info({ taskId, title: jobData.title }, 'Updated task with title/subtitle in Redis');
            }
        } catch (redisError) {
            correlatedLogger.warn({ taskId, error: (redisError as Error).message }, 'Failed to update task with title/subtitle in Redis');
        }
    }
}

export function buildCompletionComment(
    commitResult: CommitResult | null,
    unprocessedComments: UnprocessedComment[],
    commentContext: CommentContext,
    claudeResult: ClaudeCodeResponse
): string {
    const { changesSummary, commitMessage, llm, authorsText } = commentContext;

    if (commitResult) {
        let prCommentBody = `✅ **Applied the requested follow-up changes** in commit ${commitResult.commitHash.substring(0, 7)}\n\n`;

        if (unprocessedComments.length > 1) {
            prCommentBody += `Processed ${unprocessedComments.length} comments:\n`;
            unprocessedComments.forEach((comment, index) => {
                prCommentBody += `- Comment ${index + 1} by @${comment.author} (ID: ${String(comment.id)}✓)\n`;
            });
            prCommentBody += '\n';
        }

        if (changesSummary) {
            const commitBody = commitMessage.split('\n\n').slice(1).join('\n\n').trim();
            prCommentBody += `## Summary of Changes\n\n${commitBody || changesSummary}\n\n`;
        }

        prCommentBody += buildMetricsSection(claudeResult, llm, authorsText);
        prCommentBody += `\n\n---\n_Processing comment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}_`;

        return prCommentBody;
    } else {
        let noChangesBody = `ℹ️ **Analyzed the follow-up request** by ${authorsText}\n\n`;

        if (changesSummary) {
            noChangesBody += `## Analysis Summary\n\n${changesSummary}\n\n`;
        }

        noChangesBody += `No code changes were necessary based on the current state of the branch.\n\n`;
        noChangesBody += buildMetricsSection(claudeResult, llm, authorsText, true);
        noChangesBody += `\n\n---\n_Processing comment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}_`;

        return noChangesBody;
    }
}

function buildMetricsSection(
    claudeResult: ClaudeCodeResponse,
    llm: string | null | undefined,
    authorsText: string,
    isAnalysis = false
): string {
    const defaultModel = process.env.DEFAULT_CLAUDE_MODEL || 'claude-sonnet-4-20250514';
    let section = `---\n🤖 **${isAnalysis ? 'Analysis' : 'Implemented'} by Claude Code**\n`;

    if (!isAnalysis) section += `- Requested by: ${authorsText}\n`;
    section += `- Model: ${claudeResult.model || llm || defaultModel}\n`;

    if ((claudeResult.finalResult as { num_turns?: number } | null)?.num_turns) {
        section += `- Turns: ${(claudeResult.finalResult as { num_turns?: number }).num_turns}\n`;
    }
    if (claudeResult.executionTime) {
        section += `- ${isAnalysis ? 'Analysis' : 'Execution'} time: ${Math.round(claudeResult.executionTime / 1000)}s\n`;
    }

    const { inputTokens, outputTokens, totalTokens } = getUsageStats({ conversationLog: claudeResult.conversationLog as TokenClaudeResult['conversationLog'] });
    if (totalTokens > 0) {
        section += `- Tokens used: ${totalTokens.toLocaleString()} [${inputTokens.toLocaleString()} input + ${outputTokens.toLocaleString()} output]\n`;
    }

    const cost = claudeResult.finalResult?.cost_usd || (claudeResult.finalResult as { total_cost_usd?: number } | null)?.total_cost_usd;
    if (cost != null) {
        section += `- Cost: $${cost.toFixed(2)}\n`;
    }

    return section;
}
