/**
 * GitHub user whitelist — single source of truth.
 *
 * Consumed by the API access gate, the daemon trigger-authorization gate,
 * and the PR-comment command gate. One allowlist (GITHUB_USER_WHITELIST)
 * governs every surface.
 *
 * An empty/unset whitelist means open access. Matching is case-insensitive.
 * Bot accounts (trailing "[bot]") require an explicit `name[bot]` entry —
 * a plain `name` entry does NOT match `name[bot]`, preventing a GitHub App
 * whose slug matches a whitelisted username from passing the gate.
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
    const lower = login.toLowerCase();
    return whitelist.some((entry) => entry.toLowerCase() === lower);
}
