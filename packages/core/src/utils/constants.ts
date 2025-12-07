export const PENDING_PR_COMMENTS_KEY_PREFIX: string = 'pending-pr-comments';

export function getPendingPrCommentsKey(owner: string, repo: string, prNumber: number): string {
    return `${PENDING_PR_COMMENTS_KEY_PREFIX}:${owner}:${repo}:${prNumber}`;
}
