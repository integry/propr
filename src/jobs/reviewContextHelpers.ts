import type { Logger } from 'pino';
import {
    calculateCostWithCachePricing,
    getAuthenticatedOctokit,
    getDetailedUsageStats,
    getModelHardLimit,
    getModelPricing,
    getOpenRouterId,
} from '@propr/core';
import type { AnalysisResult } from '@propr/core';
import { fetchLinkedIssueContext, buildCommentHistory } from './prCommentJobHelpers.js';
import { fetchAllComments, fetchPRFiles, fetchPRFileContents, formatPRDiffWithMetadata, formatFileContents } from './prCommentJobUtils.js';
import {
    currentHeadChecksHaveFailures,
    formatCurrentHeadCheckSummary,
    type ReviewCheckRun,
} from './reviewCheckSummary.js';

export interface PRData { data: { head: { ref: string; sha?: string }; body: string | null; labels: Array<{ name: string }>; user: { login: string }; title: string } }

async function fetchCurrentHeadCheckSummary(
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
    prData: PRData,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger },
): Promise<{ checkSummary: string; hasCurrentCheckFailure: boolean }> {
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger } = params;
    const ref = prData.data.head.sha || prData.data.head.ref;
    try {
        const checkRuns = await octokit.paginate('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
            owner: repoOwner,
            repo: repoName,
            ref,
            filter: 'latest',
            per_page: 100,
        }) as unknown as ReviewCheckRun[];
        return {
            checkSummary: formatCurrentHeadCheckSummary(checkRuns),
            hasCurrentCheckFailure: currentHeadChecksHaveFailures(checkRuns),
        };
    } catch (error) {
        correlatedLogger.warn(
            { pullRequestNumber, error: error instanceof Error ? error.message : String(error) },
            'Failed to fetch current-head check runs for review',
        );
        return {
            checkSummary: 'Current-head check status is unavailable; do not infer it from historical comments.',
            hasCurrentCheckFailure: false,
        };
    }
}

const MIN_REVIEW_DIFF_MAX_CHARS = 100000;
const MIN_CONFIGURED_REVIEW_DIFF_MAX_CHARS = 10000;
const MAX_REVIEW_DIFF_MAX_CHARS = 1200000;
const REVIEW_DIFF_CHARS_PER_TOKEN_ESTIMATE = 2;
const REVIEW_DIFF_CONTEXT_RATIO = 0.7;
// Keep this bounded headroom unavailable to review input so the agent runtime
// can add its own context and still produce a complete structured review.
const REVIEW_OUTPUT_TOKEN_RESERVE = 16000;
const REVIEW_RUNTIME_CONTEXT_TOKEN_RESERVE = 8000;
export const REVIEW_CONTEXT_TOKEN_RESERVE = REVIEW_OUTPUT_TOKEN_RESERVE + REVIEW_RUNTIME_CONTEXT_TOKEN_RESERVE;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function resolveReviewDiffMaxChars(models: string[]): number {
    return resolveReviewDiffMaxCharsForBudget(models);
}

export function resolveReviewContextTokenBudget(models: string[], configuredMaxTokens = 0): number {
    const hardLimits = models.length > 0
        ? models.map(model => getModelHardLimit(model))
        : [getModelHardLimit(undefined)];
    const smallestHardLimit = Math.min(...hardLimits);
    const safeInputLimit = Math.max(0, smallestHardLimit - REVIEW_CONTEXT_TOKEN_RESERVE);
    return configuredMaxTokens > 0 ? Math.min(configuredMaxTokens, safeInputLimit) : safeInputLimit;
}

export function resolveReviewDiffMaxCharsForBudget(models: string[], configuredMaxTokens = 0): number {
    const envOverride = Number.parseInt(process.env.PR_REVIEW_DIFF_MAX_CHARS || '', 10);
    if (Number.isFinite(envOverride) && envOverride > 0) {
        return clamp(envOverride, MIN_REVIEW_DIFF_MAX_CHARS, MAX_REVIEW_DIFF_MAX_CHARS);
    }

    const contextTokenBudget = resolveReviewContextTokenBudget(models, configuredMaxTokens);
    const diffTokenBudget = Math.floor(contextTokenBudget * REVIEW_DIFF_CONTEXT_RATIO);
    const maxChars = diffTokenBudget * REVIEW_DIFF_CHARS_PER_TOKEN_ESTIMATE;

    const minimumChars = configuredMaxTokens > 0
        ? MIN_CONFIGURED_REVIEW_DIFF_MAX_CHARS
        : MIN_REVIEW_DIFF_MAX_CHARS;
    return clamp(maxChars, minimumChars, MAX_REVIEW_DIFF_MAX_CHARS);
}

export async function calculateReviewCost(
    analysisResult: AnalysisResult,
    model: string,
    correlatedLogger: Logger
): Promise<number | undefined> {
    if (!analysisResult.tokenUsage) return undefined;

    const detailedStats = getDetailedUsageStats({ tokenUsage: analysisResult.tokenUsage });
    if (detailedStats.totalTokens <= 0) return undefined;

    try {
        const openRouterId = getOpenRouterId(model);
        const pricing = await getModelPricing(openRouterId);
        return pricing
            ? calculateCostWithCachePricing(model, detailedStats, pricing)
            : undefined;
    } catch (error) {
        correlatedLogger.warn({ model, error: (error as Error).message }, 'Failed to calculate review cost for comment');
        return undefined;
    }
}

export async function fetchReviewContext(
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
    prData: PRData,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; models: string[]; maxContextTokens?: number; correlationId: string; correlatedLogger: Logger }
) {
    const { repoOwner, repoName, pullRequestNumber, models, maxContextTokens = 0, correlationId, correlatedLogger } = params;
    const checkSummaryPromise = fetchCurrentHeadCheckSummary(octokit, prData, {
        repoOwner,
        repoName,
        pullRequestNumber,
        correlatedLogger,
    });
    const allComments = await fetchAllComments(octokit, repoOwner, repoName, pullRequestNumber);
    const commentsByTime = [...allComments].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const linkedIssueResult = await fetchLinkedIssueContext(octokit as unknown as Parameters<typeof fetchLinkedIssueContext>[0], prData, { repoOwner, repoName, pullRequestNumber }, { correlationId, correlatedLogger });
    const commentHistory = buildCommentHistory(commentsByTime, prData, correlationId);

    correlatedLogger.info({ pullRequestNumber }, 'Fetching PR diff for review');
    const prFiles = await fetchPRFiles({ octokit, repoOwner, repoName, pullRequestNumber });
    const diffMaxChars = resolveReviewDiffMaxCharsForBudget(models, maxContextTokens);
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

    const checkContext = await checkSummaryPromise;

    return {
        allComments,
        commentHistory,
        linkedIssueResult,
        prDiff,
        omittedDiffFiles,
        changedFilePaths: prFiles.map(file => file.filename),
        fileContents,
        ...checkContext,
    };
}
