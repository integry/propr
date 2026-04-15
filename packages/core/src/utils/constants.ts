export const PENDING_PR_COMMENTS_KEY_PREFIX: string = 'pending-pr-comments';

export function getPendingPrCommentsKey(owner: string, repo: string, prNumber: number): string {
    return `${PENDING_PR_COMMENTS_KEY_PREFIX}:${owner}:${repo}:${prNumber}`;
}

export const PROCESSED_REVIEW_COMMENTS_KEY_PREFIX: string = 'processed-review-comments';

export function getProcessedReviewCommentsKey(owner: string, repo: string, prNumber: number): string {
    return `${PROCESSED_REVIEW_COMMENTS_KEY_PREFIX}:${owner}:${repo}:${prNumber}`;
}

export const MERGE_CONFLICT_IDEMPOTENCY_PREFIX: string = 'merge-conflict-queued';

export function getMergeConflictIdempotencyKey(params: { owner: string; repo: string; prNumber: number; headSha: string; baseSha: string }): string {
    return `${MERGE_CONFLICT_IDEMPOTENCY_PREFIX}:${params.owner}:${params.repo}:${params.prNumber}:${params.headSha}:${params.baseSha}`;
}
