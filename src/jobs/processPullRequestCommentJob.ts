import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { getStateManager, TaskStates } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { ensureRepoCloned, createWorktreeFromExistingBranch, getRepoUrl } from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import { ensureGitRepository } from '@propr/core';
import { createLogFiles } from '@propr/core';
import { UsageLimitError } from '@propr/core';
import type { ClaudeCodeResponse } from '@propr/core';
import { recordLLMMetrics } from '@propr/core';
import { issueQueue, type CommentJobData, type UnprocessedComment, type JobResult } from '@propr/core';
import { Redis } from 'ioredis';
import { loadPrimaryProcessingLabels } from '@propr/core';
import {
    validateAndFilterComments, filterUnprocessedComments, fetchLinkedIssueContext,
    buildCommentHistory, updateTaskTitleForPR
} from './prCommentJobHelpers.js';
import { localizeContentImages } from './issueJobHelpers.js';
import {
    buildCombinedComment, extractModelFromLabels, fetchAllComments, buildPrompt,
    handleJobError, cleanupJob, toClaudeResult
} from './prCommentJobUtils.js';
import { pickUpPendingComments, applyPendingCommentCommandContext } from './prPendingComments.js';
import { executeReviewProcessing } from './prCommentReviewJob.js';
import { generateSummaryTitle, resolveAndExecuteAgent, resolvePRCommentModelName } from './prCommentAgentUtils.js';
import { gatherUnprocessedReviewComments } from './reviewCommentGatherer.js';
import type { AIReviewComment } from './reviewCommentGatherer.js';
import { handleUltrafixContinuation } from './ultrafixJobHelpers.js';
import { handlePostExecution } from './prCommentPostExecution.js';
import {
    buildDeterministicPrTaskSubtitle,
    buildPrTaskTitle,
    buildPrTaskTitleContext,
    buildPrTaskTitleContextHistoryMetadata,
    getPrTaskWorkflowLabel,
    resolvePrTaskWorkflow,
} from './prTaskTitleHelpers.js';
import type { GitHubToken } from './githubTypes.js';
import { buildWorkEvidenceMarker, filterRealComments } from '../shared/workEvidenceMarker.js';

const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

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
    primaryProcessingLabels: string[];
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

async function getPrimaryLabels(): Promise<string[]> {
    try {
        if (process.env.CONFIG_REPO) return await loadPrimaryProcessingLabels();
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Failed to load primary processing labels from config, using fallback');
    }
    // Fallback to environment variable or default
    const envLabels = process.env.PRIMARY_PROCESSING_LABELS;
    if (envLabels) {
        return envLabels.split(',').map(l => l.trim()).filter(l => l);
    }
    // Final fallback to PR_LABEL for backwards compatibility
    return [process.env.PR_LABEL || 'propr'];
}

async function initializePRJobContext(job: Job<CommentJobData>): Promise<PRJobContext> {
    const { pullRequestNumber, commentId, commentBody, commentAuthor, comments, repoOwner, repoName, correlationId } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);

    // Normalize missing commandMode to 'default' for backward compatibility
    if (!job.data.commandMode) {
        job.data.commandMode = 'default';
    }

    correlatedLogger.debug({ commandMode: job.data.commandMode, hasCommandMeta: !!job.data.commandMeta }, 'Normalized command mode for PR comment job');

    const primaryProcessingLabels = await getPrimaryLabels();
    const isBatchJob = !!comments && Array.isArray(comments);
    let commentsToProcess: UnprocessedComment[] = isBatchJob ? [...comments] : [{ id: commentId!, body: commentBody!, author: commentAuthor!, type: 'issue' as const }];
    commentsToProcess = await pickUpPendingComments(commentsToProcess, { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient });
    applyPendingCommentCommandContext(job.data, commentsToProcess, correlatedLogger);
    const { branchName: jobBranchName, llm: jobLlm } = job.data;
    return { pullRequestNumber, jobBranchName, repoOwner, repoName, llm: jobLlm, correlationId, correlatedLogger, primaryProcessingLabels, isBatchJob, commentsToProcess };
}

async function acquirePRLock(lockParams: LockParams): Promise<boolean> {
    const { lockKey, correlationId, correlatedLogger, job } = lockParams;

    // Use atomic SET NX to avoid race condition where two jobs both check,
    // see no lock, and both set - causing the second to overwrite the first
    const result = await redisClient.set(lockKey, correlationId, 'EX', 3600, 'NX');

    if (result === 'OK') {
        correlatedLogger.debug({ lockKey }, 'PR lock acquired');
        return true;
    }

    // Lock exists - check if it's ours (re-entry case)
    const currentLock = await redisClient.get(lockKey);
    if (currentLock === correlationId) {
        correlatedLogger.debug({ lockKey }, 'Already holding PR lock');
        // Refresh the TTL
        await redisClient.expire(lockKey, 3600);
        return true;
    }

    // Lock held by another job - reschedule
    correlatedLogger.info({ lockOwner: currentLock }, 'PR is currently being processed by another job. Rescheduling...');
    await issueQueue.add(job.name, job.data, { delay: 10000 });
    return false;
}

async function validatePRAndComments(octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>, context: PRJobContext & { llm: string | null | undefined }): Promise<ValidationResult> {
    const { commentsToProcess, pullRequestNumber, repoOwner, repoName, primaryProcessingLabels, correlatedLogger, llm: initialLlm } = context;
    const prData = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: repoOwner, repo: repoName, pull_number: pullRequestNumber,
        mediaType: { format: 'full' }  // Get body_html with signed image URLs
    }) as PRData;
    const botUsername = process.env.GITHUB_BOT_USERNAME || 'propr-dev[bot]';
    // Fetch ALL comments with pagination to handle PRs with 100+ comments
    const allCommentsForValidation = await fetchAllComments(octokit, repoOwner, repoName, pullRequestNumber);
    // Separate issue comments for unprocessed detection (issue comments are first in the array from fetchAllComments)
    const prCommentsForValidation = allCommentsForValidation.filter(c => !('diff_hunk' in c));
    const validatedComments = await validateAndFilterComments(commentsToProcess, allCommentsForValidation, pullRequestNumber, correlatedLogger);
    if (validatedComments.length === 0) return { skip: true, reason: 'all_comments_deleted' };
    // Check if PR has ANY of the primary processing labels (e.g., 'AI' or 'gitfix')
    if (!prData.data.labels.some(label => primaryProcessingLabels.includes(label.name))) return { skip: true, reason: 'missing_required_label' };
    const llm = extractModelFromLabels(prData.data.labels, initialLlm, pullRequestNumber, correlatedLogger);
    const unprocessedComments = filterUnprocessedComments(validatedComments, prCommentsForValidation, botUsername, { pullRequestNumber, correlatedLogger });
    if (unprocessedComments.length === 0) return { skip: true, reason: 'already_processed' };
    return { skip: false, prData, validatedComments, unprocessedComments, llm, prCommentsForValidation };
}

interface ExecuteProcessingParams {
    job: Job<CommentJobData>;
    context: PRJobContext;
    llm: string | null | undefined;
    taskId: string;
    stateManager: WorkerStateManager;
    state: ProcessingState;
}

function formatReviewCommentsSection(reviewComments: AIReviewComment[]): string {
    if (reviewComments.length === 0) return '';

    let section = `**AI Review Comments (unprocessed — please address these findings):**\n\n`;
    for (const comment of reviewComments) {
        section += `---\n**Review by:** @${comment.author} (Comment ID: ${comment.id})\n`;
        section += `${comment.body}\n---\n\n`;
    }
    return section;
}

function checkTerminalStateAfterExecution(currentState: { state: string } | null, taskId: string, correlatedLogger: Logger): void {
    const TERMINAL_STATES: string[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
    if (currentState && TERMINAL_STATES.includes(currentState.state)) {
        correlatedLogger.info({ taskId, currentState: currentState.state }, 'Task already in terminal state after agent execution, skipping state update');
        if (currentState.state === TaskStates.CANCELLED) {
            throw new Error('Execution aborted by user request');
        }
        throw new Error(`Task already in terminal state: ${currentState.state}`);
    }
}

function getWebUiUrl(): string {
    return process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
}

function buildStartingWorkCommentBody(authorsText: string, unprocessedComments: UnprocessedComment[], taskUrl: string): string {
    const realComments = filterRealComments(unprocessedComments);
    const plural = unprocessedComments.length > 1 ? 's' : '';
    const commentIdsSuffix = realComments.length > 0
        ? `\n\n---\n_Processing comment ID${realComments.length > 1 ? 's' : ''}: ${realComments.map(c => String(c.id) + '✓').join(', ')}_`
        : '';
    const evidenceMarker = buildWorkEvidenceMarker('started', realComments.map(comment => comment.id));
    return `🔄 **Starting work on follow-up changes** requested by ${authorsText}\n\nI'll analyze the ${unprocessedComments.length} request${plural} and implement the necessary changes.\n\n[View Task Progress](${taskUrl})${commentIdsSuffix}${evidenceMarker ? `\n${evidenceMarker}` : ''}`;
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

    const taskUrl = `${getWebUiUrl()}/tasks/${taskId}`;

    const allComments = await fetchAllComments(state.octokit, repoOwner, repoName, pullRequestNumber);
    const commentsByTime = [...allComments].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const linkedIssueResult = await fetchLinkedIssueContext(state.octokit as unknown as Parameters<typeof fetchLinkedIssueContext>[0], prData!, { repoOwner, repoName, pullRequestNumber }, { correlationId, correlatedLogger });
    const commentHistory = buildCommentHistory(commentsByTime, prData!, correlationId);

    // Gather unprocessed AI review comments only for /fix mode
    const isFixMode = job.data.commandMode === 'fix';
    const unprocessedReviewComments = isFixMode
        ? await gatherUnprocessedReviewComments(allComments, {
            repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger,
        })
        : [];
    const reviewCommentsSection = formatReviewCommentsSection(unprocessedReviewComments);

    state.startingWorkComment = await state.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
        body: buildStartingWorkCommentBody(state.authorsText, state.unprocessedComments, taskUrl),
    });

    const githubToken = await state.octokit.auth({ type: "installation" }) as GitHubToken;
    const repoUrl = getRepoUrl({ repoOwner, repoName });

    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
        reason: 'Starting PR comment processing',
        historyMetadata: { commandMode: job.data.commandMode || 'default' }
    });
    await ensureGitRepository(correlatedLogger);
    state.localRepoPath = await ensureRepoCloned({ repoUrl, owner: repoOwner, repoName, authToken: githubToken.token });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    state.worktreeInfo = await createWorktreeFromExistingBranch(state.localRepoPath, branchName, { worktreeDirName: `pr-${pullRequestNumber}-followup-${timestamp}`, owner: repoOwner, repoName });
    correlatedLogger.info({ worktreePath: state.worktreeInfo.worktreePath, branchName: state.worktreeInfo.branchName }, 'Created worktree from existing PR branch');

    const localizedCombinedCommentBody = await localizeContentImages(combinedCommentBody, state.worktreeInfo.worktreePath, correlatedLogger, { bodyHtml: combinedBodyHtml, issueOrPrId: pullRequestNumber });
    const localizedOriginalTaskSpec = linkedIssueResult.context
        ? await localizeContentImages(linkedIssueResult.context, state.worktreeInfo.worktreePath, correlatedLogger, { bodyHtml: linkedIssueResult.bodyHtml, issueOrPrId: pullRequestNumber })
        : linkedIssueResult.context;

    const workflow = resolvePrTaskWorkflow(job.data.commandMode, Boolean(job.data.ultrafixMeta));
    const instructionText = workflow === 'followup'
        ? localizedCombinedCommentBody
        : job.data.commandInstructions;
    const titleContext = buildPrTaskTitleContext({
        workflow,
        pullRequestNumber,
        prTitle: prData!.data.title,
        instructionText,
        recentComments: allComments,
        prDescription: prData!.data.body,
        reviewFeedback: reviewCommentsSection,
        excludeCommentIds: state.unprocessedComments.map(comment => comment.id),
    });
    const fallbackSubtitle = buildDeterministicPrTaskSubtitle(workflow);
    const summaryTitle = await generateSummaryTitle({
        combinedCommentBody: localizedCombinedCommentBody,
        titleContext: titleContext.context,
        fallbackSubtitle,
        worktreeInfo: state.worktreeInfo,
        githubToken,
        pullRequestNumber,
        prTitle: prData!.data.title,
        workflowLabel: getPrTaskWorkflowLabel(workflow),
        repoOwner,
        repoName,
        correlationId,
        taskId,
        correlatedLogger,
    });
    job.data.title = buildPrTaskTitle({ workflow, pullRequestNumber, prTitle: prData!.data.title });
    job.data.subtitle = summaryTitle;
    await updateTaskTitleForPR({ taskId, jobData: job.data, stateManager, correlatedLogger, redisClient, linkedIssueNumber: linkedIssueResult.linkedIssueNumber });
    await stateManager.updateHistoryMetadata(taskId, TaskStates.PROCESSING, {
        titleContext: buildPrTaskTitleContextHistoryMetadata(titleContext),
    });

    const prompt = buildPrompt({ pullRequestNumber, combinedCommentBody: localizedCombinedCommentBody, commentHistory, originalTaskSpec: localizedOriginalTaskSpec, worktreeInfo: state.worktreeInfo, repoOwner, repoName, commentCount: state.unprocessedComments.length, commandMode: job.data.commandMode || 'default', reviewCommentsSection });

    const { claudeResult, agentType } = await resolveAndExecuteAgent({
        llm, worktreePath: state.worktreeInfo.worktreePath, branchName: state.worktreeInfo.branchName, prompt,
        pullRequestNumber, repoOwner, repoName, stateManager, correlatedLogger, githubToken: githubToken.token, taskId, redisClient
    });
    state.claudeResult = claudeResult;

    checkTerminalStateAfterExecution(await stateManager.getTaskState(taskId), taskId, correlatedLogger);

    await recordLLMMetrics(toClaudeResult(state.claudeResult), { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'pr_comment', correlationId, taskId });
    await createLogFiles(state.claudeResult as unknown, { number: pullRequestNumber, repoOwner, repoName });
    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
        reason: `${agentType} agent execution completed`,
        claudeResult: { success: state.claudeResult.success, sessionId: state.claudeResult.sessionId, conversationId: state.claudeResult.conversationId, executionTime: state.claudeResult.executionTime },
        historyMetadata: {
            sessionId: state.claudeResult.sessionId,
            conversationId: state.claudeResult.conversationId,
            model: state.claudeResult.model,
            tokenUsage: state.claudeResult.tokenUsage
        }
    });

    const postResult = await handlePostExecution(
        { state, job, taskId, stateManager, context, unprocessedReviewComments, llm, redisClient },
        taskUrl,
    );

    await handleUltrafixContinuation('fix', { job, stateManager, taskId, redisClient, repoOwner, repoName, pullRequestNumber, correlatedLogger, correlationId });

    return { status: 'complete', commit: postResult.commitHash, pullRequestNumber, claudeResult: { success: state.claudeResult.success } };
}

export async function processPullRequestCommentJob(job: Job<CommentJobData>): Promise<JobResult> {
    const context = await initializePRJobContext(job);
    const { pullRequestNumber, repoOwner, repoName, correlationId, correlatedLogger, isBatchJob, commentsToProcess, jobBranchName, llm } = context;
    correlatedLogger.info({ pullRequestNumber, branchName: jobBranchName, llm, isBatchJob, commentsCount: commentsToProcess.length }, `Processing PR comment${isBatchJob ? 's batch' : ''} job...`);

    const modelName = await resolvePRCommentModelName(llm, correlatedLogger);

    const taskId = job.id || `pr-comment-${pullRequestNumber}-${Date.now()}`;
    const stateManager = getStateManager();
    const lockKey = `lock:pr:${repoOwner}:${repoName}:${pullRequestNumber}`;

    const lockAcquired = await acquirePRLock({ lockKey, correlationId, correlatedLogger, job });
    if (!lockAcquired) return { status: 'rescheduled', reason: 'pr_locked_by_other_job' };

    try {
        await stateManager.createTaskState(taskId, { number: pullRequestNumber, repoOwner, repoName, comments: job.data.comments, modelName } as unknown as Parameters<typeof stateManager.createTaskState>[1], correlationId);
    } catch (stateError) {
        correlatedLogger.warn({ taskId, error: (stateError as Error).message }, 'Failed to create initial task state, continuing anyway');
    }

    const state: ProcessingState = { octokit: null, localRepoPath: undefined, worktreeInfo: undefined, claudeResult: null, authorsText: '', unprocessedComments: [], startingWorkComment: null };

    try {
        // Branch early for review mode — read-only analysis, no commits or pushes
        if (job.data.commandMode === 'review') {
            return await executeReviewProcessing({ job, context, llm, taskId, stateManager, state, redisClient, validatePRAndComments });
        }
        return await executeProcessing({ job, context, llm, taskId, stateManager, state });
    } catch (error) {
        await handleJobError(error as Error, job, { pullRequestNumber, repoOwner, repoName, authorsText: state.authorsText, unprocessedComments: state.unprocessedComments, octokit: state.octokit, startingWorkComment: state.startingWorkComment, claudeResult: state.claudeResult, correlationId, correlatedLogger, stateManager, taskId });
        // Don't re-throw for user cancellations (not an error, just cancelled)
        const isUserCancelled = (error as Error).message?.includes('aborted by user');
        if (isUserCancelled) {
            return { status: 'cancelled', reason: 'user_cancelled' };
        }
        if (!(error instanceof UsageLimitError)) throw error;
        return { status: 'requeued', reason: 'usage_limit' };
    } finally {
        await cleanupJob({ stateManager, lockKey, correlationId, localRepoPath: state.localRepoPath, worktreeInfo: state.worktreeInfo, repoOwner, repoName, pullRequestNumber, jobBranchName: context.jobBranchName, jobLlm: context.llm, correlatedLogger, redisClient });
    }
}
