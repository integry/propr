import { createClient, type RedisClientType } from 'redis';
import type { Request } from 'express';
import { createHash } from 'crypto';
import type { GitHubUser } from './authUser.js';

let tokenCacheClient: RedisClientType | null = null;
const TOKEN_CACHE_PREFIX = 'propr:bearer:';
const TOKEN_CACHE_TTL_SECONDS = 300;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface GitHubProfileResponse {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
}

interface GitHubTokenRefreshResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
}

async function getTokenCacheClient(): Promise<RedisClientType> {
    if (!tokenCacheClient) {
        const redisHost = process.env.REDIS_HOST || '127.0.0.1';
        const redisPort = process.env.REDIS_PORT || '6379';
        tokenCacheClient = createClient({ url: `redis://${redisHost}:${redisPort}` }) as RedisClientType;
        tokenCacheClient.on('error', err => console.error('Token Cache Redis Client Error', err));
        await tokenCacheClient.connect();
    }
    return tokenCacheClient;
}

function tokenCacheKey(token: string): string {
    const digest = createHash('sha256').update(token).digest('hex');
    return `${TOKEN_CACHE_PREFIX}${digest}`;
}

export async function validateGitHubToken(token: string): Promise<GitHubUser | null> {
    try {
        const redis = await getTokenCacheClient();
        const cacheKey = tokenCacheKey(token);
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached) as GitHubUser;

        const response = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'ProPR-CLI',
            },
        });
        if (!response.ok) return null;

        const profile = await response.json() as GitHubProfileResponse;
        const user: GitHubUser = {
            id: String(profile.id),
            login: profile.login,
            username: profile.login,
            displayName: profile.name || profile.login,
            email: profile.email,
            avatarUrl: profile.avatar_url,
            accessToken: token,
        };

        await redis.set(cacheKey, JSON.stringify(user), { EX: TOKEN_CACHE_TTL_SECONDS });
        return user;
    } catch (error) {
        console.error('Bearer token validation error:', error);
        return null;
    }
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
