import { normalizeWorkEvidenceCommentIds } from '@propr/shared';

/** Filter out ultrafix synthetic comments (author='propr-ultrafix' or id=0) */
export function filterRealComments<T extends { author: string; id: number }>(comments: readonly T[]): T[] {
    return comments.filter(comment => comment.author !== 'propr-ultrafix' && comment.id !== 0);
}

/**
 * Stable machine-readable evidence embedded in ProPR's GitHub comments.
 * Visible copy may be customized freely; Connect reads only this bounded marker.
 */
export function buildWorkEvidenceMarker(
    phase: 'started' | 'completed' | 'failed',
    commentIds: readonly number[],
): string {
    const ids = normalizeWorkEvidenceCommentIds(commentIds);
    return ids.length > 0
        ? `<!-- propr:work-evidence phase=${phase} trigger-comment-ids=${ids.join(',')} -->`
        : '';
}
