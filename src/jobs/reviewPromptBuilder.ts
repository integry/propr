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
}

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
    } = options;

    const diffSection = prDiff
        ? `\n**PR Diff (Current Code Changes):**\nThis diff shows the CURRENT state of all changes in this PR. Base your review on this actual code, not on what earlier comments may have mentioned.\n\n${prDiff}\n`
        : '\n**Note:** No diff available. Review based on available context only.\n';

    const prompt = `You are reviewing pull request #${pullRequestNumber} in ${repoOwner}/${repoName}.

**PR Comment History and Context:**
${commentHistory}${originalTaskSpec}
${diffSection}
**Review Request:**
${combinedCommentBody}

${instructions ? `**Additional Review Instructions:**\n${instructions}\n\n` : ''}**IMPORTANT:** The comment history above may reference issues that have since been fixed in subsequent commits. Always verify against the actual PR diff shown above before reporting an issue. If an earlier comment mentions a problem but the diff shows it has been addressed, do NOT report it as a current issue.

**YOUR TASK:**
Perform a thorough code review of this pull request based on the CURRENT diff. Your response MUST contain exactly the following three sections with the headers shown below. Do not omit any section.

## Overall Evaluation
Provide a concise summary of the PR's purpose, approach, and overall quality. State whether the PR is ready to merge, needs minor changes, or needs significant rework.

## Findings
List every issue, concern, or suggestion you identify. Organise them by severity using the markers below. Each finding MUST start with the severity emoji, include a short title, and reference file names / line numbers where applicable.

- 🔴 **Critical** — Bugs, security issues, data loss risks, correctness problems
- 🟡 **Warning** — Performance concerns, potential edge cases, maintainability issues
- 🟢 **Suggestion** — Style improvements, minor optimisations, best practices
- ✅ **Positive** — Things done well that should be called out

If there are no findings at a given severity level, omit that level (but you must include at least one finding overall).

## Score
Rate the PR on a scale of **1 – 10** using the format: **Score: N/10**
Follow the score with a one- or two-sentence justification.

Be constructive and specific. Reference file names and line numbers when possible.
Do NOT modify any files. This is a read-only review.`;

    return prompt;
}
