/* eslint-disable max-lines -- browser, bearer, and socket authentication share session state */
import passport from 'passport';
import { Strategy as GitHubStrategy, Profile } from 'passport-github2';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';
import { randomBytes } from 'node:crypto';
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import { validateSessionSecret } from '@propr/shared';
import { validateGitHubToken } from './authBearer.js';
import { configureDemoMode, getDemoUser, isDemoMode } from './demoMode.js';
import { clearSessionForReauth, isGitHubTokenExpired, refreshGitHubTokenWithResult } from './authGithubTokens.js';
import { getValidatedRedirectTo, getDefaultRedirectUrl } from './authRedirect.js';
import { isUserWhitelisted } from './userWhitelist.js';
import type { GitHubUser } from './authTypes.js';
import { createAuthRequestRateLimiter } from './requestRateLimits.js';
import {
    clearSessionCookie,
    completeAuthenticatedSession,
    getSessionCookieDomain,
    redirectAuthError,
    shouldUseSecureSessionCookie,
    type AuthSession,
} from './authSession.js';
import {
    buildConnectAuthorizationUrl,
    redeemConnectAuthorizationCode,
    resolveBrowserAuthMode,
} from './connectAuth.js';
import {
    authenticatedUserResponse,
    resolveAuthorization,
    resolveInstanceAuthorization,
    type InstanceAuthorization,
} from './authorization.js';
import { captureVisualPreviewCredentialFromAdminLogin } from './services/visualPreviewOAuth.js';
import './authTypes.js';

export { refreshGitHubTokenIfNeeded } from './authGithubTokens.js';
export { getSessionCookieDomain, shouldUseSecureSessionCookie } from './authSession.js';
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
    function verifyCallback(accessToken: string, refreshToken: string, params: { expires_in?: number; refresh_token_expires_in?: number }, profile: Profile, done: (error: Error | null, user?: GitHubUser) => void) {
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
            refreshTokenExpiresAt: params.refresh_token_expires_in
                ? Date.now() + (params.refresh_token_expires_in * 1000)
                : undefined,
            oauthSource: 'github',
        };
        return done(null, user);
    });
}

/** Build the Connect callback with an injectable redeemer for route-level tests. */
export function createConnectCallbackHandler(
    redeem: typeof redeemConnectAuthorizationCode = redeemConnectAuthorizationCode,
): RequestHandler {
    return async (req: Request, res: Response) => {
        const authSession = req.session as AuthSession;
        const state = typeof req.query.state === 'string' ? req.query.state : '';
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        if (!authSession.connectOAuthState || state !== authSession.connectOAuthState || !code) {
            delete authSession.connectOAuthState;
            redirectAuthError(res, 'oauth_state_mismatch');
            return;
        }

        // Consume local state before the network exchange. The Connect grant
        // itself is also one-use, so retrying this callback cannot create a
        // second session if the browser replays the URL.
        delete authSession.connectOAuthState;
        try {
            const user = await redeem({
                code,
                relayUrl: process.env.PROPR_GH_RELAY_URL!,
                relayToken: process.env.PROPR_GH_RELAY_TOKEN!,
            });
            req.login(user, { session: true, keepSessionInfo: true }, (loginError) => {
                if (loginError) {
                    console.error('Connect session login failed:', loginError);
                    redirectAuthError(res, 'session_unavailable');
                    return;
                }
                void completeAuthenticatedSessionWithPreviewCredential(req, res);
            });
        } catch (error) {
            console.error('Connect instance login failed:', error);
            redirectAuthError(res, 'connect_login_failed');
        }
    };
}

async function completeAuthenticatedSessionWithPreviewCredential(req: Request, res: Response): Promise<void> {
    if (req.user && isUserWhitelisted(req.user.username)) {
        try {
            const captured = await captureVisualPreviewCredentialFromAdminLogin(req.user);
            if (captured) console.log(`[visual-preview] Captured OAuth upload credential for administrator ${req.user.username}`);
        } catch (error) {
            // Preview uploads are optional; a storage or encryption issue must not
            // prevent an otherwise valid administrator from logging in.
            console.warn('[visual-preview] Could not capture OAuth upload credential during login:', (error as Error).message);
        }
    }
    completeAuthenticatedSession(req, res);
}

export function setupAuth(app: Express, demoModeAtStartup = isDemoMode()): SocketAuthMiddlewareBundle {
    configureDemoMode(demoModeAtStartup);
    const browserAuthMode = demoModeAtStartup ? 'disabled' : resolveBrowserAuthMode();
    const requiredEnvVars = browserAuthMode === 'github'
        ? ['GH_OAUTH_CLIENT_ID', 'GH_OAUTH_CLIENT_SECRET', 'GH_OAUTH_CALLBACK_URL', 'FRONTEND_URL']
        : browserAuthMode === 'connect'
            ? ['PROPR_GH_RELAY_URL', 'PROPR_GH_RELAY_TOKEN', 'GH_OAUTH_CALLBACK_URL', 'FRONTEND_URL']
            : ['FRONTEND_URL'];
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

    // Keep OAuth starts and callbacks bounded independently from the general
    // API quota. Session checks, logout, and auth metadata remain covered by
    // the general API limiter and must not exhaust the much smaller OAuth
    // bucket during normal UI use.
    app.use('/api/auth/github', createAuthRequestRateLimiter());

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

        if (browserAuthMode === 'github') {
            passport.use(createGitHubOAuthStrategy({
                clientID: process.env.GH_OAUTH_CLIENT_ID!,
                clientSecret: process.env.GH_OAUTH_CLIENT_SECRET!,
                callbackURL: process.env.GH_OAUTH_CALLBACK_URL!,
            }));
        }

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
            (req.session as AuthSession).redirectTo = redirectTo;
        }

        if (browserAuthMode === 'connect') {
            const state = randomBytes(32).toString('base64url');
            (req.session as AuthSession).connectOAuthState = state;
            req.session.save((error) => {
                if (error) {
                    console.error('Could not save Connect OAuth state:', error);
                    redirectAuthError(res, 'session_unavailable');
                    return;
                }
                try {
                    res.redirect(buildConnectAuthorizationUrl({
                        connectOrigin: process.env.PROPR_CONNECT_URL,
                        callbackUrl: process.env.GH_OAUTH_CALLBACK_URL!,
                        state,
                        installationId: process.env.GH_INSTALLATION_ID,
                    }));
                } catch (buildError) {
                    console.error('Could not build Connect authorization URL:', buildError);
                    redirectAuthError(res, 'connect_not_configured');
                }
            });
            return;
        }

        if (browserAuthMode === 'disabled') {
            redirectAuthError(res, 'web_auth_not_configured');
            return;
        }
        passport.authenticate('github', { scope: ['user:email', 'read:org', 'repo', 'offline_access'] })(req, res, next);
    });

    if (demoModeAtStartup) {
        app.get('/api/auth/github/callback', (req: Request, res: Response) => {
            const redirectTo = getValidatedRedirectTo(req.query.redirect_to as string | undefined);
            res.redirect(redirectTo || getDefaultRedirectUrl());
        });
    } else if (browserAuthMode === 'github') {
        app.get('/api/auth/github/callback',
            passport.authenticate('github', { failureRedirect: '/login' }),
            completeAuthenticatedSessionWithPreviewCredential
        );
    } else if (browserAuthMode === 'connect') {
        app.get('/api/auth/github/callback', createConnectCallbackHandler());
    } else {
        app.get('/api/auth/github/callback', (_req: Request, res: Response) => {
            redirectAuthError(res, 'web_auth_not_configured');
        });
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

// Session, bearer, demo, and refresh outcomes are intentionally centralized.
// eslint-disable-next-line complexity
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
            // Await synchronization with the durable upload grant before a
            // downstream route can use an access token invalidated by rotation.
            // Temporary proactive-refresh failures do not invalidate a token
            // whose recorded expiry is still in the future.
            const refreshResult = await refreshGitHubTokenWithResult(req);
            if (refreshResult.status === 'reauth-required' || req.user?.githubAuthInvalid) {
                if (req.user?.githubAuthInvalid) await clearSessionForReauth(req);
                res.status(401).json({ error: 'GitHub authentication expired', code: 'GITHUB_REAUTH_REQUIRED', message: 'Your GitHub session has expired. Please log in again.' });
                return;
            }
            if (refreshResult.status === 'temporarily-unavailable') {
                console.warn('Proactive GitHub token refresh was temporarily unavailable; continuing with the unexpired session token');
            }
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
