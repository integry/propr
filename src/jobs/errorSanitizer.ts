import { stripUpstreamPageTitles } from './upstreamPageTitle.js';

/**
 * Names an HTML error page by its status. The page title is the edge's branding
 * ("Attention Required! | Cloudflare", "Unicorn! · GitHub"), not a cause, so it
 * is never published.
 */
function parseGitHubHtmlError(html: string): string {
    if (html.includes('Unicorn')) {
        return 'GitHub API server error (5xx)';
    }
    if (html.includes('rate limit') || html.includes('Rate limit')) {
        return 'GitHub API rate limit exceeded (HTML response)';
    }
    if (html.includes('Not Found') || html.includes('404')) {
        return 'GitHub API resource not found (404)';
    }
    if (html.includes('Bad credentials') || html.includes('401')) {
        return 'GitHub API authentication failed (401)';
    }
    if (html.includes('Forbidden') || html.includes('403')) {
        return 'GitHub API forbidden (403)';
    }
    const status = /\b([45]\d\d)\b/.exec(html.replace(/<[^>]*>/g, ' '))?.[1];
    return status
        ? `GitHub API returned an HTML error page (${status})`
        : 'GitHub API returned an HTML error page instead of JSON';
}

export function sanitizeErrorMessage(message: string | undefined, maxLength = 500): string {
    if (!message) return 'Unknown error';
    const sanitized = message
        .replace(/https:\/\/x-access-token:[^@\s'"]+@github\.com\//g, 'https://x-access-token:[REDACTED]@github.com/')
        .replace(/https:\/\/[^:\s'"]+:[^@\s'"]+@github\.com\//g, 'https://[REDACTED]@github.com/')
        .replace(/\b(?:ghs|ghp|gho|ghu|ghr|github_pat)_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_TOKEN]');
    if (message.includes('<!DOCTYPE html>') || message.includes('<html>')) {
        return parseGitHubHtmlError(sanitized);
    }
    const withoutPageTitles = stripUpstreamPageTitles(sanitized);
    if (withoutPageTitles.length > maxLength) {
        return withoutPageTitles.slice(0, maxLength) + '... [truncated]';
    }
    return withoutPageTitles;
}
