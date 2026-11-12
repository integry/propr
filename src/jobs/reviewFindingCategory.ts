/**
 * Closed vocabulary that says what kind of problem a merge blocker is.
 *
 * Reviewers state a category on every F# record. Records published before the
 * category existed carry none and are read as `correctness`, the class every
 * blocker implicitly belonged to then.
 */

export const REVIEW_FINDING_CATEGORIES = [
    'correctness',
    'requirement',
    'security',
    'tests',
    'complexity',
    'style',
] as const;

export type ReviewFindingCategory = typeof REVIEW_FINDING_CATEGORIES[number];

/** The category of a record that does not state one. */
export const DEFAULT_REVIEW_FINDING_CATEGORY: ReviewFindingCategory = 'correctness';

export type ReviewFindingCategoryCounts = Record<ReviewFindingCategory, number>;

/**
 * Normalize a record's category value. A missing or empty value is the
 * default category; a value outside the vocabulary returns null so the record
 * is rejected instead of silently reclassified. Case and surrounding inline
 * code or emphasis markers are ignored, e.g. `` `Style` `` is `style`.
 */
export function parseReviewFindingCategory(value: string | undefined): ReviewFindingCategory | null {
    const normalized = (value ?? '').trim().replace(/^[`*_]+|[`*_.]+$/g, '').trim().toLowerCase();
    if (normalized === '') return DEFAULT_REVIEW_FINDING_CATEGORY;
    return (REVIEW_FINDING_CATEGORIES as readonly string[]).includes(normalized)
        ? normalized as ReviewFindingCategory
        : null;
}

/** Per-category blocker counts, with every category present. */
export function countFindingsByCategory(
    findings: readonly { category?: ReviewFindingCategory }[],
): ReviewFindingCategoryCounts {
    const counts = Object.fromEntries(REVIEW_FINDING_CATEGORIES.map(category => [category, 0])) as ReviewFindingCategoryCounts;
    for (const finding of findings) counts[finding.category ?? DEFAULT_REVIEW_FINDING_CATEGORY] += 1;
    return counts;
}

/** Whether at least one blocker remains and every remaining blocker is stylistic. */
export function hasOnlyStyleFindings(findings: readonly { category?: ReviewFindingCategory }[]): boolean {
    return findings.length > 0 && findings.every(finding => finding.category === 'style');
}
