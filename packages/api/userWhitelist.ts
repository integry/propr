/**
 * Dashboard/CLI access whitelist.
 *
 * Gates who may authenticate to the API (web session or CLI bearer token),
 * using the same GITHUB_USER_WHITELIST source as the PR-comment command gate
 * (packages/core/src/utils/commentFilters.ts) so "added in ProPR settings"
 * controls every surface consistently.
 *
 * Semantics: an empty/unset whitelist means access is open (unchanged behavior).
 * Matching is case-insensitive and tolerant of a trailing "[bot]" suffix, so
 * whitelisting "my-bot" also matches "my-bot[bot]". This matches the daemon-side
 * whitelist (packages/core/src/utils/userWhitelist.ts).
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
  const exact = username.toLowerCase();
  const normalized = username.replace(/\[bot\]$/i, '').toLowerCase();
  return whitelist.some((entry) => {
    const candidate = entry.toLowerCase();
    return candidate === exact || candidate === normalized;
  });
}
