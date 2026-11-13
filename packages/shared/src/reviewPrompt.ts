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
export const DEFAULT_REVIEW_GUIDANCE = `Review only behavior added, changed, or newly exposed by this pull request. Validate both the original objective and the correctness and safety invariants of the changed behavior; a regression introduced by the diff remains a merge blocker even when the original objective did not enumerate that invariant. Do not classify pre-existing limitations, general hardening opportunities, or adjacent architectural improvements as merge blockers. Report those separately as suggestions. Check whether newly added helpers, functions or modules duplicate code the repository already has, and flag a duplicate under the \`complexity\` category when the review uses that category. A broad redesign is actionable only when the current pull request cannot be made correct with a localized fix. Also compare the size and shape of the change with the effective objective, using the change size given above. Flag unrequested complexity as a blocker with category \`complexity\`: new abstractions, generic retry, validation, or configuration layers, and options nobody asked for; support for platforms, databases, or environments the product does not target; and a diff much larger than the effective objective implies. Flag as category \`requirement\` a change that delivers a reduced or placeholder version of what was asked while reporting it as done, such as stubbed code, skipped or deleted tests, or an implementation described as temporary or "for now". Purely stylistic points belong in Suggestions; a blocker may use category \`style\` only when it violates an explicit repository rule, which its evidence must cite. Your response MUST contain exactly the four sections specified below.`;
