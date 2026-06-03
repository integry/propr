import { isIP } from 'net';
import type { AllowedRedirectHost } from './authTypes.js';

function isValidHostname(hostname: string): boolean {
    if (!hostname || hostname.length > 253 || hostname.includes('..')) return false;
    if (hostname === 'localhost') return true;
    if (isIP(hostname)) return true;
    return hostname
        .split('.')
        .every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function normalizeHostname(hostname: string): string {
    return hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

function parseHostname(value: string): string | null {
    const normalizedValue = value.trim().replace(/^(https?:\/\/)\./i, '$1').replace(/^\./, '');
    try {
        const hostname = normalizeHostname(new URL(normalizedValue).hostname);
        return isValidHostname(hostname) ? hostname : null;
    } catch {
        try {
            const hostname = normalizeHostname(new URL(`https://${normalizedValue}`).hostname);
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
    const normalized = normalizeHostname(hostname);
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

// HTTPS is required for all non-local redirect targets. HTTP is only permitted
// for localhost/127.0.0.1/::1 to support local development. Internal or preview
// deployments using HTTP hostnames must either use HTTPS or be accessed via a
// loopback address.
//
// Note: the allowlist validates hostnames only — all ports on an allowed host
// are trusted. This is intentional for environments where the same host serves
// multiple services on different ports (e.g. API on :4000, UI on :5173).
export function getValidatedRedirectTo(redirectTo: string | undefined): string | undefined {
    if (!redirectTo) return undefined;
    try {
        const url = new URL(redirectTo);
        const hostname = normalizeHostname(url.hostname);
        if (url.protocol === 'https:' && isAllowedRedirectHost(hostname)) return url.toString();
        if (url.protocol === 'http:' && isLocalHttpRedirectHost(hostname) && isAllowedRedirectHost(hostname)) return url.toString();
    } catch {
        // Invalid URL, ignore.
    }
    return undefined;
}

// Returns a validated FRONTEND_URL for use as a redirect fallback, applying the
// same HTTPS/allowlist rules as getValidatedRedirectTo. Falls back to '/' if
// FRONTEND_URL is unset or does not pass validation (e.g. HTTP on a non-local host).
export function getDefaultRedirectUrl(): string {
    const frontendUrl = process.env.FRONTEND_URL;
    if (frontendUrl) {
        const target = frontendUrl.endsWith('/') ? frontendUrl : `${frontendUrl}/`;
        const validated = getValidatedRedirectTo(target);
        if (validated) return validated;
    }
    return '/';
}
