const passport = require('passport');
const { Strategy: GitHubStrategy } = require('passport-github2');
const session = require('express-session');

function setupAuth(app) {
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
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        }
    }));
    app.use(passport.initialize());
    app.use(passport.session());

    passport.use(new GitHubStrategy({
        clientID: process.env.GH_OAUTH_CLIENT_ID,
        clientSecret: process.env.GH_OAUTH_CLIENT_SECRET,
        callbackURL: process.env.GH_OAUTH_CALLBACK_URL,
    },
    (accessToken, refreshToken, profile, done) => {
        // Here you would find or create a user in your database.
        // For now, we'll just pass the profile through.
        console.log('User authenticated:', profile.username);
        const user = {
            id: profile.id,
            username: profile.username,
            displayName: profile.displayName,
            email: profile.emails && profile.emails[0] ? profile.emails[0].value : null,
            avatarUrl: profile.photos && profile.photos[0] ? profile.photos[0].value : null,
            accessToken: accessToken
        };
        return done(null, user);
    }));

    passport.serializeUser((user, done) => done(null, user));
    passport.deserializeUser((obj, done) => done(null, obj));

    // Routes
    app.get('/api/auth/github', passport.authenticate('github', { scope: ['user:email', 'read:org', 'repo'] }));

    app.get('/api/auth/github/callback',
        passport.authenticate('github', { failureRedirect: '/login' }),
        (req, res) => {
            // Successful authentication, redirect to the dashboard.
            res.redirect(`${process.env.FRONTEND_URL}/`);
        }
    );

    app.get('/api/auth/logout', (req, res) => {
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

    app.get('/api/auth/user', ensureAuthenticated, (req, res) => {
        res.json(req.user);
    });
}

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        // Here you can add authorization logic, e.g.,
        // check if req.user.username is part of a specific GitHub org.
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { setupAuth, ensureAuthenticated };