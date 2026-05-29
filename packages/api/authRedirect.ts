import type { AllowedRedirectHost } from './authTypes.js';

function isValidHostname(hostname: string): boolean {
    if (!hostname || hostname.length > 253 || hostname.includes('..')) return false;
    if (hostname === 'localhost') return true;
    return hostname
        .split('.')
        .every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function parseHostname(value: string): string | null {
    try {
        const hostname = new URL(value).hostname.replace(/^\./, '');
        return isValidHostname(hostname) ? hostname : null;
    } catch {
        try {
            const hostname = new URL(`https://${value}`).hostname.replace(/^\./, '');
            return isValidHostname(hostname) ? hostname : null;
        } catch {
            return null;
        }
    }
}

function parseAllowedRedirectHost(value: string, includeSubdomainsByDefault = false): AllowedRedirectHost | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const includeSubdomains = includeSubdomainsByDefault || trimmed.startsWith('.') || trimmed.startsWith('*.') || trimmed.startsWith('https://*.') || trimmed.startsWith('http://*.');
    const normalized = trimmed.replace(/^(https?:\/\/)\*\./, '$1').replace(/^\*\./, '');
    const host = parseHostname(normalized);
    return host ? { host, includeSubdomains } : null;
}

function getAllowedRedirectHosts(): AllowedRedirectHost[] {
    const hosts = [
        process.env.FRONTEND_URL ? parseAllowedRedirectHost(process.env.FRONTEND_URL) : null,
        process.env.COOKIE_DOMAIN ? parseAllowedRedirectHost(process.env.COOKIE_DOMAIN, process.env.COOKIE_DOMAIN.trim().startsWith('.')) : null,
        ...(process.env.AUTH_REDIRECT_ALLOWED_HOSTS || '').split(',').map(value => parseAllowedRedirectHost(value))
    ].filter((value): value is AllowedRedirectHost => Boolean(value));
    const uniqueHosts = new Map<string, AllowedRedirectHost>();
    for (const host of hosts) {
        const existing = uniqueHosts.get(host.host);
        uniqueHosts.set(host.host, { host: host.host, includeSubdomains: host.includeSubdomains || existing?.includeSubdomains === true });
    }
    return Array.from(uniqueHosts.values());
}

function isAllowedRedirectHost(hostname: string): boolean {
    return getAllowedRedirectHosts().some(({ host, includeSubdomains }) =>
        hostname === host || (includeSubdomains && hostname.endsWith(`.${host}`))
    );
}

function isLocalHttpRedirectHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function getValidatedRedirectTo(redirectTo: string | undefined): string | undefined {
    if (!redirectTo) return undefined;
    try {
        const url = new URL(redirectTo);
        if (url.protocol === 'https:' && isAllowedRedirectHost(url.hostname)) return redirectTo;
        if (url.protocol === 'http:' && isLocalHttpRedirectHost(url.hostname) && isAllowedRedirectHost(url.hostname)) return redirectTo;
    } catch {
        // Invalid URL, ignore.
    }
    return undefined;
}
