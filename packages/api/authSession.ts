import type session from 'express-session';
import type { Request, Response } from 'express';
import { getDefaultRedirectUrl } from './authRedirect.js';
import { isUserWhitelisted } from './userWhitelist.js';

export type AuthSession = session.Session & {
    redirectTo?: string;
    connectOAuthState?: string;
};

export function getSessionCookieDomain(): string | undefined {
    if (process.env.COOKIE_DOMAIN) return process.env.COOKIE_DOMAIN;
    return undefined;
}

export function shouldUseSecureSessionCookie(cookieDomain: string | undefined): boolean {
    try {
        if (process.env.API_PUBLIC_URL) {
            const url = new URL(process.env.API_PUBLIC_URL);
            if (url.protocol === 'https:') return true;
            if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')) return false;
        }
        return process.env.NODE_ENV === 'production' || Boolean(cookieDomain);
    } catch {
        return process.env.NODE_ENV === 'production' || Boolean(cookieDomain);
    }
}

export function clearSessionCookie(res: Response): void {
    const domain = getSessionCookieDomain();
    // Mirror the attributes used when the session cookie is set — browsers match
    // on name/domain/path, but mirroring secure/httpOnly/sameSite is the safer
    // convention.
    res.clearCookie('connect.sid', {
        ...(domain ? { domain } : {}),
        path: '/',
        secure: shouldUseSecureSessionCookie(domain),
        httpOnly: true,
        sameSite: 'lax',
    });
}

export function redirectAuthError(res: Response, error: string): void {
    res.redirect(`${process.env.FRONTEND_URL}/login?error=${encodeURIComponent(error)}`);
}

export function completeAuthenticatedSession(req: Request, res: Response): void {
    if (!isUserWhitelisted(req.user?.username)) {
        req.logout(() => {
            req.session.destroy(() => {
                clearSessionCookie(res);
                redirectAuthError(res, 'not_authorized');
            });
        });
        return;
    }

    const authSession = req.session as AuthSession;
    const finalRedirect = authSession.redirectTo || getDefaultRedirectUrl();
    delete authSession.redirectTo;
    delete authSession.connectOAuthState;
    req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect(finalRedirect);
    });
}
