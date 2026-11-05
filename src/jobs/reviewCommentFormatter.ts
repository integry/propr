/**
 * Review comment formatter helpers.
 *
 * Formats the LLM review output into a GitHub comment that:
 *   - Identifies the reviewing model.
 *   - Contains actionable findings, non-automatic suggestions, evaluation, and a score.
 *   - Ends with a short /fix instruction for the user.
 *   - Includes a machine-detectable HTML marker so the /fix pipeline can
 *     distinguish AI review comments from ordinary human comments and
 *     implementation-completion comments.
 */

import { getModelName, type AnalysisResult } from '@propr/core';
import { formatFixCommand } from '@propr/shared';
import type { ReviewAssignment } from './prReviewRunner.js';
import {
    FIX_COMMAND_COPY_LABEL, highestReviewRecordNumber, parsePublishableReview, parseStructuredReview,
    publishedReviewScore, renderPublicReview,
} from './reviewOutputParser.js';

/** HTML comment marker prefix used to identify AI review comments. */
export const REVIEW_COMMENT_MARKER_PREFIX = '<!-- propr:ai-review';

/**
 * RegExp that matches the machine-readable marker embedded in every AI review
 * comment. Captures the model name so the /fix pipeline knows which model
 * produced each review.
 */
export const REVIEW_COMMENT_MARKER_RE = /<!-- propr:ai-review model="([^"]+)"(?: [^>]*)? -->/;

/**
 * Check whether a comment body looks like an AI review comment produced by
 * ProPR.  This is intentionally a cheap string check so callers can filter
 * large lists without compiling a regex per comment.
 */
export function isReviewComment(body: string): boolean {
    return body.includes(REVIEW_COMMENT_MARKER_PREFIX);
}

interface AuthoredReviewComment {
    body: string | null;
    user: { login: string };
}

/** First identifier of each kind a review run may publish on one pull request. */
export interface ReviewRecordStartNumbers {
    firstFindingNumber: number;
    firstSuggestionNumber: number;
}

/**
 * Find the next PR-wide F# and S# using only comments authored by the identity
 * from ProPR's authenticated GitHub response. Unsafe IDs cannot seed either
 * allocator. The two sequences advance independently so a review that publishes
 * no blocker still leaves the S# sequence where the previous review ended.
 */
export function getNextAuthenticatedReviewRecordNumbers(
    comments: readonly AuthoredReviewComment[],
    authenticatedProprLogin: string | undefined,
): ReviewRecordStartNumbers {
    const normalizedProprLogin = authenticatedProprLogin?.trim().toLowerCase();
    if (!normalizedProprLogin) return { firstFindingNumber: 1, firstSuggestionNumber: 1 };

    let highestFinding = 0;
    let highestSuggestion = 0;
    for (const comment of comments) {
        if (
            !comment.body
            || comment.user.login.toLowerCase() !== normalizedProprLogin
            || !isReviewComment(comment.body)
        ) continue;

        const parsed = parseStructuredReview(comment.body);
        highestFinding = Math.max(highestFinding, highestReviewRecordNumber(parsed.actionableFindings));
        highestSuggestion = Math.max(highestSuggestion, highestReviewRecordNumber(parsed.suggestions));
    }
    return { firstFindingNumber: highestFinding + 1, firstSuggestionNumber: highestSuggestion + 1 };
}

/**
 * Extract the model name from an AI review comment's marker.
 * Returns `null` when the comment is not an AI review comment.
 */
export function extractReviewModel(body: string): string | null {
    const match = body.match(REVIEW_COMMENT_MARKER_RE);
    return match ? match[1] : null;
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

/** Convert legacy suggestion metadata into the current title-and-reasoning shape. */
function normalizeSuggestionMetadata(response: string): string {
    const sectionMatch = /^##[ \t]+Suggestions and Follow-ups(?:[ \t]+.*)?$/im.exec(response);
    if (!sectionMatch) return response;

    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const afterStart = response.slice(sectionStart);
    const nextSection = /^##\s+/m.exec(afterStart);
    const sectionEnd = sectionStart + (nextSection?.index ?? afterStart.length);
    const section = response.slice(sectionStart, sectionEnd)
        .replace(
            /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?summary:?(?:\*\*)?[ \t]*:?\s*(.*?)[ \t]*(?:\r?\n|$)/gim,
            '$1\n',
        )
        .replace(/^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?auto[- ]?fix:?(?:\*\*)?[ \t]*:?.*(?:\r?\n|$)/gim, '');

    return response.slice(0, sectionStart) + section + response.slice(sectionEnd);
}

function reviewExecutionMetadata(options: { reviewedHead?: string; taskId?: string }): string {
    const head = options.reviewedHead && /^[a-f0-9]{40}$/.test(options.reviewedHead) ? ` head="${options.reviewedHead}"` : '';
    const task = options.taskId ? ` task="${encodeURIComponent(options.taskId)}"` : '';
    return head + task;
}

/** Read the public IDs after numbering and validation, including reserved ranges. */
function buildFixCommandCopyBlock(publicResponse: string | null): string {
    if (!publicResponse) return '';
    const published = parseStructuredReview(publicResponse);
    const fixCommand = formatFixCommand({
        findingIds: published.actionableFindings.map(finding => finding.id),
        suggestionIds: published.suggestions.map(suggestion => suggestion.id),
    });
    return fixCommand ? `\n${FIX_COMMAND_COPY_LABEL}\n\n\`\`\`text\n${fixCommand}\n\`\`\`` : '';
}

const currentCheckScoreCap = (hasCurrentCheckFailure?: boolean) => hasCurrentCheckFailure
    ? { maximum: 7, reason: 'Score capped at 7 because a current-head check is failing.' }
    : undefined;

export interface EffectiveReviewScore {
    score: number;
    blockerCount: number;
    suggestionCount: number;
}

/**
 * The effective score `buildReviewComment` publishes for a review response,
 * including the blocker and current-head check caps; null when the comment
 * would not show a valid scored review.
 */
export function effectiveReviewScore(
    response: string,
    options: { hasCurrentCheckFailure?: boolean; changedFilePaths?: readonly string[] } = {},
): EffectiveReviewScore | null {
    const publishable = parsePublishableReview(normalizeSuggestionMetadata(response), { changedFilePaths: options.changedFilePaths });
    const parsed = publishable?.parsed;
    if (!parsed || parsed.score === null) return null;
    return {
        score: publishedReviewScore(parsed.score, currentCheckScoreCap(options.hasCurrentCheckFailure)),
        blockerCount: parsed.actionableFindings.length,
        suggestionCount: parsed.suggestions.length,
    };
}

/**
 * Build the GitHub comment body for a successful review.
 *
 * Structure:
 *   1. Header with model label.
 *   2. The validated response rendered with public review sections and labels.
 *   3. Review Details metadata block (model, time, tokens).
 *   4. A short instruction and copyable command telling the user about /fix.
 *   5. A hidden HTML marker for machine detection.
 */
export function buildReviewComment(
    assignment: ReviewAssignment,
    analysisResult: AnalysisResult,
    taskUrl?: string,
    options: {
        reviewedHead?: string;
        taskId?: string;
        /** Every file absent from the review diff, whatever the reason. */
        omittedDiffFiles?: string[];
        /** Subset GitHub returned without patch content. */
        missingPatchFiles?: string[];
        /** Subset that did not fit the reviewer's context budget. */
        budgetOmittedFiles?: string[];
        /** Subset dropped by the diff size I/O guard. */
        ioGuardOmittedFiles?: string[];
        prDiffTruncated?: boolean;
        costUsd?: number | null;
        hasCurrentCheckFailure?: boolean;
        firstFindingNumber?: number;
        firstSuggestionNumber?: number;
        changedFilePaths?: readonly string[];
    } = {},
): string {
    const { model, label } = assignment;
    const { response, executionTimeMs, tokenUsage, modelUsed } = analysisResult;
    const omittedDiffFiles = options.omittedDiffFiles ?? [];
    const isPartialReview = options.prDiffTruncated === true || omittedDiffFiles.length > 0;

    const effectiveModel = modelUsed || model;
    const modelDisplayName = getModelName(effectiveModel);

    const sanitizedResponse = normalizeSuggestionMetadata(response);
    const publicResponse = renderPublicReview(sanitizedResponse, currentCheckScoreCap(options.hasCurrentCheckFailure), {
        firstFindingNumber: options.firstFindingNumber,
        firstSuggestionNumber: options.firstSuggestionNumber,
        changedFilePaths: options.changedFilePaths,
    });
    let comment = `## 🔍 AI Code Review — ${label}\n\n`;
    comment += publicResponse ?? '⚠️ **Review output was invalid and could not be displayed safely.**';

    // --- Review Details ---
    comment += `\n\n---\n### 🤖 Review Details\n\n`;
    comment += `* **Model:** ${modelDisplayName}\n`;
    comment += `* **Time:** ${formatDuration(executionTimeMs)}\n`;
    if (tokenUsage) {
        const input = (tokenUsage.input_tokens || 0)
            + (tokenUsage.cache_creation_input_tokens || 0)
            + (tokenUsage.cache_read_input_tokens || 0);
        const output = tokenUsage.output_tokens || 0;
        const total = input + output;
        if (total > 0) {
            comment += `* **Tokens:** ${total.toLocaleString()} (${input.toLocaleString()} in / ${output.toLocaleString()} out)\n`;
        }
    }
    if (options.costUsd != null && options.costUsd > 0) {
        comment += `* **Cost:** $${options.costUsd.toFixed(2)}\n`;
    }
    const omissionReasons = classifyOmittedDiffFiles(omittedDiffFiles, options);
    if (isPartialReview) {
        comment += `* **Review scope:** Partial — ${describePartialReviewScope(omissionReasons, options.prDiffTruncated === true)}\n`;
    }
    if (taskUrl) {
        comment += `\n[View Task](${taskUrl})`;
    }
    if (omittedDiffFiles.length > 0) {
        comment += formatOmittedDiffFilesForComment(omittedDiffFiles, omissionReasons);
    }

    // --- /fix instructions ---
    comment += `\n\n---\n`;
    comment += `> 💡 **Next step:** Comment \`/fix\` to address every F# merge blocker, \`/fix all\` for every pending blocker and suggestion, or name records explicitly, as in \`/fix F3 S5\`.\n`;
    comment += `> F# and S# IDs increment across review comments and remain permanent, so selectors such as \`/fix F3 F5\` stay unambiguous across cycles. S# suggestions stay optional: they are implemented only when you name them or request \`/fix all\`, and they never relax a merge blocker.\n`;
    comment += buildFixCommandCopyBlock(publicResponse);

    // --- Machine-readable marker ---
    comment += `\n\n<sub>\u{1F916} Review by [ProPR](https://propr.dev)</sub>`;
    const executionMetadata = reviewExecutionMetadata(options);
    const partialReviewMetadata = isPartialReview ? ' partial="true"' : '';
    comment += `\n<!-- propr:ai-review model="${effectiveModel}"${partialReviewMetadata}${executionMetadata} -->`;

    return comment;
}

interface OmittedDiffFileReasons {
    missingPatchFiles: string[];
    budgetOmittedFiles: string[];
    ioGuardOmittedFiles: string[];
    /** Omitted files whose reason the caller did not classify. */
    unclassifiedFiles: string[];
}

function classifyOmittedDiffFiles(
    omittedDiffFiles: string[],
    options: { missingPatchFiles?: string[]; budgetOmittedFiles?: string[]; ioGuardOmittedFiles?: string[] },
): OmittedDiffFileReasons {
    const missingPatchFiles = options.missingPatchFiles ?? [];
    const budgetOmittedFiles = options.budgetOmittedFiles ?? [];
    const ioGuardOmittedFiles = options.ioGuardOmittedFiles ?? [];
    const classified = new Set([...missingPatchFiles, ...budgetOmittedFiles, ...ioGuardOmittedFiles]);
    return {
        missingPatchFiles,
        budgetOmittedFiles,
        ioGuardOmittedFiles,
        unclassifiedFiles: omittedDiffFiles.filter(filename => !classified.has(filename)),
    };
}

function plural(count: number, singular: string, pluralForm: string): string {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}

function describePartialReviewScope(reasons: OmittedDiffFileReasons, prDiffTruncated: boolean): string {
    const parts: string[] = [];
    if (reasons.missingPatchFiles.length > 0) {
        parts.push(`${plural(reasons.missingPatchFiles.length, 'changed file has', 'changed files have')} no patch content from GitHub, which a larger review budget cannot recover`);
    }
    if (reasons.budgetOmittedFiles.length > 0) {
        parts.push(`${plural(reasons.budgetOmittedFiles.length, 'file was', 'files were')} omitted by the review context budget`);
    }
    if (reasons.ioGuardOmittedFiles.length > 0) {
        parts.push(`${plural(reasons.ioGuardOmittedFiles.length, 'file was', 'files were')} omitted by the diff size safety guard`);
    }
    if (parts.length > 0) return `${parts.join('; ')}.`;
    return prDiffTruncated && reasons.unclassifiedFiles.length === 0
        ? 'PR diff ranges were omitted by the review context budget.'
        : 'PR diff files or ranges were unavailable from GitHub or omitted by the review context budget.';
}

function formatOmittedDiffFileGroup(heading: string, filenames: string[]): string[] {
    if (filenames.length === 0) return [];
    const maxListedFiles = 50;
    const listedFiles = filenames.slice(0, maxListedFiles).map(filename => `  - \`${filename}\``);
    const remainingCount = filenames.length - maxListedFiles;
    return [
        '',
        `**${heading}**`,
        '',
        ...listedFiles,
        ...(remainingCount > 0 ? [`  - ...and ${remainingCount} more`] : []),
    ];
}

function formatOmittedDiffFilesForComment(omittedFiles: string[], reasons: OmittedDiffFileReasons): string {
    const classified = reasons.unclassifiedFiles.length < omittedFiles.length;
    const groups = classified
        ? [
            ...formatOmittedDiffFileGroup('No patch content from GitHub (a larger review budget cannot recover these)', reasons.missingPatchFiles),
            ...formatOmittedDiffFileGroup('Did not fit the review context budget', reasons.budgetOmittedFiles),
            ...formatOmittedDiffFileGroup('Exceeded the diff size safety guard', reasons.ioGuardOmittedFiles),
            ...formatOmittedDiffFileGroup('Omitted for another reason', reasons.unclassifiedFiles),
        ]
        : formatOmittedDiffFileGroup('Omitted files', omittedFiles).slice(2);

    return [
        '',
        '',
        '<details>',
        '<summary>Files omitted from review diff</summary>',
        '',
        classified
            ? `${plural(omittedFiles.length, 'file was', 'files were')} omitted from the review diff. Large, binary, generated, and lockfile changes are deprioritized.`
            : `${plural(omittedFiles.length, 'file was', 'files were')} omitted because patch content was unavailable from GitHub or did not fit the review context budget. Large, binary, generated, and lockfile changes are deprioritized.`,
        ...groups,
        '',
        '</details>',
    ].join('\n');
}

/**
 * Build the GitHub comment body for a *failed* review.
 */
export function buildReviewErrorComment(
    label: string,
    model: string,
    errorMessage: string,
): string {
    return (
        `## 🔍 AI Code Review — ${label}\n\n` +
        `❌ **Review failed:** ${errorMessage}\n\n` +
        `<!-- propr:ai-review model="${model}" error="true" -->`
    );
}
