/**
 * Identifier grammar for the two kinds of feedback one review publishes.
 *
 * A review emits merge-blocking `## Actionable Findings` as `F1`, `F2`, ... and
 * non-blocking `## Suggestions and Follow-ups` as `S1`, `S2`, ... . A `/fix`
 * request may name either kind, mixed freely. Both the worker (parsing a typed
 * comment line) and the MCP tool (validating a supplied array) resolve
 * identifiers through this module, so the two surfaces cannot drift: one
 * accepting `F007` while the other rejects it is a bug that only appears once a
 * user hits it in production.
 */

/** Canonical published form. The `i` flag accepts lower-case human input. */
export const REVIEW_FINDING_ID_PATTERN = /^F[1-9][0-9]*$/i;
export const REVIEW_SUGGESTION_ID_PATTERN = /^S[1-9][0-9]*$/i;

/**
 * Selector-shaped, valid or not. A token matching this but failing the two
 * patterns above is a typo to report, never prose to keep: reclassifying `S0`
 * as instruction text is how a mistyped request silently becomes an empty one.
 */
export const REVIEW_FEEDBACK_TOKEN_SHAPE = /^[FS]-?[0-9]+$/i;

/**
 * Upper bound on one request. Mirrors the pre-existing `.max(100)` on the MCP
 * tool's `findingIds`, now applied to the combined selection so the ceiling
 * cannot be doubled by splitting a request across both namespaces.
 */
export const MAX_REVIEW_FEEDBACK_SELECTION = 100;

export type ReviewFeedbackKind = 'finding' | 'suggestion';

export interface ReviewFeedbackSelection {
    /** Canonical, de-duplicated, order-preserving. */
    findingIds: string[];
    suggestionIds: string[];
}

/**
 * Canonicalise one token, or return null when it is not an identifier at all.
 * Upper-casing here rather than at each call site means a receipt, a posted
 * comment and a rendered prompt can never disagree about `f20` versus `F20`.
 */
export function normalizeReviewFeedbackId(token: string): { kind: ReviewFeedbackKind; id: string } | null {
    const trimmed = token.trim();
    if (REVIEW_FINDING_ID_PATTERN.test(trimmed)) return { kind: 'finding', id: trimmed.toUpperCase() };
    if (REVIEW_SUGGESTION_ID_PATTERN.test(trimmed)) return { kind: 'suggestion', id: trimmed.toUpperCase() };
    return null;
}

/** Selector-shaped but not a valid identifier, e.g. `S0`, `F007`, `F-1`. */
export function isMalformedReviewFeedbackToken(token: string): boolean {
    const trimmed = token.trim();
    return REVIEW_FEEDBACK_TOKEN_SHAPE.test(trimmed) && normalizeReviewFeedbackId(trimmed) === null;
}

export const emptyReviewFeedbackSelection = (): ReviewFeedbackSelection => ({ findingIds: [], suggestionIds: [] });

export const reviewFeedbackSelectionSize = (selection: ReviewFeedbackSelection): number =>
    selection.findingIds.length + selection.suggestionIds.length;

export const isEmptyReviewFeedbackSelection = (selection: ReviewFeedbackSelection): boolean =>
    reviewFeedbackSelectionSize(selection) === 0;

/**
 * Canonicalise a caller-supplied selection. `invalid` is returned rather than
 * thrown so each surface can phrase its own error: the MCP tool answers with a
 * status code, the comment path posts an explanation on the pull request.
 */
export function canonicalizeReviewFeedbackSelection(
    input: { findingIds?: readonly string[]; suggestionIds?: readonly string[] },
): ReviewFeedbackSelection & { invalid: string[] } {
    const selection = emptyReviewFeedbackSelection();
    const invalid: string[] = [];
    const seen = new Set<string>();
    const take = (token: string, expected: ReviewFeedbackKind) => {
        const resolved = normalizeReviewFeedbackId(token);
        // A finding id supplied under suggestionIds is a caller bug, not a silent
        // reclassification: accepting it would make the receipt lie about scope.
        if (!resolved || resolved.kind !== expected) {
            invalid.push(token.trim());
            return;
        }
        if (seen.has(resolved.id)) return;
        seen.add(resolved.id);
        (resolved.kind === 'finding' ? selection.findingIds : selection.suggestionIds).push(resolved.id);
    };
    for (const token of input.findingIds ?? []) take(token, 'finding');
    for (const token of input.suggestionIds ?? []) take(token, 'suggestion');
    return { ...selection, invalid };
}

/** Command-line form: findings first, then suggestions, e.g. `F20 S3 S5`. */
export const formatReviewFeedbackSelection = (selection: ReviewFeedbackSelection): string =>
    [...selection.findingIds, ...selection.suggestionIds].join(' ');

/**
 * Human-facing form for comments and recaps. Deliberately keeps the two kinds
 * separate so a reader can see at a glance that a blocker was addressed and an
 * optional follow-up was taken on; a flat list would blur exactly the
 * distinction this feature must preserve.
 */
export function describeReviewFeedbackSelection(selection: ReviewFeedbackSelection): string {
    const parts: string[] = [];
    if (selection.findingIds.length) {
        parts.push(`finding${selection.findingIds.length > 1 ? 's' : ''} ${selection.findingIds.join(', ')}`);
    }
    if (selection.suggestionIds.length) {
        parts.push(`suggestion${selection.suggestionIds.length > 1 ? 's' : ''} ${selection.suggestionIds.join(', ')}`);
    }
    return parts.join(' · ');
}
