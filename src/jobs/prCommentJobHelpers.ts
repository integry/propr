import { logger } from '@propr/core';
import type { Logger } from 'pino';
import fs from 'fs-extra';
import type { Redis } from 'ioredis';
import { TaskStates } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { db } from '@propr/core';
import { filterCommentByAuthor } from '@propr/core';
import type { UnprocessedComment, CommentJobData } from '@propr/core';

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
    id: number;
    user: { login: string; type?: string };
    body: string | null;
    body_html?: string;  // HTML with signed image URLs
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

type Octokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
    paginate: <T>(endpoint: string, options: Record<string, unknown>) => Promise<T[]>;
    graphql: <T = unknown>(query: string, variables?: Record<string, unknown>) => Promise<T>;
};

export async function validateAndFilterComments(
    commentsToProcess: UnprocessedComment[],
    allCommentsForValidation: ValidationComment[],
    pullRequestNumber: number,
    correlatedLogger: Logger
): Promise<UnprocessedComment[]> {
    const validatedComments: UnprocessedComment[] = [];
    for (const comment of commentsToProcess) {
        // Skip validation for ultrafix synthetic comments (they don't exist on GitHub)
        if (comment.author === 'propr-ultrafix') {
            validatedComments.push(comment);
            continue;
        }

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
    return commentsToProcess
        .filter(comment => {
            // Skip "already processed" check for ultrafix synthetic comments
            if (comment.author === 'propr-ultrafix') {
                return true;
            }

            const alreadyProcessed = prCommentsForValidation.some(prComment => {
                const isBotComment = prComment.user.login === botUsername;
                if (!isBotComment) return false;
                return prComment.body?.includes(`${String(comment.id)}✓`);
            });

            if (alreadyProcessed) {
                correlatedLogger.debug({ pullRequestNumber, commentId: comment.id, commentAuthor: comment.author }, 'Comment already processed, filtering out');
            }

            return !alreadyProcessed;
        })
        .map(comment => {
            // Enrich with body_html from API response (for signed image URLs)
            const apiComment = prCommentsForValidation.find(c => c.id === comment.id);
            if (apiComment && (apiComment as { body_html?: string }).body_html) {
                return { ...comment, body_html: (apiComment as { body_html?: string }).body_html };
            }
            return comment;
        });
}

export interface LinkedIssueResult {
    context: string;
    linkedIssueNumber: number | null;
    bodyHtml?: string;  // HTML with signed image URLs
}

export async function fetchLinkedIssueContext(
    octokit: Octokit,
    prData: PRData,
    repoContext: RepoContext,
    options: FetchLinkedIssueOptions
): Promise<LinkedIssueResult> {
    const { repoOwner, repoName, pullRequestNumber } = repoContext;
    const { correlationId, correlatedLogger } = options;
    let originalTaskSpec = '';
    const bodyHtmlParts: string[] = [];

    // Use GraphQL to get linked issues (cleaner than regex parsing)
    let linkedIssueNumbers: number[] = [];
    try {
        const graphqlResponse = await octokit.graphql<{
            repository: {
                pullRequest: {
                    closingIssuesReferences: {
                        nodes: Array<{ number: number }>;
                    };
                };
            };
        }>(`
            query($owner: String!, $repo: String!, $prNumber: Int!) {
                repository(owner: $owner, name: $repo) {
                    pullRequest(number: $prNumber) {
                        closingIssuesReferences(first: 20) {
                            nodes {
                                number
                            }
                        }
                    }
                }
            }
        `, { owner: repoOwner, repo: repoName, prNumber: pullRequestNumber });

        const linkedIssues = graphqlResponse.repository.pullRequest.closingIssuesReferences.nodes;
        if (linkedIssues.length > 0) {
            linkedIssueNumbers = linkedIssues
                .map(issue => issue.number)
                .filter((issueNumber, index, all) => all.indexOf(issueNumber) === index);
            correlatedLogger.info({ pullRequestNumber, linkedIssueNumbers }, 'Found linked issues via GraphQL');
        }
    } catch (graphqlError) {
        correlatedLogger.warn({ pullRequestNumber, error: (graphqlError as Error).message }, 'GraphQL query for linked issues failed, falling back to regex');
        // Fallback to regex parsing
        const linkedIssueMatches = Array.from(prData.data.body?.matchAll(/(?:closes|fixes|resolves|addresses)\s+#(\d+)/gi) ?? []);
        if (linkedIssueMatches.length > 0) {
            linkedIssueNumbers = linkedIssueMatches
                .map(match => parseInt(match[1], 10))
                .filter((issueNumber, index, all) => Number.isFinite(issueNumber) && all.indexOf(issueNumber) === index);
            correlatedLogger.info({ pullRequestNumber, linkedIssueNumbers }, 'Found linked issues via regex fallback');
        }
    }

    const linkedIssueNumber = linkedIssueNumbers[0] ?? null;
    if (linkedIssueNumbers.length === 0) return { context: originalTaskSpec, linkedIssueNumber: null };

    originalTaskSpec += linkedIssueNumbers.length > 1
        ? `Here are the linked issue specifications for this pull request:\n\n`
        : `Here is the linked issue specification for this pull request:\n\n`;

    for (const issueNumber of linkedIssueNumbers) {
        try {
            const linkedIssueData = await octokit.request<{ data: { title: string; body: string; body_html?: string; user: { login: string } } }>('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner: repoOwner, repo: repoName, issue_number: issueNumber,
                mediaType: { format: 'full' }  // Get body_html with signed image URLs
            });
            if (linkedIssueData.data.body_html) {
                bodyHtmlParts.push(linkedIssueData.data.body_html);
            }

            // Use request for mediaType support - paginate doesn't support it well
            const linkedIssueCommentsResp = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner, repo: repoName, issue_number: issueNumber, per_page: 100,
                mediaType: { format: 'full' }  // Get body_html with signed image URLs
            }) as { data: Array<{ user: { login: string; type?: string }; body: string; body_html?: string }> };
            const linkedIssueComments = linkedIssueCommentsResp.data;
            bodyHtmlParts.push(...linkedIssueComments.filter(c => c.body_html).map(c => c.body_html as string));

            const clarifyingComments = linkedIssueComments.filter(comment => {
                const filterResult = filterCommentByAuthor(comment.user.login, comment.user.type, correlationId);
                return !filterResult.shouldFilter;
            });

            originalTaskSpec += `---\n**Issue #${issueNumber}:** ${linkedIssueData.data.title}\n**Author:** @${linkedIssueData.data.user.login}\n**Body:**\n${formatCommentForPrompt(linkedIssueData.data.body)}\n---\n`;

            if (clarifyingComments.length > 0) {
                originalTaskSpec += `\n**Clarifying Comments on Issue #${issueNumber}:**\n\n`;
                for (const comment of clarifyingComments) {
                    originalTaskSpec += `---\n**Author:** @${comment.user.login}\n**Comment:**\n${formatCommentForPrompt(comment.body)}\n---\n`;
                }
            }
            originalTaskSpec += '\n';
        } catch (issueError) {
            correlatedLogger.warn({ pullRequestNumber, linkedIssueNumber: issueNumber, error: (issueError as Error).message }, 'Failed to fetch linked issue data, continuing without it');
        }
    }

    const bodyHtml = bodyHtmlParts.length > 0 ? bodyHtmlParts.join('\n') : undefined;
    return { context: originalTaskSpec, linkedIssueNumber, bodyHtml };
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
    const TERMINAL_STATES: string[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
    return async (sessionId: string, conversationId?: string): Promise<void> => {
        try {
            // Check current state - don't update if already in a terminal state
            const currentState = await stateManager.getTaskState(taskId);
            if (currentState && TERMINAL_STATES.includes(currentState.state)) {
                correlatedLogger.info({ taskId, currentState: currentState.state }, 'Task already in terminal state, skipping session ID update');
                return;
            }
            if (currentState?.state === TaskStates.CLAUDE_EXECUTION) {
                // Already in claude_execution, just update the history metadata with session info
                await stateManager.updateHistoryMetadata(taskId, 'claude_execution', {
                    sessionId, conversationId, model: llm
                });
            } else {
                // Transition to claude_execution state
                await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
                    reason: 'Claude execution started',
                    claudeResult: { success: false, sessionId, conversationId },
                    historyMetadata: { sessionId, conversationId, model: llm }
                });
            }

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
    const TERMINAL_STATES: string[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
    return async (containerId: string, containerName: string): Promise<void> => {
        try {
            // Check current state - don't update if already in a terminal state
            const currentState = await stateManager.getTaskState(taskId);
            if (!currentState) {
                logger.warn({ taskId }, 'Task state not found when trying to store container info');
                return;
            }

            if (TERMINAL_STATES.includes(currentState.state)) {
                logger.info({ taskId, currentState: currentState.state }, 'Task already in terminal state, skipping container ID update');
                return;
            }

            if (currentState.state === TaskStates.CLAUDE_EXECUTION) {
                // Already in claude_execution, just update the history metadata
                await stateManager.updateHistoryMetadata(taskId, 'claude_execution', { containerId, containerName });
            } else {
                // Not yet in claude_execution state - transition to it with container info
                // This happens when container starts before session_id is received
                await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
                    reason: 'Docker container started',
                    historyMetadata: { containerId, containerName }
                });
            }
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
    linkedIssueNumber?: number | null;
}

export async function updateTaskTitleForPR(options: UpdateTaskTitleOptions): Promise<void> {
    const { taskId, jobData, stateManager, correlatedLogger, linkedIssueNumber } = options;

    // Add linkedIssueNumber to jobData for DB storage
    const jobDataWithIssue = linkedIssueNumber
        ? { ...jobData, issueNumber: linkedIssueNumber }
        : jobData;

    try {
        await db('tasks').where({ task_id: taskId }).update({ initial_job_data: JSON.stringify(jobDataWithIssue) });
        correlatedLogger.info({ taskId, title: jobData.title, subtitle: jobData.subtitle, linkedIssueNumber }, 'Updated task with title/subtitle in DB');
    } catch (dbError) {
        correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to update task with title/subtitle in DB');
    }
    try {
        // Include issueNumber in issueRef if we have a linked issue
        await stateManager.updateIssueRef(taskId, {
            number: jobData.pullRequestNumber,
            repoOwner: jobData.repoOwner,
            repoName: jobData.repoName,
            pullRequestNumber: jobData.pullRequestNumber,
            title: jobData.title,
            subtitle: jobData.subtitle,
            ...(linkedIssueNumber && { issueNumber: linkedIssueNumber })
        });
        correlatedLogger.info({ taskId, title: jobData.title, linkedIssueNumber }, 'Updated task with title/subtitle in Redis');
    } catch (redisError) {
        correlatedLogger.warn({ taskId, error: (redisError as Error).message }, 'Failed to update task with title/subtitle in Redis');
    }
}

export { buildCompletionComment } from './prCompletionComment.js';
