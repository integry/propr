import type { Request } from 'express';
import { RelayRefreshHttpError, readRefreshErrorCode } from './deviceGrantRenewal.js';

const REFRESH_TIMEOUT_MS = 20_000;

export interface GrantRefreshResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    error?: string;
}

/** The session fallback's refresh request: the relay for Connect and device sign-ins, GitHub for OAuth. */
export function buildTokenRefreshRequest(user: NonNullable<Request['user']>): { endpoint: string; init: RequestInit } {
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

/**
 * The durable grant's refresh request. A non-OK answer throws
 * RelayRefreshHttpError with its status and JSON `error`, so device grants can
 * tell a missing relay route from a temporary failure.
 */
export async function requestGrantRefresh(
    fetchImpl: typeof fetch,
    environment: NodeJS.ProcessEnv,
    source: 'github' | 'connect',
    refreshToken: string,
): Promise<GrantRefreshResponse> {
    let endpoint: string;
    let headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
    let body: Record<string, string>;
    if (source === 'connect') {
        const relayUrl = environment.PROPR_GH_RELAY_URL?.trim().replace(/\/+$/, '');
        const relayToken = environment.PROPR_GH_RELAY_TOKEN?.trim();
        if (!relayUrl || !relayToken) throw new Error('ProPR Connect credentials are unavailable for GitHub reauthorization');
        const refreshUrl = new URL(`${relayUrl}/auth/instance-grants/refresh`);
        if (refreshUrl.protocol !== 'https:' && refreshUrl.hostname !== 'localhost' && refreshUrl.hostname !== '127.0.0.1') {
            throw new Error('PROPR_GH_RELAY_URL must use HTTPS');
        }
        endpoint = refreshUrl.toString();
        headers = { ...headers, authorization: `Bearer ${relayToken}` };
        body = { refresh_token: refreshToken };
    } else {
        const clientId = environment.GH_OAUTH_CLIENT_ID?.trim();
        const clientSecret = environment.GH_OAUTH_CLIENT_SECRET?.trim();
        if (!clientId || !clientSecret) throw new Error('GitHub OAuth client credentials are unavailable for token refresh');
        endpoint = 'https://github.com/login/oauth/access_token';
        body = { client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken };
    }
    const response = await fetchImpl(endpoint, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) throw new RelayRefreshHttpError(response.status, await readRefreshErrorCode(response));
    return response.json() as Promise<GrantRefreshResponse>;
}
