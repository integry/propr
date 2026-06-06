import type { Logger } from 'pino';
import type { Job } from 'bullmq';
import { getAuthenticatedOctokit, getModelHardLimit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { TaskStates } from '@propr/core';
import type { WorkerStateManager, WorktreeInfo } from '@propr/core';
import { AgentRegistry, resolveLlmLabel } from '@propr/core';
import type { AnalysisResult } from '@propr/core';
import { recordLLMMetrics } from '@propr/core';
import type { CommentJobData, UnprocessedComment } from '@propr/core';
import { loadPrReviewModel } from '@propr/core';
import { fetchLinkedIssueContext, buildCommentHistory, updateTaskTitleForPR } from './prCommentJobHelpers.js';
import { buildCombinedComment, fetchAllComments, fetchPRFiles, fetchPRFileContents, formatPRDiffWithMetadata, formatFileContents } from './prCommentJobUtils.js';
import { buildReviewPrompt } from './reviewPromptBuilder.js';
import { buildReviewComment, buildReviewErrorComment } from './reviewCommentFormatter.js';
import { generateSummaryTitle, resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';
import { continueUltrafixLoop } from './ultrafixLoopContinuation.js';
import { buildUltrafixHistoryMeta, buildContinuationMeta, patchUltrafixContinuationMeta } from './ultrafixContinuationMeta.js';
import { loadState as loadUltrafixState, type UltrafixAction } from './ultrafixOrchestrationService.js';
import {
    buildDeterministicPrTaskSubtitle,
    buildPrTaskTitle,
    buildPrTaskTitleContext,
    buildPrTaskTitleContextHistoryMetadata,
    getPrTaskWorkflowLabel,
    resolvePrTaskWorkflow,
} from './prTaskTitleHelpers.js';
import type { Redis } from 'ioredis';

export interface ReviewAssignment {
    agentAlias: string;
    model: string;
    label: string;
}

export interface ReviewResult {
    assignment: ReviewAssignment;
    analysisResult: AnalysisResult;
    commentUrl?: string;
    error?: string;
    prompt?: string;
}

interface PRData { data: { head: { ref: string }; body: string | null; labels: Array<{ name: string }>; user: { login: string }; title: string } }

const MIN_REVIEW_DIFF_MAX_CHARS = 100000;
const MAX_REVIEW_DIFF_MAX_CHARS = 1200000;
const REVIEW_DIFF_CHARS_PER_TOKEN_ESTIMATE = 2;
const REVIEW_DIFF_CONTEXT_RATIO = 0.7;

export interface PRJobContext {
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

interface ProcessingState {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
    localRepoPath: string | undefined;
    worktreeInfo: WorktreeInfo | undefined;
    claudeResult: unknown;
    authorsText: string;
    unprocessedComments: UnprocessedComment[];
    startingWorkComment: { data: { id: number; html_url: string } } | null;
}

export interface ExecuteReviewParams {
    job: Job<CommentJobData>;
    context: PRJobContext;
    llm: string | null | undefined;
    taskId: string;
    stateManager: WorkerStateManager;
    state: ProcessingState;
    redisClient: Redis;
    validatePRAndComments: (octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>, context: PRJobContext & { llm: string | null | undefined }) => Promise<{
        skip: boolean;
        reason?: string;
        prData?: PRData;
        unprocessedComments?: UnprocessedComment[];
        llm?: string | null;
    }>;
}

export interface JobResult {
    status: string;
    reason?: string;
    pullRequestNumber?: number;
    reviewsPosted?: number;
    reviewsFailed?: number;
    [key: string]: unknown;
}

export async function resolveReviewAssignments(
    requestedModels: string[] | undefined,
    llm: string | null | undefined,
    correlatedLogger: Logger
): Promise<ReviewAssignment[]> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const assignments: ReviewAssignment[] = [];

    let modelsToReview: string[];
    if (requestedModels && requestedModels.length > 0) {
        // Explicit model(s) specified in /review command
        modelsToReview = requestedModels;
    } else {
        // No explicit models - use pr_review_model config, ignoring llm from PR labels
        // (labels specify implementation model, not review model)
        let prReviewModel = '';
        try {
            prReviewModel = await loadPrReviewModel();
        } catch (err) {
            correlatedLogger.debug({ error: (err as Error).message }, 'Failed to load pr_review_model setting');
        }
        if (prReviewModel) {
            modelsToReview = [prReviewModel];
            correlatedLogger.info({ prReviewModel }, 'Using configured pr_review_model as default review model');
        } else if (llm) {
            // Fall back to llm from labels only if no pr_review_model configured
            modelsToReview = [llm];
            correlatedLogger.info({ llm }, 'No pr_review_model configured, falling back to llm from labels');
        } else {
            modelsToReview = ['default'];
        }
    }

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
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
        assignments.push({ agentAlias: resolvedAlias, model: resolvedModel, label: resolvedModel });
    }

    return assignments;
}

interface RunReviewsContext {
    registry: AgentRegistry;
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    taskId: string;
    taskUrl: string;
    combinedCommentBody: string;
    commentHistory: string;
    originalTaskSpec: string;
    commandInstructions?: string;
    prDiff: string;
    omittedDiffFiles: string[];
    fileContents: string;
    correlatedLogger: Logger;
}

async function runSingleReview(
    assignment: ReviewAssignment,
    ctx: RunReviewsContext
): Promise<ReviewResult> {
    const { registry, octokit, pullRequestNumber, repoOwner, repoName, taskId, taskUrl, correlatedLogger } = ctx;
    const { agentAlias, model, label } = assignment;
    correlatedLogger.info({ pullRequestNumber, agentAlias, model, label }, 'Starting review analysis');

    const agent = registry.getAgentByAlias(agentAlias);
    if (!agent) {
        const errorMsg = `Agent not found for alias: ${agentAlias}`;
        correlatedLogger.error({ agentAlias }, errorMsg);
        return { assignment, analysisResult: { response: '', modelUsed: model, executionTimeMs: 0, success: false, error: errorMsg }, error: errorMsg };
    }

    const reviewPrompt = buildReviewPrompt({
        pullRequestNumber, combinedCommentBody: ctx.combinedCommentBody, commentHistory: ctx.commentHistory,
        originalTaskSpec: ctx.originalTaskSpec, repoOwner, repoName, instructions: ctx.commandInstructions,
        prDiff: ctx.prDiff, fileContents: ctx.fileContents,
    });

    try {
        const analysisResult = await agent.analyze(reviewPrompt, { model, taskId, prNumber: pullRequestNumber, repository: `${repoOwner}/${repoName}`, executionType: 'pr-review' });
        correlatedLogger.info({
            pullRequestNumber, model: analysisResult.modelUsed, success: analysisResult.success,
            executionTimeMs: analysisResult.executionTimeMs, responseLength: analysisResult.response.length,
        }, 'Review analysis completed');

        const reviewCommentBody = analysisResult.success
            ? buildReviewComment(assignment, analysisResult, taskUrl, { omittedDiffFiles: ctx.omittedDiffFiles })
            : buildReviewErrorComment(label, model, analysisResult.error || 'Unknown error');

        const reviewComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: pullRequestNumber, body: reviewCommentBody,
        });

        return { assignment, analysisResult, commentUrl: reviewComment.data.html_url, prompt: reviewPrompt };
    } catch (reviewError) {
        const errorMsg = (reviewError as Error).message;
        correlatedLogger.error({ pullRequestNumber, model, error: errorMsg }, 'Review analysis failed');

        try {
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
                body: buildReviewErrorComment(label, model, errorMsg),
            });
        } catch (commentError) {
            correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post review error comment');
        }

        return { assignment, analysisResult: { response: '', modelUsed: model, executionTimeMs: 0, success: false, error: errorMsg }, error: errorMsg, prompt: reviewPrompt };
    }
}

async function recordReviewMetrics(
    reviewResults: ReviewResult[],
    issueRef: { pullRequestNumber: number; repoOwner: string; repoName: string; correlationId: string; taskId: string }
): Promise<void> {
    const { pullRequestNumber, repoOwner, repoName, correlationId, taskId } = issueRef;
    for (const result of reviewResults) {
        const timestamp = new Date().toISOString();
        const conversationLog = [
            { type: 'user', timestamp, message: { content: [{ type: 'text', text: result.prompt || 'Review prompt not captured' }] } },
            { type: 'assistant', timestamp, message: { content: [{ type: 'text', text: result.analysisResult.response || result.error || 'No response' }] } },
        ];

        const metricsResult: Parameters<typeof recordLLMMetrics>[0] = {
            success: result.analysisResult.success,
            model: result.analysisResult.modelUsed || result.assignment.model,
            executionTime: result.analysisResult.executionTimeMs,
            sessionId: result.analysisResult.sessionId || null,
            tokenUsage: result.analysisResult.tokenUsage,
            conversationLog,
            ...(result.analysisResult.success ? {} : { error: result.analysisResult.error || result.error }),
        };
        await recordLLMMetrics(metricsResult, { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'pr_review', correlationId, taskId, executionType: 'pr-review' });
    }
}

async function updateReviewCompletionComment(
    state: ProcessingState, reviewResults: ReviewResult[],
    options: { repoOwner: string; repoName: string; taskUrl: string; correlatedLogger: Logger }
): Promise<void> {
    const { repoOwner, repoName, taskUrl, correlatedLogger } = options;
    if (!state.startingWorkComment) return;

    const successCount = reviewResults.filter(r => r.analysisResult.success).length;
    const failCount = reviewResults.filter(r => !r.analysisResult.success).length;

    try {
        const reviewLinks = reviewResults.filter(r => r.commentUrl).map(r => `- [${r.assignment.label}](${r.commentUrl})`).join('\n');
        const statusEmoji = failCount === 0 ? '✅' : '⚠️';
        const statusText = failCount === 0
            ? `Posted ${successCount} review${successCount > 1 ? 's' : ''}`
            : `Posted ${successCount} review${successCount > 1 ? 's' : ''}, ${failCount} failed`;

        await state.octokit!.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: repoOwner, repo: repoName, comment_id: state.startingWorkComment.data.id,
            body: `${statusEmoji} **AI Code Review Complete** requested by ${state.authorsText}\n\n${statusText}:\n${reviewLinks}\n\n[View Task Details](${taskUrl})`,
        });
    } catch (updateError) {
        correlatedLogger.warn({ error: (updateError as Error).message }, 'Failed to update starting review comment');
    }
}

function getWebUiTaskUrl(taskId: string): string {
    const webUiUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
    return `${webUiUrl}/tasks/${taskId}`;
}

async function fetchReviewContext(
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
    prData: PRData,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; reviewAssignments: ReviewAssignment[]; correlationId: string; correlatedLogger: Logger }
) {
    const { repoOwner, repoName, pullRequestNumber, reviewAssignments, correlationId, correlatedLogger } = params;
    const allComments = await fetchAllComments(octokit, repoOwner, repoName, pullRequestNumber);
    const commentsByTime = [...allComments].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const linkedIssueResult = await fetchLinkedIssueContext(octokit as unknown as Parameters<typeof fetchLinkedIssueContext>[0], prData, { repoOwner, repoName, pullRequestNumber }, { correlationId, correlatedLogger });
    const commentHistory = buildCommentHistory(commentsByTime, prData, correlationId);

    correlatedLogger.info({ pullRequestNumber }, 'Fetching PR diff for review');
    const prFiles = await fetchPRFiles({ octokit, repoOwner, repoName, pullRequestNumber });
    const diffMaxChars = resolveReviewDiffMaxChars(reviewAssignments.map(assignment => assignment.model));
    const { diff: prDiff, omittedFiles: omittedDiffFiles } = formatPRDiffWithMetadata(prFiles, diffMaxChars);
    correlatedLogger.info({
        pullRequestNumber,
        fileCount: prFiles.length,
        diffMaxChars,
        diffLength: prDiff.length,
        omittedDiffFileCount: omittedDiffFiles.length,
    }, 'Fetched PR diff');

    const fileContentsMap = await fetchPRFileContents({ octokit, repoOwner, repoName, prHeadRef: prData.data.head.ref, files: prFiles });
    const fileContents = formatFileContents(fileContentsMap);
    correlatedLogger.info({ pullRequestNumber, filesWithContent: fileContentsMap.size, contentLength: fileContents.length }, 'Fetched full file contents');

    return { allComments, commentHistory, linkedIssueResult, prDiff, omittedDiffFiles, fileContents };
}

function resolveReviewDiffMaxChars(models: string[]): number {
    const envOverride = Number.parseInt(process.env.PR_REVIEW_DIFF_MAX_CHARS || '', 10);
    if (Number.isFinite(envOverride) && envOverride > 0) {
        return clamp(envOverride, MIN_REVIEW_DIFF_MAX_CHARS, MAX_REVIEW_DIFF_MAX_CHARS);
    }

    const hardLimits = models.length > 0
        ? models.map(model => getModelHardLimit(model))
        : [getModelHardLimit(undefined)];
    const smallestHardLimit = Math.min(...hardLimits);
    const diffTokenBudget = Math.floor(smallestHardLimit * REVIEW_DIFF_CONTEXT_RATIO);
    const maxChars = diffTokenBudget * REVIEW_DIFF_CHARS_PER_TOKEN_ESTIMATE;

    return clamp(maxChars, MIN_REVIEW_DIFF_MAX_CHARS, MAX_REVIEW_DIFF_MAX_CHARS);
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

async function handleUltrafixContinuation(
    action: UltrafixAction,
    params: { job: Job<CommentJobData>; stateManager: WorkerStateManager; taskId: string; redisClient: Redis; repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; correlationId: string }
): Promise<void> {
    if (!params.job.data.ultrafixMeta) return;
    const { job, stateManager, taskId, redisClient, repoOwner, repoName, pullRequestNumber, correlatedLogger, correlationId } = params;
    try {
        const continuationResult = await continueUltrafixLoop({
            owner: repoOwner, repo: repoName, pullRequestNumber, completedAction: action,
            ultrafixMeta: job.data.ultrafixMeta!, redisClient, correlatedLogger, correlationId,
            currentJobId: job.id,
        });
        correlatedLogger.info({ pullRequestNumber, ...continuationResult }, `Ultrafix loop continuation after ${action}`);
        await patchUltrafixContinuationMeta(stateManager, taskId, buildContinuationMeta(continuationResult), correlatedLogger);
    } catch (contErr) {
        correlatedLogger.error({ error: (contErr as Error).message, pullRequestNumber }, `Ultrafix loop continuation failed after ${action}`);
    }
}

async function resolveUltrafixHistoryMeta(
    job: Job<CommentJobData>, redisClient: Redis, issueRef: { repoOwner: string; repoName: string; pullRequestNumber: number }
): Promise<Record<string, unknown> | undefined> {
    if (!job.data.ultrafixMeta) return undefined;
    return buildUltrafixHistoryMeta(job.data.ultrafixMeta, await loadUltrafixState(redisClient, issueRef.repoOwner, issueRef.repoName, issueRef.pullRequestNumber));
}

export async function executeReviewProcessing(params: ExecuteReviewParams): Promise<JobResult> {
    const { job, context, taskId, stateManager, state, redisClient, validatePRAndComments } = params;
    let { llm } = params;
    const { pullRequestNumber, repoOwner, repoName, correlationId, correlatedLogger } = context;

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
    const taskUrl = getWebUiTaskUrl(taskId);

    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
        reason: 'Starting review processing',
        historyMetadata: { commandMode: 'review' }
    });

    const assignments = await resolveReviewAssignments(job.data.requestedModels, llm, correlatedLogger);
    correlatedLogger.info({ pullRequestNumber, assignmentCount: assignments.length, models: assignments.map(a => a.model) }, 'Resolved review assignments');

    const { allComments, commentHistory, linkedIssueResult, prDiff, omittedDiffFiles, fileContents } = await fetchReviewContext(
        state.octokit, prData!, { repoOwner, repoName, pullRequestNumber, reviewAssignments: assignments, correlationId, correlatedLogger }
    );

    // Filter out ultrafix synthetic comments (id: 0) from displayed IDs
    const realComments = state.unprocessedComments.filter(c => c.author !== 'propr-ultrafix' && c.id !== 0);
    const commentIdsSuffix = realComments.length > 0
        ? `\n\n---\n_Processing comment ID${realComments.length > 1 ? 's' : ''}: ${realComments.map(c => String(c.id)).join(', ')}_`
        : '';
    const modelList = assignments.map(a => `\`${a.label}\``).join(', ');
    state.startingWorkComment = await state.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner: repoOwner, repo: repoName, issue_number: pullRequestNumber, body: `🔍 **Starting AI Code Review** requested by ${state.authorsText}\n\nAnalyzing the pull request with ${modelList}...\n\n[View Task Progress](${taskUrl})${commentIdsSuffix}` });

    const workflow = resolvePrTaskWorkflow(job.data.commandMode, Boolean(job.data.ultrafixMeta));
    const titleContext = buildPrTaskTitleContext({ workflow, pullRequestNumber, prTitle: prData!.data.title, instructionText: job.data.commandInstructions, recentComments: allComments, prDescription: prData!.data.body, excludeCommentIds: state.unprocessedComments.map(comment => comment.id) });
    const fallbackSubtitle = buildDeterministicPrTaskSubtitle(workflow);
    const githubToken = await state.octokit.auth({ type: "installation" }) as { token: string };
    let summaryTitle = fallbackSubtitle;
    if (titleContext.hasMeaningfulContext) {
        try {
            summaryTitle = await generateSummaryTitle({
                combinedCommentBody, titleContext: titleContext.context, fallbackSubtitle,
                githubToken,
                pullRequestNumber, prTitle: prData!.data.title, workflowLabel: getPrTaskWorkflowLabel(workflow),
                repoOwner, repoName, correlationId, taskId, correlatedLogger,
            });
        } catch (titleError) {
            correlatedLogger.warn({ taskId, error: (titleError as Error).message }, 'Failed to generate review task subtitle');
        }
    }
    job.data.title = buildPrTaskTitle({ workflow, pullRequestNumber, prTitle: prData!.data.title });
    job.data.subtitle = titleContext.hasMeaningfulContext ? summaryTitle : fallbackSubtitle;
    await updateTaskTitleForPR({ taskId, jobData: job.data, stateManager, correlatedLogger, redisClient, linkedIssueNumber: linkedIssueResult.linkedIssueNumber });
    await stateManager.updateHistoryMetadata(taskId, TaskStates.PROCESSING, {
        titleContext: buildPrTaskTitleContextHistoryMetadata(titleContext),
    });

    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const reviewCtx: RunReviewsContext = {
        registry, octokit: state.octokit, pullRequestNumber, repoOwner, repoName,
        taskId, taskUrl, combinedCommentBody, commentHistory,
        originalTaskSpec: linkedIssueResult.context || '',
        commandInstructions: job.data.commandInstructions,
        prDiff,
        omittedDiffFiles,
        fileContents,
        correlatedLogger,
    };

    const reviewResults: ReviewResult[] = [];
    for (const assignment of assignments) {
        reviewResults.push(await runSingleReview(assignment, reviewCtx));
    }

    await recordReviewMetrics(reviewResults, { pullRequestNumber, repoOwner, repoName, correlationId, taskId });
    await updateReviewCompletionComment(state, reviewResults, { repoOwner, repoName, taskUrl, correlatedLogger });

    const successCount = reviewResults.filter(r => r.analysisResult.success).length;
    const failCount = reviewResults.filter(r => !r.analysisResult.success).length;

    const ultrafixHistoryMeta = await resolveUltrafixHistoryMeta(job, redisClient, { repoOwner, repoName, pullRequestNumber });

    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'Review processing completed successfully',
        historyMetadata: {
            commandMode: 'review',
            reviewResults: reviewResults.map(r => ({
                model: r.assignment.model, label: r.assignment.label,
                success: r.analysisResult.success, commentUrl: r.commentUrl, error: r.error,
            })),
            ...ultrafixHistoryMeta,
        },
    });

    correlatedLogger.info({ pullRequestNumber, successCount, failCount, totalReviews: assignments.length }, 'Review processing completed');
    await handleUltrafixContinuation('review', { job, stateManager, taskId, redisClient, repoOwner, repoName, pullRequestNumber, correlatedLogger, correlationId });

    return { status: 'complete', pullRequestNumber, reviewsPosted: successCount, reviewsFailed: failCount };
}
