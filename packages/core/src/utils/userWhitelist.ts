/**
 * Shared GitHub user whitelist check for trigger authorization.
 *
 * Same source (GITHUB_USER_WHITELIST) and semantics as the PR-comment command
 * gate (commentFilters.ts) and the API access gate (packages/api/userWhitelist),
 * so one allowlist governs every trigger surface.
 *
 * An empty/unset whitelist means open access (unchanged behavior). Matching is
 * case-insensitive and tolerant of a trailing "[bot]" suffix.
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
    const normalized = login.replace('[bot]', '').toLowerCase();
    return whitelist.some((entry) => {
        const candidate = entry.toLowerCase();
        return candidate === exact || candidate === normalized;
    });
}
