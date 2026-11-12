import { createHash } from 'node:crypto';
import { normalizeWorkEvidenceCommentIds } from '@propr/shared';

/** Authors of requests ProPR queued itself: Ultrafix steps and escalated validation follow-ups. */
const SYNTHETIC_COMMENT_AUTHORS = new Set(['propr-ultrafix', 'propr-escalation']);

/** A request ProPR queued itself; it does not exist on GitHub. */
export function isSyntheticComment(comment: { author: string }): boolean {
    return SYNTHETIC_COMMENT_AUTHORS.has(comment.author);
}

/** Filter out synthetic comments (a synthetic author, or id=0) */
export function filterRealComments<T extends { author: string; id: number }>(comments: readonly T[]): T[] {
    return comments.filter(comment => !isSyntheticComment(comment) && comment.id !== 0);
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

/** Digest of a GitHub comment body, independent of the line endings it was saved with. */
export function acceptedRequestDigest(body: string): string {
    return createHash('sha256').update(body.replace(/\r\n?/g, '\n')).digest('hex');
}

/**
 * Binds a completed run to the exact comment bodies it accepted. Emitted only
 * on the trailing footer of a completion comment, after the completed marker;
 * a comment without a recorded digest gets no binding.
 */
export function buildAcceptedRequestMarkers(comments: readonly { id: number; acceptedBodySha256?: string }[]): string {
    return comments
        .filter(comment => Number.isSafeInteger(comment.id) && comment.id > 0 && /^[a-f0-9]{64}$/.test(comment.acceptedBodySha256 ?? ''))
        .map(comment => `<!-- propr:accepted-request comment-id=${comment.id} body-sha256=${comment.acceptedBodySha256} -->`)
        .join('\n');
}
