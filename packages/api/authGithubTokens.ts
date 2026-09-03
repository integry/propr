import type { Request } from 'express';
import { isSupportedVisualPreviewUploadToken } from '@propr/core';
import {
    updateVisualPreviewCredentialForCurrentOwner,
    visualPreviewOAuthCredentialService,
} from './services/visualPreviewOAuth.js';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface GitHubTokenRefreshResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
}

export type GitHubTokenRefreshStatus = 'refreshed' | 'not-needed' | 'reauth-required' | 'temporarily-unavailable';

export interface GitHubTokenRefreshResult {
    status: GitHubTokenRefreshStatus;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    refreshTokenExpiresAt?: number;
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
    delete user.refreshTokenExpiresAt;

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
    if (result.refreshTokenExpiresAt) user.refreshTokenExpiresAt = result.refreshTokenExpiresAt;
}

async function saveSession(req: Request, successMessage: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        req.session.save(err => {
            if (err) {
                console.error('Error saving session after token refresh:', err);
                reject(err);
            } else {
                console.log(successMessage);
                resolve();
            }
        });
    });
}

function buildTokenRefreshRequest(user: NonNullable<Request['user']>): { endpoint: string; init: RequestInit } {
    if (user.oauthSource === 'connect') {
        const relayUrl = process.env.PROPR_GH_RELAY_URL?.trim().replace(/\/+$/, '');
        const relayToken = process.env.PROPR_GH_RELAY_TOKEN?.trim();
        if (!relayUrl || !relayToken) throw new Error('ProPR Connect credentials are unavailable for token refresh');
        const endpoint = new URL(`${relayUrl}/auth/instance-grants/refresh`);
        if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
            throw new Error('PROPR_GH_RELAY_URL must use HTTPS');
        }
        return {
            endpoint: endpoint.toString(),
            init: {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${relayToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ refresh_token: user.refreshToken }),
            },
        };
    }
    return {
        endpoint: 'https://github.com/login/oauth/access_token',
        init: {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: process.env.GH_OAUTH_CLIENT_ID,
                client_secret: process.env.GH_OAUTH_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: user.refreshToken,
            }),
        },
    };
}

// Session fallback and the shared background credential deliberately converge here.
// eslint-disable-next-line complexity
async function performGitHubTokenRefresh(req: Request, force: boolean): Promise<GitHubTokenRefreshResult> {
    const user = req.user;
    if (!user || user.githubAuthInvalid) return { status: 'reauth-required' };
    const supportsVisualPreviewUploads = isSupportedVisualPreviewUploadToken(user.accessToken || '');

    if (supportsVisualPreviewUploads) {
        try {
            const sharedGrant = await visualPreviewOAuthCredentialService.refreshAndGetForOwner(user.id, force);
            if (sharedGrant?.status === 'reauth_required') {
                await markGitHubSessionReauthRequired(req, 'shared_visual_preview_grant_invalid');
                return { status: 'reauth-required' };
            }
            if (sharedGrant?.accessToken) {
                const changed = user.accessToken !== sharedGrant.accessToken
                    || user.refreshToken !== sharedGrant.refreshToken
                    || user.tokenExpiresAt !== sharedGrant.accessTokenExpiresAt;
                user.accessToken = sharedGrant.accessToken;
                user.refreshToken = sharedGrant.refreshToken;
                user.tokenExpiresAt = sharedGrant.accessTokenExpiresAt;
                user.refreshTokenExpiresAt = sharedGrant.refreshTokenExpiresAt;
                if (changed) {
                    await saveSession(req, `Synchronized refreshed GitHub token for user ${user.username}`);
                }
                return {
                    status: changed ? 'refreshed' : 'not-needed',
                    accessToken: user.accessToken,
                    refreshToken: user.refreshToken,
                    tokenExpiresAt: user.tokenExpiresAt,
                    refreshTokenExpiresAt: user.refreshTokenExpiresAt,
                };
            }
        } catch (error) {
            console.error('Error refreshing shared GitHub OAuth credential:', error);
            return { status: 'temporarily-unavailable' };
        }
    }

    if (!user.refreshToken) {
        return { status: force ? 'reauth-required' : 'not-needed' };
    }

    const now = Date.now();
    const needsRefresh = force || (user.tokenExpiresAt && (user.tokenExpiresAt - now) < TOKEN_REFRESH_BUFFER_MS);
    if (!needsRefresh) return { status: 'not-needed' };

    console.log(`Refreshing GitHub token for user ${user.username} (force=${force})`);

    try {
        const refreshRequest = buildTokenRefreshRequest(user);
        const response = await fetch(refreshRequest.endpoint, refreshRequest.init);
        if (!response.ok) {
            console.error(`GitHub token refresh failed with status ${response.status}`);
            return { status: 'temporarily-unavailable' };
        }

        const data = await response.json() as GitHubTokenRefreshResponse;
        if (data.error) {
            console.error(`GitHub token refresh error: ${data.error} - ${data.error_description}`);
            if (isUnrecoverableRefreshError(data.error)) await markGitHubSessionReauthRequired(req, data.error);
            return { status: isUnrecoverableRefreshError(data.error) ? 'reauth-required' : 'temporarily-unavailable' };
        }
        if (!data.access_token) {
            console.error('GitHub token refresh response missing access_token');
            return { status: 'temporarily-unavailable' };
        }

        user.accessToken = data.access_token;
        if (data.refresh_token) user.refreshToken = data.refresh_token;
        if (data.expires_in) user.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
        if (data.refresh_token_expires_in) {
            user.refreshTokenExpiresAt = Date.now() + (data.refresh_token_expires_in * 1000);
        }

        await saveSession(req, `Successfully refreshed GitHub token for user ${user.username}`);
        if (supportsVisualPreviewUploads) {
            try {
                await updateVisualPreviewCredentialForCurrentOwner(user);
            } catch (error) {
                console.warn('[visual-preview] Could not persist the refreshed OAuth upload credential:', (error as Error).message);
            }
        }

        return {
            status: 'refreshed',
            accessToken: user.accessToken,
            refreshToken: user.refreshToken,
            tokenExpiresAt: user.tokenExpiresAt,
            refreshTokenExpiresAt: user.refreshTokenExpiresAt,
        };
    } catch (error) {
        console.error('Error refreshing GitHub token:', error);
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
