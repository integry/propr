import type { Logger } from 'pino';
import type { Job } from 'bullmq';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { TaskStates } from '@propr/core';
import type { WorkerStateManager, WorktreeInfo } from '@propr/core';
import { AgentRegistry } from '@propr/core';
import type { CommentJobData, UnprocessedComment } from '@propr/core';
import { loadSettings } from '@propr/core';
import { resolvePrReasoningLevelOverride, updateTaskTitleForPR } from './prCommentJobHelpers.js';
import { buildCombinedComment } from './prCommentJobUtils.js';
import { calculateReviewCost, fetchReviewContext, type PRData } from './reviewContextHelpers.js';
import { buildReviewPrompt } from './reviewPromptBuilder.js';
import { buildReviewComment, buildReviewErrorComment } from './reviewCommentFormatter.js';
import { generateSummaryTitle } from './prCommentAgentUtils.js';
import { handleUltrafixContinuation, resolveUltrafixHistoryMeta } from './ultrafixJobHelpers.js';
import {
    buildDeterministicPrTaskSubtitle,
    buildPrTaskTitle,
    buildPrTaskTitleContext,
    buildPrTaskTitleContextHistoryMetadata,
    getPrTaskWorkflowLabel,
    resolvePrTaskWorkflow,
} from './prTaskTitleHelpers.js';
import type { Redis } from 'ioredis';
import { buildWorkEvidenceMarker, filterRealComments } from '../shared/workEvidenceMarker.js';
import type { ReasoningLevel } from '@propr/shared';
import { finalizePRCommentTaskResultBestEffort } from './prCommentTaskFinalizer.js';
import {
    buildReviewAssignmentMarker,
    persistReviewRemoteOutcome,
    recordReviewMetrics,
    recoverPublishedReview,
    type ReviewAssignment,
    type ReviewResult,
} from './prCommentReviewRecovery.js';

export { buildReviewAssignmentMarker } from './prCommentReviewRecovery.js';
export type { ReviewAssignment, ReviewResult } from './prCommentReviewRecovery.js';
export { resolveReviewAssignments } from './prCommentReviewAssignments.js';
import { resolveReviewAssignments } from './prCommentReviewAssignments.js';

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
    prProcessingLockToken: string;
    assertLease: () => Promise<void>;
    signal: AbortSignal;
    validatePRAndComments: (octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>, context: PRJobContext & { llm: string | null | undefined }) => Promise<{
        skip: boolean;
        reason?: string;
        prData?: PRData;
        unprocessedComments?: UnprocessedComment[];
        llm?: string | null;
        prCommentsForValidation?: Array<{
            id: number;
            body: string | null;
            user: { login: string; type?: string };
            html_url?: string;
        }>;
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
    reviewPromptOverride: string;
    reasoningLevel?: ReasoningLevel;
    correlatedLogger: Logger;
    assertLease: () => Promise<void>;
    signal: AbortSignal;
    assignmentIndex: number;
}

async function runSingleReview(
    assignment: ReviewAssignment,
    ctx: RunReviewsContext
): Promise<ReviewResult> {
    const { registry, octokit, pullRequestNumber, repoOwner, repoName, taskId, taskUrl, correlatedLogger, assertLease, signal } = ctx;
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
        prDiff: ctx.prDiff, fileContents: ctx.fileContents, reviewPromptOverride: ctx.reviewPromptOverride,
    });

    try {
        await assertLease();
        const analysisResult = await agent.analyze(reviewPrompt, { model, taskId, prNumber: pullRequestNumber, repository: `${repoOwner}/${repoName}`, executionType: 'pr-review', reasoningLevel: ctx.reasoningLevel });
        await assertLease();
        correlatedLogger.info({
            pullRequestNumber, model: analysisResult.modelUsed, success: analysisResult.success,
            executionTimeMs: analysisResult.executionTimeMs, responseLength: analysisResult.response.length,
        }, 'Review analysis completed');

        const costUsd = await calculateReviewCost(analysisResult, analysisResult.modelUsed || model, correlatedLogger);
        const reviewCommentBody = analysisResult.success
            ? buildReviewComment(assignment, analysisResult, taskUrl, { omittedDiffFiles: ctx.omittedDiffFiles, costUsd })
            : buildReviewErrorComment(label, model, analysisResult.error || 'Unknown error');
        const publicationStatus = analysisResult.success ? 'success' : 'error';

        await assertLease();
        const reviewComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            issue_number: pullRequestNumber,
            body: `${reviewCommentBody}\n\n${buildReviewAssignmentMarker(taskId, assignment, ctx.assignmentIndex, publicationStatus)}`,
            request: { signal },
        });

        return { assignment, analysisResult, commentUrl: reviewComment.data.html_url, prompt: reviewPrompt };
    } catch (reviewError) {
        await assertLease();
        const errorMsg = (reviewError as Error).message;
        correlatedLogger.error({ pullRequestNumber, model, error: errorMsg }, 'Review analysis failed');

        try {
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
                body: `${buildReviewErrorComment(label, model, errorMsg)}\n\n${buildReviewAssignmentMarker(taskId, assignment, ctx.assignmentIndex, 'error')}`,
                request: { signal },
            });
        } catch (commentError) {
            correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post review error comment');
        }

        return { assignment, analysisResult: { response: '', modelUsed: model, executionTimeMs: 0, success: false, error: errorMsg }, error: errorMsg, prompt: reviewPrompt };
    }
}

async function updateReviewCompletionComment(
    state: ProcessingState, reviewResults: ReviewResult[],
    options: { repoOwner: string; repoName: string; taskUrl: string; correlatedLogger: Logger; assertLease: () => Promise<void>; signal: AbortSignal }
): Promise<void> {
    const { repoOwner, repoName, taskUrl, correlatedLogger, assertLease, signal } = options;
    if (!state.startingWorkComment) return;

    const successCount = reviewResults.filter(r => r.analysisResult.success).length;
    const failCount = reviewResults.length - successCount;

    try {
        const reviewLinks = reviewResults.filter(r => r.commentUrl).map(r => `- [${r.assignment.label}](${r.commentUrl})`).join('\n');
        const statusEmoji = failCount === 0 ? '✅' : '⚠️';
        const statusText = failCount === 0
            ? `Posted ${successCount} review${successCount > 1 ? 's' : ''}`
            : `Posted ${successCount} review${successCount > 1 ? 's' : ''}, ${failCount} failed`;
        const completedEvidence = buildWorkEvidenceMarker(
            reviewResults.length > 0 && failCount === reviewResults.length ? 'failed' : 'completed',
            filterRealComments(state.unprocessedComments).map(comment => comment.id),
        );

        await assertLease();
        await state.octokit!.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: repoOwner, repo: repoName, comment_id: state.startingWorkComment.data.id,
            body: `${statusEmoji} **AI Code Review Complete** requested by ${state.authorsText}\n\n${statusText}:\n${reviewLinks}\n\n[View Task Details](${taskUrl})${completedEvidence ? `\n${completedEvidence}` : ''}`,
            request: { signal },
        });
    } catch (updateError) {
        await assertLease();
        correlatedLogger.warn({ error: (updateError as Error).message }, 'Failed to update starting review comment');
    }
}

function getWebUiTaskUrl(taskId: string): string {
    const webUiUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
    return `${webUiUrl}/tasks/${taskId}`;
}

export async function executeReviewProcessing(params: ExecuteReviewParams): Promise<JobResult> {
    const { job, context, taskId, stateManager, state, redisClient, validatePRAndComments, prProcessingLockToken, assertLease, signal } = params;
    let { llm } = params;
    const { pullRequestNumber, repoOwner, repoName, correlationId, correlatedLogger } = context;

    state.octokit = await withRetry(() => getAuthenticatedOctokit(), { ...retryConfigs.githubApi, correlationId }, 'get_authenticated_octokit');
    const validation = await validatePRAndComments(state.octokit, { ...context, llm });
    if (validation.skip) {
        await assertLease();
        correlatedLogger.info({ pullRequestNumber, reason: validation.reason }, 'Skipping review processing');
        const result = { status: 'skipped', reason: validation.reason, pullRequestNumber };
        await finalizePRCommentTaskResultBestEffort(
            taskId,
            stateManager,
            result,
            {
                prProcessingLockToken,
                onError: error => correlatedLogger.warn({ taskId, error: (error as Error).message }, 'Deferred skipped review finalization to worker recovery'),
            },
        );
        return result;
    }

    const { prData, unprocessedComments: validUnprocessed, llm: resolvedLlm } = validation;
    state.unprocessedComments = validUnprocessed!;
    llm = resolvedLlm;
    const { combinedCommentBody, commentAuthors } = buildCombinedComment(state.unprocessedComments);
    state.authorsText = commentAuthors.map(a => `@${a}`).join(', ');
    const taskUrl = getWebUiTaskUrl(taskId);

    await assertLease();
    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
        reason: 'Starting review processing',
        historyMetadata: { commandMode: 'review' }
    }, prProcessingLockToken);

    const assignments = await resolveReviewAssignments(job.data.requestedModels, llm, correlatedLogger);
    correlatedLogger.info({ pullRequestNumber, assignmentCount: assignments.length, models: assignments.map(a => a.model) }, 'Resolved review assignments');

    const { allComments, commentHistory, linkedIssueResult, prDiff, omittedDiffFiles, fileContents } = await fetchReviewContext(
        state.octokit, prData!, { repoOwner, repoName, pullRequestNumber, models: assignments.map(a => a.model), correlationId, correlatedLogger }
    );
    job.data.reasoningLevel = resolvePrReasoningLevelOverride(prData!.data.labels, linkedIssueResult.linkedIssueLabels, {
        repoOwner,
        repoName,
        pullRequestNumber,
        correlatedLogger,
    });

    const realComments = filterRealComments(state.unprocessedComments);
    const botUsername = process.env.GITHUB_BOT_USERNAME || 'propr-dev[bot]';
    const commentIdsSuffix = realComments.length > 0
        ? `\n\n---\n_Processing comment ID${realComments.length > 1 ? 's' : ''}: ${realComments.map(c => String(c.id)).join(', ')}_`
        : '';
    const modelList = assignments.map(a => `\`${a.label}\``).join(', ');
    const startedEvidence = buildWorkEvidenceMarker('started', realComments.map(comment => comment.id));
    await assertLease();
    const previousStartingComment = startedEvidence
        ? validation.prCommentsForValidation?.find(comment => (
            comment.user.type === 'Bot'
            && comment.user.login.toLowerCase() === botUsername.toLowerCase()
            && comment.body?.includes('**Starting AI Code Review**')
            && comment.body.includes(startedEvidence)
        ))
        : undefined;
    state.startingWorkComment = previousStartingComment
        ? { data: { id: previousStartingComment.id, html_url: previousStartingComment.html_url || taskUrl } }
        : await state.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            issue_number: pullRequestNumber,
            body: `🔍 **Starting AI Code Review** requested by ${state.authorsText}\n\nAnalyzing the pull request with ${modelList}...\n\n[View Task Progress](${taskUrl})${commentIdsSuffix}${startedEvidence ? `\n${startedEvidence}` : ''}`,
            request: { signal },
        });

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
            await assertLease();
            correlatedLogger.warn({ taskId, error: (titleError as Error).message }, 'Failed to generate review task subtitle');
        }
    }
    job.data.title = buildPrTaskTitle({ workflow, pullRequestNumber, prTitle: prData!.data.title });
    job.data.subtitle = titleContext.hasMeaningfulContext ? summaryTitle : fallbackSubtitle;
    await assertLease();
    await updateTaskTitleForPR({ taskId, jobData: job.data, stateManager, correlatedLogger, linkedIssueNumber: linkedIssueResult.linkedIssueNumber, prProcessingLockToken });
    await stateManager.updateHistoryMetadata(taskId, TaskStates.PROCESSING, {
        titleContext: buildPrTaskTitleContextHistoryMetadata(titleContext),
    }, prProcessingLockToken);

    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    // Load the operator-configured review prompt override once per job. A
    // settings load failure must NOT block the review - fall back to default.
    let reviewPromptOverride = '';
    try {
        const loadedSettings = await loadSettings();
        const configured = (loadedSettings as Record<string, unknown>).pr_review_prompt;
        if (typeof configured === 'string') {
            reviewPromptOverride = configured;
        }
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message }, 'Failed to load pr_review_prompt setting, using default review prompt');
    }

    const reviewCtx: RunReviewsContext = {
        registry, octokit: state.octokit, pullRequestNumber, repoOwner, repoName,
        taskId, taskUrl, combinedCommentBody, commentHistory,
        originalTaskSpec: linkedIssueResult.context || '',
        commandInstructions: job.data.commandInstructions,
        prDiff,
        omittedDiffFiles,
        fileContents,
        reviewPromptOverride,
        reasoningLevel: job.data.reasoningLevel,
        correlatedLogger,
        assertLease,
        signal,
        assignmentIndex: 0,
    };

    const reviewResults: ReviewResult[] = [];
    for (const [assignmentIndex, assignment] of assignments.entries()) {
        const recoveredReview = recoverPublishedReview(
            allComments,
            taskId,
            assignment,
            { assignmentIndex, botUsername },
        );
        if (recoveredReview) {
            correlatedLogger.warn(
                { taskId, assignmentIndex, model: assignment.model },
                'Recovered an already-published review assignment',
            );
            reviewResults.push(recoveredReview);
            continue;
        }
        reviewResults.push(await runSingleReview(assignment, {
            ...reviewCtx,
            assignmentIndex,
        }));
    }

    await assertLease();
    await recordReviewMetrics(reviewResults, { pullRequestNumber, repoOwner, repoName, correlationId, taskId });
    await updateReviewCompletionComment(state, reviewResults, { repoOwner, repoName, taskUrl, correlatedLogger, assertLease, signal });

    const successCount = reviewResults.filter(r => r.analysisResult.success).length;
    const failCount = reviewResults.length - successCount;

    await handleUltrafixContinuation('review', { job, stateManager, taskId, redisClient, repoOwner, repoName, pullRequestNumber, correlatedLogger, correlationId, prProcessingLockToken, assertLease });
    const ultrafixHistoryMeta = await resolveUltrafixHistoryMeta(job, { repoOwner, repoName, pullRequestNumber }, redisClient);

    await assertLease();
    const result = await persistReviewRemoteOutcome(redisClient, {
        taskId, repoOwner, repoName, pullRequestNumber, prProcessingLockToken,
        reviewsPosted: successCount, reviewsFailed: failCount,
    });
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
    }, prProcessingLockToken);

    correlatedLogger.info({ pullRequestNumber, successCount, failCount, totalReviews: assignments.length }, 'Review processing completed');

    return result;
}
