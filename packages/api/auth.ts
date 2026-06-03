import passport from 'passport';
import { Strategy as GitHubStrategy, Profile } from 'passport-github2';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';
import type { Express, Request, Response, NextFunction } from 'express';
import { validateGitHubToken } from './authBearer.js';
import { configureDemoMode, getDemoUser, isDemoMode } from './demoMode.js';
import { clearSessionForReauth, refreshGitHubTokenIfNeeded } from './authGithubTokens.js';
import { getValidatedRedirectTo, getDefaultRedirectUrl } from './authRedirect.js';
import type { GitHubUser } from './authTypes.js';
import './authTypes.js';

export { refreshGitHubTokenIfNeeded } from './authGithubTokens.js';
export type { GitHubUser } from './authTypes.js';

export function setupAuth(app: Express, demoModeAtStartup = isDemoMode()): void {
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
        const sessionRedisHost = process.env.SESSION_REDIS_HOST || process.env.REDIS_HOST || 'redis';
        const sessionRedisPort = process.env.SESSION_REDIS_PORT || process.env.REDIS_PORT || '6379';
        const redisClient = createClient({ url: `redis://${sessionRedisHost}:${sessionRedisPort}` });
        redisClient.on('error', (err) => {
            console.error('Session Redis Client Error', err);
        });
        redisClient.connect().catch(console.error);

        // Use Redis store for sessions to share across subdomains
        const redisStore = new RedisStore({ client: redisClient, prefix: 'propr:session:' });

        app.use(session({
            store: redisStore,
            secret: process.env.SESSION_SECRET || 'your-secret-key-here',
            resave: false,
            saveUninitialized: false,
            rolling: true, // Extend session expiration on each request
            cookie: {
                // Always secure since gitfix.dev uses HTTPS
                secure: true,
                httpOnly: true,
                maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
                // Set domain to .gitfix.dev to share cookies across all subdomains
                domain: process.env.COOKIE_DOMAIN || '.gitfix.dev',
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
            console.log('User authenticated:', profile.username);

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
            (req: Request, res: Response) => {
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
                res.clearCookie('connect.sid');
                res.redirect(`${process.env.FRONTEND_URL}/login?logged_out=true`);
            });
        });
    });

    app.get('/api/auth/user', ensureAuthenticated, (req: Request, res: Response) => {
        res.json(req.user);
    });

    app.get('/api/auth/demo-mode', (_req: Request, res: Response) => {
        res.json({ demoMode: demoModeAtStartup });
    });

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

        // Proactively refresh token in background if needed
        // Don't block the request, let it continue while refresh happens
        refreshGitHubTokenIfNeeded(req).catch((err) => {
            console.error('Background token refresh failed:', err);
        });
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
