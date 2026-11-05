import type { Request } from 'express';
import { canonicalProprHttpUrlOrigin, isProprLoopbackHostname } from '@propr/shared';
import { getValidatedRedirectTo } from './authRedirect.js';

const OAUTH_START_PATH = '/api/auth/github';
const OAUTH_CALLBACK_PATH = '/api/auth/github/callback';

/** Origin of a configured plain-HTTP loopback callback, or null for every other deployment. */
export function configuredLoopbackCallbackOrigin(callbackUrl: string | undefined): string | null {
    const raw = callbackUrl?.trim() ?? '';
    const origin = canonicalProprHttpUrlOrigin(raw);
    if (!origin) return null;
    const url = new URL(raw);
    if (url.protocol !== 'http:' || !isProprLoopbackHostname(url.hostname)) return null;
    if (url.pathname !== OAUTH_CALLBACK_PATH || url.search || url.hash) return null;
    return origin;
}

function directLoopbackRequestHostname(req: Request): string | null {
    // Forwarded requests belong to a reverse proxy that owns its public origin.
    if (req.headers['x-forwarded-host'] !== undefined || req.headers.forwarded !== undefined) return null;
    const host = req.headers.host;
    if (typeof host !== 'string' || !host) return null;
    const origin = canonicalProprHttpUrlOrigin(`http://${host}/`);
    if (!origin) return null;
    const hostname = new URL(origin).hostname;
    return isProprLoopbackHostname(hostname) ? hostname : null;
}

/**
 * OAuth state is bound to a host-scoped session cookie. When a loopback alias
 * (for example a saved `127.0.0.1` Desktop profile) starts login but the
 * configured callback uses another loopback name (`localhost`), the callback
 * can never see that cookie. Return the same start route on the configured
 * callback origin so state is created where it will be verified. The target
 * origin comes only from validated callback configuration; the request Host
 * only decides whether to move, never where to.
 */
export function loopbackOAuthStartRedirect(req: Request, callbackUrl: string | undefined): string | null {
    const callbackOrigin = configuredLoopbackCallbackOrigin(callbackUrl);
    if (!callbackOrigin) return null;
    const requestHostname = directLoopbackRequestHostname(req);
    if (!requestHostname) return null;
    if (requestHostname.toLowerCase() === new URL(callbackOrigin).hostname.toLowerCase()) return null;

    const target = new URL(OAUTH_START_PATH, callbackOrigin);
    const redirectTo = getValidatedRedirectTo(req.query.redirect_to as string | undefined);
    if (redirectTo) target.searchParams.set('redirect_to', redirectTo);
    return target.toString();
}
