import type { Logger } from 'pino';
import type { Job } from 'bullmq';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { TaskStates } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { AgentRegistry, resolveLlmLabel } from '@propr/core';
import type { AnalysisResult } from '@propr/core';
import { recordLLMMetrics } from '@propr/core';
import type { CommentJobData, UnprocessedComment } from '@propr/core';
import { getDefaultModel, loadSettings } from '@propr/core';
import {
    fetchLinkedIssueContext,
    buildCommentHistory, updateTaskTitleForPR
} from './prCommentJobHelpers.js';
import {
    buildCombinedComment, fetchAllComments
} from './prCommentJobUtils.js';
import { buildReviewPrompt } from './reviewPromptBuilder.js';
import { buildReviewComment, buildReviewErrorComment } from './reviewCommentFormatter.js';
import type { Redis } from 'ioredis';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

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
}

interface PRData { data: { head: { ref: string }; body: string | null; labels: Array<{ name: string }>; user: { login: string }; title: string } }

export interface PRJobContext {
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

interface ProcessingState {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
    localRepoPath: string | undefined;
    worktreeInfo: unknown;
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

async function resolveDefaultAgentAndModel(
    registry: AgentRegistry,
    correlatedLogger: Logger
): Promise<{ resolvedAlias: string; resolvedModel: string }> {
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

    const defaultAgent = registry.getDefaultAgent();
    const resolvedAlias = defaultAgent?.config.alias || 'claude';
    const resolvedModel = defaultAgent?.config.defaultModel || DEFAULT_MODEL_NAME;
    correlatedLogger.debug({ fallbackAgent: resolvedAlias, fallbackModel: resolvedModel }, 'Using fallback default agent');
    return { resolvedAlias, resolvedModel };
}

async function resolveReviewAssignments(
    requestedModels: string[] | undefined,
    llm: string | null | undefined,
    correlatedLogger: Logger
): Promise<ReviewAssignment[]> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const assignments: ReviewAssignment[] = [];

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
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
        assignments.push({ agentAlias: resolvedAlias, model: resolvedModel, label: resolvedModel });
    }

    return assignments;
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

    const webUiUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
    const taskUrl = `${webUiUrl}/tasks/${taskId}`;

    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting review processing' });

    const allComments = await fetchAllComments(state.octokit, repoOwner, repoName, pullRequestNumber);
    const commentsByTime = allComments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const linkedIssueResult = await fetchLinkedIssueContext(state.octokit as unknown as Parameters<typeof fetchLinkedIssueContext>[0], prData!, { repoOwner, repoName, pullRequestNumber }, { correlationId, correlatedLogger });
    const commentHistory = buildCommentHistory(commentsByTime, prData!, correlationId);

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

            const reviewCommentBody = analysisResult.success
                ? buildReviewComment(assignment, analysisResult, taskUrl)
                : buildReviewErrorComment(label, model, analysisResult.error || 'Unknown error');

            const reviewComment = await state.octokit!.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
                body: reviewCommentBody,
            });

            reviewResults.push({ assignment, analysisResult, commentUrl: reviewComment.data.html_url });
        } catch (reviewError) {
            const errorMsg = (reviewError as Error).message;
            correlatedLogger.error({ pullRequestNumber, model, error: errorMsg }, 'Review analysis failed');

            try {
                await state.octokit!.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
                    body: buildReviewErrorComment(label, model, errorMsg),
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
