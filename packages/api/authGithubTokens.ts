import type { Request } from 'express';
import { logger } from '@propr/core';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface GitHubTokenRefreshResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
}

export type GitHubTokenRefreshStatus = 'refreshed' | 'not-needed' | 'reauth-required' | 'temporarily-unavailable';

export interface GitHubTokenRefreshResult {
    status: GitHubTokenRefreshStatus;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
}

const sessionRefreshes = new Map<string, Promise<GitHubTokenRefreshResult>>();

function isUnrecoverableRefreshError(error?: string): boolean {
    return error === 'bad_refresh_token' || error === 'invalid_grant';
}

export function isGitHubTokenExpired(req: Request): boolean {
    const tokenExpiresAt = req.user?.tokenExpiresAt;
    return typeof tokenExpiresAt === 'number' && tokenExpiresAt <= Date.now();
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
            if (err) {
                logger.error({ userId: user.id, error: err.message },
                    'Failed to save session after marking GitHub auth invalid');
            } else {
                logger.warn({ userId: user.id, username: user.username, reason },
                    'Marked GitHub OAuth session as requiring re-authentication');
            }
            resolve();
        });
    });
}

export async function clearSessionForReauth(req: Request): Promise<void> {
    await new Promise<void>(resolve => {
        req.logout(logoutErr => {
            if (logoutErr) {
                logger.error({ error: logoutErr.message },
                    'Passport logout failed after GitHub auth invalidation');
            }
            req.session.destroy(destroyErr => {
                if (destroyErr) {
                    logger.error({ error: destroyErr.message },
                        'Session destruction failed after GitHub auth invalidation');
                }
                resolve();
            });
        });
    });
}

function getRefreshLockKey(req: Request): string | undefined {
    const sessionId = 'sessionID' in req && typeof req.sessionID === 'string' ? req.sessionID : undefined;
    return sessionId ?? req.user?.id;
}

function applyRefreshResultToRequest(req: Request, result: GitHubTokenRefreshResult): void {
    const user = req.user;
    if (!user || result.status !== 'refreshed' || !result.accessToken) return;

    user.accessToken = result.accessToken;
    if (result.refreshToken) user.refreshToken = result.refreshToken;
    if (result.tokenExpiresAt) user.tokenExpiresAt = result.tokenExpiresAt;
}

async function saveSession(req: Request, successMessage: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        req.session.save(err => {
            if (err) {
                logger.error({ error: err.message }, 'Failed to save session after GitHub token refresh');
                reject(err);
            } else {
                logger.info(successMessage);
                resolve();
            }
        });
    });
}

async function performGitHubTokenRefresh(req: Request, force: boolean): Promise<GitHubTokenRefreshResult> {
    const user = req.user;
    if (!user || user.githubAuthInvalid) return { status: 'reauth-required' };
    if (!user.refreshToken) return { status: 'reauth-required' };

    const now = Date.now();
    const needsRefresh = force || (user.tokenExpiresAt && (user.tokenExpiresAt - now) < TOKEN_REFRESH_BUFFER_MS);
    if (!needsRefresh) return { status: 'not-needed' };

    logger.info({ userId: user.id, username: user.username, force }, 'Refreshing GitHub token');

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
            logger.error({ userId: user.id, responseStatus: response.status },
                'GitHub token refresh request failed');
            return { status: 'temporarily-unavailable' };
        }

        const data = await response.json() as GitHubTokenRefreshResponse;
        if (data.error) {
            logger.error({
                userId: user.id,
                githubError: data.error,
                description: data.error_description,
            }, 'GitHub token refresh returned an error');
            if (isUnrecoverableRefreshError(data.error)) await markGitHubSessionReauthRequired(req, data.error);
            return { status: isUnrecoverableRefreshError(data.error) ? 'reauth-required' : 'temporarily-unavailable' };
        }
        if (!data.access_token) {
            logger.error({ userId: user.id }, 'GitHub token refresh response omitted access token');
            return { status: 'temporarily-unavailable' };
        }

        user.accessToken = data.access_token;
        if (data.refresh_token) user.refreshToken = data.refresh_token;
        if (data.expires_in) user.tokenExpiresAt = Date.now() + (data.expires_in * 1000);

        await saveSession(req, `Successfully refreshed GitHub token for user ${user.username}`);

        return {
            status: 'refreshed',
            accessToken: user.accessToken,
            refreshToken: user.refreshToken,
            tokenExpiresAt: user.tokenExpiresAt,
        };
    } catch (error) {
        logger.error({ userId: user.id, error: error instanceof Error ? error.message : String(error) },
            'GitHub token refresh failed');
        return { status: 'temporarily-unavailable' };
    }
}

export async function refreshGitHubTokenWithResult(req: Request, force = false): Promise<GitHubTokenRefreshResult> {
    const lockKey = getRefreshLockKey(req);
    const existingRefresh = lockKey ? sessionRefreshes.get(lockKey) : undefined;
    if (existingRefresh) {
        const result = await existingRefresh;
        applyRefreshResultToRequest(req, result);
        if (result.status === 'refreshed') {
            await saveSession(req, `Saved refreshed GitHub token for concurrent request by user ${req.user?.username}`);
        }
        return result;
    }

    const refreshPromise = performGitHubTokenRefresh(req, force);
    if (lockKey) sessionRefreshes.set(lockKey, refreshPromise);
    try {
        return await refreshPromise;
    } finally {
        if (lockKey) sessionRefreshes.delete(lockKey);
    }
}

export async function refreshGitHubTokenIfNeeded(req: Request, force = false): Promise<boolean> {
    const result = await refreshGitHubTokenWithResult(req, force);
    return result.status === 'refreshed';
}
