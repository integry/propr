import passport from 'passport';
import { Strategy as GitHubStrategy, Profile } from 'passport-github2';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';
import type { Express, Request, Response, NextFunction } from 'express';

interface GitHubUser {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    accessToken: string;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface User {
            id: string;
            username: string;
            displayName: string;
            email: string | null;
            avatarUrl: string | null;
            accessToken: string;
        }
    }
}

export function setupAuth(app: Express): void {
    const requiredEnvVars = ['GH_OAUTH_CLIENT_ID', 'GH_OAUTH_CLIENT_SECRET', 'GH_OAUTH_CALLBACK_URL', 'FRONTEND_URL'];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    // Create Redis client for session store
    // SESSION_REDIS_HOST allows PR previews to share sessions with main API via host Redis
    const sessionRedisHost = process.env.SESSION_REDIS_HOST || process.env.REDIS_HOST || 'redis';
    const sessionRedisPort = process.env.SESSION_REDIS_PORT || process.env.REDIS_PORT || '6379';
    const redisClient = createClient({
        url: `redis://${sessionRedisHost}:${sessionRedisPort}`
    });
    redisClient.connect().catch(console.error);

    // Use Redis store for sessions to share across subdomains
    const redisStore = new RedisStore({
        client: redisClient,
        prefix: 'gitfix:session:'
    });

    app.use(session({
        store: redisStore,
        secret: process.env.SESSION_SECRET || 'your-secret-key-here',
        resave: false,
        saveUninitialized: false,
        cookie: {
            // Always secure since gitfix.dev uses HTTPS
            secure: true,
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
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
    (accessToken: string, refreshToken: string, profile: Profile, done: (error: Error | null, user?: GitHubUser) => void) => {
        // Here you would find or create a user in your database.
        // For now, we'll just pass the profile through.
        console.log('User authenticated:', profile.username);
        const user: GitHubUser = {
            id: profile.id,
            username: profile.username || '',
            displayName: profile.displayName,
            email: profile.emails && profile.emails[0] ? profile.emails[0].value : null,
            avatarUrl: profile.photos && profile.photos[0] ? profile.photos[0].value : null,
            accessToken: accessToken
        };
        return done(null, user);
    }));

    passport.serializeUser((user, done) => done(null, user));
    passport.deserializeUser((obj: Express.User, done) => done(null, obj));

    // Routes
    // Accept optional redirect_to parameter for PR preview environments
    app.get('/api/auth/github', (req: Request, res: Response, next: NextFunction) => {
        const redirectTo = req.query.redirect_to as string | undefined;
        if (redirectTo) {
            // Validate redirect URL to prevent open redirect attacks
            // Only allow redirects to *.gitfix.dev domains
            try {
                const url = new URL(redirectTo);
                if (url.hostname.endsWith('.gitfix.dev') || url.hostname === 'gitfix.dev') {
                    (req.session as session.Session & { redirectTo?: string }).redirectTo = redirectTo;
                }
            } catch {
                // Invalid URL, ignore
            }
        }
        passport.authenticate('github', { scope: ['user:email', 'read:org', 'repo'] })(req, res, next);
    });

    app.get('/api/auth/github/callback',
        passport.authenticate('github', { failureRedirect: '/login' }),
        (req: Request, res: Response) => {
            // Check for stored redirect URL (for PR preview environments)
            const redirectTo = (req.session as session.Session & { redirectTo?: string }).redirectTo;
            if (redirectTo) {
                // Clear the stored redirect
                delete (req.session as session.Session & { redirectTo?: string }).redirectTo;
            }

            const finalRedirect = redirectTo || `${process.env.FRONTEND_URL}/`;

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

    app.get('/api/auth/logout', (req: Request, res: Response) => {
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

}

export function ensureAuthenticated(req: Request, res: Response, next: NextFunction): void {
    if (req.isAuthenticated()) {
        // Here you can add authorization logic, e.g.,
        // check if req.user.username is part of a specific GitHub org.
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}
