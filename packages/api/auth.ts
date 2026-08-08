import passport from 'passport';
import { Strategy as GitHubStrategy, Profile } from 'passport-github2';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import { validateSessionSecret } from '@propr/shared';
import { validateGitHubToken } from './authBearer.js';
import { configureDemoMode, getDemoUser, isDemoMode } from './demoMode.js';
import { clearSessionForReauth, isGitHubTokenExpired, refreshGitHubTokenIfNeeded, refreshGitHubTokenWithResult } from './authGithubTokens.js';
import { getValidatedRedirectTo, getDefaultRedirectUrl } from './authRedirect.js';
import { isUserWhitelisted } from './userWhitelist.js';
import type { GitHubUser } from './authTypes.js';
import {
    authenticatedUserResponse,
    resolveAuthorization,
    resolveInstanceAuthorization,
    type InstanceAuthorization,
} from './authorization.js';
import './authTypes.js';

export { refreshGitHubTokenIfNeeded } from './authGithubTokens.js';
export type { GitHubUser } from './authTypes.js';

export interface SocketAuthMiddlewareBundle {
    /** Express-compatible middleware that must run on the Engine.IO handshake. */
    engineMiddleware: RequestHandler[];
}

export interface SocketPrincipal {
    user: GitHubUser;
    authorization: InstanceAuthorization;
}

export interface SocketAuthenticationDependencies {
    validateToken: typeof validateGitHubToken;
    isWhitelisted: typeof isUserWhitelisted;
    resolveInstanceAuthorization: typeof resolveInstanceAuthorization;
    refreshToken: typeof refreshGitHubTokenWithResult;
}

const defaultSocketAuthenticationDependencies: SocketAuthenticationDependencies = {
    validateToken: validateGitHubToken,
    isWhitelisted: isUserWhitelisted,
    resolveInstanceAuthorization,
    refreshToken: refreshGitHubTokenWithResult,
};

export class SocketAuthenticationError extends Error {
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'SocketAuthenticationError';
    }
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

function clearSessionCookie(res: Response): void {
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

export interface GitHubOAuthStrategyConfig {
    clientID: string;
    clientSecret: string;
    callbackURL: string;
}

export function createGitHubOAuthStrategy(config: GitHubOAuthStrategyConfig): GitHubStrategy {
    return new GitHubStrategy({
        ...config,
        // passport-github2's types narrow the inherited OAuth2 option to a
        // string, but passport-oauth2 uses the boolean form to enable its
        // random, session-backed state store.
        state: true as unknown as string,
    },
    // eslint-disable-next-line max-params
    function verifyCallback(accessToken: string, refreshToken: string, params: { expires_in?: number }, profile: Profile, done: (error: Error | null, user?: GitHubUser) => void) {
        console.log('User authenticated:', profile.username);

        const tokenExpiresAt = params.expires_in ? Date.now() + (params.expires_in * 1000) : undefined;
        const user: GitHubUser = {
            id: profile.id,
            login: profile.username || '',
            username: profile.username || '',
            displayName: profile.displayName,
            email: profile.emails?.[0]?.value || null,
            avatarUrl: profile.photos?.[0]?.value || null,
            accessToken,
            refreshToken: refreshToken || undefined,
            tokenExpiresAt,
        };
        return done(null, user);
    });
}

export function setupAuth(app: Express, demoModeAtStartup = isDemoMode()): SocketAuthMiddlewareBundle {
    configureDemoMode(demoModeAtStartup);
    const requiredEnvVars = demoModeAtStartup
        ? ['FRONTEND_URL']
        : ['GH_OAUTH_CLIENT_ID', 'GH_OAUTH_CLIENT_SECRET', 'GH_OAUTH_CALLBACK_URL', 'FRONTEND_URL'];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    const sessionSecret = process.env.SESSION_SECRET;
    if (!demoModeAtStartup) {
        const sessionSecretError = validateSessionSecret(sessionSecret);
        if (sessionSecretError) throw new Error(sessionSecretError);
    }
    const engineMiddleware: RequestHandler[] = [];

    if (!demoModeAtStartup) {
        // Create Redis client for session store
        // SESSION_REDIS_HOST allows PR previews to share sessions with main API via host Redis
        const sessionRedisHost = process.env.SESSION_REDIS_HOST || process.env.REDIS_HOST || 'redis';
        const sessionRedisPort = process.env.SESSION_REDIS_PORT || process.env.REDIS_PORT || '6379';
        const redisClient = createClient({ url: `redis://${sessionRedisHost}:${sessionRedisPort}` });
        redisClient.on('error', (err) => {
            console.error('Session Redis Client Error', err);
        });
        redisClient.connect().catch(console.error);

        // Use Redis store for sessions to share across subdomains
        const redisStore = new RedisStore({ client: redisClient, prefix: 'propr:session:' });

        const cookieDomain = getSessionCookieDomain();
        const sessionMiddleware = session({
            store: redisStore,
            secret: sessionSecret!,
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
        });
        const passportInitializeMiddleware = passport.initialize();
        const passportSessionMiddleware = passport.session();
        engineMiddleware.push(
            sessionMiddleware,
            passportInitializeMiddleware,
            passportSessionMiddleware,
        );
        app.use(sessionMiddleware);
        app.use(passportInitializeMiddleware);
        app.use(passportSessionMiddleware);

        passport.use(createGitHubOAuthStrategy({
            clientID: process.env.GH_OAUTH_CLIENT_ID!,
            clientSecret: process.env.GH_OAUTH_CLIENT_SECRET!,
            callbackURL: process.env.GH_OAUTH_CALLBACK_URL!,
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
            (req: Request, res: Response) => {
                // Reject logins from users not on the access whitelist, before a
                // session is usable. (No-op when no whitelist is configured.)
                if (!isUserWhitelisted(req.user?.username)) {
                    req.logout(() => {
                        req.session.destroy(() => {
                            clearSessionCookie(res);
                            res.redirect(`${process.env.FRONTEND_URL}/login?error=not_authorized`);
                        });
                    });
                    return;
                }

                // Check for stored redirect URL (for PR preview environments)
                const redirectTo = (req.session as session.Session & { redirectTo?: string }).redirectTo;
                if (redirectTo) {
                    // Clear the stored redirect
                    delete (req.session as session.Session & { redirectTo?: string }).redirectTo;
                }

                const finalRedirect = redirectTo || getDefaultRedirectUrl();

                // Explicitly save session before redirect to ensure cookie is set
                // This is required when using Redis store with async operations
                req.session.save((err) => {
                    if (err) {
                        console.error('Session save error:', err);
                    }
                    res.redirect(finalRedirect);
                });
            }
        );
    }

    app.get('/api/auth/logout', (req: Request, res: Response) => {
        if (demoModeAtStartup) {
            res.redirect(`${process.env.FRONTEND_URL}/`);
            return;
        }

        req.logout((err) => {
            if (err) {
                console.error('Logout error:', err);
            }
            req.session.destroy((sessionErr) => {
                if (sessionErr) {
                    console.error('Session destroy error:', sessionErr);
                }
                clearSessionCookie(res);
                res.redirect(`${process.env.FRONTEND_URL}/login?logged_out=true`);
            });
        });
    });

    app.get('/api/auth/user', ensureAuthenticated, resolveAuthorization, (req: Request, res: Response) => {
        if (!req.user || !req.authorization) {
            res.status(500).json({ error: 'Instance authorization was not resolved' });
            return;
        }
        res.json(authenticatedUserResponse(req.user, req.authorization));
    });

    app.get('/api/auth/demo-mode', (_req: Request, res: Response) => {
        res.json({ demoMode: demoModeAtStartup });
    });

    return { engineMiddleware };
}

/**
 * Authenticate a Socket.IO handshake using the same identities accepted by the
 * HTTP API. Browser clients normally arrive with a Passport session cookie;
 * non-browser clients may provide the normal Authorization: Bearer header.
 */
export async function authenticateSocketRequest(
    req: Request,
    dependencies: SocketAuthenticationDependencies = defaultSocketAuthenticationDependencies,
): Promise<SocketPrincipal> {
    if (req.isAuthenticated?.() && req.user) {
        if (req.user.githubAuthInvalid) {
            throw new SocketAuthenticationError('GITHUB_REAUTH_REQUIRED', 'GitHub authentication expired');
        }

        if (isGitHubTokenExpired(req)) {
            const refreshResult = await dependencies.refreshToken(req, true);
            if (refreshResult.status === 'reauth-required' || req.user.githubAuthInvalid) {
                throw new SocketAuthenticationError('GITHUB_REAUTH_REQUIRED', 'GitHub authentication expired');
            }
            if (refreshResult.status === 'temporarily-unavailable') {
                throw new SocketAuthenticationError(
                    'GITHUB_TOKEN_REFRESH_UNAVAILABLE',
                    'GitHub authentication could not be refreshed',
                );
            }
        }

        if (!dependencies.isWhitelisted(req.user.username)) {
            throw new SocketAuthenticationError('USER_NOT_WHITELISTED', 'GitHub user is not allowed');
        }

        return {
            user: req.user,
            authorization: await dependencies.resolveInstanceAuthorization(req.user),
        };
    }

    const bearerEnabled = process.env.ENABLE_BEARER_AUTH !== 'false';
    const rawAuthHeader = req.headers.authorization;
    const authHeader = Array.isArray(rawAuthHeader) ? rawAuthHeader[0] : rawAuthHeader;
    if (bearerEnabled && authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();
        if (!token) {
            throw new SocketAuthenticationError('INVALID_BEARER_TOKEN', 'Bearer token is empty');
        }
        const user = await dependencies.validateToken(token);
        if (!user) {
            throw new SocketAuthenticationError('INVALID_BEARER_TOKEN', 'Bearer token is invalid');
        }
        if (!dependencies.isWhitelisted(user.username)) {
            throw new SocketAuthenticationError('USER_NOT_WHITELISTED', 'GitHub user is not allowed');
        }
        return {
            user,
            authorization: await dependencies.resolveInstanceAuthorization(user),
        };
    }

    throw new SocketAuthenticationError('AUTHENTICATION_REQUIRED', 'Authentication required');
}

export async function ensureAuthenticated(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (isDemoMode()) {
        res.set('X-ProPR-Demo-Mode', 'true');
        // Demo mode is deployment-wide: browser callers receive the synthetic read-only user.
        // Stale bearer headers are ignored so public demo visitors are treated consistently.
        (req as Request & { user: GitHubUser }).user = getDemoUser();
        return next();
    }

    // Session-based auth (Passport)
    if (req.isAuthenticated()) {
        if (req.user?.githubAuthInvalid) {
            await clearSessionForReauth(req);
            res.status(401).json({ error: 'GitHub authentication expired', code: 'GITHUB_REAUTH_REQUIRED', message: 'Your GitHub session has expired. Please log in again.' });
            return;
        }

        if (!isUserWhitelisted(req.user?.username)) {
            req.logout(() => {
                req.session.destroy(() => {
                    clearSessionCookie(res);
                    res.status(403).json({ error: 'Forbidden', code: 'USER_NOT_WHITELISTED', message: 'Your GitHub account is not authorized for this ProPR instance. Ask an admin to add you to the user whitelist.' });
                });
            });
            return;
        }

        if (isGitHubTokenExpired(req)) {
            const refreshResult = await refreshGitHubTokenWithResult(req, true);
            if (refreshResult.status === 'reauth-required' || req.user?.githubAuthInvalid) {
                if (req.user?.githubAuthInvalid) await clearSessionForReauth(req);
                res.status(401).json({ error: 'GitHub authentication expired', code: 'GITHUB_REAUTH_REQUIRED', message: 'Your GitHub session has expired. Please log in again.' });
                return;
            }
            if (refreshResult.status === 'temporarily-unavailable') {
                res.status(503).json({ error: 'GitHub token refresh unavailable', code: 'GITHUB_TOKEN_REFRESH_UNAVAILABLE', message: 'GitHub authentication could not be refreshed right now. Please retry shortly.' });
                return;
            }
        } else {
            // Proactively refresh token in background if needed.
            refreshGitHubTokenIfNeeded(req).catch((err) => {
                console.error('Background token refresh failed:', err);
            });
        }
        return next();
    }

    // Bearer token auth (CLI)
    const bearerEnabled = process.env.ENABLE_BEARER_AUTH !== 'false';
    const authHeader = req.headers.authorization;

    if (bearerEnabled && authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);

        try {
            const user = await validateGitHubToken(token);
            if (user) {
                if (!isUserWhitelisted(user.username)) {
                    res.status(403).json({ error: 'Forbidden', code: 'USER_NOT_WHITELISTED', message: 'Your GitHub account is not authorized for this ProPR instance. Ask an admin to add you to the user whitelist.' });
                    return;
                }
                // Populate req.user so downstream handlers work the same way
                (req as Request & { user: GitHubUser }).user = user;
                return next();
            }
            res.status(401).json({ error: 'Unauthorized: invalid token' });
        } catch {
            res.status(401).json({ error: 'Unauthorized: token validation failed' });
        }
        return;
    }

    res.status(401).json({ error: 'Unauthorized' });
}
