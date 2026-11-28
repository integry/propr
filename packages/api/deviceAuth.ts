/**
 * Dashboard sign-in through GitHub's device flow (#3867).
 *
 * Relay-enrolled instances without their own OAuth client or a usable Connect
 * callback sign browsers in with the shared App's public client ID. No client
 * secret or callback URL is involved, so this works on any hostname, port or
 * private network, and ProPR's hosted services never see the user token at
 * sign-in.
 *
 * Every attempt is bound to the browser session that started it: the device
 * code stays server-side, the user code is returned only in the start
 * response, and a poll must name the attempt it continues. One code per
 * attempt; starting again replaces it.
 *
 * Token material is never logged or returned in a response.
 */

import { randomBytes } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';

type FetchResponse = globalThis.Response;
import {
    GitHubDeviceFlowError,
    githubDeviceFlowErrorMessage,
    pollGitHubDeviceToken,
    requestGitHubDeviceCode,
    type GitHubDeviceFlowErrorCode,
    type GitHubDeviceToken,
} from '@propr/shared';
import type { GitHubUser } from './authTypes.js';
import type { AuthSession } from './authSession.js';
import { resolveDeviceClientId } from './connectAuth.js';
import { createRequestRateLimiter, resolveRequestRateLimitPolicies } from './requestRateLimits.js';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_TIMEOUT_MS = 20_000;
const MAX_INSTALLATION_PAGES = 10;
/** Starts allowed per browser session per window, on top of the per-IP limiter. */
export const DEVICE_SESSION_START_LIMIT = 5;
export const DEVICE_SESSION_START_WINDOW_MS = 15 * 60_000;

export interface DeviceLoginAttempt {
    attempt: string;
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: number;
    intervalSeconds: number;
    nextPollAt: number;
}

export type DeviceAuthSession = AuthSession & {
    deviceLogin?: DeviceLoginAttempt;
    deviceLoginStarts?: number[];
};

/** Errors a browser can see, each with fixed copy. */
export type DeviceSignInErrorCode =
    | GitHubDeviceFlowErrorCode
    | 'device_login_missing'
    | 'device_login_failed'
    | 'installation_access_denied'
    | 'not_authorized'
    | 'session_unavailable'
    | 'too_many_attempts';

const ERROR_MESSAGES: Record<DeviceSignInErrorCode, string> = {
    device_flow_disabled: githubDeviceFlowErrorMessage('device_flow_disabled'),
    access_denied: githubDeviceFlowErrorMessage('access_denied'),
    expired_token: githubDeviceFlowErrorMessage('expired_token'),
    incorrect_client_credentials: githubDeviceFlowErrorMessage('incorrect_client_credentials'),
    incorrect_device_code: githubDeviceFlowErrorMessage('incorrect_device_code'),
    unsupported_grant_type: githubDeviceFlowErrorMessage('unsupported_grant_type'),
    invalid_response: githubDeviceFlowErrorMessage('invalid_response'),
    device_login_missing: 'This sign-in attempt is no longer active. Start sign-in again.',
    device_login_failed: 'GitHub sign-in could not be completed. Try again.',
    installation_access_denied: "This GitHub account doesn't have access to the GitHub App installation this instance uses.",
    not_authorized: 'This GitHub account is not authorized to use this instance.',
    session_unavailable: 'GitHub sign-in could not be saved because the instance session store is unavailable. Try again shortly.',
    too_many_attempts: 'Too many sign-in attempts. Wait a few minutes, then try again.',
};

const ERROR_STATUS: Partial<Record<DeviceSignInErrorCode, number>> = {
    device_login_missing: 409,
    installation_access_denied: 403,
    not_authorized: 403,
    session_unavailable: 503,
    too_many_attempts: 429,
    device_login_failed: 502,
    invalid_response: 502,
};

export class DeviceSignInError extends Error {
    constructor(public readonly code: DeviceSignInErrorCode, message = ERROR_MESSAGES[code]) {
        super(message);
        this.name = 'DeviceSignInError';
    }
}

export interface DeviceSignInDependencies {
    env: NodeJS.ProcessEnv;
    now: () => number;
    fetchImpl: typeof fetch;
    requestCode: typeof requestGitHubDeviceCode;
    pollToken: typeof pollGitHubDeviceToken;
    /** An installation token for the relay's installation (only used without GH_INSTALLATION_ID). */
    relayInstallationToken: () => Promise<string>;
    /** Log the user in, create the session and answer the poll. */
    finishLogin: (req: Request, res: Response, user: GitHubUser) => void | Promise<void>;
}

function sendError(res: Response, code: DeviceSignInErrorCode): void {
    res.status(ERROR_STATUS[code] ?? 400).json({ status: 'failed', error: code, message: ERROR_MESSAGES[code] });
}

function noStore(res: Response): void {
    res.set('Cache-Control', 'no-store');
}

function saveSession(req: Request): Promise<void> {
    return new Promise((resolve, reject) => req.session.save(error => (error ? reject(error) : resolve())));
}

async function githubGet(fetchImpl: typeof fetch, path: string, token: string): Promise<FetchResponse> {
    return fetchImpl(`${GITHUB_API}${path}`, {
        headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'user-agent': 'ProPR',
            'x-github-api-version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
}

interface GitHubUserProfile { id: number; login: string; name?: string | null; avatar_url?: string | null; email?: string | null }

function isProfile(value: unknown): value is GitHubUserProfile {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.id === 'number' && Number.isSafeInteger(candidate.id) && candidate.id > 0
        && typeof candidate.login === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(candidate.login);
}

/** `GET /user` with the device-flow token. */
export async function fetchDeviceUserProfile(fetchImpl: typeof fetch, accessToken: string): Promise<GitHubUserProfile> {
    const response = await githubGet(fetchImpl, '/user', accessToken);
    if (!response.ok) throw new Error(`GitHub rejected the device sign-in token (HTTP ${response.status})`);
    const body = await response.json() as unknown;
    if (!isProfile(body)) throw new Error('GitHub returned an invalid user for the device sign-in token');
    return body;
}

interface UserInstallation { id: number; account?: { id?: number; login?: string } | null }

async function listUserInstallations(fetchImpl: typeof fetch, accessToken: string): Promise<UserInstallation[]> {
    const installations: UserInstallation[] = [];
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
        const response = await githubGet(fetchImpl, `/user/installations?per_page=100&page=${page}`, accessToken);
        if (!response.ok) throw new Error(`GitHub could not list the user's App installations (HTTP ${response.status})`);
        const body = await response.json() as { installations?: unknown };
        const pageItems = Array.isArray(body.installations) ? body.installations as UserInstallation[] : [];
        installations.push(...pageItems.filter(item => typeof item?.id === 'number'));
        if (pageItems.length < 100) break;
    }
    return installations;
}

/** The account that owns the relay's installation, from one of its repositories. */
async function relayInstallationAccountId(fetchImpl: typeof fetch, installationToken: string): Promise<number | undefined> {
    const response = await githubGet(fetchImpl, '/installation/repositories?per_page=1', installationToken);
    if (!response.ok) throw new Error(`GitHub could not read the relay installation (HTTP ${response.status})`);
    const body = await response.json() as { repositories?: Array<{ owner?: { id?: unknown } }> };
    const ownerId = body.repositories?.[0]?.owner?.id;
    return typeof ownerId === 'number' ? ownerId : undefined;
}

/**
 * The same check Connect applies before it issues a sign-in: the user's own
 * token must list the relay's installation among the App installations the
 * user can access (`GET /user/installations`). With GH_INSTALLATION_ID the
 * match is by installation ID. Without it, the relay installation's account
 * is read from its repositories and matched against the account of the
 * user's installation: an App has one installation per account, so that
 * names the same installation. Anything undeterminable fails closed.
 */
export async function userCanAccessRelayInstallation(options: {
    accessToken: string;
    installationId?: string;
    fetchImpl: typeof fetch;
    relayInstallationToken: () => Promise<string>;
}): Promise<boolean> {
    const installations = await listUserInstallations(options.fetchImpl, options.accessToken);
    const configured = options.installationId?.trim();
    if (configured) {
        if (!/^\d+$/.test(configured)) return false;
        return installations.some(installation => String(installation.id) === configured);
    }
    if (installations.length === 0) return false;
    const accountId = await relayInstallationAccountId(options.fetchImpl, await options.relayInstallationToken());
    if (accountId === undefined) {
        console.warn('Device sign-in could not identify the relay installation (no repositories); set GH_INSTALLATION_ID.');
        return false;
    }
    return installations.some(installation => installation.account?.id === accountId);
}

/** Build the session user the same way the Connect path does. */
export function deviceSignInUser(profile: GitHubUserProfile, token: GitHubDeviceToken, now: number): GitHubUser {
    return {
        id: String(profile.id),
        login: profile.login,
        username: profile.login,
        displayName: profile.name || profile.login,
        email: null,
        avatarUrl: typeof profile.avatar_url === 'string' ? profile.avatar_url : null,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenExpiresAt: token.expiresInSeconds ? now + token.expiresInSeconds * 1000 : undefined,
        refreshTokenExpiresAt: token.refreshTokenExpiresInSeconds
            ? now + token.refreshTokenExpiresInSeconds * 1000
            : undefined,
        // Same App as Connect: renewal goes through the relay, which holds the
        // App's secret, exactly as for a Connect sign-in.
        oauthSource: 'connect',
    };
}

function recentStarts(session: DeviceAuthSession, now: number): number[] {
    return (session.deviceLoginStarts ?? []).filter(at => typeof at === 'number' && now - at < DEVICE_SESSION_START_WINDOW_MS);
}

/** A JSON body forces a CORS preflight, so other sites cannot drive these routes. */
function requiresJson(req: Request, res: Response): boolean {
    if (req.is('application/json')) return true;
    res.status(415).json({ status: 'failed', error: 'unsupported_media_type', message: 'Send a JSON request body.' });
    return false;
}

export function createDeviceStartHandler(deps: DeviceSignInDependencies): RequestHandler {
    return async (req, res) => {
        noStore(res);
        if (!requiresJson(req, res)) return;
        const session = req.session as DeviceAuthSession;
        const now = deps.now();
        const starts = recentStarts(session, now);
        if (starts.length >= DEVICE_SESSION_START_LIMIT) {
            sendError(res, 'too_many_attempts');
            return;
        }
        session.deviceLoginStarts = [...starts, now];
        delete session.deviceLogin;

        let code;
        try {
            code = await deps.requestCode({ clientId: resolveDeviceClientId(deps.env), fetchImpl: deps.fetchImpl });
        } catch (error) {
            const flowCode = error instanceof GitHubDeviceFlowError ? error.code : 'device_login_failed';
            console.warn(`Device sign-in could not start: ${flowCode}`);
            await saveSession(req).catch(() => undefined);
            sendError(res, flowCode === 'invalid_response' ? 'device_login_failed' : flowCode);
            return;
        }

        const attempt: DeviceLoginAttempt = {
            attempt: randomBytes(24).toString('base64url'),
            deviceCode: code.deviceCode,
            userCode: code.userCode,
            verificationUri: code.verificationUri,
            expiresAt: now + code.expiresInSeconds * 1000,
            intervalSeconds: code.intervalSeconds,
            nextPollAt: now + code.intervalSeconds * 1000,
        };
        session.deviceLogin = attempt;
        try {
            await saveSession(req);
        } catch (error) {
            console.error('Could not save the device sign-in attempt:', (error as Error).message);
            sendError(res, 'session_unavailable');
            return;
        }
        res.json({
            attempt: attempt.attempt,
            userCode: attempt.userCode,
            verificationUri: attempt.verificationUri,
            expiresAt: new Date(attempt.expiresAt).toISOString(),
            interval: attempt.intervalSeconds,
        });
    };
}

function pendingBody(attempt: DeviceLoginAttempt, now: number) {
    return {
        status: 'pending' as const,
        interval: attempt.intervalSeconds,
        retryAfterMs: Math.max(0, attempt.nextPollAt - now),
    };
}

/** Finish a poll that GitHub has answered with a token. */
async function completeAuthorizedAttempt(
    req: Request,
    res: Response,
    token: GitHubDeviceToken,
    deps: DeviceSignInDependencies,
): Promise<void> {
    let user: GitHubUser;
    try {
        const profile = await fetchDeviceUserProfile(deps.fetchImpl, token.accessToken);
        const allowed = await userCanAccessRelayInstallation({
            accessToken: token.accessToken,
            installationId: deps.env.GH_INSTALLATION_ID,
            fetchImpl: deps.fetchImpl,
            relayInstallationToken: deps.relayInstallationToken,
        });
        if (!allowed) {
            console.warn(`Device sign-in refused for ${profile.login}: no access to the relay installation`);
            await saveSession(req).catch(() => undefined);
            sendError(res, 'installation_access_denied');
            return;
        }
        user = deviceSignInUser(profile, token, deps.now());
    } catch (error) {
        console.error('Device sign-in could not verify the GitHub user:', (error as Error).message);
        await saveSession(req).catch(() => undefined);
        sendError(res, 'device_login_failed');
        return;
    }
    await deps.finishLogin(req, res, user);
}

const inFlightPolls = new Set<string>();

// The poll step maps every GitHub answer to one browser-visible state.
export function createDevicePollHandler(deps: DeviceSignInDependencies): RequestHandler {
    return async (req, res) => {
        noStore(res);
        if (!requiresJson(req, res)) return;
        const session = req.session as DeviceAuthSession;
        const requested = typeof req.body?.attempt === 'string' ? req.body.attempt : '';
        const attempt = session.deviceLogin;
        if (!attempt || !requested || attempt.attempt !== requested) {
            sendError(res, 'device_login_missing');
            return;
        }
        const now = deps.now();
        if (now >= attempt.expiresAt) {
            delete session.deviceLogin;
            await saveSession(req).catch(() => undefined);
            sendError(res, 'expired_token');
            return;
        }
        // GitHub's interval applies to us, not to how often the browser asks.
        if (now < attempt.nextPollAt || inFlightPolls.has(attempt.attempt)) {
            res.json(pendingBody(attempt, now));
            return;
        }

        inFlightPolls.add(attempt.attempt);
        try {
            let result;
            try {
                result = await deps.pollToken({
                    clientId: resolveDeviceClientId(deps.env),
                    deviceCode: attempt.deviceCode,
                    intervalSeconds: attempt.intervalSeconds,
                    fetchImpl: deps.fetchImpl,
                });
            } catch (error) {
                // Transient: keep the attempt and try again after the interval.
                console.warn('Device sign-in poll failed:', error instanceof GitHubDeviceFlowError ? error.code : (error as Error).message);
                attempt.nextPollAt = deps.now() + attempt.intervalSeconds * 1000;
                await saveSession(req).catch(() => undefined);
                res.json(pendingBody(attempt, deps.now()));
                return;
            }

            if (result.status === 'pending' || result.status === 'slow_down') {
                attempt.intervalSeconds = result.intervalSeconds;
                attempt.nextPollAt = deps.now() + result.intervalSeconds * 1000;
                await saveSession(req).catch(() => undefined);
                res.json(pendingBody(attempt, deps.now()));
                return;
            }

            // Authorized or failed: the code is spent either way.
            delete session.deviceLogin;
            if (result.status === 'failed') {
                console.warn(`Device sign-in ended: ${result.error}`);
                await saveSession(req).catch(() => undefined);
                sendError(res, result.error);
                return;
            }
            await completeAuthorizedAttempt(req, res, result.token, deps);
        } finally {
            inFlightPolls.delete(attempt.attempt);
        }
    };
}

export function createDeviceCancelHandler(): RequestHandler {
    return async (req, res) => {
        noStore(res);
        if (!requiresJson(req, res)) return;
        const session = req.session as DeviceAuthSession;
        if (session.deviceLogin) {
            delete session.deviceLogin;
            await saveSession(req).catch(() => undefined);
        }
        res.json({ status: 'cancelled' });
    };
}

/** Register the device sign-in routes; the caller has installed sessions and JSON parsing. */
export function registerDeviceSignInRoutes(
    app: Express,
    deps: DeviceSignInDependencies,
    rateLimitEnvironment: NodeJS.ProcessEnv = process.env,
): void {
    const policies = resolveRequestRateLimitPolicies(rateLimitEnvironment);
    const startLimiter = createRequestRateLimiter(policies.deviceSignInStart);
    const pollLimiter = createRequestRateLimiter(policies.deviceSignInPoll);
    app.post('/api/auth/device/start', startLimiter, createDeviceStartHandler(deps));
    app.post('/api/auth/device/poll', pollLimiter, createDevicePollHandler(deps));
    app.post('/api/auth/device/cancel', pollLimiter, createDeviceCancelHandler());
}
