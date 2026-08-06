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
import type { ReviewAssignment } from './prCommentReviewJob.js';

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

/** Ensure every public S# record visibly carries the non-automation policy. */
export function markSuggestionsNonAutomatic(response: string): string {
    const sectionMatch = /^##[ \t]+Suggestions and Follow-ups(?:[ \t]+.*)?$/im.exec(response);
    if (!sectionMatch) return response;

    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const afterStart = response.slice(sectionStart);
    const nextSection = /^##\s+/m.exec(afterStart);
    const sectionEnd = sectionStart + (nextSection?.index ?? afterStart.length);
    let section = response.slice(sectionStart, sectionEnd);

    const recordHeading = /^###[ \t]+S\d+[ \t]*(?::|[-—])[ \t]*.+$/gim;
    const matches = [...section.matchAll(recordHeading)];
    for (let index = matches.length - 1; index >= 0; index--) {
        const match = matches[index];
        const bodyStart = (match.index ?? 0) + match[0].length;
        const bodyEnd = matches[index + 1]?.index ?? section.length;
        const body = section.slice(bodyStart, bodyEnd);
        const autoFixLine = /^[-*]\s+\*\*auto[- ]?fix:?\*\*\s*:?.*$/im;
        if (autoFixLine.test(body)) {
            const normalizedBody = body.replace(autoFixLine, '- **autoFix:** false');
            section = section.slice(0, bodyStart) + normalizedBody + section.slice(bodyEnd);
        } else {
            section = section.slice(0, bodyStart) + '\n- **autoFix:** false' + section.slice(bodyStart);
        }
    }

    return response.slice(0, sectionStart) + section + response.slice(sectionEnd);
}

/**
 * Build the GitHub comment body for a successful review.
 *
 * Structure:
 *   1. Header with model label.
 *   2. The LLM response (which contains Overall Evaluation, Findings, Score).
 *   3. Review Details metadata block (model, time, tokens).
 *   4. A short instruction telling the user about /fix.
 *   5. A hidden HTML marker for machine detection.
 */
export function buildReviewComment(
    assignment: ReviewAssignment,
    analysisResult: AnalysisResult,
    taskUrl?: string,
    options: { omittedDiffFiles?: string[]; costUsd?: number | null } = {},
): string {
    const { model, label } = assignment;
    const { response, executionTimeMs, tokenUsage, modelUsed } = analysisResult;

    const effectiveModel = modelUsed || model;
    const modelDisplayName = getModelName(effectiveModel);

    let comment = `## 🔍 AI Code Review — ${label}\n\n`;
    comment += markSuggestionsNonAutomatic(response);

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
    if (taskUrl) {
        comment += `\n[View Task](${taskUrl})`;
    }
    if (options.omittedDiffFiles && options.omittedDiffFiles.length > 0) {
        comment += formatOmittedDiffFilesForComment(options.omittedDiffFiles);
    }

    // --- /fix instructions ---
    comment += `\n\n---\n`;
    comment += `> 💡 **Next step:** Comment \`/fix\` to address actionable F# blockers only.\n`;
    comment += `> Explicit IDs such as \`/fix F1 F3\` refer to the newest review. Suggestions are \`autoFix: false\` and require a separate ordinary follow-up request.\n`;

    // --- Machine-readable marker ---
    comment += `\n\n<sub>\u{1F916} Review by [ProPR](https://propr.dev)</sub>`;
    comment += `\n<!-- propr:ai-review model="${effectiveModel}" -->`;

    return comment;
}

function formatOmittedDiffFilesForComment(omittedFiles: string[]): string {
    const maxListedFiles = 50;
    const listedFiles = omittedFiles.slice(0, maxListedFiles).map(filename => `  - \`${filename}\``).join('\n');
    const remainingCount = omittedFiles.length - maxListedFiles;
    const remainingNote = remainingCount > 0 ? `\n  - ...and ${remainingCount} more` : '';

    return [
        '',
        '',
        '<details>',
        '<summary>Files omitted from review diff</summary>',
        '',
        `${omittedFiles.length} file${omittedFiles.length === 1 ? ' was' : 's were'} omitted from the prompt diff due to the review context budget. Large, binary, generated, and lockfile changes are deprioritized.`,
        '',
        listedFiles,
        remainingNote,
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
