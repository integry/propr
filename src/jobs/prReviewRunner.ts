import type { Logger } from 'pino';
import { buildAnalysisSafetySuffix, getAuthenticatedOctokit } from '@propr/core';
import type { AgentRegistry, AnalysisResult, AnalyzeOptions, SyntheticRoutingSession } from '@propr/core';
import type { ReasoningLevel } from '@propr/shared';
import type { Redis } from 'ioredis';
import { calculateReviewCost } from './reviewContextHelpers.js';
import { buildReviewPromptWithinBudget } from './reviewPromptBuilder.js';
import { buildReviewErrorComment } from './reviewCommentFormatter.js';
import { buildReviewCommentWithReservedFindingRange } from './reviewFindingNumberAllocator.js';

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;
const REVIEW_ANALYSIS_SAFETY_SUFFIX = buildAnalysisSafetySuffix('text', false, undefined);

export interface ReviewAssignment {
    agentAlias: string;
    model: string;
    label: string;
    /** Physical route selected before the shared review budget was calculated. */
    routingSession?: SyntheticRoutingSession;
    physicalAgentAlias?: string;
    physicalModel?: string;
}
export interface ReviewResult {
    assignment: ReviewAssignment;
    analysisResult: AnalysisResult;
    commentId?: number;
    commentUrl?: string;
    error?: string;
    prompt?: string;
    findingCount?: number;
}

export interface RunReviewsContext {
    registry: AgentRegistry;
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    taskId: string;
    taskUrl: string;
    reviewedHead?: string;
    combinedCommentBody: string;
    commentHistory: string;
    originalTaskSpec: string;
    commandInstructions?: string;
    prDiff: string;
    omittedDiffFiles: string[];
    changedFilePaths: string[];
    findingStartNumber: number;
    redisClient: Redis;
    fileContents: string;
    relatedContext: string;
    checkSummary: string;
    hasCurrentCheckFailure: boolean;
    reviewPromptOverride: string;
    reviewMaxContextTokens: number;
    reasoningLevel?: ReasoningLevel;
    correlatedLogger: Logger;
}

export async function runSingleReview(
    assignment: ReviewAssignment,
    ctx: RunReviewsContext
): Promise<ReviewResult> {
    const { registry, octokit, pullRequestNumber, repoOwner, repoName, taskId, taskUrl, correlatedLogger } = ctx;
    const { agentAlias, model, label } = assignment;
    correlatedLogger.info({ pullRequestNumber, agentAlias, model, label }, 'Starting review analysis');

    const executionAgentAlias = assignment.physicalAgentAlias || agentAlias;
    const executionModel = assignment.physicalModel || model;
    const agent = registry.getAgentByAlias(executionAgentAlias);
    if (!agent) {
        const errorMsg = `Agent not found for alias: ${agentAlias}`;
        correlatedLogger.error({ agentAlias }, errorMsg);
        return { assignment, analysisResult: { response: '', modelUsed: model, executionTimeMs: 0, success: false, error: errorMsg }, error: errorMsg };
    }

    // Built inside the try so a budget too small for the mandatory review
    // instructions is reported like any other review failure instead of
    // aborting the remaining reviewers.
    let reviewPrompt = '';
    try {
        const promptResult = buildReviewPromptWithinBudget({
            pullRequestNumber, combinedCommentBody: ctx.combinedCommentBody, commentHistory: ctx.commentHistory,
            originalTaskSpec: ctx.originalTaskSpec, repoOwner, repoName, instructions: ctx.commandInstructions,
            prDiff: ctx.prDiff, fileContents: ctx.fileContents, relatedContext: ctx.relatedContext,
            checkSummary: ctx.checkSummary, reviewPromptOverride: ctx.reviewPromptOverride,
        }, ctx.reviewMaxContextTokens, REVIEW_ANALYSIS_SAFETY_SUFFIX);
        reviewPrompt = promptResult.prompt;
        if (promptResult.truncatedSections.length > 0) {
            correlatedLogger.warn({
                pullRequestNumber,
                model: executionModel,
                maxContextTokens: ctx.reviewMaxContextTokens,
                estimatedTokens: promptResult.estimatedTokens,
                truncatedSections: promptResult.truncatedSections,
            }, 'Trimmed PR review context to fit token budget');
        }

        const analyzeOptions: AnalyzeOptions = {
            model: executionModel,
            taskId,
            prNumber: pullRequestNumber,
            repository: `${repoOwner}/${repoName}`,
            executionType: 'pr-review',
            responseFormat: 'text',
            reasoningLevel: ctx.reasoningLevel,
            timeoutMs: REVIEW_TIMEOUT_MS,
        };
        const analysisResult = assignment.routingSession
            ? await assignment.routingSession.analyze(reviewPrompt, analyzeOptions)
            : await agent.analyze(reviewPrompt, analyzeOptions);
        correlatedLogger.info({
            pullRequestNumber, model: analysisResult.modelUsed, success: analysisResult.success,
            executionTimeMs: analysisResult.executionTimeMs, responseLength: analysisResult.response.length,
        }, 'Review analysis completed');

        const costUsd = await calculateReviewCost(analysisResult, analysisResult.modelUsed || model, correlatedLogger);
        const { reviewCommentBody, findingCount } = await buildReviewCommentWithReservedFindingRange(
            assignment, analysisResult, taskUrl, {
                reviewedHead: ctx.reviewedHead, taskId,
                omittedDiffFiles: ctx.omittedDiffFiles,
                prDiffTruncated: promptResult.prDiffTruncated,
                costUsd,
                hasCurrentCheckFailure: ctx.hasCurrentCheckFailure,
                changedFilePaths: ctx.changedFilePaths,
                redisClient: ctx.redisClient, issueRef: { repoOwner, repoName, pullRequestNumber },
                observedNextFindingNumber: ctx.findingStartNumber,
            },
        );

        const reviewComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: pullRequestNumber, body: reviewCommentBody,
        });

        return { assignment, analysisResult, commentId: reviewComment.data.id, commentUrl: reviewComment.data.html_url, prompt: reviewPrompt, findingCount };
    } catch (reviewError) {
        const errorMsg = (reviewError as Error).message;
        correlatedLogger.error({ pullRequestNumber, model, error: errorMsg }, 'Review analysis failed');

        let errorComment: { data: { id: number; html_url: string } } | undefined;
        try {
            errorComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
                body: buildReviewErrorComment(label, model, errorMsg),
            });
        } catch (commentError) {
            correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post review error comment');
        }

        return { assignment, analysisResult: { response: '', modelUsed: model, executionTimeMs: 0, success: false, error: errorMsg }, commentId: errorComment?.data.id, commentUrl: errorComment?.data.html_url, error: errorMsg, prompt: reviewPrompt };
    }
}

type ReviewRoutingOutcome = { status: 'routed'; assignment: ReviewAssignment }
    | { status: 'failed'; result: ReviewResult };

export async function routeReviewAssignments(
    registry: AgentRegistry, assignments: ReviewAssignment[], pullRequestNumber: number, correlatedLogger: Logger,
): Promise<ReviewRoutingOutcome[]> {
    return Promise.all(assignments.map(async assignment => {
        try {
            const routingSession = registry.beginRoutingSession({ requestedAgentAlias: assignment.agentAlias, requestedModel: assignment.model });
            const selection = await routingSession.select();
            return {
                status: 'routed' as const,
                assignment: { ...assignment, routingSession,
                    physicalAgentAlias: selection.physicalAgentAlias,
                    physicalModel: selection.physicalModel },
            };
        } catch (routingError) {
            const error = `Failed to route review assignment '${assignment.label}': ${(routingError as Error).message}`;
            correlatedLogger.warn({ pullRequestNumber, agentAlias: assignment.agentAlias,
                model: assignment.model, error: (routingError as Error).message,
            }, 'Review assignment unavailable; continuing with remaining reviewers');
            return {
                status: 'failed' as const,
                result: { assignment,
                    analysisResult: { response: '', modelUsed: assignment.model,
                        executionTimeMs: 0, success: false, error }, error },
            };
        }
    }));
}

export async function runReviewRoutingOutcomes(
    routingOutcomes: ReviewRoutingOutcome[], reviewCtx: RunReviewsContext, firstFindingNumber: number,
): Promise<ReviewResult[]> {
    const reviewResults: ReviewResult[] = [];
    let nextFindingNumber = firstFindingNumber;
    for (const outcome of routingOutcomes) {
        if (outcome.status === 'failed') {
            reviewResults.push(outcome.result);
            continue;
        }
        const result = await runSingleReview(outcome.assignment, {
            ...reviewCtx, findingStartNumber: nextFindingNumber,
        });
        reviewResults.push(result);
        nextFindingNumber += result.findingCount ?? 0;
    }
    return reviewResults;
}
