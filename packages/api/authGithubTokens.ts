import type { Request } from 'express';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface GitHubTokenRefreshResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
}

function isUnrecoverableRefreshError(error?: string): boolean {
    return error === 'bad_refresh_token' || error === 'invalid_grant';
}

async function markGitHubSessionReauthRequired(req: Request, reason: string): Promise<void> {
    const user = req.user;
    if (!user) return;

    user.githubAuthInvalid = true;
    user.accessToken = '';
    delete user.refreshToken;
    delete user.tokenExpiresAt;

    await new Promise<void>(resolve => {
        req.session.save(err => {
            if (err) console.error('Error saving session after marking GitHub auth invalid:', err);
            else console.warn(`Marked GitHub OAuth session for user ${user.username} as requiring re-authentication (${reason})`);
            resolve();
        });
    });
}

export async function clearSessionForReauth(req: Request): Promise<void> {
    await new Promise<void>(resolve => {
        req.logout(logoutErr => {
            if (logoutErr) console.error('Error during logout after GitHub auth invalidation:', logoutErr);
            req.session.destroy(destroyErr => {
                if (destroyErr) console.error('Error destroying session after GitHub auth invalidation:', destroyErr);
                resolve();
            });
        });
    });
}

export async function refreshGitHubTokenIfNeeded(req: Request, force = false): Promise<boolean> {
    const user = req.user;
    if (!user || user.githubAuthInvalid || !user.refreshToken) return false;

    const now = Date.now();
    const needsRefresh = force || (user.tokenExpiresAt && (user.tokenExpiresAt - now) < TOKEN_REFRESH_BUFFER_MS);
    if (!needsRefresh) return false;

    console.log(`Refreshing GitHub token for user ${user.username} (force=${force})`);

    try {
        const response = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: process.env.GH_OAUTH_CLIENT_ID,
                client_secret: process.env.GH_OAUTH_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: user.refreshToken,
            }),
        });
        if (!response.ok) {
            console.error(`GitHub token refresh failed with status ${response.status}`);
            return false;
        }

        const data = await response.json() as GitHubTokenRefreshResponse;
        if (data.error) {
            console.error(`GitHub token refresh error: ${data.error} - ${data.error_description}`);
            if (isUnrecoverableRefreshError(data.error)) await markGitHubSessionReauthRequired(req, data.error);
            return false;
        }
        if (!data.access_token) {
            console.error('GitHub token refresh response missing access_token');
            return false;
        }

        user.accessToken = data.access_token;
        if (data.refresh_token) user.refreshToken = data.refresh_token;
        if (data.expires_in) user.tokenExpiresAt = Date.now() + (data.expires_in * 1000);

        await new Promise<void>((resolve, reject) => {
            req.session.save(err => {
                if (err) {
                    console.error('Error saving session after token refresh:', err);
                    reject(err);
                } else {
                    console.log(`Successfully refreshed GitHub token for user ${user.username}`);
                    resolve();
                }
            });
        });

        return true;
    } catch (error) {
        console.error('Error refreshing GitHub token:', error);
        return false;
    }
}
