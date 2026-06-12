// URL.hostname returns brackets for IPv6, e.g. '[::1]'.
const LOCALHOST_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Validate a relay URL: must be parseable and use https (http allowed for localhost).
 * Returns an error message string, or `null` when valid.
 */
export function validateRelayUrl(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return `Relay URL ("${url}") is not a valid URL`;
    }
    const isLocalhost = LOCALHOST_HOSTS.includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
        return 'Relay URL must use https:// (http is only allowed for localhost)';
    }
    return null;
}
