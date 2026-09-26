/**
 * Strips credentials that Git echoes back inside remote URLs and error output.
 * Kept in a dependency-free module so any Git helper can redact without pulling
 * in GitHub authentication.
 */

// The credential run excludes '/' so a match attempt can never scan past the
// start of the next "https://" prefix. Without that exclusion, output
// containing many repeated "https://x-access-token:" fragments makes the
// engine rescan the remainder of the string from every prefix position, which
// is quadratic in the length of untrusted Git output. URL userinfo cannot
// contain an unencoded '/' anyway, so redaction coverage is unchanged.
const AUTHENTICATED_REMOTE_PATTERN = /https:\/\/x-access-token:[^@\s'"/\\]+@github\.com\//g;
const GITHUB_TOKEN_PATTERN = /\b(?:ghs|ghp|gho|ghu|ghr|github_pat)_[A-Za-z0-9_.-]+/g;

export function redactAuthenticatedGitUrl(message: string): string {
    return message
        .replace(AUTHENTICATED_REMOTE_PATTERN, 'https://x-access-token:[REDACTED]@github.com/')
        .replace(GITHUB_TOKEN_PATTERN, '[REDACTED_GITHUB_TOKEN]');
}
