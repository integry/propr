/**
 * Review prompt builder helpers.
 *
 * Builds the system/user prompt sent to the LLM when running a /review command.
 * The prompt enforces a structured response shape so that the output is
 * machine-parseable by the /fix pipeline later.
 */

import { DEFAULT_REVIEW_GUIDANCE } from '@propr/shared';

export interface ReviewPromptOptions {
    pullRequestNumber: number;
    combinedCommentBody: string;
    commentHistory: string;
    originalTaskSpec: string;
    repoOwner: string;
    repoName: string;
    instructions?: string;
    /** Formatted PR diff from fetchPRFiles + formatPRDiff */
    prDiff?: string;
    /** Full content of changed files for additional context */
    fileContents?: string;
    /**
     * Operator-configured review prompt (`pr_review_prompt` setting). When
     * non-empty, this replaces the default high-level review guidance line.
     * The mandatory structured output sections (Overall Evaluation, Actionable
     * Findings, Suggestions and Follow-ups, and the `Score: N/10` line) are
     * always appended regardless of the override. An empty/undefined value uses
     * the built-in default.
     */
    reviewPromptOverride?: string;
}

/**
 * The default high-level review guidance lives in `@propr/shared`
 * (`DEFAULT_REVIEW_GUIDANCE`) so the Settings UI can prefill the
 * `pr_review_prompt` field with the exact text the override replaces. It is the
 * only part of the task block the override replaces — the structured sections
 * below it are always preserved.
 */

/**
 * Fixed transition appended after an operator override. It re-establishes the
 * structured output contract as a non-negotiable system requirement so the
 * model does not treat the mandatory sections below as part of the (possibly
 * markdown-structured or format-conflicting) operator guidance. This is only
 * inserted when an override is active — the default guidance already states
 * the contract inline.
 */
const REVIEW_OUTPUT_CONTRACT_TRANSITION = `Regardless of the guidance above, you MUST use the exact output format specified below. The following four sections (Overall Evaluation, Actionable Findings, Suggestions and Follow-ups, and the final \`Score: N/10\` line) are mandatory and may not be omitted, renamed, or reordered. The semantic blocker boundary and required finding fields below override any conflicting operator guidance.`;

/**
 * Build the review prompt that is sent to the reviewing model.
 *
 * The prompt requires the model to return:
 *   1. Overall Evaluation — high-level assessment of the PR.
 *   2. Actionable Findings — verified merge blockers in changed code.
 *   3. Suggestions and Follow-ups — explicitly non-automatic observations.
 *   4. Score — a 1-10 numeric score with justification.
 *
 * These sections are later extracted by `buildReviewComment` to format
 * the GitHub comment, and by the /fix pipeline to gather actionable items.
 */
export function buildReviewPrompt(options: ReviewPromptOptions): string {
    const {
        pullRequestNumber,
        combinedCommentBody,
        commentHistory,
        originalTaskSpec,
        repoOwner,
        repoName,
        instructions,
        prDiff,
        fileContents,
        reviewPromptOverride,
    } = options;

    const overrideActive = !!reviewPromptOverride && reviewPromptOverride.trim() !== '';
    const taskGuidance = overrideActive
        ? `${reviewPromptOverride}\n\n${REVIEW_OUTPUT_CONTRACT_TRANSITION}`
        : DEFAULT_REVIEW_GUIDANCE;

    const diffSection = prDiff
        ? `\n**PR Diff (Current Code Changes):**\nThis diff shows the CURRENT, COMPLETE state of the PR changes included below. Base your review on this actual code, not on what earlier comments may have mentioned. Only treat the review as partial if the diff contains an explicit "files omitted" note; otherwise assume it is complete and do NOT claim it was truncated.\n\n${prDiff}\n`
        : '\n**Note:** No diff available. Review based on available context only.\n';

    const fileContentsSection = fileContents
        ? `\n**Full File Contents (for context):**\nThese are the complete contents of the changed files in the PR. Use this to understand the full context when reviewing the diff - variables, functions, and imports defined elsewhere in the file are visible here.\n\n${fileContents}\n`
        : '';

    const prompt = `You are reviewing pull request #${pullRequestNumber} in ${repoOwner}/${repoName}.

**REQUIRED OUTPUT FORMAT (full details at the end of this prompt):**
Your response MUST contain exactly four markdown sections, in this order:
1. \`## Overall Evaluation\`
2. \`## Actionable Findings\` — structured merge blockers with IDs F1, F2, ...
3. \`## Suggestions and Follow-ups\` — non-blocking items with IDs S1, S2, ...
4. \`## Score\` — ending with the exact line \`Score: N/10\`
Do not omit any section; the **Score** section is mandatory. The detailed instructions for each section appear at the very end of this prompt — follow them exactly. (This format is restated here because the diff below can be long.)

**PR Comment History and Context:**
${commentHistory}${originalTaskSpec ? `**IMMUTABLE ORIGINAL PR OBJECTIVE:**\n${originalTaskSpec}\n` : ''}
${diffSection}${fileContentsSection}
**Review Request:**
${combinedCommentBody}

${instructions ? `**Additional Review Instructions:**\n${instructions}\n\n` : ''}**IMPORTANT:** The comment history above is context, not an expanded specification. The immutable original PR objective remains the review boundary on every cycle. Earlier reviews may reference issues that have since been fixed; verify every report against the actual base-to-head diff shown above. New code added by a fix cycle is still part of that diff and may be reviewed strictly.

**YOUR TASK:**
${taskGuidance}

## Overall Evaluation
Provide a concise summary of the PR's purpose, approach, and overall quality. State whether the PR is ready to merge, needs minor changes, or needs significant rework.

## Actionable Findings
Report only problems that satisfy **all** of these conditions:
- introduced or exposed by this PR;
- violate the immutable original objective or its acceptance criteria;
- are necessary to correct before merge; and
- have evidence in the actual base-to-head changed code.

Use sequential IDs and this exact record shape for every blocker:

### F1: Short title
- **violatedRequirement:** The original requirement or acceptance criterion that is violated
- **evidence:** changed/file.ts:123 — concrete evidence in changed code
- **introducedByPR:** true — why this PR introduced or exposed the problem
- **requiredForMerge:** true
- **minimumCorrection:** the smallest correction necessary to make the PR correct

Every field is mandatory. If you cannot truthfully supply every field, the item is not actionable and belongs in Suggestions and Follow-ups. Do not use a broad redesign as the correction when a localized fix can make the current PR correct. If there are no actionable findings, write \`No actionable findings.\`

## Suggestions and Follow-ups
Put hardening, cleanup, broader architecture, pre-existing issues, optional tests, performance ideas, and alternative designs here. These items are public information but are not merge blockers and must never be presented as required work.

Use sequential IDs and put the complete suggestion in a single heading with no additional record fields:

### S1: Concise description of the optional follow-up

If there are no suggestions, write \`No suggestions.\` Positive observations may be included in the Overall Evaluation instead of being assigned finding IDs.

## Score
Rate the PR on a scale of **1 – 10** using the format: **Score: N/10**
Follow the score with a one- or two-sentence justification.

The score reflects correctness against the immutable objective, regressions introduced by the diff, test coverage for changed behavior, and merge readiness within scope. Suggestions and follow-ups do not reduce the score merely because they remain unimplemented; a merge-ready PR can score 8–9/10 while retaining documented follow-up opportunities.

Be constructive and specific. Reference file names and line numbers when possible.
Do NOT modify any files. This is a read-only review.`;

    return prompt;
}
