import type session from 'express-session';
import type { Request, Response, RequestHandler } from 'express';
import { isProprLoopbackHostname, normalizeProprApiOrigin } from '@propr/shared';
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
            const raw = process.env.API_PUBLIC_URL;
            const url = new URL(raw);
            if (url.protocol === 'https:') return true;
            if (normalizeProprApiOrigin(raw) !== url.origin) {
                return process.env.NODE_ENV === 'production' || Boolean(cookieDomain);
            }
            if (url.protocol === 'http:' && isProprLoopbackHostname(url.hostname)) return false;
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

/** Owns HTTP/Engine.IO admission and every asynchronous session-store operation. */
export class BrowserSessionLifecycle {
    private stopping = false;
    private storeClosed = false;
    private requests = 0;
    private operations = new Set<Promise<unknown>>();
    private drained?: () => void;
    private closing?: Promise<void>;

    readonly middleware: RequestHandler = (req, res, next) => {
        if (this.stopping) { res.statusCode = 503; res.end(); return; }
        // Engine.IO WebSocket upgrades use a response shim without events.
        const completion = typeof res.once === 'function' ? res : req.socket;
        this.requests++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            completion.off('finish', release); completion.off('close', release);
            if (--this.requests === 0) this.drained?.();
        };
        completion.once('finish', release); completion.once('close', release);
        next();
    };

    trackStore(store: session.Store): void {
        // Stores may complete through callbacks, promises, or both.
        for (const name of ['get', 'set', 'touch', 'destroy', 'clear', 'length', 'ids', 'all'] as const) {
            const target = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
            // Store extensions are optional (MemoryStore, for example, has no ids).
            if (typeof target[name] !== 'function') continue;
            const original = target[name].bind(store);
            target[name] = (...args: unknown[]) => {
                if (this.storeClosed) {
                    const error = new Error('Browser sessions are closed');
                    const callback = args.at(-1);
                    if (typeof callback === 'function') { callback(error); return Promise.resolve(); }
                    return Promise.reject(error);
                }
                const callback = args.at(-1);
                let callbackDone: Promise<void> | undefined;
                let settleCallback: (() => void) | undefined;
                if (typeof callback === 'function') {
                    callbackDone = new Promise<void>(resolve => {
                        settleCallback = resolve;
                        args[args.length - 1] = function (this: unknown, ...results: unknown[]) {
                            try { return callback.apply(this, results); }
                            finally { resolve(); }
                        };
                    });
                }
                const result = Promise.resolve().then(() => {
                    try { return original(...args); }
                    catch (error) {
                        // Invocation failed before returning work: no callback is owed.
                        // A returned promise's rejection must still wait for its callback.
                        settleCallback?.();
                        throw error;
                    }
                });
                // Keep the caller's result independent of the drain obligation:
                // a dual API can settle its promise before invoking its callback.
                const operation = Promise.allSettled(callbackDone ? [result, callbackDone] : [result]);
                this.operations.add(operation);
                void operation.then(() => this.operations.delete(operation));
                return result;
            };
        }
    }

    close(disconnect: () => Promise<void>): Promise<void> {
        this.stopping = true;
        return this.closing ??= (async () => {
            if (this.requests) await new Promise<void>(resolve => { this.drained = resolve; });
            // No await between draining admissions and revoking store authority.
            // Aborted responses may still have callbacks: those cannot start Redis work.
            this.storeClosed = true;
            await Promise.allSettled([...this.operations]);
            await disconnect();
        })();
    }
}
