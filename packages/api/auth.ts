import passport from 'passport';
import { Strategy as GitHubStrategy, Profile } from 'passport-github2';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import type { Express, Request, Response, NextFunction } from 'express';
import { logger, withNotificationDeadline } from '@propr/core';
import { validateGitHubToken } from './authBearer.js';
import { configureDemoMode, getDemoUser, isDemoMode } from './demoMode.js';
import { clearSessionForReauth, isGitHubTokenExpired, refreshGitHubTokenWithResult } from './authGithubTokens.js';
import { getValidatedRedirectTo, getDefaultRedirectUrl } from './authRedirect.js';
import { isUserWhitelisted } from './userWhitelist.js';
import type { GitHubUser } from './authTypes.js';
import { getSessionAuthGeneration } from './authSessionGeneration.js';
import { authenticatedUserResponse, resolveAuthorization } from './authorization.js';
import { createSessionRedisClient } from './serverRuntime.js';
import './authTypes.js';

export { refreshGitHubTokenIfNeeded } from './authGithubTokens.js';
export type { GitHubUser } from './authTypes.js';

export interface AuthLifecycleHooks {
    invalidateNotificationEntitlements?: (userId: string, authGeneration: string) => Promise<void>;
    activateNotificationEntitlements?: (userId: string, authGeneration: string) => Promise<void>;
    updateNotificationCredential?: (
        userId: string,
        accessToken: string,
        authGeneration: string
    ) => void;
}

const AUTH_ENTITLEMENT_INVALIDATION_TIMEOUT_MS = 5_000;

async function invalidateRequestEntitlements(
    req: Request,
    lifecycleHooks: AuthLifecycleHooks
): Promise<void> {
    const userId = req.user?.id;
    if (!userId || !lifecycleHooks.invalidateNotificationEntitlements) return;
    const authGeneration = getSessionAuthGeneration(req);
    await withNotificationDeadline(
        lifecycleHooks.invalidateNotificationEntitlements(userId, authGeneration),
        AUTH_ENTITLEMENT_INVALIDATION_TIMEOUT_MS,
        'persisting notification entitlement invalidation'
    );
}

async function invalidateBeforeSessionCleanup(
    req: Request,
    res: Response,
    lifecycleHooks: AuthLifecycleHooks
): Promise<boolean> {
    try {
        await invalidateRequestEntitlements(req, lifecycleHooks);
        return true;
    } catch (error) {
        logger.error({
            userId: req.user?.id,
            error: error instanceof Error ? error.message : String(error)
        }, 'Failed to invalidate notification entitlements during session cleanup');
        res.status(503).json({
            error: 'Session cleanup unavailable',
            code: 'AUTH_CLEANUP_UNAVAILABLE',
            message: 'Authorization cleanup could not be persisted. Please retry.'
        });
        return false;
    }
}

function saveSession(req: Request): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        req.session.save(error => error ? reject(error) : resolve());
    });
}

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

export function setupAuth(
    app: Express,
    demoModeAtStartup = isDemoMode(),
    lifecycleHooks: AuthLifecycleHooks = {}
): ReturnType<typeof createEnsureAuthenticated> {
    const appEnsureAuthenticated = createEnsureAuthenticated(lifecycleHooks);
    configureDemoMode(demoModeAtStartup);
    const requiredEnvVars = demoModeAtStartup
        ? ['FRONTEND_URL']
        : ['GH_OAUTH_CLIENT_ID', 'GH_OAUTH_CLIENT_SECRET', 'GH_OAUTH_CALLBACK_URL', 'FRONTEND_URL'];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    if (!demoModeAtStartup) {
        // Create Redis client for session store
        // SESSION_REDIS_HOST allows PR previews to share sessions with main API via host Redis
        const redisClient = createSessionRedisClient();
        redisClient.on('error', (err) => {
            logger.error({ error: err instanceof Error ? err.message : String(err) },
                'Session Redis client error');
        });
        redisClient.connect().catch((error) => {
            logger.error({ error: error instanceof Error ? error.message : String(error) },
                'Failed to connect session Redis client');
        });

        // Use Redis store for sessions to share across subdomains
        const redisStore = new RedisStore({ client: redisClient, prefix: 'propr:session:' });

        const cookieDomain = getSessionCookieDomain();
        app.use(session({
            store: redisStore,
            secret: process.env.SESSION_SECRET || 'your-secret-key-here',
            resave: false,
            saveUninitialized: false,
            rolling: true, // Extend session expiration on each request
            cookie: {
                secure: shouldUseSecureSessionCookie(cookieDomain),
                httpOnly: true,
                maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
                ...(cookieDomain ? { domain: cookieDomain } : {}),
                sameSite: 'lax'
            }
        }));
        app.use(passport.initialize());
        app.use(passport.session());

        passport.use(new GitHubStrategy({
            clientID: process.env.GH_OAUTH_CLIENT_ID!,
            clientSecret: process.env.GH_OAUTH_CLIENT_SECRET!,
            callbackURL: process.env.GH_OAUTH_CALLBACK_URL!,
        },
        // eslint-disable-next-line max-params
        function verifyCallback(accessToken: string, refreshToken: string, params: { expires_in?: number }, profile: Profile, done: (error: Error | null, user?: GitHubUser) => void) {
            // Here you would find or create a user in your database.
            // For now, we'll just pass the profile through.
            logger.info({ username: profile.username }, 'GitHub user authenticated');

            // Calculate token expiration time (expires_in is in seconds)
            const tokenExpiresAt = params.expires_in ? Date.now() + (params.expires_in * 1000) : undefined;

            const user: GitHubUser = {
                id: profile.id,
                login: profile.username || '',
                username: profile.username || '',
                displayName: profile.displayName,
                email: profile.emails?.[0]?.value || null,
                avatarUrl: profile.photos?.[0]?.value || null,
                accessToken: accessToken,
                refreshToken: refreshToken || undefined,
                tokenExpiresAt: tokenExpiresAt
            };
            return done(null, user);
        }));

        passport.serializeUser((user, done) => done(null, user));
        passport.deserializeUser((obj: Express.User, done) => done(null, obj));
    }

    // Routes
    // Accept optional redirect_to parameter for PR preview environments
    app.get('/api/auth/github', (req: Request, res: Response, next: NextFunction) => {
        const redirectTo = getValidatedRedirectTo(req.query.redirect_to as string | undefined);

        if (demoModeAtStartup) {
            res.redirect(redirectTo || getDefaultRedirectUrl());
            return;
        }

        if (redirectTo) {
            (req.session as session.Session & { redirectTo?: string }).redirectTo = redirectTo;
        }
        passport.authenticate('github', { scope: ['user:email', 'read:org', 'repo'] })(req, res, next);
    });

    if (demoModeAtStartup) {
        app.get('/api/auth/github/callback', (req: Request, res: Response) => {
            const redirectTo = getValidatedRedirectTo(req.query.redirect_to as string | undefined);
            res.redirect(redirectTo || getDefaultRedirectUrl());
        });
    } else {
        app.get('/api/auth/github/callback',
            passport.authenticate('github', { failureRedirect: '/login' }),
            async (req: Request, res: Response) => {
                // Reject logins from users not on the access whitelist, before a
                // session is usable. (No-op when no whitelist is configured.)
                if (!isUserWhitelisted(req.user?.username)) {
                    if (!await invalidateBeforeSessionCleanup(req, res, lifecycleHooks)) return;
                    await clearSessionForReauth(req);
                    clearSessionCookie(res);
                    res.redirect(`${process.env.FRONTEND_URL}/login?error=not_authorized`);
                    return;
                }

                const userId = req.user?.id;
                const authGeneration = userId ? getSessionAuthGeneration(req) : undefined;

                // Persist the authenticated session before activating its durable
                // notification generation. A failed save therefore cannot strand
                // an active generation without a session that can revoke it.
                try {
                    await saveSession(req);
                } catch (error) {
                    logger.error({
                        userId,
                        error: error instanceof Error ? error.message : String(error)
                    }, 'Session save failed after login');
                    await clearSessionForReauth(req);
                    clearSessionCookie(res);
                    res.status(503).json({
                        error: 'Login session unavailable',
                        code: 'AUTH_SESSION_UNAVAILABLE',
                        message: 'Your authenticated session could not be persisted. Please retry login.'
                    });
                    return;
                }

                if (userId && authGeneration && lifecycleHooks.activateNotificationEntitlements) {
                    try {
                        await lifecycleHooks.activateNotificationEntitlements(
                            userId,
                            authGeneration
                        );
                    } catch (error) {
                        logger.error({
                            userId,
                            error: error instanceof Error ? error.message : String(error),
                        }, 'Failed to activate notification entitlements after login');
                        // Activation hooks are expected to be transactional, but
                        // explicitly tombstone the generation in case a custom hook
                        // persisted activation before reporting an error.
                        if (!await invalidateBeforeSessionCleanup(req, res, lifecycleHooks)) return;
                        await clearSessionForReauth(req);
                        clearSessionCookie(res);
                        res.status(503).json({
                            error: 'Login activation unavailable',
                            code: 'AUTH_ACTIVATION_UNAVAILABLE',
                            message: 'Authorization activation could not be persisted. Please retry login.'
                        });
                        return;
                    }
                }

                // Check for stored redirect URL (for PR preview environments)
                const redirectTo = (req.session as session.Session & { redirectTo?: string }).redirectTo;
                if (redirectTo) {
                    // Clear the stored redirect
                    delete (req.session as session.Session & { redirectTo?: string }).redirectTo;
                }

                const finalRedirect = redirectTo || getDefaultRedirectUrl();
                res.redirect(finalRedirect);
            }
        );
    }

    app.get('/api/auth/logout', async (req: Request, res: Response) => {
        if (demoModeAtStartup) {
            res.redirect(`${process.env.FRONTEND_URL}/`);
            return;
        }

        if (!await invalidateBeforeSessionCleanup(req, res, lifecycleHooks)) return;
        await clearSessionForReauth(req);
        clearSessionCookie(res);
        res.redirect(`${process.env.FRONTEND_URL}/login?logged_out=true`);
    });

    app.get('/api/auth/user', appEnsureAuthenticated, resolveAuthorization, (req: Request, res: Response) => {
        if (!req.user || !req.authorization) {
            res.status(500).json({ error: 'Instance authorization was not resolved' });
            return;
        }
        res.json(authenticatedUserResponse(req.user, req.authorization));
    });

    app.get('/api/auth/demo-mode', (_req: Request, res: Response) => {
        res.json({ demoMode: demoModeAtStartup });
    });

    return appEnsureAuthenticated;
}

export function createEnsureAuthenticated(
    lifecycleHooks: AuthLifecycleHooks = {}
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (isDemoMode()) {
            res.set('X-ProPR-Demo-Mode', 'true');
            // Demo mode is deployment-wide: browser callers receive the synthetic read-only user.
            // Stale bearer headers are ignored so public demo visitors are treated consistently.
            (req as Request & { user: GitHubUser }).user = getDemoUser();
            return next();
        }

        return req.isAuthenticated()
            ? authenticateSessionRequest(req, res, next, lifecycleHooks)
            : authenticateBearerRequest(req, res, next);
    };
}

async function authenticateSessionRequest(
    req: Request,
    res: Response,
    next: NextFunction,
    lifecycleHooks: AuthLifecycleHooks
): Promise<void> {
    if (req.user?.githubAuthInvalid) {
        if (!await invalidateBeforeSessionCleanup(req, res, lifecycleHooks)) return;
        await clearSessionForReauth(req);
        clearSessionCookie(res);
        respondGitHubReauthRequired(res);
        return;
    }
    if (!isUserWhitelisted(req.user?.username)) {
        if (!await invalidateBeforeSessionCleanup(req, res, lifecycleHooks)) return;
        await clearSessionForReauth(req);
        clearSessionCookie(res);
        res.status(403).json({ error: 'Forbidden', code: 'USER_NOT_WHITELISTED', message: 'Your GitHub account is not authorized for this ProPR instance. Ask an admin to add you to the user whitelist.' });
        return;
    }
    if (isGitHubTokenExpired(req)) {
        await authenticateExpiredSession(req, res, next, lifecycleHooks);
        return;
    }
    void refreshGitHubTokenWithResult(req).then((result) => {
        const userId = req.user?.id;
        const accessToken = req.user?.accessToken;
        if (result.status === 'refreshed' && userId && accessToken) {
            lifecycleHooks.updateNotificationCredential?.(
                userId,
                accessToken,
                getSessionAuthGeneration(req)
            );
        }
    }).catch((error) => {
        logger.error({ error: error instanceof Error ? error.message : String(error) },
            'Background GitHub token refresh failed');
    });
    next();
}

async function authenticateExpiredSession(
    req: Request,
    res: Response,
    next: NextFunction,
    lifecycleHooks: AuthLifecycleHooks
): Promise<void> {
    const refreshResult = await refreshGitHubTokenWithResult(req, true);
    if (refreshResult.status === 'reauth-required' || req.user?.githubAuthInvalid) {
        if (!await invalidateBeforeSessionCleanup(req, res, lifecycleHooks)) return;
        await clearSessionForReauth(req);
        clearSessionCookie(res);
        respondGitHubReauthRequired(res);
        return;
    }
    if (refreshResult.status === 'temporarily-unavailable') {
        res.status(503).json({ error: 'GitHub token refresh unavailable', code: 'GITHUB_TOKEN_REFRESH_UNAVAILABLE', message: 'GitHub authentication could not be refreshed right now. Please retry shortly.' });
        return;
    }
    const userId = req.user?.id;
    const accessToken = req.user?.accessToken;
    if (refreshResult.status === 'refreshed' && userId && accessToken) {
        lifecycleHooks.updateNotificationCredential?.(
            userId,
            accessToken,
            getSessionAuthGeneration(req)
        );
    }
    next();
}

async function authenticateBearerRequest(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    const authHeader = req.headers.authorization;
    if (process.env.ENABLE_BEARER_AUTH === 'false' || !authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    try {
        const user = await validateGitHubToken(authHeader.slice(7));
        if (!user) {
            res.status(401).json({ error: 'Unauthorized: invalid token' });
            return;
        }
        if (!isUserWhitelisted(user.username)) {
            res.status(403).json({ error: 'Forbidden', code: 'USER_NOT_WHITELISTED', message: 'Your GitHub account is not authorized for this ProPR instance. Ask an admin to add you to the user whitelist.' });
            return;
        }
        (req as Request & { user: GitHubUser }).user = user;
        next();
    } catch {
        res.status(401).json({ error: 'Unauthorized: token validation failed' });
    }
}

function respondGitHubReauthRequired(res: Response): void {
    res.status(401).json({
        error: 'GitHub authentication expired',
        code: 'GITHUB_REAUTH_REQUIRED',
        message: 'Your GitHub session has expired. Please log in again.'
    });
}

export const ensureAuthenticated = createEnsureAuthenticated();
