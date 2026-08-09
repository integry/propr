export const ULTRAFIX_STATE_KEY_PREFIX = 'ultrafix:state';

export function getUltrafixStateKey(owner: string, repo: string, pr: number): string {
    return `${ULTRAFIX_STATE_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}
