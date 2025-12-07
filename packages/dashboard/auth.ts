import passport from 'passport';
import { Strategy as GitHubStrategy, Profile } from 'passport-github2';
import session from 'express-session';
import type { Express, Request, Response, NextFunction } from 'express';

interface GitHubUser {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    accessToken: string;
}

declare module 'express-serve-static-core' {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends GitHubUser {}
}

export function setupAuth(app: Express): void {
    const requiredEnvVars = ['GH_OAUTH_CLIENT_ID', 'GH_OAUTH_CLIENT_SECRET', 'GH_OAUTH_CALLBACK_URL', 'FRONTEND_URL'];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    app.use(session({
        secret: process.env.SESSION_SECRET || 'your-secret-key-here',
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.NODE_ENV === 'production',
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000
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

    app.get('/api/auth/github', passport.authenticate('github', { scope: ['user:email', 'read:org', 'repo'] }));

    app.get('/api/auth/github/callback',
        passport.authenticate('github', { failureRedirect: '/login' }),
        (req: Request, res: Response) => {
            res.redirect(`${process.env.FRONTEND_URL}/`);
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
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}
