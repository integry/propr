import type { Logger } from 'pino';
import {
    calculateCostWithCachePricing,
    getAuthenticatedOctokit,
    getDetailedUsageStats,
    getModelPricing,
    getOpenRouterId,
} from '@propr/core';
import {
    resolveReviewInputCapacity,
    resolveReviewInputCeiling,
    type ReviewInputCapacity,
    type ReviewInputCeiling,
    type ReviewRouteDescriptor,
} from '@propr/shared';
import type { AnalysisResult } from '@propr/core';
import { fetchLinkedIssueContext, buildCommentHistory } from './prCommentJobHelpers.js';
import { fetchAllComments, fetchPRFiles, fetchPRFileContents, formatFileContents } from './prCommentJobUtils.js';
import { assemblePRDiff, preparePRDiff } from './prDiffFormatting.js';
import type { PullRequestHead } from './prGitTarget.js';
import {
    currentHeadChecksHaveFailures,
    formatCurrentHeadCheckSummary,
    type ReviewCheckRun,
} from './reviewCheckSummary.js';

export interface PRData { data: { head: PullRequestHead & { sha?: string }; body: string | null; labels: Array<{ name: string }>; user: { login: string }; title: string } }

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

// Bounded in-memory guard for the fetched diff text. It is independent of any
// model's token capacity: token budgeting selects files per reviewer later.
// PR_REVIEW_DIFF_MAX_CHARS (an advanced operator limit) overrides the default
// and always takes precedence, because it bounds what is held for every
// reviewer before any per-reviewer budget is applied.
export const DEFAULT_REVIEW_DIFF_IO_GUARD_CHARS = 4000000;
const MIN_REVIEW_DIFF_IO_GUARD_CHARS = 100000;
const MAX_REVIEW_DIFF_IO_GUARD_CHARS = 16000000;

export interface ReviewDiffIoGuard {
    maxChars: number;
    source: 'default' | 'PR_REVIEW_DIFF_MAX_CHARS';
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function resolveReviewDiffIoGuard(env: NodeJS.ProcessEnv = process.env): ReviewDiffIoGuard {
    const override = Number.parseInt(env.PR_REVIEW_DIFF_MAX_CHARS || '', 10);
    return Number.isFinite(override) && override > 0
        ? { maxChars: clamp(override, MIN_REVIEW_DIFF_IO_GUARD_CHARS, MAX_REVIEW_DIFF_IO_GUARD_CHARS), source: 'PR_REVIEW_DIFF_MAX_CHARS' }
        : { maxChars: DEFAULT_REVIEW_DIFF_IO_GUARD_CHARS, source: 'default' };
}

export interface ReviewBudgetSettings {
    /** Percentage of the safe input capacity (10-100). */
    percent: number;
    /** Retained legacy absolute cap; 0 when none. */
    legacyMaxContextTokens: number;
}

export interface ReviewerBudget {
    capacity: ReviewInputCapacity;
    ceiling: ReviewInputCeiling;
}

/**
 * Resolve one routed reviewer's own input ceiling. Each reviewer is fitted to
 * its own capacity, so a smaller reviewer never narrows a larger one.
 */
export function resolveReviewerBudget(route: ReviewRouteDescriptor, settings: ReviewBudgetSettings): ReviewerBudget {
    const capacity = resolveReviewInputCapacity(route);
    return {
        capacity,
        ceiling: resolveReviewInputCeiling(capacity.safeInputTokens, {
            percent: settings.percent,
            legacyMaxContextTokens: settings.legacyMaxContextTokens,
        }),
    };
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
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; correlationId: string; correlatedLogger: Logger }
) {
    const { repoOwner, repoName, pullRequestNumber, correlationId, correlatedLogger } = params;
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
    const ioGuard = resolveReviewDiffIoGuard();
    // Untrimmed apart from the I/O guard: each reviewer selects what fits its
    // own token budget when its prompt is assembled.
    const preparedDiff = preparePRDiff(prFiles, ioGuard.maxChars);
    const prDiff = assemblePRDiff(preparedDiff, new Set(preparedDiff.files.map(file => file.filename))).diff;
    correlatedLogger.info({
        pullRequestNumber,
        fileCount: prFiles.length,
        diffFilesWithPatch: preparedDiff.files.length,
        diffLength: prDiff.length,
        ioGuardMaxChars: ioGuard.maxChars,
        ioGuardSource: ioGuard.source,
        missingPatchFileCount: preparedDiff.missingPatchFiles.length,
        ioGuardOmittedFileCount: preparedDiff.ioGuardOmittedFiles.length,
    }, 'Fetched PR diff');
    if (preparedDiff.ioGuardOmittedFiles.length > 0) {
        correlatedLogger.warn({
            pullRequestNumber,
            ioGuardMaxChars: ioGuard.maxChars,
            ioGuardSource: ioGuard.source,
            ioGuardOmittedFileCount: preparedDiff.ioGuardOmittedFiles.length,
        }, 'PR diff exceeded the diff size I/O guard; files were omitted independently of model context capacity');
    }

    const fileContentsMap = await fetchPRFileContents({ octokit, repoOwner, repoName, prHeadRef: prData.data.head.sha || prData.data.head.ref, files: prFiles });
    const fileContents = formatFileContents(fileContentsMap);
    correlatedLogger.info({ pullRequestNumber, filesWithContent: fileContentsMap.size, contentLength: fileContents.length }, 'Fetched full file contents');

    const checkContext = await checkSummaryPromise;
    // PR file lists are addressed by PR number. Verify the snapshot did not
    // move while reading them before publishing an exact reviewed-head marker.
    const { data: currentPr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: repoOwner, repo: repoName, pull_number: pullRequestNumber,
    });
    if (currentPr.head.sha !== prData.data.head.sha) throw new Error('Pull request head changed while gathering review context; request a fresh review.');

    return {
        allComments,
        commentHistory,
        linkedIssueResult,
        prDiff,
        preparedDiff,
        changedFilePaths: prFiles.map(file => file.filename),
        fileContents,
        ...checkContext,
    };
}
