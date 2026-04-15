import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { getStateManager, TaskStates } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { ensureRepoCloned, createWorktreeFromExistingBranch, getRepoUrl, commitChanges, pushBranch } from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import { ensureGitRepository } from '@propr/core';
import { createLogFiles } from '@propr/core';
import { UsageLimitError, generateTaskSummary, AgentRegistry, resolveLlmLabel } from '@propr/core';
import type { ClaudeCodeResponse } from '@propr/core';
import type { AnalysisResult } from '@propr/core';
import { recordLLMMetrics } from '@propr/core';
import { issueQueue, type CommentJobData, type UnprocessedComment, type JobResult } from '@propr/core';
import { Redis } from 'ioredis';
import { getDefaultModel, loadSettings, db } from '@propr/core';
import { loadPrLabel } from '@propr/core';
import {
    validateAndFilterComments, filterUnprocessedComments, fetchLinkedIssueContext,
    buildCommentHistory, createSessionIdCallbackForPR, createContainerIdCallbackForPR, updateTaskTitleForPR, buildCompletionComment
} from './prCommentJobHelpers.js';
import { localizeContentImages } from './issueJobHelpers.js';
import {
    buildCombinedComment, extractModelFromLabels, fetchAllComments, buildCommitMessage, buildPrompt,
    handleJobError, cleanupJob, pickUpPendingComments, toClaudeResult, agentResultToClaudeResponse
} from './prCommentJobUtils.js';

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
    return process.env.PR_LABEL || 'propr';
}

async function initializePRJobContext(job: Job<CommentJobData>): Promise<PRJobContext> {
    const { pullRequestNumber, commentId, commentBody, commentAuthor, comments, branchName: jobBranchName, repoOwner, repoName, llm: jobLlm, correlationId } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);

    // Normalize missing commandMode to 'default' for backward compatibility
    if (!job.data.commandMode) {
        job.data.commandMode = 'default';
    }

    correlatedLogger.debug({ commandMode: job.data.commandMode, hasCommandMeta: !!job.data.commandMeta }, 'Normalized command mode for PR comment job');

    const PR_LABEL = await getPrLabel();
    const isBatchJob = !!comments && Array.isArray(comments);
    let commentsToProcess: UnprocessedComment[] = isBatchJob ? [...comments] : [{ id: commentId!, body: commentBody!, author: commentAuthor!, type: 'issue' as const }];
    commentsToProcess = await pickUpPendingComments(commentsToProcess, { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient });
    return { pullRequestNumber, jobBranchName, repoOwner, repoName, llm: jobLlm, correlationId, correlatedLogger, PR_LABEL, isBatchJob, commentsToProcess };
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
    const { commentsToProcess, pullRequestNumber, repoOwner, repoName, PR_LABEL, correlatedLogger, llm: initialLlm } = context;
    const prData = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: repoOwner, repo: repoName, pull_number: pullRequestNumber,
        mediaType: { format: 'full' }  // Get body_html with signed image URLs
    }) as PRData;
    const botUsername = process.env.GITHUB_BOT_USERNAME || 'propr.dev[bot]';
    // Fetch ALL comments with pagination to handle PRs with 100+ comments
    const allCommentsForValidation = await fetchAllComments(octokit, repoOwner, repoName, pullRequestNumber);
    // Separate issue comments for unprocessed detection (issue comments are first in the array from fetchAllComments)
    const prCommentsForValidation = allCommentsForValidation.filter(c => !('diff_hunk' in c));
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

/**
 * Resolves the default agent and model from settings, with fallback to registry default.
 */
async function resolveDefaultAgentAndModel(
    registry: AgentRegistry,
    correlatedLogger: Logger
): Promise<{ resolvedAlias: string; resolvedModel: string }> {
    // First, try to use the configured default agent from settings
    try {
        const settings = await loadSettings();
        if (settings.default_agent_alias) {
            const configuredAgent = registry.getAgentByAlias(settings.default_agent_alias as string);
            if (configuredAgent && configuredAgent.config.enabled) {
                const resolvedAlias = settings.default_agent_alias as string;
                const resolvedModel = configuredAgent.config.defaultModel || DEFAULT_MODEL_NAME;
                correlatedLogger.debug({ configuredDefaultAgent: resolvedAlias, defaultModel: resolvedModel }, 'Using default agent from settings');
                return { resolvedAlias, resolvedModel };
            }
        }
    } catch (settingsError) {
        correlatedLogger.debug({ error: (settingsError as Error).message }, 'Failed to load default agent from settings');
    }

    // Fallback to registry default
    const defaultAgent = registry.getDefaultAgent();
    const resolvedAlias = defaultAgent?.config.alias || 'claude';
    const resolvedModel = defaultAgent?.config.defaultModel || DEFAULT_MODEL_NAME;
    correlatedLogger.debug({ fallbackAgent: resolvedAlias, fallbackModel: resolvedModel }, 'Using fallback default agent');
    return { resolvedAlias, resolvedModel };
}

interface AgentExecutionParams {
    llm: string | null | undefined;
    worktreePath: string;
    branchName: string;
    prompt: string;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    taskId: string;
    stateManager: WorkerStateManager;
    correlatedLogger: Logger;
    githubToken: string;
}

async function resolveAndExecuteAgent(params: AgentExecutionParams): Promise<{ claudeResult: ClaudeCodeResponse; agentType: string }> {
    const { llm, worktreePath, branchName, prompt, pullRequestNumber, repoOwner, repoName, taskId, stateManager, correlatedLogger, githubToken } = params;

    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    let agentAlias: string;
    let modelToUse: string;

    if (llm) {
        // LLM was specified (from PR label or job data) - resolve it
        const resolution = await resolveLlmLabel(llm);
        agentAlias = resolution.agentAlias;
        modelToUse = resolution.model;
    } else {
        // No LLM specified - use default agent from settings, with fallback
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
        agentAlias = resolvedAlias;
        modelToUse = resolvedModel;
    }

    const agent = registry.getAgentByAlias(agentAlias);

    if (!agent) {
        throw new Error(`Agent not found for alias: ${agentAlias}`);
    }

    correlatedLogger.info({
        agentAlias,
        agentType: agent.config.type,
        model: modelToUse,
        pullRequestNumber
    }, 'Executing PR comment task with agent');

    const agentResult = await agent.executeTask({
        worktreePath,
        issueRef: { number: pullRequestNumber, repoOwner, repoName },
        prompt,
        model: modelToUse,
        githubToken,
        branchName,
        onSessionId: createSessionIdCallbackForPR(taskId, { pullRequestNumber, repoOwner, repoName }, { llm: modelToUse, stateManager, correlatedLogger, redisClient }),
        onContainerId: createContainerIdCallbackForPR(taskId, stateManager)
    });

    return { claudeResult: agentResultToClaudeResponse(agentResult), agentType: agent.config.type };
}

interface ReviewAssignment {
    agentAlias: string;
    model: string;
    label: string;
}

interface ReviewResult {
    assignment: ReviewAssignment;
    analysisResult: AnalysisResult;
    commentUrl?: string;
    error?: string;
}

function buildReviewPrompt(options: {
    pullRequestNumber: number;
    combinedCommentBody: string;
    commentHistory: string;
    originalTaskSpec: string;
    repoOwner: string;
    repoName: string;
    instructions?: string;
}): string {
    const { pullRequestNumber, combinedCommentBody, commentHistory, originalTaskSpec, repoOwner, repoName, instructions } = options;
    const prompt = `You are reviewing pull request #${pullRequestNumber} in ${repoOwner}/${repoName}.

**PR Comment History and Context:**
${commentHistory}${originalTaskSpec}

**Review Request:**
${combinedCommentBody}

${instructions ? `**Additional Review Instructions:**\n${instructions}\n\n` : ''}**YOUR TASK:**
Perform a thorough code review of this pull request. Provide:

1. **Overall Assessment** — A brief summary of the PR's purpose and quality.
2. **Findings** — List specific issues, concerns, or suggestions organized by severity:
   - 🔴 **Critical** — Bugs, security issues, data loss risks
   - 🟡 **Warning** — Performance concerns, potential edge cases, maintainability issues
   - 🟢 **Suggestion** — Style improvements, minor optimizations, best practices
3. **Score** — Rate the PR on a scale of 1-10 with a brief justification.

Be constructive and specific. Reference file names and line numbers when possible.
Do NOT modify any files. This is a read-only review.`;

    return prompt;
}

function buildReviewComment(assignment: ReviewAssignment, analysisResult: AnalysisResult, taskUrl?: string): string {
    const { model, label } = assignment;
    const { response, executionTimeMs, tokenUsage, modelUsed } = analysisResult;

    const formatDuration = (ms: number): string => {
        const seconds = Math.floor(ms / 1000);
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return m === 0 ? `${s}s` : `${m}m ${s}s`;
    };

    let comment = `## 🔍 AI Code Review — ${label}\n\n`;
    comment += response;
    comment += `\n\n---\n### 🤖 Review Details\n\n`;
    comment += `* **Model:** ${modelUsed || model}\n`;
    comment += `* **Time:** ${formatDuration(executionTimeMs)}\n`;
    if (tokenUsage) {
        const total = (tokenUsage.input_tokens || 0) + (tokenUsage.output_tokens || 0);
        if (total > 0) {
            comment += `* **Tokens:** ${total.toLocaleString()} (${(tokenUsage.input_tokens || 0).toLocaleString()} in / ${(tokenUsage.output_tokens || 0).toLocaleString()} out)\n`;
        }
    }
    if (taskUrl) {
        comment += `\n[View Task](${taskUrl})`;
    }
    comment += `\n\n<!-- propr:ai-review model="${modelUsed || model}" -->`;

    return comment;
}

async function resolveReviewAssignments(
    requestedModels: string[] | undefined,
    llm: string | null | undefined,
    correlatedLogger: Logger
): Promise<ReviewAssignment[]> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const assignments: ReviewAssignment[] = [];

    // If no models were explicitly requested, use the default or label-specified model
    const modelsToReview = (requestedModels && requestedModels.length > 0) ? requestedModels : [llm || 'default'];

    for (const modelLabel of modelsToReview) {
        try {
            if (modelLabel === 'default') {
                const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
                assignments.push({ agentAlias: resolvedAlias, model: resolvedModel, label: resolvedModel });
            } else {
                const resolution = await resolveLlmLabel(modelLabel);
                assignments.push({ agentAlias: resolution.agentAlias, model: resolution.model, label: modelLabel });
            }
        } catch (resolveError) {
            correlatedLogger.warn({ modelLabel, error: (resolveError as Error).message }, 'Failed to resolve review model, skipping');
        }
    }

    if (assignments.length === 0) {
        // Fallback to default agent if all resolutions failed
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
        assignments.push({ agentAlias: resolvedAlias, model: resolvedModel, label: resolvedModel });
    }

    return assignments;
}

async function executeReviewProcessing(params: ExecuteProcessingParams): Promise<JobResult> {
    const { job, context, taskId, stateManager, state } = params;
    let { llm } = params;
    const { pullRequestNumber, jobBranchName, repoOwner, repoName, correlationId, correlatedLogger } = context;

    state.octokit = await withRetry(() => getAuthenticatedOctokit(), { ...retryConfigs.githubApi, correlationId }, 'get_authenticated_octokit');
    const validation = await validatePRAndComments(state.octokit, { ...context, llm });
    if (validation.skip) {
        correlatedLogger.info({ pullRequestNumber, reason: validation.reason }, 'Skipping review processing');
        return { status: 'skipped', reason: validation.reason, pullRequestNumber };
    }

    const { prData, unprocessedComments: validUnprocessed, llm: resolvedLlm } = validation;
    state.unprocessedComments = validUnprocessed!;
    llm = resolvedLlm;
    const { combinedCommentBody, commentAuthors } = buildCombinedComment(state.unprocessedComments);
    state.authorsText = commentAuthors.map(a => `@${a}`).join(', ');

    const webUiUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
    const taskUrl = `${webUiUrl}/tasks/${taskId}`;

    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting review processing' });

    // Collect PR context for review prompt
    const allComments = await fetchAllComments(state.octokit, repoOwner, repoName, pullRequestNumber);
    const commentsByTime = allComments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const linkedIssueResult = await fetchLinkedIssueContext(state.octokit as unknown as Parameters<typeof fetchLinkedIssueContext>[0], prData!, { repoOwner, repoName, pullRequestNumber }, { correlationId, correlatedLogger });
    const commentHistory = buildCommentHistory(commentsByTime, prData!, correlationId);

    // Resolve review assignments (one per requested model)
    const requestedModels = job.data.requestedModels;
    const commandInstructions = job.data.commandInstructions;
    const assignments = await resolveReviewAssignments(requestedModels, llm, correlatedLogger);

    correlatedLogger.info({ pullRequestNumber, assignmentCount: assignments.length, models: assignments.map(a => a.model) }, 'Resolved review assignments');

    job.data.title = `Review: ${prData!.data.title}`;
    job.data.subtitle = `Code review with ${assignments.map(a => a.label).join(', ')}`;
    await updateTaskTitleForPR({ taskId, jobData: job.data, stateManager, correlatedLogger, redisClient, linkedIssueNumber: linkedIssueResult.linkedIssueNumber });

    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const reviewResults: ReviewResult[] = [];

    // Run reviews sequentially (as specified in the issue)
    for (const assignment of assignments) {
        const { agentAlias, model, label } = assignment;
        correlatedLogger.info({ pullRequestNumber, agentAlias, model, label }, 'Starting review analysis');

        const agent = registry.getAgentByAlias(agentAlias);
        if (!agent) {
            const errorMsg = `Agent not found for alias: ${agentAlias}`;
            correlatedLogger.error({ agentAlias }, errorMsg);
            reviewResults.push({ assignment, analysisResult: { response: '', modelUsed: model, executionTimeMs: 0, success: false, error: errorMsg }, error: errorMsg });
            continue;
        }

        const reviewPrompt = buildReviewPrompt({
            pullRequestNumber,
            combinedCommentBody,
            commentHistory,
            originalTaskSpec: linkedIssueResult.context || '',
            repoOwner,
            repoName,
            instructions: commandInstructions,
        });

        try {
            const analysisResult = await agent.analyze(reviewPrompt, {
                model,
                taskId,
                executionType: 'review',
            });

            correlatedLogger.info({
                pullRequestNumber, model: analysisResult.modelUsed, success: analysisResult.success,
                executionTimeMs: analysisResult.executionTimeMs, responseLength: analysisResult.response.length,
            }, 'Review analysis completed');

            // Post review comment to GitHub
            const reviewCommentBody = analysisResult.success
                ? buildReviewComment(assignment, analysisResult, taskUrl)
                : `## 🔍 AI Code Review — ${label}\n\n❌ **Review failed:** ${analysisResult.error || 'Unknown error'}\n\n<!-- propr:ai-review model="${model}" error="true" -->`;

            const reviewComment = await state.octokit!.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
                body: reviewCommentBody,
            });

            reviewResults.push({ assignment, analysisResult, commentUrl: reviewComment.data.html_url });
        } catch (reviewError) {
            const errorMsg = (reviewError as Error).message;
            correlatedLogger.error({ pullRequestNumber, model, error: errorMsg }, 'Review analysis failed');

            // Post error comment for this model
            try {
                await state.octokit!.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
                    body: `## 🔍 AI Code Review — ${label}\n\n❌ **Review failed:** ${errorMsg}\n\n<!-- propr:ai-review model="${model}" error="true" -->`,
                });
            } catch (commentError) {
                correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post review error comment');
            }

            reviewResults.push({
                assignment,
                analysisResult: { response: '', modelUsed: model, executionTimeMs: 0, success: false, error: errorMsg },
                error: errorMsg,
            });
        }
    }

    // Record LLM metrics for each review (both successful and failed)
    for (const result of reviewResults) {
        const metricsResult: Parameters<typeof recordLLMMetrics>[0] = {
            success: result.analysisResult.success,
            model: result.analysisResult.modelUsed || result.assignment.model,
            executionTime: result.analysisResult.executionTimeMs,
            sessionId: result.analysisResult.sessionId || null,
            tokenUsage: result.analysisResult.tokenUsage,
            ...(result.analysisResult.success ? {} : { error: result.analysisResult.error || result.error }),
        };
        await recordLLMMetrics(metricsResult, { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'pr_review', correlationId, taskId });
    }

    const successCount = reviewResults.filter(r => r.analysisResult.success).length;
    const failCount = reviewResults.filter(r => !r.analysisResult.success).length;

    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'Review processing completed successfully',
        historyMetadata: {
            reviewResults: reviewResults.map(r => ({
                model: r.assignment.model,
                label: r.assignment.label,
                success: r.analysisResult.success,
                commentUrl: r.commentUrl,
                error: r.error,
            })),
        },
    });

    correlatedLogger.info({ pullRequestNumber, successCount, failCount, totalReviews: assignments.length }, 'Review processing completed');

    return { status: 'complete', pullRequestNumber, reviewsPosted: successCount, reviewsFailed: failCount };
}

interface ExecuteProcessingParams {
    job: Job<CommentJobData>;
    context: PRJobContext;
    llm: string | null | undefined;
    taskId: string;
    stateManager: WorkerStateManager;
    state: ProcessingState;
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

interface UndoContextParams {
    commitResult: Awaited<ReturnType<typeof commitChanges>>;
    unprocessedComments: UnprocessedComment[];
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    branchName: string;
}

function buildUndoContext(params: UndoContextParams) {
    const { commitResult, unprocessedComments, repoOwner, repoName, pullRequestNumber, branchName } = params;
    const instructionCommentId = unprocessedComments.length > 0 ? unprocessedComments[0].id : 0;
    if (!commitResult || !instructionCommentId) return undefined;
    return { repoOwner, repoName, prNumber: pullRequestNumber, branchName, instructionCommentId };
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

    const webUiUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
    const taskUrl = `${webUiUrl}/tasks/${taskId}`;

    const allComments = await fetchAllComments(state.octokit, repoOwner, repoName, pullRequestNumber);
    const commentsByTime = allComments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const linkedIssueResult = await fetchLinkedIssueContext(state.octokit as unknown as Parameters<typeof fetchLinkedIssueContext>[0], prData!, { repoOwner, repoName, pullRequestNumber }, { correlationId, correlatedLogger });
    const commentHistory = buildCommentHistory(commentsByTime, prData!, correlationId);

    state.startingWorkComment = await state.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
        body: `🔄 **Starting work on follow-up changes** requested by ${state.authorsText}\n\nI'll analyze the ${state.unprocessedComments.length} request${state.unprocessedComments.length > 1 ? 's' : ''} and implement the necessary changes.\n\n[View Task Progress](${taskUrl})\n\n---\n_Processing comment ID${state.unprocessedComments.length > 1 ? 's' : ''}: ${state.unprocessedComments.map(c => String(c.id) + '✓').join(', ')}_`,
    });

    const githubToken = await state.octokit.auth({ type: "installation" }) as GitHubToken;
    const repoUrl = getRepoUrl({ repoOwner, repoName });

    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting PR comment processing' });
    await ensureGitRepository(correlatedLogger);
    state.localRepoPath = await ensureRepoCloned({ repoUrl, owner: repoOwner, repoName, authToken: githubToken.token });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    state.worktreeInfo = await createWorktreeFromExistingBranch(state.localRepoPath, branchName, { worktreeDirName: `pr-${pullRequestNumber}-followup-${timestamp}`, owner: repoOwner, repoName });
    correlatedLogger.info({ worktreePath: state.worktreeInfo.worktreePath, branchName: state.worktreeInfo.branchName }, 'Created worktree from existing PR branch');

    const localizedCombinedCommentBody = await localizeContentImages(combinedCommentBody, state.worktreeInfo.worktreePath, correlatedLogger, { bodyHtml: combinedBodyHtml, issueOrPrId: pullRequestNumber });
    const localizedOriginalTaskSpec = linkedIssueResult.context
        ? await localizeContentImages(linkedIssueResult.context, state.worktreeInfo.worktreePath, correlatedLogger, { bodyHtml: linkedIssueResult.bodyHtml, issueOrPrId: pullRequestNumber })
        : linkedIssueResult.context;

    const summaryTitle = await generateSummaryTitle({ combinedCommentBody: localizedCombinedCommentBody, worktreeInfo: state.worktreeInfo, githubToken, pullRequestNumber, repoOwner, repoName, correlationId, taskId, correlatedLogger });
    job.data.title = `Followup: ${prData!.data.title}`;
    job.data.subtitle = summaryTitle;
    await updateTaskTitleForPR({ taskId, jobData: job.data, stateManager, correlatedLogger, redisClient, linkedIssueNumber: linkedIssueResult.linkedIssueNumber });

    const prompt = buildPrompt({ pullRequestNumber, combinedCommentBody: localizedCombinedCommentBody, commentHistory, originalTaskSpec: localizedOriginalTaskSpec, worktreeInfo: state.worktreeInfo, repoOwner, repoName, commentCount: state.unprocessedComments.length });

    const { claudeResult, agentType } = await resolveAndExecuteAgent({
        llm, worktreePath: state.worktreeInfo.worktreePath, branchName: state.worktreeInfo.branchName, prompt,
        pullRequestNumber, repoOwner, repoName, stateManager, correlatedLogger, githubToken: githubToken.token, taskId
    });
    state.claudeResult = claudeResult;

    checkTerminalStateAfterExecution(await stateManager.getTaskState(taskId), taskId, correlatedLogger);

    await recordLLMMetrics(toClaudeResult(state.claudeResult), { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'pr_comment', correlationId, taskId });
    await createLogFiles(state.claudeResult as unknown, { number: pullRequestNumber, repoOwner, repoName });
    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
        reason: `${agentType} agent execution completed`,
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

    const undoContext = buildUndoContext({ commitResult, unprocessedComments: state.unprocessedComments, repoOwner, repoName, pullRequestNumber, branchName: state.worktreeInfo.branchName });
    const prCommentBody = await buildCompletionComment(commitResult, state.unprocessedComments, { changesSummary, commitMessage, llm, authorsText: state.authorsText, undoContext, taskUrl }, state.claudeResult);
    const completionComment = await state.octokit!.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', { owner: repoOwner, repo: repoName, comment_id: state.startingWorkComment!.data.id, body: prCommentBody }) as { data: { html_url: string; body?: string } };
    correlatedLogger.info({ pullRequestNumber, commitHash: commitResult?.commitHash, commentUrl: completionComment.data.html_url }, 'Successfully applied follow-up changes');

    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'PR comment processing completed successfully', commitHash: commitResult?.commitHash,
        historyMetadata: { githubComment: { url: completionComment.data.html_url, body: completionComment.data.body } }
    });

    // Persist commit hash to database for historic diff exploration
    if (commitResult?.commitHash) {
        try {
            await db('tasks')
                .where({ task_id: taskId })
                .update({ commit_hash: commitResult.commitHash });
            correlatedLogger.info({ taskId, commitHash: commitResult.commitHash }, 'Saved commit hash to tasks table');
        } catch (dbError) {
            correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to save commit hash to database');
        }
    }

    return { status: 'complete', commit: commitResult?.commitHash, pullRequestNumber, claudeResult: { success: state.claudeResult.success } };
}

export async function processPullRequestCommentJob(job: Job<CommentJobData>): Promise<JobResult> {
    const context = await initializePRJobContext(job);
    const { pullRequestNumber, repoOwner, repoName, correlationId, correlatedLogger, isBatchJob, commentsToProcess, jobBranchName, llm } = context;
    correlatedLogger.info({ pullRequestNumber, branchName: jobBranchName, llm, isBatchJob, commentsCount: commentsToProcess.length }, `Processing PR comment${isBatchJob ? 's batch' : ''} job...`);

    // Resolve model name early for task state tracking
    let modelName = DEFAULT_MODEL_NAME;
    if (llm) {
        try {
            const resolution = await resolveLlmLabel(llm);
            modelName = resolution.model;
        } catch {
            // Keep default if resolution fails
        }
    } else {
        // No LLM specified - use the default agent's model for accurate tracking
        try {
            const registry = AgentRegistry.getInstance();
            await registry.ensureInitialized();
            const defaultAgent = registry.getDefaultAgent();
            if (defaultAgent?.config.defaultModel) {
                modelName = defaultAgent.config.defaultModel;
            }
        } catch {
            // Keep DEFAULT_MODEL_NAME if registry fails
        }
    }

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
            return await executeReviewProcessing({ job, context, llm, taskId, stateManager, state });
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
