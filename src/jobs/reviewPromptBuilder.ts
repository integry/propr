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
    } = options;

    const prompt = `You are reviewing pull request #${pullRequestNumber} in ${repoOwner}/${repoName}.

**PR Comment History and Context:**
${commentHistory}${originalTaskSpec}

**Review Request:**
${combinedCommentBody}

${instructions ? `**Additional Review Instructions:**\n${instructions}\n\n` : ''}**YOUR TASK:**
Perform a thorough code review of this pull request. Your response MUST contain exactly the following three sections with the headers shown below. Do not omit any section.

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
