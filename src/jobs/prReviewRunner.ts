import type { Logger } from 'pino';
import { buildAnalysisSafetySuffix, getAuthenticatedOctokit } from '@propr/core';
import type { AgentRegistry, AnalysisResult, AnalyzeOptions, SyntheticRoutingSession } from '@propr/core';
import type { ReasoningLevel } from '@propr/shared';
import type { Redis } from 'ioredis';
import { calculateReviewCost, resolveReviewerBudget, type ReviewBudgetSettings } from './reviewContextHelpers.js';
import { buildReviewPromptWithinBudget } from './reviewPromptBuilder.js';
import type { PreparedPRDiff } from './prDiffFormatting.js';
import { ReviewTokenEstimator, type ReviewTokenStatsCache } from './reviewTokenEstimator.js';
import { buildReviewErrorComment } from './reviewCommentFormatter.js';
import { buildReviewCommentWithReservedFindingRange } from './reviewFindingNumberAllocator.js';

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;
const REVIEW_ANALYSIS_SAFETY_SUFFIX = buildAnalysisSafetySuffix('text', false, undefined);

export interface ReviewAssignment {
    agentAlias: string;
    model: string;
    label: string;
    /** Physical route selected before this reviewer's own input budget is resolved. */
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
    /** Untrimmed diff; each reviewer selects the files that fit its own budget. */
    preparedDiff: PreparedPRDiff;
    /** Tokenizer statistics shared by every reviewer of this job. */
    tokenStats: ReviewTokenStatsCache;
    changedFilePaths: string[];
    findingStartNumber: number;
    redisClient: Redis;
    fileContents: string;
    relatedContext: string;
    checkSummary: string;
    hasCurrentCheckFailure: boolean;
    reviewPromptOverride: string;
    reviewBudgetSettings: ReviewBudgetSettings;
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
        const { capacity, ceiling } = resolveReviewerBudget({
            agentType: agent.config.type,
            model: executionModel,
            runtimeEnv: agent.config.envVars,
        }, ctx.reviewBudgetSettings);
        const promptResult = buildReviewPromptWithinBudget({
            pullRequestNumber, combinedCommentBody: ctx.combinedCommentBody, commentHistory: ctx.commentHistory,
            originalTaskSpec: ctx.originalTaskSpec, repoOwner, repoName, instructions: ctx.commandInstructions,
            fileContents: ctx.fileContents, relatedContext: ctx.relatedContext,
            checkSummary: ctx.checkSummary, reviewPromptOverride: ctx.reviewPromptOverride,
        }, ceiling.ceiling, REVIEW_ANALYSIS_SAFETY_SUFFIX, {
            preparedDiff: ctx.preparedDiff,
            estimator: new ReviewTokenEstimator(capacity.tokenizerProfile, ctx.tokenStats),
        });
        reviewPrompt = promptResult.prompt;
        // Sizes and reasons only: prompt text stays out of ordinary logs.
        const budgetLog = {
            pullRequestNumber,
            agentAlias: executionAgentAlias,
            agentType: agent.config.type,
            model: executionModel,
            capacitySource: capacity.source,
            contextWindow: capacity.contextWindow,
            outputReserve: capacity.outputReserve,
            runtimeOverheadReserve: capacity.runtimeOverheadReserve,
            safeInputTokens: capacity.safeInputTokens,
            budgetPercent: ceiling.percent,
            legacyMaxContextTokens: ceiling.legacyMaxContextTokens,
            ceilingLimitedBy: ceiling.limitedBy,
            maxContextTokens: ceiling.ceiling,
            tokenizerProfile: capacity.tokenizerProfile,
            estimatedTokens: promptResult.estimatedTokens,
            sectionTokens: promptResult.sectionTokens,
            missingPatchFileCount: promptResult.missingPatchFiles.length,
            ioGuardOmittedFileCount: promptResult.ioGuardOmittedFiles.length,
            budgetOmittedFileCount: promptResult.budgetOmittedFiles.length,
        };
        if (promptResult.trimmedSections.length > 0) {
            correlatedLogger.warn({
                ...budgetLog,
                truncatedSections: promptResult.trimmedSections,
                trimReason: ceiling.limitedBy === 'legacy-cap' ? 'legacy token cap' : 'review context budget',
            }, 'Trimmed PR review context to fit token budget');
        } else {
            correlatedLogger.info(budgetLog, 'PR review context fits token budget');
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
                omittedDiffFiles: [
                    ...promptResult.missingPatchFiles,
                    ...promptResult.ioGuardOmittedFiles,
                    ...promptResult.budgetOmittedFiles,
                ],
                missingPatchFiles: promptResult.missingPatchFiles,
                ioGuardOmittedFiles: promptResult.ioGuardOmittedFiles,
                budgetOmittedFiles: promptResult.budgetOmittedFiles,
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
