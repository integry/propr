/**
 * Default high-level review guidance for the `/review` command.
 *
 * This is the single source of truth for the *overridable* portion of the
 * review prompt — the part the operator-configurable `pr_review_prompt` setting
 * replaces. It is consumed in two places:
 *   - the review prompt builder (`buildReviewPrompt`) uses it at review time
 *     whenever no override has been configured, and
 *   - the Settings UI prefills the `pr_review_prompt` field with it so operators
 *     can see exactly what the override replaces before editing it.
 *
 * The mandatory structured output sections (Overall Evaluation, Actionable
 * Findings, Suggestions and Follow-ups, and the final `Score: N/10` line) are
 * NOT part of this guidance — they are always appended by the builder
 * regardless of any override, because the /fix gatherer and ultrafix score
 * extraction depend on that exact format.
 */
export const DEFAULT_REVIEW_GUIDANCE = `Review only behavior added, changed, or newly exposed by this pull request. Validate both the original objective and the correctness and safety invariants of the changed behavior; a regression introduced by the diff remains a merge blocker even when the original objective did not enumerate that invariant. Do not classify pre-existing limitations, general hardening opportunities, or adjacent architectural improvements as merge blockers. Report those separately as suggestions. A broad redesign is actionable only when the current pull request cannot be made correct with a localized fix. Your response MUST contain exactly the four sections specified below.`;
