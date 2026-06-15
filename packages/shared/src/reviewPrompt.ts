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
 * The mandatory structured output sections (Overall Evaluation, Findings, and
 * the final `Score: N/10` line) are NOT part of this guidance — they are always
 * appended by the builder regardless of any override, because the /fix gatherer
 * and ultrafix score extraction depend on that exact format.
 */
export const DEFAULT_REVIEW_GUIDANCE = `Perform a thorough code review of this pull request based on the CURRENT diff. Your response MUST contain exactly the following three sections with the headers shown below. Do not omit any section.`;
