/**
 * Review prompt builder helpers.
 *
 * Builds the system/user prompt sent to the LLM when running a /review command.
 * The prompt enforces a structured response shape so that the output is
 * machine-parseable by the /fix pipeline later.
 */

import { DEFAULT_REVIEW_GUIDANCE } from '@propr/shared';
import { assemblePRDiff, type PreparedPRDiff } from './prDiffFormatting.js';
import { ReviewTokenEstimator } from './reviewTokenEstimator.js';

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
     * always appended regardless of the override, together with the
     * demonstrated-failure and verification-provenance requirements every
     * blocker must satisfy. An empty/undefined value uses the built-in
     * default.
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
const REVIEW_OUTPUT_CONTRACT_TRANSITION = `Regardless of the guidance above, you MUST use the exact output format specified below. The following four sections (Overall Evaluation, Actionable Findings, Suggestions and Follow-ups, and the final \`Score: N/10\` line) are mandatory and may not be omitted, renamed, or reordered. The semantic blocker boundary, the required finding fields, and the demonstrated-failure and verification-provenance requirements below override any conflicting operator guidance.`;

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
 *
 * Every blocker must also demonstrate its failure — trigger, ordered sequence,
 * observable consequence, why existing guards do not prevent it, and whether
 * the verification was executed or is a static trace / proposed regression.
 * That detail travels inside the existing `evidence` and `minimumCorrection`
 * fields, so the machine contract the parser, publisher and /fix gatherer
 * depend on stays unchanged. Fields may continue on indented lines; the
 * supported continuation syntax described in the prompt mirrors the field
 * grammar documented on `extractRecordFields` in `reviewRecordFields.ts`.
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
        ? `\n**PR Diff (Current Code Changes):**\nThe content below is the current PR diff available to this review. Base your review on this actual code, not on what earlier comments may have mentioned. Treat the review as partial only if the diff contains an explicit notice that files or diff ranges were omitted; otherwise assume it is complete and do NOT claim it was truncated.\n\n${prDiff}\n`
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
4. For each candidate blocker, build the concrete failure sequence required below. A candidate you cannot drive from a reachable trigger to an observable incorrect outcome is not a blocker.
5. Derive the key correctness invariants of the changed behavior and trace each across relevant entry points, state transitions, recovery paths, and cleanup. Check applicable success, refusal, timeout, access-loss, retry, crash, and takeover paths; do not invent scenarios merely to fill this list.
6. For every verified defect, inspect sibling implementations and callers for the same invalid assumption before publishing. For asynchronous stateful code, examine what can change across awaited operations, which authority permits subsequent mutations, and what evidence permits durable obligations to be released. Verify the actual protections instead of assuming that an await loses ownership.
7. Do not stop after the first verified blocker. Complete this related-path audit and report all verified blockers found, without a finding-count limit or quota. Group occurrences that share a root cause and correction, citing every verified affected location; keep independently actionable defects separate. If a material path could not be checked, state that limitation rather than implying exhaustive coverage.
8. Classify only PR-introduced merge requirements as F# findings. Keep pre-existing problems, optional hardening, and adjacent redesigns as S# suggestions. Related-path inspection does not expand the original review boundary or turn speculative external races into blockers.

Do not print this validation pass or turn it into a generic checklist. Report only verified results in the four required sections.

## Overall Evaluation
Provide a concise summary of the PR's purpose, approach, and overall quality. State whether the PR is ready to merge, needs minor changes, or needs significant rework. Explicitly acknowledge verified strengths in the changed implementation using one to three observations in this shape:

✅ **Short title** — Specific evidence of what the PR implements correctly or especially well.

These positive observations are informational and must not receive F# or S# IDs. Do not invent praise. If no positive observation can be verified, state that plainly instead.

## Actionable Findings
Report only problems that satisfy **all** of these conditions:
- introduced or exposed by this PR;
- violate the immutable original objective or its acceptance criteria, **or** make behavior changed by the PR incorrect, unsafe, or internally inconsistent;
- are necessary to correct before merge;
- have evidence in the actual base-to-head changed code. The evidence field must cite an exact changed-file path from the supplied PR diff; findings supported only by unchanged or adjacent files are rejected by the publisher; and
- are demonstrated by a reachable failure sequence with material consequences. Naming a possible race, a theoretical ordering, or an unproven assumption is not a demonstration.

Use sequential IDs and this exact record shape for every blocker:

### F1: Short title
- **violatedRequirement:** The original requirement, acceptance criterion, or correctness/safety invariant of changed behavior that is violated
- **evidence:** \`changed/file.ts:123\` — trigger, ordered failure sequence, observable consequence, why existing protections do not prevent it, and how it was verified
- **introducedByPR:** true — why this PR introduced or exposed the problem
- **requiredForMerge:** true
- **minimumCorrection:** the smallest correction that removes the demonstrated failure

**Field layout.** Start every field on its own unindented \`- **field:**\` line. A field may continue on the following lines when that makes it easier to read: indent every continuation line by two spaces, separate paragraphs with a blank line, and use indented numbered (\`1.\`) or bulleted (\`-\`) lists. Inline code and links are fine. Only unindented \`- **field:**\` lines, \`### F#\` headings, and \`## \` section headings are structural; indented text always belongs to the current field. Any other unindented line inside a finding — an unindented list item, heading, table, or stray paragraph — makes the whole review invalid, so never outdent continuation text. Do not add headings or tables inside a field. Keep simple fields on one line.

**Demonstrated failure — required inside the evidence field.** Show the failure instead of naming its possibility; this is content the evidence must carry, not a per-finding checklist of headings. Start with a concise code reference — the exact changed-file path with line or symbol — then give the ordered failure sequence, then short explanatory paragraphs only where needed. The evidence field must carry: (1) the specific starting conditions or trigger that reach the changed code; (2) the ordered steps that produce the failure, grounded in this diff and the supplied context, written as an indented numbered list (\`1.\`, \`2.\`, \`3.\`) beneath the code reference; (3) the observable user impact, or the incorrect persistent or external state that remains; (4) why the protections already present — validation, locks, leases, heartbeats, transactions, retries, existing tests — do not prevent this exact sequence; and (5) verification provenance, labelled explicitly: \`executed:\` only for a command or test you actually ran during this review, \`static trace:\` for reasoning over the supplied code, \`proposed regression:\` for a scenario you propose but did not run. Executing a test is not required to establish a blocker, but never word an unexecuted scenario as though it had been run. A simple finding may need only a one-line reference, a short sequence, and one sentence; do not pad it.

Acceptable shape and density (shape, not content):

- **evidence:** \`src/jobs/recovery.ts:88\`, \`recoverSuspendedRuns\`

  Static trace:
  1. Cancellation of A succeeds.
  2. B returns an explicit 403, but B's new rerun intent remains.
  3. Someone independently cancels B.
  4. Recovery reruns B despite ProPR's refusal.

  The existing lease guard runs before step 2, so it never observes B's intent. Proposed regression: assert B is not rerun while A remains recoverable.

For a concurrency, race, or interleaving finding, also name the awaited operation or interruption point, what the competing actor does inside that window, and why the interleaving is possible despite the locks, leases, heartbeats, or transactions present in the code. A slow or long-running await alone does not establish that a renewing lease expired or that ownership was lost; do not assume it.

State inside the evidence field any assumption you could not verify. A failure that depends on an unverified assumption, is unreachable from any caller, or has no material consequence is speculative hardening and belongs in Suggestions and Follow-ups.

Judge minimumCorrection against the demonstrated sequence: it must close the demonstrated failure, including verified sibling occurrences of the same root cause, without unrelated redesign. Do not demand atomicity that independent external systems cannot provide — when two independent external APIs cannot be updated as one transaction, separate the avoidable window this PR can close from the residual external race it cannot. That distinction never excuses a practical fencing token, ownership check, or reconciliation step that would have prevented the demonstrated failure.

Every field is mandatory. If you cannot truthfully supply every field, the item is not actionable and belongs in Suggestions and Follow-ups. A PR-introduced correctness, security, data-loss, or contract regression must not be demoted to a suggestion merely because it was absent from the original task wording. Do not use a broad redesign as the correction when a localized fix can make the current PR correct. If there are no actionable findings, write \`No actionable findings.\`

## Suggestions and Follow-ups
Put hardening, cleanup, broader architecture, pre-existing issues, optional tests, performance ideas, and alternative designs here. These items are public information but are not merge blockers and must never be presented as required work.

Use sequential IDs and this exact shape for every suggestion. Keep the title short (ideally 3–8 words), then explain the reasoning in a concise paragraph:

### S1: Short title
Explain why the follow-up would help, what evidence in or around the changed code motivates it, and why it is optional rather than required for merge.

The description is mandatory. Do not add structured fields such as \`summary\` or \`autoFix\`, and do not put the full explanation in the heading.

If there are no suggestions, write \`No suggestions.\` Positive observations may be included in the Overall Evaluation instead of being assigned finding IDs.

## Score
Rate the PR on a scale of **1 – 10**. Provide a one- or two-sentence justification, then end the section with the literal plain-text line Score: N/10; do not wrap that line in bold or other Markdown.

The score reflects correctness against the immutable objective, regressions introduced by the diff, test coverage for changed behavior, current-head check status, and merge readiness within scope. Keep the score consistent with the findings and evaluation:
- **8–10:** no actionable findings and no known current-head check failure; the PR is merge-ready within scope (10 is exceptional).
- **7:** no verified code blocker, but a current-head check failure or material verification gap prevents calling the PR merge-ready.
- **1–6:** one or more actionable findings remain; use lower scores for broader or more severe required corrections.

Suggestions and follow-ups do not reduce the score merely because they remain unimplemented. Pending checks alone do not impose a score cap, although merge readiness may be stated as conditional on their completion.

Be constructive and specific. Reference file names and line numbers when possible.
Do NOT modify any files. This is a read-only review.`;

    return prompt;
}

const TRUNCATION_MARKER = '\n\n[Context truncated to fit the PR review context budget.]';
const PR_DIFF_TRUNCATION_MARKER = '\n\n[PR diff truncated to fit the PR review context budget. Files or diff ranges were omitted by the review budget, so this review is partial.]';

type TrimmableKey = 'relatedContext' | 'commentHistory' | 'fileContents' | 'prDiff' | 'originalTaskSpec'
    | 'combinedCommentBody' | 'instructions' | 'reviewPromptOverride';

/**
 * Trimming order. Redundant context (scout excerpts, comment history, copies of
 * whole changed files) goes first; the changed-code diff next; the objective,
 * review request and operator instructions only once everything else is gone.
 */
const TRIM_ORDER: ReadonlyArray<readonly [TrimmableKey, string]> = [
    ['relatedContext', 'related unchanged context'],
    ['commentHistory', 'comment history'],
    ['fileContents', 'changed file contents'],
    ['prDiff', 'PR diff'],
    ['originalTaskSpec', 'original PR objective'],
    ['combinedCommentBody', 'review request'],
    ['instructions', 'additional review instructions'],
    ['reviewPromptOverride', 'review prompt override'],
];

// Slack per assembled section for tokenizer merges across section boundaries.
const SECTION_BOUNDARY_SLACK_TOKENS = 4;
const MAX_FIT_ATTEMPTS = 4;

export interface ReviewPromptBudgetOptions {
    /**
     * Untrimmed diff shared by all reviewers. When supplied, whole files are
     * selected in review-priority order to fit this reviewer's budget and
     * `options.prDiff` is ignored.
     */
    preparedDiff?: PreparedPRDiff;
    /** Token estimator for the routed reviewer. Defaults to the most conservative profile. */
    estimator?: ReviewTokenEstimator;
}

export interface ReviewPromptSectionTrim {
    section: string;
    originalTokens: number;
    keptTokens: number;
}

export interface ReviewPromptBudgetResult {
    prompt: string;
    /** Estimated tokens of the prompt plus the analysis runtime suffix. */
    estimatedTokens: number;
    truncatedSections: string[];
    trimmedSections: ReviewPromptSectionTrim[];
    /** Estimated tokens per section in the final prompt ('scaffold' is the fixed instructions). */
    sectionTokens: Record<string, number>;
    prDiffTruncated: boolean;
    /** Diff files with patch content that did not fit this reviewer's budget. */
    budgetOmittedFiles: string[];
    /** Diff files GitHub returned without patch content. */
    missingPatchFiles: string[];
    /** Diff files dropped by the diff size I/O guard. */
    ioGuardOmittedFiles: string[];
}

interface BudgetSelection {
    mutable: ReviewPromptOptions;
    trimmedSections: ReviewPromptSectionTrim[];
    prDiffTruncated: boolean;
    budgetOmittedFiles: string[];
    sectionTokens: Record<string, number>;
    trimmableRemaining: boolean;
}

interface SelectionInputs {
    options: ReviewPromptOptions;
    analysisPromptSuffix: string;
    estimator: ReviewTokenEstimator;
    preparedDiff?: PreparedPRDiff;
}

/** Whole diff files, in review-priority order, whose estimated cost fits `allowance`. */
function selectDiffFiles(
    preparedDiff: PreparedPRDiff,
    allowance: number,
    estimator: ReviewTokenEstimator,
): { diff: string; budgetOmittedFiles: string[] } {
    const selected = new Set<string>();
    // Upper bound for the summary and omission note: every file omitted.
    let used = estimator.estimate(assemblePRDiff(preparedDiff, selected).diff, { cache: false });
    if (used > allowance) {
        return { diff: PR_DIFF_TRUNCATION_MARKER, budgetOmittedFiles: preparedDiff.files.map(file => file.filename) };
    }
    for (const file of preparedDiff.files) {
        const cost = estimator.estimate(file.section) + SECTION_BOUNDARY_SLACK_TOKENS;
        if (used + cost > allowance) continue;
        selected.add(file.filename);
        used += cost;
    }
    const assembled = assemblePRDiff(preparedDiff, selected);
    return { diff: assembled.diff, budgetOmittedFiles: assembled.budgetOmittedFiles };
}

/** Longest chunk-aligned prefix of a text section that fits, with a truncation marker. */
function trimTextSection(key: TrimmableKey, current: string, allowance: number, estimator: ReviewTokenEstimator): string {
    const marker = key === 'prDiff' ? PR_DIFF_TRUNCATION_MARKER : TRUNCATION_MARKER;
    const prefixLength = allowance > 0 ? estimator.fitPrefixLength(current, allowance - estimator.estimate(marker)) : 0;
    if (prefixLength > 0) return `${current.slice(0, prefixLength)}${marker}`;
    return key === 'prDiff' ? PR_DIFF_TRUNCATION_MARKER : '';
}

function selectWithinBudget(inputs: SelectionInputs, target: number): BudgetSelection {
    const { options, analysisPromptSuffix, estimator, preparedDiff } = inputs;
    const mutable: ReviewPromptOptions = { ...options };
    if (preparedDiff) mutable.prDiff = assemblePRDiff(preparedDiff, new Set(preparedDiff.files.map(file => file.filename))).diff;

    const emptied: ReviewPromptOptions = { ...mutable };
    for (const [key] of TRIM_ORDER) emptied[key] = '';
    const scaffoldTokens = estimator.estimate(`${buildReviewPrompt(emptied)}${analysisPromptSuffix}`, { cache: false });
    const wrappers = new Map<TrimmableKey, number>();
    const wrapperTokens = (key: TrimmableKey): number => {
        if (!wrappers.has(key)) {
            const withSection = estimator.estimate(`${buildReviewPrompt({ ...emptied, [key]: '.' })}${analysisPromptSuffix}`, { cache: false });
            wrappers.set(key, Math.max(0, withSection - scaffoldTokens) + SECTION_BOUNDARY_SLACK_TOKENS);
        }
        return wrappers.get(key)!;
    };
    const sectionCost = (key: TrimmableKey, value: string | undefined): number =>
        value ? wrapperTokens(key) + estimator.estimate(value) : 0;

    let total = scaffoldTokens;
    for (const [key] of TRIM_ORDER) total += sectionCost(key, mutable[key]);

    const trimmedSections: ReviewPromptSectionTrim[] = [];
    let budgetOmittedFiles: string[] = [];

    for (const [key, label] of TRIM_ORDER) {
        const current = mutable[key];
        if (total <= target || !current) continue;
        const currentCost = sectionCost(key, current);
        const allowance = currentCost - (total - target) - wrapperTokens(key);
        let next: string;
        if (key === 'prDiff' && preparedDiff) {
            ({ diff: next, budgetOmittedFiles } = selectDiffFiles(preparedDiff, allowance, estimator));
        } else {
            next = trimTextSection(key, current, allowance, estimator);
        }

        mutable[key] = next;
        total += sectionCost(key, next) - currentCost;
        trimmedSections.push({
            section: label,
            originalTokens: estimator.estimate(current),
            keptTokens: next ? estimator.estimate(next) : 0,
        });
    }

    const sectionTokens: Record<string, number> = { scaffold: scaffoldTokens };
    for (const [key] of TRIM_ORDER) {
        if (mutable[key]) sectionTokens[key] = estimator.estimate(mutable[key]!);
    }
    const trimmableRemaining = TRIM_ORDER.some(([key]) => !!mutable[key] && mutable[key] !== PR_DIFF_TRUNCATION_MARKER);
    return {
        mutable,
        trimmedSections,
        prDiffTruncated: trimmedSections.some(trim => trim.section === 'PR diff'),
        budgetOmittedFiles,
        sectionTokens,
        trimmableRemaining,
    };
}

/**
 * Fit the complete review request within the reviewer's input ceiling,
 * including any suffix appended by the analysis runtime. The output contract
 * is always preserved. Optional scout excerpts are reduced first, then
 * historical comments, changed-file copies, and the diff. Scope and request
 * text are protected until those bulk context sections are gone.
 *
 * Section costs are estimated additively; the assembled request is then
 * measured as a whole and, if boundary effects push it over, re-fitted to a
 * lower target. An over-limit request is never returned.
 *
 * @throws when the ceiling cannot hold the mandatory instruction scaffolding
 * even after every trimmable section is removed. The scaffolding is not
 * reducible, so the only alternatives are an explicit failure or an oversized
 * prompt whose substantive review inputs have all been discarded.
 */
export function buildReviewPromptWithinBudget(
    options: ReviewPromptOptions,
    maxContextTokens: number,
    analysisPromptSuffix = '',
    budgetOptions: ReviewPromptBudgetOptions = {},
): ReviewPromptBudgetResult {
    const estimator = budgetOptions.estimator ?? new ReviewTokenEstimator('generic-calibrated');
    const { preparedDiff } = budgetOptions;
    let target = maxContextTokens;
    let estimatedTokens = 0;

    for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt += 1) {
        const selection = selectWithinBudget({ options, analysisPromptSuffix, estimator, preparedDiff }, target);
        const prompt = buildReviewPrompt(selection.mutable);
        estimatedTokens = estimator.estimate(`${prompt}${analysisPromptSuffix}`, { cache: false });
        if (estimatedTokens <= maxContextTokens) {
            return {
                prompt,
                estimatedTokens,
                truncatedSections: selection.trimmedSections.map(trim => trim.section),
                trimmedSections: selection.trimmedSections,
                sectionTokens: selection.sectionTokens,
                prDiffTruncated: selection.prDiffTruncated,
                budgetOmittedFiles: selection.budgetOmittedFiles,
                missingPatchFiles: [...(preparedDiff?.missingPatchFiles ?? [])],
                ioGuardOmittedFiles: [...(preparedDiff?.ioGuardOmittedFiles ?? [])],
            };
        }
        // Every trimmable section is already gone: what remains is the
        // mandatory instruction scaffolding plus the runtime suffix.
        if (!selection.trimmableRemaining) break;
        target -= estimatedTokens - maxContextTokens + SECTION_BOUNDARY_SLACK_TOKENS * TRIM_ORDER.length;
    }

    // Returning the remaining prompt would hand the reviewer an oversized
    // request with the diff, objective, and review request stripped out.
    throw new Error(
        `PR review token budget too small: the mandatory review instructions need at least ${estimatedTokens} estimated tokens, `
        + `but the configured input ceiling is ${maxContextTokens}. Raise the Review context budget percentage or remove the legacy token cap.`,
    );
}
