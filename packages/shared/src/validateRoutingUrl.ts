// URL.hostname returns brackets for IPv6, e.g. '[::1]'.
const LOCALHOST_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Validate a PROPR_ROUTING_URL origin. This is the single source of truth for
 * the routing-URL policy, shared by the boot/CLI prerequisite checks
 * (intakeModePrerequisites) and the daemon service that actually dials it
 * (RoutingWebSocketIntakeService), so the two can never disagree.
 *
 * Policy:
 *   - must be a parseable URL
 *   - must use a secure scheme: `wss://` or `https://`
 *     (`ws://`/`http://` is allowed ONLY for localhost development)
 *   - must be a bare ORIGIN — no path/query/fragment — because the service owns
 *     the `/v1/...` paths it appends (connect + payload pull); a configured path
 *     like `wss://routing/v1` would corrupt the derived URLs (`/v1/v1/connect`).
 *
 * Note the `wss://`/`ws://` (and `https://`/`http://`) schemes are all accepted
 * because the service derives both the WebSocket connect URL and the HTTP
 * payload-pull URL from this single value. The default `wss://webhook.propr.dev`
 * is valid under this policy.
 *
 * Returns an error message string, or `null` when valid.
 */
export function validateRoutingUrl(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return `Routing URL ("${url}") is not a valid URL. Set PROPR_ROUTING_URL to a wss:// origin, e.g. wss://webhook.propr.dev.`;
    }
    const scheme = parsed.protocol;
    if (scheme !== 'ws:' && scheme !== 'wss:' && scheme !== 'http:' && scheme !== 'https:') {
        return `Routing URL must use wss:// or https:// (ws://, http:// only for localhost); got "${scheme}//".`;
    }
    const isSecure = scheme === 'wss:' || scheme === 'https:';
    const isLocalhost = LOCALHOST_HOSTS.includes(parsed.hostname);
    if (!isSecure && !isLocalhost) {
        return 'Routing URL must use wss:// or https:// (ws://, http:// is only allowed for localhost).';
    }
    if (parsed.pathname.replace(/\/+$/, '') !== '' || parsed.search || parsed.hash) {
        return `Routing URL must be an origin without a path (e.g. wss://webhook.propr.dev), got "${url}".`;
    }
    return null;
}
