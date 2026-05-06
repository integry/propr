function parseGitHubHtmlError(html: string): string {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/&middot;/g, '-').replace(/&#\d+;/g, '').trim() : null;

    if (html.includes('Unicorn')) {
        return `GitHub API server error (5xx): ${title || 'Unicorn page'}`;
    }
    if (html.includes('rate limit') || html.includes('Rate limit')) {
        return 'GitHub API rate limit exceeded (HTML response)';
    }
    if (html.includes('Not Found') || html.includes('404')) {
        return `GitHub API resource not found: ${title || '404'}`;
    }
    if (html.includes('Bad credentials') || html.includes('401')) {
        return 'GitHub API authentication failed (401)';
    }
    if (html.includes('Forbidden') || html.includes('403')) {
        return `GitHub API forbidden: ${title || '403'}`;
    }
    if (title) {
        return `GitHub API error: ${title}`;
    }
    return 'GitHub API returned an HTML error page instead of JSON';
}

export function sanitizeErrorMessage(message: string | undefined): string {
    if (!message) return 'Unknown error';
    if (message.includes('<!DOCTYPE html>') || message.includes('<html>')) {
        return parseGitHubHtmlError(message);
    }
    if (message.length > 500) {
        return message.slice(0, 500) + '... [truncated]';
    }
    return message;
}
