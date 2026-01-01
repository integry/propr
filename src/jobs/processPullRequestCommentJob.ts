import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '@gitfix/core';
import { getAuthenticatedOctokit } from '@gitfix/core';
import { withRetry, retryConfigs } from '@gitfix/core';
import { getStateManager, TaskStates } from '@gitfix/core';
import type { WorkerStateManager } from '@gitfix/core';
import { ensureRepoCloned, createWorktreeFromExistingBranch, getRepoUrl, commitChanges, pushBranch } from '@gitfix/core';
import type { WorktreeInfo } from '@gitfix/core';
import { ensureGitRepository } from '@gitfix/core';
import { createLogFiles } from '@gitfix/core';
import { UsageLimitError, generateTaskSummary, AgentRegistry, resolveLlmLabel } from '@gitfix/core';
import type { ClaudeCodeResponse, AgentExecutionResult } from '@gitfix/core';
import type { ClaudeResult } from '@gitfix/core';
import { recordLLMMetrics } from '@gitfix/core';
import { issueQueue, type CommentJobData, type UnprocessedComment, type JobResult } from '@gitfix/core';
import { Redis } from 'ioredis';
import { getDefaultModel } from '@gitfix/core';
import { loadPrLabel } from '@gitfix/core';
import {
    validateAndFilterComments, filterUnprocessedComments, fetchLinkedIssueContext,
    buildCommentHistory, createSessionIdCallbackForPR, createContainerIdCallbackForPR, updateTaskTitleForPR, buildCompletionComment
} from './prCommentJobHelpers.js';
import { localizeContentImages } from './issueJobHelpers.js';
import {
    buildCombinedComment, extractModelFromLabels, fetchAllComments, buildCommitMessage, buildPrompt,
    handleJobError, cleanupJob, pickUpPendingComments
} from './prCommentJobUtils.js';

function toClaudeResult(response: ClaudeCodeResponse): ClaudeResult {
    return {
        model: response.model,
        success: response.success,
        executionTime: response.executionTime,
        sessionId: response.sessionId,
        conversationId: response.conversationId,
        finalResult: response.finalResult,
        conversationLog: response.conversationLog as ClaudeResult['conversationLog'],
        error: response.error
    };
}

/**
 * Converts AgentExecutionResult to ClaudeCodeResponse for backwards compatibility
 * with existing post-processing code.
 */
function agentResultToClaudeResponse(result: AgentExecutionResult): ClaudeCodeResponse {
    return {
        success: result.success,
        model: result.modelUsed,
        executionTime: result.executionTimeMs,
        output: null,
        sessionId: result.sessionId || null,
        conversationId: result.conversationId,
        finalResult: result.summary ? { type: 'result', result: result.summary } : null,
        rawOutput: result.rawOutput,
        summary: result.summary || null,
        logs: result.logs,
        exitCode: result.exitCode ?? null,
        error: result.error,
        modifiedFiles: result.modifiedFiles,
        commitMessage: result.commitMessage || null
    };
}

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

interface GitHubToken { token: string }
interface PRData { data: { head: { ref: string }; body: string | null; labels: Array<{ name: string }>; user: { login: string }; title: string } }
interface PRComment { id: number; body: string; body_html?: string; user: { login: string; type?: string }; created_at: string; pull_request_review_id?: number }

interface PRJobContext {
    pullRequestNumber: number;
    jobBranchName: string | undefined;
    repoOwner: string;
    repoName: string;
    llm: string | null | undefined;
    correlationId: string;
    correlatedLogger: Logger;
    PR_LABEL: string;
    isBatchJob: boolean;
    commentsToProcess: UnprocessedComment[];
}

interface ValidationResult {
    skip: boolean;
    reason?: string;
    prData?: PRData;
    validatedComments?: UnprocessedComment[];
    unprocessedComments?: UnprocessedComment[];
    llm?: string | null;
    prCommentsForValidation?: PRComment[];
}

interface LockParams {
    lockKey: string;
    correlationId: string;
    correlatedLogger: Logger;
    job: Job<CommentJobData>;
}

interface ProcessingState {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
    localRepoPath: string | undefined;
    worktreeInfo: WorktreeInfo | undefined;
    claudeResult: ClaudeCodeResponse | null;
    authorsText: string;
    unprocessedComments: UnprocessedComment[];
    startingWorkComment: { data: { id: number; html_url: string } } | null;
}

async function getPrLabel(): Promise<string> {
    try {
        if (process.env.CONFIG_REPO) return await loadPrLabel();
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Failed to load PR label from config, using fallback');
    }
    return process.env.PR_LABEL || 'gitfix';
}

async function initializePRJobContext(job: Job<CommentJobData>): Promise<PRJobContext> {
    const { pullRequestNumber, commentId, commentBody, commentAuthor, comments, branchName: jobBranchName, repoOwner, repoName, llm: jobLlm, correlationId } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const PR_LABEL = await getPrLabel();
    const isBatchJob = !!comments && Array.isArray(comments);
    let commentsToProcess: UnprocessedComment[] = isBatchJob ? [...comments] : [{ id: commentId!, body: commentBody!, author: commentAuthor!, type: 'issue' as const }];
    commentsToProcess = await pickUpPendingComments(commentsToProcess, { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient });
    return { pullRequestNumber, jobBranchName, repoOwner, repoName, llm: jobLlm, correlationId, correlatedLogger, PR_LABEL, isBatchJob, commentsToProcess };
}

async function acquirePRLock(lockParams: LockParams): Promise<boolean> {
    const { lockKey, correlationId, correlatedLogger, job } = lockParams;
    const currentLock = await redisClient.get(lockKey);
    if (currentLock && currentLock !== correlationId) {
        correlatedLogger.info({ lockOwner: currentLock }, 'PR is currently being processed by another job. Rescheduling...');
        await issueQueue.add(job.name, job.data, { delay: 10000 });
        return false;
    }
    await redisClient.set(lockKey, correlationId, 'EX', 3600);
    return true;
}

async function validatePRAndComments(octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>, context: PRJobContext & { llm: string | null | undefined }): Promise<ValidationResult> {
    const { commentsToProcess, pullRequestNumber, repoOwner, repoName, PR_LABEL, correlatedLogger, llm: initialLlm } = context;
    const prData = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: repoOwner, repo: repoName, pull_number: pullRequestNumber,
        mediaType: { format: 'full' }  // Get body_html with signed image URLs
    }) as PRData;
    const botUsername = process.env.GITHUB_BOT_USERNAME || 'gitfixio[bot]';
    // Use request for mediaType support - paginate doesn't support it well
    const prCommentsResp = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: repoOwner, repo: repoName, issue_number: pullRequestNumber, per_page: 100,
        mediaType: { format: 'full' }  // Get body_html with signed image URLs
    });
    const prCommentsForValidation = prCommentsResp.data as PRComment[];
    const reviewCommentsResp = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
        owner: repoOwner, repo: repoName, pull_number: pullRequestNumber, per_page: 100,
        mediaType: { format: 'full' }  // Get body_html with signed image URLs
    });
    const reviewCommentsForValidation = reviewCommentsResp.data as PRComment[];
    const allCommentsForValidation = [...prCommentsForValidation, ...reviewCommentsForValidation];
    const validatedComments = await validateAndFilterComments(commentsToProcess, allCommentsForValidation, pullRequestNumber, correlatedLogger);
    if (validatedComments.length === 0) return { skip: true, reason: 'all_comments_deleted' };
    if (!prData.data.labels.some(label => label.name === PR_LABEL)) return { skip: true, reason: 'missing_required_label' };
    const llm = extractModelFromLabels(prData.data.labels, initialLlm, pullRequestNumber, correlatedLogger);
    const unprocessedComments = filterUnprocessedComments(validatedComments, prCommentsForValidation, botUsername, { pullRequestNumber, correlatedLogger });
    if (unprocessedComments.length === 0) return { skip: true, reason: 'already_processed' };
    return { skip: false, prData, validatedComments, unprocessedComments, llm, prCommentsForValidation };
}

interface SummaryTitleOptions {
    combinedCommentBody: string;
    worktreeInfo: WorktreeInfo;
    githubToken: GitHubToken;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    correlationId: string;
    taskId: string;
    correlatedLogger: Logger;
}

async function generateSummaryTitle(options: SummaryTitleOptions): Promise<string> {
    const { combinedCommentBody, worktreeInfo, githubToken, pullRequestNumber, repoOwner, repoName, correlationId, taskId, correlatedLogger } = options;
    try {
        const summaryRequest = `Summarize this change request in one sentence, focusing on the main action: ${combinedCommentBody}`;
        const title = await generateTaskSummary({ summaryRequest, worktreePath: worktreeInfo.worktreePath, githubToken: githubToken.token, issueRef: { number: pullRequestNumber, repoOwner, repoName }, correlationId, modelAlias: 'haiku' });
        correlatedLogger.info({ taskId, summaryTitle: title }, 'Generated AI summary for follow-up task');
        return title;
    } catch (summaryError) {
        correlatedLogger.warn({ taskId, error: (summaryError as Error).message }, 'Failed to generate AI summary, falling back to truncation.');
        if (combinedCommentBody) {
            const firstLine = combinedCommentBody.split('\n')[0].replace(/[^a-zA-Z0-9 ]/g, '').trim();
            return "Follow-up: " + firstLine.substring(0, 75) + (firstLine.length > 75 ? '...' : '');
        }
        return `Follow-up: PR #${pullRequestNumber}`;
    }
}

interface ExecuteProcessingParams {
    job: Job<CommentJobData>;
    context: PRJobContext;
    llm: string | null | undefined;
    taskId: string;
    stateManager: WorkerStateManager;
    state: ProcessingState;
}

async function executeProcessing(params: ExecuteProcessingParams): Promise<JobResult> {
    const { job, context, taskId, stateManager, state } = params;
    let { llm } = params;
    const { pullRequestNumber, jobBranchName, repoOwner, repoName, correlationId, correlatedLogger } = context;

    state.octokit = await withRetry(() => getAuthenticatedOctokit(), { ...retryConfigs.githubApi, correlationId }, 'get_authenticated_octokit');
    const validation = await validatePRAndComments(state.octokit, { ...context, llm });
    if (validation.skip) {
        correlatedLogger.info({ pullRequestNumber, reason: validation.reason }, 'Skipping PR comment processing');
        return { status: 'skipped', reason: validation.reason, pullRequestNumber };
    }

    const { prData, unprocessedComments: validUnprocessed, llm: resolvedLlm } = validation;
    state.unprocessedComments = validUnprocessed!;
    llm = resolvedLlm;
    const branchName = jobBranchName || prData!.data.head.ref;
    const { combinedCommentBody, combinedBodyHtml, commentAuthors } = buildCombinedComment(state.unprocessedComments);
    state.authorsText = commentAuthors.map(a => `@${a}`).join(', ');

    // Construct Task URL for linking to the Web UI
    const webUiUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
    const taskUrl = `${webUiUrl}/tasks/${taskId}`;

    const allComments = await fetchAllComments(state.octokit, repoOwner, repoName, pullRequestNumber);
    const commentsByTime = allComments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const linkedIssueResult = await fetchLinkedIssueContext(state.octokit as unknown as Parameters<typeof fetchLinkedIssueContext>[0], prData!, { repoOwner, repoName, pullRequestNumber }, { correlationId, correlatedLogger });
    const originalTaskSpec = linkedIssueResult.context;
    const linkedIssueNumber = linkedIssueResult.linkedIssueNumber;
    const commentHistory = buildCommentHistory(commentsByTime, prData!, correlationId);

    state.startingWorkComment = await state.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
        body: `🔄 **Starting work on follow-up changes** requested by ${state.authorsText}\n\nI'll analyze the ${state.unprocessedComments.length} request${state.unprocessedComments.length > 1 ? 's' : ''} and implement the necessary changes.\n\n[View Task Progress](${taskUrl})\n\n---\n_Processing comment ID${state.unprocessedComments.length > 1 ? 's' : ''}: ${state.unprocessedComments.map(c => String(c.id) + '✓').join(', ')}_`,
    });

    const githubToken = await state.octokit.auth({ type: "installation" }) as GitHubToken;
    const repoUrl = getRepoUrl({ repoOwner, repoName });

    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting PR comment processing' });
    await ensureGitRepository(correlatedLogger);
    state.localRepoPath = await ensureRepoCloned(repoUrl, repoOwner, repoName, githubToken.token);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    state.worktreeInfo = await createWorktreeFromExistingBranch(state.localRepoPath, branchName, { worktreeDirName: `pr-${pullRequestNumber}-followup-${timestamp}`, owner: repoOwner, repoName });
    correlatedLogger.info({ worktreePath: state.worktreeInfo.worktreePath, branchName: state.worktreeInfo.branchName }, 'Created worktree from existing PR branch');

    // Localize remote images FIRST so they're available for summary generation
    // This downloads images to the worktree so the agent can access them
    // We pass body_html which contains signed URLs for GitHub user-attachments
    // Assets are stored in subdirectory identified by PR number for cleanup when PR is merged
    const localizedCombinedCommentBody = await localizeContentImages(combinedCommentBody, state.worktreeInfo.worktreePath, correlatedLogger, { bodyHtml: combinedBodyHtml, issueOrPrId: pullRequestNumber });
    // For originalTaskSpec (linked issue), we'd need body_html from the issue
    const localizedOriginalTaskSpec = originalTaskSpec
        ? await localizeContentImages(originalTaskSpec, state.worktreeInfo.worktreePath, correlatedLogger, { bodyHtml: linkedIssueResult.bodyHtml, issueOrPrId: pullRequestNumber })
        : originalTaskSpec;

    // Generate summary using localized content so Haiku can see images
    const summaryTitle = await generateSummaryTitle({ combinedCommentBody: localizedCombinedCommentBody, worktreeInfo: state.worktreeInfo, githubToken, pullRequestNumber, repoOwner, repoName, correlationId, taskId, correlatedLogger });
    job.data.title = `Followup: ${prData!.data.title}`;
    job.data.subtitle = summaryTitle;
    await updateTaskTitleForPR({ taskId, jobData: job.data, stateManager, correlatedLogger, redisClient, linkedIssueNumber });

    const prompt = buildPrompt({ pullRequestNumber, combinedCommentBody: localizedCombinedCommentBody, commentHistory, originalTaskSpec: localizedOriginalTaskSpec, worktreeInfo: state.worktreeInfo, repoOwner, repoName, commentCount: state.unprocessedComments.length });

    // Resolve agent and model using resolveLlmLabel
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const modelToUse = llm || DEFAULT_MODEL_NAME;
    const resolution = await resolveLlmLabel(modelToUse);
    const agent = registry.getAgentByAlias(resolution.agentAlias);

    if (!agent) {
        throw new Error(`Agent not found for alias: ${resolution.agentAlias}`);
    }

    correlatedLogger.info({
        agentAlias: resolution.agentAlias,
        agentType: agent.config.type,
        model: resolution.model,
        pullRequestNumber
    }, 'Executing PR comment task with agent');

    // Execute task via agent abstraction
    const agentResult = await agent.executeTask({
        worktreePath: state.worktreeInfo.worktreePath,
        issueRef: { number: pullRequestNumber, repoOwner, repoName },
        prompt,
        model: resolution.model,
        githubToken: githubToken.token,
        branchName: state.worktreeInfo.branchName,
        onSessionId: createSessionIdCallbackForPR(taskId, { pullRequestNumber, repoOwner, repoName }, { llm: resolution.model, stateManager, correlatedLogger, redisClient }),
        onContainerId: createContainerIdCallbackForPR(taskId, stateManager)
    });

    // Convert to ClaudeCodeResponse for backwards compatibility
    state.claudeResult = agentResultToClaudeResponse(agentResult);

    await recordLLMMetrics(toClaudeResult(state.claudeResult), { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'pr_comment', correlationId, taskId });
    await createLogFiles(state.claudeResult as unknown, { number: pullRequestNumber, repoOwner, repoName });
    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
        reason: `${agent.config.type} agent execution completed`,
        claudeResult: { success: state.claudeResult.success, sessionId: state.claudeResult.sessionId, conversationId: state.claudeResult.conversationId, executionTime: state.claudeResult.executionTime },
        historyMetadata: { sessionId: state.claudeResult.sessionId, conversationId: state.claudeResult.conversationId, model: state.claudeResult.model }
    });

    if (!state.claudeResult.success) throw new Error(`Agent execution failed: ${state.claudeResult.error || 'Unknown error'}`);

    const changesSummary = state.claudeResult.summary || state.claudeResult.finalResult?.result || '';
    const commitMessage = buildCommitMessage({ changesSummary, unprocessedComments: state.unprocessedComments, pullRequestNumber, claudeResult: state.claudeResult, llm, authorsText: state.authorsText });
    const commitResult = await commitChanges(state.worktreeInfo.worktreePath, commitMessage, { name: 'Claude Code', email: 'claude-code@anthropic.com' }, { issueNumber: pullRequestNumber, issueTitle: 'Follow-up changes' });

    if (commitResult) {
        await pushBranch(state.worktreeInfo.worktreePath, state.worktreeInfo.branchName, { repoUrl, authToken: githubToken.token });
    }

    // Build undo context using the first instruction comment (user's original request)
    const instructionCommentId = state.unprocessedComments.length > 0 ? state.unprocessedComments[0].id : 0;
    const undoContext = commitResult && instructionCommentId ? {
        repoOwner,
        repoName,
        prNumber: pullRequestNumber,
        branchName: state.worktreeInfo.branchName,
        instructionCommentId
    } : undefined;

    const prCommentBody = buildCompletionComment(commitResult, state.unprocessedComments, { changesSummary, commitMessage, llm, authorsText: state.authorsText, undoContext }, state.claudeResult, taskUrl);
    const completionComment = await state.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', { owner: repoOwner, repo: repoName, comment_id: state.startingWorkComment.data.id, body: prCommentBody }) as { data: { html_url: string; body?: string } };
    correlatedLogger.info({ pullRequestNumber, commitHash: commitResult?.commitHash, commentUrl: completionComment.data.html_url }, 'Successfully applied follow-up changes');

    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'PR comment processing completed successfully', commitHash: commitResult?.commitHash,
        historyMetadata: { githubComment: { url: completionComment.data.html_url, body: completionComment.data.body } }
    });

    return { status: 'complete', commit: commitResult?.commitHash, pullRequestNumber, claudeResult: { success: state.claudeResult.success } };
}

export async function processPullRequestCommentJob(job: Job<CommentJobData>): Promise<JobResult> {
    const context = await initializePRJobContext(job);
    const { pullRequestNumber, repoOwner, repoName, correlationId, correlatedLogger, isBatchJob, commentsToProcess, jobBranchName, llm } = context;
    correlatedLogger.info({ pullRequestNumber, branchName: jobBranchName, llm, isBatchJob, commentsCount: commentsToProcess.length }, `Processing PR comment${isBatchJob ? 's batch' : ''} job...`);

    const taskId = job.id || `pr-comment-${pullRequestNumber}-${Date.now()}`;
    const stateManager = getStateManager();
    const lockKey = `lock:pr:${repoOwner}:${repoName}:${pullRequestNumber}`;

    const lockAcquired = await acquirePRLock({ lockKey, correlationId, correlatedLogger, job });
    if (!lockAcquired) return { status: 'rescheduled', reason: 'pr_locked_by_other_job' };

    try {
        await stateManager.createTaskState(taskId, { number: pullRequestNumber, repoOwner, repoName, comments: job.data.comments } as unknown as Parameters<typeof stateManager.createTaskState>[1], correlationId);
    } catch (stateError) {
        correlatedLogger.warn({ taskId, error: (stateError as Error).message }, 'Failed to create initial task state, continuing anyway');
    }

    const state: ProcessingState = { octokit: null, localRepoPath: undefined, worktreeInfo: undefined, claudeResult: null, authorsText: '', unprocessedComments: [], startingWorkComment: null };

    try {
        return await executeProcessing({ job, context, llm, taskId, stateManager, state });
    } catch (error) {
        await handleJobError(error as Error, job, { pullRequestNumber, repoOwner, repoName, authorsText: state.authorsText, unprocessedComments: state.unprocessedComments, octokit: state.octokit, startingWorkComment: state.startingWorkComment, claudeResult: state.claudeResult, correlationId, correlatedLogger, stateManager, taskId });
        if (!(error instanceof UsageLimitError)) throw error;
        return { status: 'requeued', reason: 'usage_limit' };
    } finally {
        await cleanupJob({ stateManager, lockKey, correlationId, localRepoPath: state.localRepoPath, worktreeInfo: state.worktreeInfo, repoOwner, repoName, pullRequestNumber, jobBranchName: context.jobBranchName, jobLlm: context.llm, correlatedLogger, redisClient });
    }
}

export { processPullRequestCommentJob as default };
