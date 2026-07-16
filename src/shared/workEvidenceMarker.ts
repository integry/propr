/**
 * Stable machine-readable evidence embedded in ProPR's GitHub comments.
 * Visible copy may be customized freely; Connect reads only this bounded marker.
 */
export function buildWorkEvidenceMarker(
    phase: 'started' | 'completed' | 'failed',
    commentIds: readonly number[],
): string {
    const ids = [...new Set(commentIds)]
        .filter(id => Number.isSafeInteger(id) && id > 0)
        .slice(0, 100);
    return ids.length > 0
        ? `<!-- propr:work-evidence phase=${phase} trigger-comment-ids=${ids.join(',')} -->`
        : '';
}
