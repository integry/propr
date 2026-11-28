/**
 * GitHub's device flow against the shared ProPR App (#3827 follow-up), used
 * by the wizard's ProPR App path to get the one-time GitHub user token that
 * relay enrollment needs, instead of a pasted token.
 *
 * Needs only the App's public client ID: no client secret, no callback URL,
 * so it works on `https://<app>.fly.dev` and any other host. The user token
 * it returns is handed straight to enrollment and dropped; it is never
 * written to the volume, logged or rendered. The device code and user code
 * are never logged either; the user code is rendered only to the claimant.
 *
 * Device Flow must be enabled on the App. Until it is, GitHub answers
 * `device_flow_disabled` and the wizard falls back to a pasted token
 * (DeviceFlowDisabledError).
 *
 * TODO(#3867): #3867 ships the shared client ID next to
 * DEFAULT_PROPR_GH_RELAY_URL in @propr/shared and a device-flow helper of its
 * own. Whichever merges second should switch this module to those.
 */
import { GithubSetupError } from './githubSetup.js';

/** The shared ProPR App's (`propr-dev`) public client ID. PROPR_GH_DEVICE_CLIENT_ID overrides it. */
export const PROPR_APP_CLIENT_ID = 'Iv23liTCmmSNYyD0NtZA';
export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const DEVICE_VERIFICATION_URL = 'https://github.com/login/device';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** GitHub's minimum polling interval; `slow_down` adds 5 seconds each time. */
const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 60;
const MAX_EXPIRES_SECONDS = 15 * 60;

type Fetcher = typeof fetch;

/** GitHub refused to start a device flow because the App does not enable it. */
export class DeviceFlowDisabledError extends GithubSetupError {
    constructor() { super('Device sign-in isn\'t enabled for the ProPR App yet.'); }
}

/** GitHub could not be reached; the device code may still be good. */
export class DeviceFlowUnreachableError extends GithubSetupError {
    constructor(path: string) { super(`GitHub could not be reached (${path}). Try again.`); }
}

export interface DeviceCode {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    /** Seconds between polls. */
    interval: number;
    /** Seconds until the codes expire. */
    expiresIn: number;
}

export type DevicePoll =
    | { kind: 'pending' }
    | { kind: 'slow_down'; interval: number }
    | { kind: 'token'; token: string };

async function postForm(fetcher: Fetcher, url: string, body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
    let response: Response;
    try {
        response = await fetcher(url, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(20_000),
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ProPR-fly-launch' },
            body: new URLSearchParams(body).toString(),
        });
    } catch {
        throw new DeviceFlowUnreachableError(new URL(url).pathname);
    }
    let json: unknown;
    try { json = await response.json(); } catch { json = undefined; }
    if (!json || typeof json !== 'object') throw new GithubSetupError(`GitHub answered HTTP ${response.status}.`, response.status);
    return { status: response.status, json: json as Record<string, unknown> };
}

const bounded = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(max, Math.max(min, n));
};
/** Codes GitHub hands out are short printable ASCII; anything else is not shown or sent. */
const safeCode = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);

/** Start a device flow (POST /login/device/code). No scopes: GitHub App user tokens carry the App's permissions. */
export async function requestDeviceCode(clientId: string, fetcher: Fetcher = fetch): Promise<DeviceCode> {
    const { status, json } = await postForm(fetcher, DEVICE_CODE_URL, { client_id: clientId });
    if (json.error === 'device_flow_disabled') throw new DeviceFlowDisabledError();
    if (json.error) throw new GithubSetupError('GitHub did not start the device sign-in. Try again, or paste a token instead.', status);
    if (!safeCode(json.device_code, 1024) || !safeCode(json.user_code, 128)) throw new GithubSetupError('GitHub returned an unexpected device code. Try again.');
    // Only GitHub's own page is offered to the user, whatever the answer says.
    if (json.verification_uri !== DEVICE_VERIFICATION_URL) throw new GithubSetupError('GitHub returned an unexpected verification page. Try again.');
    return {
        deviceCode: json.device_code,
        userCode: json.user_code,
        verificationUri: DEVICE_VERIFICATION_URL,
        interval: bounded(json.interval, MIN_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS),
        expiresIn: bounded(json.expires_in, 900, 60, MAX_EXPIRES_SECONDS),
    };
}

/** Poll once for the user token (POST /login/oauth/access_token with the device grant). */
export async function pollDeviceToken(clientId: string, deviceCode: string, currentInterval: number, fetcher: Fetcher = fetch): Promise<DevicePoll> {
    const { status, json } = await postForm(fetcher, DEVICE_TOKEN_URL, { client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT });
    if (typeof json.access_token === 'string' && json.access_token) return { kind: 'token', token: json.access_token };
    switch (json.error) {
        case 'authorization_pending': return { kind: 'pending' };
        case 'slow_down': return { kind: 'slow_down', interval: bounded(json.interval, currentInterval + 5, currentInterval + 5, MAX_INTERVAL_SECONDS) };
        case 'expired_token': throw new GithubSetupError('The GitHub code expired before it was entered. Start again for a new code.');
        case 'access_denied': throw new GithubSetupError('The sign-in was cancelled on GitHub. Start again to connect this instance.');
        case 'device_flow_disabled': throw new DeviceFlowDisabledError();
        default: throw new GithubSetupError('GitHub did not finish the device sign-in. Start again.', status);
    }
}
