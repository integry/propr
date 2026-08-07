import type { Logger } from 'pino';
import { buildAnalysisSafetySuffix, getAuthenticatedOctokit } from '@propr/core';
import type { AgentRegistry, AnalysisResult } from '@propr/core';
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

    const agent = registry.getAgentByAlias(agentAlias);
    if (!agent) {
        const errorMsg = `Agent not found for alias: ${agentAlias}`;
        correlatedLogger.error({ agentAlias }, errorMsg);
        return { assignment, analysisResult: { response: '', modelUsed: model, executionTimeMs: 0, success: false, error: errorMsg }, error: errorMsg };
    }

    const promptResult = buildReviewPromptWithinBudget({
        pullRequestNumber, combinedCommentBody: ctx.combinedCommentBody, commentHistory: ctx.commentHistory,
        originalTaskSpec: ctx.originalTaskSpec, repoOwner, repoName, instructions: ctx.commandInstructions,
        prDiff: ctx.prDiff, fileContents: ctx.fileContents, relatedContext: ctx.relatedContext,
        checkSummary: ctx.checkSummary, reviewPromptOverride: ctx.reviewPromptOverride,
    }, ctx.reviewMaxContextTokens, REVIEW_ANALYSIS_SAFETY_SUFFIX);
    const reviewPrompt = promptResult.prompt;
    if (promptResult.truncatedSections.length > 0) {
        correlatedLogger.warn({
            pullRequestNumber,
            model,
            maxContextTokens: ctx.reviewMaxContextTokens,
            estimatedTokens: promptResult.estimatedTokens,
            truncatedSections: promptResult.truncatedSections,
        }, 'Trimmed PR review context to fit token budget');
    }

    try {
        const analysisResult = await agent.analyze(reviewPrompt, {
            model,
            taskId,
            prNumber: pullRequestNumber,
            repository: `${repoOwner}/${repoName}`,
            executionType: 'pr-review',
            responseFormat: 'text',
            reasoningLevel: ctx.reasoningLevel,
            timeoutMs: REVIEW_TIMEOUT_MS,
        });
        correlatedLogger.info({
            pullRequestNumber, model: analysisResult.modelUsed, success: analysisResult.success,
            executionTimeMs: analysisResult.executionTimeMs, responseLength: analysisResult.response.length,
        }, 'Review analysis completed');

        const costUsd = await calculateReviewCost(analysisResult, analysisResult.modelUsed || model, correlatedLogger);
        const { reviewCommentBody, findingCount } = await buildReviewCommentWithReservedFindingRange(
            assignment, analysisResult, taskUrl, {
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
