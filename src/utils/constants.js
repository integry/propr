export const PENDING_PR_COMMENTS_KEY_PREFIX = 'pending-pr-comments';

export function getPendingPrCommentsKey(owner, repo, prNumber) {
    return `${PENDING_PR_COMMENTS_KEY_PREFIX}:${owner}:${repo}:${prNumber}`;
}
