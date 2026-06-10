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
    if (parsed.protocol !== 'https:' && !LOCALHOST_HOSTS.includes(parsed.hostname)) {
        return 'Relay URL must use https:// (http is only allowed for localhost)';
    }
    return null;
}
