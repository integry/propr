/**
 * GitHub user whitelist — single source of truth.
 *
 * Consumed by the API access gate, the daemon trigger-authorization gate,
 * and the PR-comment command gate. One allowlist (GITHUB_USER_WHITELIST)
 * governs every surface.
 *
 * An empty/unset whitelist means open access. Matching is case-insensitive
 * and tolerant of a trailing "[bot]" suffix.
 */

export function getGithubUserWhitelist(): string[] {
    return (process.env.GITHUB_USER_WHITELIST ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

export function isGithubUserWhitelisted(login: string | undefined | null): boolean {
    const whitelist = getGithubUserWhitelist();
    if (whitelist.length === 0) {
        return true;
    }
    if (!login) {
        return false;
    }
    const exact = login.toLowerCase();
    const normalized = login.replace(/\[bot\]$/i, '').toLowerCase();
    return whitelist.some((entry) => {
        const candidate = entry.toLowerCase();
        return candidate === exact || candidate === normalized;
    });
}
