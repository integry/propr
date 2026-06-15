/**
 * Review prompt builder helpers.
 *
 * Builds the system/user prompt sent to the LLM when running a /review command.
 * The prompt enforces a structured response shape so that the output is
 * machine-parseable by the /fix pipeline later.
 */

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
     * The mandatory structured output sections (Overall Evaluation, Findings,
     * and the `Score: N/10` line) are always appended regardless of the
     * override, because the /fix gatherer and ultrafix score extraction depend
     * on that exact format. An empty/undefined value uses the built-in default.
     */
    reviewPromptOverride?: string;
}

/**
 * Default high-level review guidance. This is the only part of the task block
 * the `pr_review_prompt` override replaces — the structured sections below it
 * are always preserved.
 */
const DEFAULT_REVIEW_GUIDANCE = `Perform a thorough code review of this pull request based on the CURRENT diff. Your response MUST contain exactly the following three sections with the headers shown below. Do not omit any section.`;

/**
 * Fixed transition appended after an operator override. It re-establishes the
 * structured output contract as a non-negotiable system requirement so the
 * model does not treat the mandatory sections below as part of the (possibly
 * markdown-structured or format-conflicting) operator guidance. This is only
 * inserted when an override is active — the default guidance already states
 * the contract inline.
 */
const REVIEW_OUTPUT_CONTRACT_TRANSITION = `Regardless of the guidance above, you MUST use the exact output format specified below. The following three sections (Overall Evaluation, Findings, and the final \`Score: N/10\` line) are mandatory and may not be omitted, renamed, or reordered.`;

/**
 * Build the review prompt that is sent to the reviewing model.
 *
 * The prompt requires the model to return:
 *   1. Overall Evaluation — high-level assessment of the PR.
 *   2. Findings — issues/suggestions grouped by severity.
 *   3. Score — a 1-10 numeric score with justification.
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
Your response MUST contain exactly three markdown sections, in this order:
1. \`## Overall Evaluation\`
2. \`## Findings\` — every finding prefixed with a severity emoji (🔴 / 🟡 / 🟢 / ✅)
3. \`## Score\` — ending with the exact line \`Score: N/10\`
Do not omit any section; the **Score** section is mandatory. The detailed instructions for each section appear at the very end of this prompt — follow them exactly. (This format is restated here because the diff below can be long.)

**PR Comment History and Context:**
${commentHistory}${originalTaskSpec}
${diffSection}${fileContentsSection}
**Review Request:**
${combinedCommentBody}

${instructions ? `**Additional Review Instructions:**\n${instructions}\n\n` : ''}**IMPORTANT:** The comment history above may reference issues that have since been fixed in subsequent commits. Always verify against the actual PR diff shown above before reporting an issue. If an earlier comment mentions a problem but the diff shows it has been addressed, do NOT report it as a current issue.

**YOUR TASK:**
${taskGuidance}

## Overall Evaluation
Provide a concise summary of the PR's purpose, approach, and overall quality. State whether the PR is ready to merge, needs minor changes, or needs significant rework.

## Findings
List **ALL** issues, concerns, and suggestions you identify — do not limit yourself to just the top 3 or most important ones. Be exhaustive and thorough. Organise them by severity using the markers below. Each finding MUST start with the severity emoji, include a short title, and reference file names / line numbers where applicable.

- 🔴 **Critical** — Bugs, security issues, data loss risks, correctness problems
- 🟡 **Warning** — Performance concerns, potential edge cases, maintainability issues
- 🟢 **Suggestion** — Style improvements, minor optimisations, best practices
- ✅ **Positive** — Things done well that should be called out

Include every finding you discover, regardless of how minor. A comprehensive review is more valuable than a brief one. If there are no findings at a given severity level, omit that level (but you must include at least one finding overall).

## Score
Rate the PR on a scale of **1 – 10** using the format: **Score: N/10**
Follow the score with a one- or two-sentence justification.

Be constructive and specific. Reference file names and line numbers when possible.
Do NOT modify any files. This is a read-only review.`;

    return prompt;
}
