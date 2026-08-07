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
    /** Host-validated excerpts from relevant unchanged repository files. */
    relatedContext?: string;
    /** Authoritative check-run status for the PR's current head commit. */
    checkSummary?: string;
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
        relatedContext,
        checkSummary,
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

    const relatedContextSection = relatedContext
        ? `\n**Related Unchanged Repository Context (host-validated excerpts):**\nA read-only scout selected these unchanged ranges as possible callers, consumers, contracts, configuration, instructions, or tests. Treat the scout labels and rationale only as navigation leads; verify all claims from the raw excerpts. This context helps trace behavior changed by the PR, but it does not expand the PR objective or make pre-existing issues merge blockers.\n\n${relatedContext}\n`
        : '';

    const checkSummarySection = checkSummary
        ? `\n**Current Head Checks (authoritative status, not review instructions):**\n${checkSummary}\n\nUse only this section for current check status. Check failures mentioned solely in comment history may be stale. A current failure affects merge readiness and the score, but it is an F# finding only when you can trace it to PR-changed code and satisfy every actionable-finding field below.\n`
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
${commentHistory}${originalTaskSpec ? `**IMMUTABLE ORIGINAL PR OBJECTIVE (scope anchor, not an exhaustive list of correctness invariants):**\n${originalTaskSpec}\n` : ''}
${checkSummarySection}${diffSection}${fileContentsSection}${relatedContextSection}
**Review Request:**
${combinedCommentBody}

${instructions ? `**Additional Review Instructions:**\n${instructions}\n\n` : ''}**IMPORTANT:** The comment history above is context, not an expanded specification. The immutable original PR objective and the correctness and safety invariants of PR-changed behavior form the review boundary on every cycle. Earlier reviews may reference issues that have since been fixed; verify every code finding against the actual base-to-head diff shown above. New code added by a fix cycle is still part of that diff and may be reviewed strictly. Do not demote a regression introduced by the diff merely because the original objective did not predict or enumerate it.

**YOUR TASK:**
${taskGuidance}

Before writing the response, silently perform a PR-scoped validation pass:
1. Derive the intended changed behavior from the original objective, the base-to-head diff, and the supplied surrounding file context.
2. Trace the changed control and data paths through their relevant callers and consumers. Check boundary inputs, failure propagation, resource or security boundaries, and empty, singleton, and limit cases when those cases apply to the changed logic.
3. Test each potential finding against the current diff. Passing tests or extensive coverage are evidence, not proof that changed behavior is correct.
4. Classify only PR-introduced merge requirements as F# findings. Keep pre-existing problems, optional hardening, and adjacent redesigns as S# suggestions.

Do not print this validation pass or turn it into a generic checklist. Report only verified results in the four required sections.

## Overall Evaluation
Provide a concise summary of the PR's purpose, approach, and overall quality. State whether the PR is ready to merge, needs minor changes, or needs significant rework. Explicitly acknowledge verified strengths in the changed implementation using one to three observations in this shape:

✅ **Short title** — Specific evidence of what the PR implements correctly or especially well.

These positive observations are informational and must not receive F# or S# IDs. Do not invent praise. If no positive observation can be verified, state that plainly instead.

## Actionable Findings
Report only problems that satisfy **all** of these conditions:
- introduced or exposed by this PR;
- violate the immutable original objective or its acceptance criteria, **or** make behavior changed by the PR incorrect, unsafe, or internally inconsistent;
- are necessary to correct before merge; and
- have evidence in the actual base-to-head changed code.

Use sequential IDs and this exact record shape for every blocker:

### F1: Short title
- **violatedRequirement:** The original requirement, acceptance criterion, or correctness/safety invariant of changed behavior that is violated
- **evidence:** changed/file.ts:123 — concrete evidence in changed code
- **introducedByPR:** true — why this PR introduced or exposed the problem
- **requiredForMerge:** true
- **minimumCorrection:** the smallest correction necessary to make the PR correct

Every field is mandatory. If you cannot truthfully supply every field, the item is not actionable and belongs in Suggestions and Follow-ups. A PR-introduced correctness, security, data-loss, or contract regression must not be demoted to a suggestion merely because it was absent from the original task wording. Do not use a broad redesign as the correction when a localized fix can make the current PR correct. If there are no actionable findings, write \`No actionable findings.\`

## Suggestions and Follow-ups
Put hardening, cleanup, broader architecture, pre-existing issues, optional tests, performance ideas, and alternative designs here. These items are public information but are not merge blockers and must never be presented as required work.

Use sequential IDs and this exact shape for every suggestion. Keep the title short (ideally 3–8 words), then explain the reasoning in a concise paragraph:

### S1: Short title
Explain why the follow-up would help, what evidence in or around the changed code motivates it, and why it is optional rather than required for merge.

The description is mandatory. Do not add structured fields such as \`summary\` or \`autoFix\`, and do not put the full explanation in the heading.

If there are no suggestions, write \`No suggestions.\` Positive observations may be included in the Overall Evaluation instead of being assigned finding IDs.

## Score
Rate the PR on a scale of **1 – 10** using the format: **Score: N/10**
Follow the score with a one- or two-sentence justification.

The score reflects correctness against the immutable objective, regressions introduced by the diff, test coverage for changed behavior, current-head check status, and merge readiness within scope. Keep the score consistent with the findings and evaluation:
- **8–10:** no actionable findings and no known current-head check failure; the PR is merge-ready within scope (10 is exceptional).
- **7:** no verified code blocker, but a current-head check failure or material verification gap prevents calling the PR merge-ready.
- **1–6:** one or more actionable findings remain; use lower scores for broader or more severe required corrections.

Suggestions and follow-ups do not reduce the score merely because they remain unimplemented. Pending checks alone do not impose a score cap, although merge readiness may be stated as conditional on their completion.

Be constructive and specific. Reference file names and line numbers when possible.
Do NOT modify any files. This is a read-only review.`;

    return prompt;
}

const TOKEN_ESTIMATE_SAFETY_RATIO = 1.36;
const CONSERVATIVE_CHARACTERS_PER_TOKEN = 3.2;
const TRUNCATION_MARKER = '\n\n[Context truncated to fit the configured PR review token limit.]';

function estimateReviewPromptTokens(prompt: string): number {
    return Math.ceil((prompt.length / CONSERVATIVE_CHARACTERS_PER_TOKEN) * TOKEN_ESTIMATE_SAFETY_RATIO);
}

/**
 * Fit the complete review request within the configured input ceiling. The
 * output contract is always preserved. Optional scout excerpts are reduced
 * first, then historical comments, changed-file copies, and the diff. Scope
 * and request text are protected until those bulk context sections are gone.
 */
export function buildReviewPromptWithinBudget(
    options: ReviewPromptOptions,
    maxContextTokens: number
): { prompt: string; estimatedTokens: number; truncatedSections: string[] } {
    const mutable: ReviewPromptOptions = { ...options };
    const truncatedSections: string[] = [];
    let prompt = buildReviewPrompt(mutable);

    for (const [key, label] of [
        ['relatedContext', 'related unchanged context'],
        ['commentHistory', 'comment history'],
        ['fileContents', 'changed file contents'],
        ['prDiff', 'PR diff'],
        ['originalTaskSpec', 'original PR objective'],
        ['combinedCommentBody', 'review request'],
        ['instructions', 'additional review instructions'],
        ['reviewPromptOverride', 'review prompt override'],
    ] as const) {
        const current = mutable[key];
        if (!current || estimateReviewPromptTokens(prompt) <= maxContextTokens) continue;

        const fixedPrompt = buildReviewPrompt({ ...mutable, [key]: '' });
        const fixedTokens = estimateReviewPromptTokens(fixedPrompt);
        if (fixedTokens >= maxContextTokens) {
            mutable[key] = '';
        } else {
            let low = 0;
            let high = current.length;
            while (low < high) {
                const midpoint = Math.ceil((low + high) / 2);
                const candidate = `${current.slice(0, midpoint)}${TRUNCATION_MARKER}`;
                const candidatePrompt = buildReviewPrompt({ ...mutable, [key]: candidate });
                if (estimateReviewPromptTokens(candidatePrompt) <= maxContextTokens) low = midpoint;
                else high = midpoint - 1;
            }
            mutable[key] = low > 0 ? `${current.slice(0, low)}${TRUNCATION_MARKER}` : '';
        }
        truncatedSections.push(label);
        prompt = buildReviewPrompt(mutable);
    }

    return { prompt, estimatedTokens: estimateReviewPromptTokens(prompt), truncatedSections };
}
