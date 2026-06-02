interface AllowedRedirectHost {
    host: string;
    includeSubdomains: boolean;
}

function parseAllowedRedirectHost(value: string, includeSubdomainsByDefault = false): AllowedRedirectHost | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const includeSubdomains = includeSubdomainsByDefault || trimmed.startsWith('.') || trimmed.startsWith('*.') || trimmed.startsWith('https://*.') || trimmed.startsWith('http://*.');
    const normalized = trimmed.replace(/^(https?:\/\/)\*\./, '$1').replace(/^\*\./, '');
    try {
        return { host: new URL(normalized).hostname.replace(/^\./, ''), includeSubdomains };
    } catch {
        return { host: normalized.replace(/^\./, ''), includeSubdomains };
    }
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

export function getValidatedRedirectTo(redirectTo: string | undefined): string | undefined {
    if (!redirectTo) return undefined;
    try {
        const url = new URL(redirectTo);
        if ((url.protocol === 'https:' || url.protocol === 'http:') && isAllowedRedirectHost(url.hostname)) return redirectTo;
    } catch {
        // Invalid URL, ignore
    }
    return undefined;
}
