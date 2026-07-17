export function normalizeWorkEvidenceCommentIds(commentIds: readonly number[]): number[] {
  return [...new Set(commentIds)]
    .filter(id => Number.isSafeInteger(id) && id > 0)
    .slice(0, 100);
}
