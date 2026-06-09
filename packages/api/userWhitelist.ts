/**
 * Dashboard/CLI access whitelist.
 *
 * Gates who may authenticate to the API (web session or CLI bearer token),
 * using the same GITHUB_USER_WHITELIST source as the PR-comment command gate
 * (packages/core/src/utils/commentFilters.ts) so "added in ProPR settings"
 * controls every surface consistently.
 *
 * Semantics: an empty/unset whitelist means access is open (unchanged behavior).
 * Matching is case-insensitive (GitHub usernames are unique case-insensitively).
 */

export function getUserWhitelist(): string[] {
  return (process.env.GITHUB_USER_WHITELIST ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isUserWhitelisted(username: string | undefined | null): boolean {
  const whitelist = getUserWhitelist();
  if (whitelist.length === 0) {
    return true;
  }
  if (!username) {
    return false;
  }
  const normalized = username.toLowerCase();
  return whitelist.some((entry) => entry.toLowerCase() === normalized);
}
