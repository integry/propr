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

export interface PRData { data: { head: { ref: string }; body: string | null; labels: Array<{ name: string }>; user: { login: string }; title: string } }

const MIN_REVIEW_DIFF_MAX_CHARS = 100000;
const MAX_REVIEW_DIFF_MAX_CHARS = 1200000;
const REVIEW_DIFF_CHARS_PER_TOKEN_ESTIMATE = 2;
const REVIEW_DIFF_CONTEXT_RATIO = 0.7;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function resolveReviewDiffMaxChars(models: string[]): number {
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
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; models: string[]; correlationId: string; correlatedLogger: Logger }
) {
    const { repoOwner, repoName, pullRequestNumber, models, correlationId, correlatedLogger } = params;
    const allComments = await fetchAllComments(octokit, repoOwner, repoName, pullRequestNumber);
    const commentsByTime = [...allComments].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const linkedIssueResult = await fetchLinkedIssueContext(octokit as unknown as Parameters<typeof fetchLinkedIssueContext>[0], prData, { repoOwner, repoName, pullRequestNumber }, { correlationId, correlatedLogger });
    const commentHistory = buildCommentHistory(commentsByTime, prData, correlationId);

    correlatedLogger.info({ pullRequestNumber }, 'Fetching PR diff for review');
    const prFiles = await fetchPRFiles({ octokit, repoOwner, repoName, pullRequestNumber });
    const diffMaxChars = resolveReviewDiffMaxChars(models);
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
