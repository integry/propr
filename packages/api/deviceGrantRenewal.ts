/**
 * Renewal outcomes specific to GitHub device sign-in grants.
 *
 * A device sign-in is renewed by sending its own refresh token to the relay's
 * `/auth/instance-grants/refresh`. Until the relay serves that route for
 * device grants (integry/propr-routing#340) it answers 404, which can never
 * succeed on retry: the user must sign in again with a new code. Connect and
 * GitHub OAuth sessions keep their own classification; only these grants use
 * this one.
 */

/** `GitHubUser.signInMethod` and the `github_user_grants.renewal` value for device grants. */
export const DEVICE_SIGN_IN = 'device';

/** The re-authentication reason reported to the browser and stored on the grant. */
export const DEVICE_SIGN_IN_EXPIRED = 'device_sign_in_expired';

export const DEVICE_SIGN_IN_EXPIRED_MESSAGE = 'Your GitHub sign-in expired. Sign in again with a new code.';

/** The relay has no refresh route for this grant. */
const MISSING_ROUTE_STATUSES = new Set([404, 405, 501]);

/** Relay or GitHub answers meaning this refresh token will never be renewed. */
const REAUTH_ERRORS = new Set(['bad_refresh_token', 'invalid_grant', 'reauth_required']);

export interface RelayRefreshFailure {
    /** HTTP status, absent when GitHub's answer was a 200 with an `error` field. */
    status?: number;
    /** The JSON body's `error` field, when present. */
    error?: string;
}

/** Thrown for a non-OK refresh response so callers can classify it. */
export class RelayRefreshHttpError extends Error implements RelayRefreshFailure {
    constructor(readonly status: number, readonly error?: string) {
        super(`GitHub user grant refresh failed with HTTP ${status}`);
        this.name = 'RelayRefreshHttpError';
    }
}

export function isDeviceGrant(value: { signInMethod?: string; renewal?: string | null } | undefined): boolean {
    return value?.signInMethod === DEVICE_SIGN_IN || value?.renewal === DEVICE_SIGN_IN;
}

export function isDeviceReauthError(error?: string): boolean {
    return typeof error === 'string' && REAUTH_ERRORS.has(error);
}

/**
 * Whether a failed device-grant refresh needs a new sign-in. 5xx (other than
 * 501), 429, other 4xx, timeouts and network errors stay temporary.
 */
export function deviceRefreshRequiresReauth(failure: RelayRefreshFailure): boolean {
    const { status, error } = failure;
    if (status !== undefined && MISSING_ROUTE_STATUSES.has(status)) return true;
    if (!isDeviceReauthError(error)) return false;
    return status === undefined || (status >= 200 && status < 500);
}

/** The JSON `error` of a failed response, if it has one. Never throws. */
export async function readRefreshErrorCode(response: Response): Promise<string | undefined> {
    try {
        const body = await response.json() as { error?: unknown };
        return typeof body?.error === 'string' ? body.error : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The 401 body for a session that needs a new GitHub sign-in. Read before the
 * session is cleared: device sign-ins get a reason the login page explains.
 */
export function githubReauthResponseBody(user: { signInMethod?: string } | undefined): Record<string, string> {
    const body = { error: 'GitHub authentication expired', code: 'GITHUB_REAUTH_REQUIRED' };
    return isDeviceGrant(user)
        ? { ...body, reason: DEVICE_SIGN_IN_EXPIRED, message: DEVICE_SIGN_IN_EXPIRED_MESSAGE }
        : { ...body, message: 'Your GitHub session has expired. Please log in again.' };
}
