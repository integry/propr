/**
 * Upstream services (Cloudflare, load balancers, GitHub) answer some failures
 * with an HTML page, and provider SDKs fold that page's title into the error:
 * "API Error: 403 Attention Required! | Cloudflare". The title is the edge's
 * branding, not a cause; only the status code is worth publishing.
 */

// "<status> <page title> | <service>" — a page title ends with the service name after a bar.
const STATUS_WITH_PAGE_TITLE = /\b([1-5]\d\d)\s+[^\n|]{1,120}?\s*\|\s*(?:Cloudflare|GitHub|nginx|Fastly|Akamai|AWS|Amazon CloudFront)\b[^\n.]*/gi;
// "<status> <title>" followed by an inline HTML document.
const STATUS_WITH_HTML_DOCUMENT = /\b([1-5]\d\d)\b[^\n<]*<(?:!doctype\s+html|html)\b[\s\S]*?(?:<\/html>|$)/gi;
// An inline HTML document without a status code before it.
const HTML_DOCUMENT = /<(?:!doctype\s+html|html)\b[\s\S]*?(?:<\/html>|$)/gi;

/** Replace upstream HTML page titles and inline HTML pages with their status code. */
export function stripUpstreamPageTitles(message: string): string {
    return message
        .replace(STATUS_WITH_HTML_DOCUMENT, (_match, status: string) => `HTTP ${status}`)
        .replace(HTML_DOCUMENT, 'an HTML error page')
        .replace(STATUS_WITH_PAGE_TITLE, (_match, status: string) => `HTTP ${status}`)
        .replace(/\bHTTP (\d{3})\b(?:\s*HTTP \1\b)+/g, 'HTTP $1')
        .trim();
}
