/**
 * GitHub OAuth device flow (RFC 8628 as implemented by GitHub).
 *
 * Only the App's public client ID is needed: no client secret and no callback
 * URL. The API uses it for dashboard sign-in on relay-enrolled instances, and
 * the same two steps suit a CLI that needs a one-time user token.
 *
 * Nothing here logs. Callers must keep `deviceCode` and the returned tokens
 * out of logs and responses; only the `userCode` is meant for the person
 * signing in.
 */

export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_DEVICE_VERIFICATION_URL = 'https://github.com/login/device';
export const GITHUB_DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** RFC 8628 §3.5: add five seconds after `slow_down` when GitHub sends no interval. */
export const GITHUB_DEVICE_SLOW_DOWN_STEP_SECONDS = 5;
const DEFAULT_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 120;
const DEFAULT_EXPIRES_IN_SECONDS = 900;
const MAX_EXPIRES_IN_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 20_000;

export interface GitHubDeviceCode {
  deviceCode: string;
  userCode: string;
  /** Always GitHub's own page; a response pointing elsewhere is ignored. */
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface GitHubDeviceToken {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  refreshTokenExpiresInSeconds?: number;
}

/** Errors GitHub returns while polling, plus `invalid_response` for anything malformed. */
export type GitHubDeviceFlowErrorCode =
  | 'device_flow_disabled'
  | 'access_denied'
  | 'expired_token'
  | 'incorrect_client_credentials'
  | 'incorrect_device_code'
  | 'unsupported_grant_type'
  | 'invalid_response';

export type GitHubDevicePollResult =
  | { status: 'pending'; intervalSeconds: number }
  | { status: 'slow_down'; intervalSeconds: number }
  | { status: 'authorized'; token: GitHubDeviceToken }
  | { status: 'failed'; error: GitHubDeviceFlowErrorCode };

export class GitHubDeviceFlowError extends Error {
  constructor(public readonly code: GitHubDeviceFlowErrorCode, message: string) {
    super(message);
    this.name = 'GitHubDeviceFlowError';
  }
}

const KNOWN_ERRORS = new Set<string>([
  'device_flow_disabled', 'access_denied', 'expired_token', 'incorrect_client_credentials',
  'incorrect_device_code', 'unsupported_grant_type',
]);

/** User-facing text for each device flow failure. */
export function githubDeviceFlowErrorMessage(code: GitHubDeviceFlowErrorCode): string {
  switch (code) {
    case 'device_flow_disabled': return "Device sign-in isn't enabled for this GitHub App.";
    case 'access_denied': return 'GitHub sign-in was cancelled.';
    case 'expired_token': return 'The GitHub sign-in code expired before it was entered.';
    case 'incorrect_client_credentials': return 'The GitHub App client ID used for device sign-in is not valid.';
    default: return 'GitHub sign-in could not be completed.';
  }
}

function positiveSeconds(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.ceil(value), max) : fallback;
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function postForm(fetchImpl: typeof fetch, url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ProPR' },
    body: formBody(fields),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GitHubDeviceFlowError('invalid_response', `GitHub returned a non-JSON device flow response (HTTP ${response.status})`);
  }
  if (typeof body !== 'object' || body === null) {
    throw new GitHubDeviceFlowError('invalid_response', `GitHub returned an invalid device flow response (HTTP ${response.status})`);
  }
  return body as Record<string, unknown>;
}

function knownError(body: Record<string, unknown>): GitHubDeviceFlowErrorCode | undefined {
  return typeof body.error === 'string' && KNOWN_ERRORS.has(body.error) ? body.error as GitHubDeviceFlowErrorCode : undefined;
}

/** Step 1: ask GitHub for a device and user code. */
export async function requestGitHubDeviceCode(options: {
  clientId: string;
  scope?: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubDeviceCode> {
  const fields: Record<string, string> = { client_id: options.clientId };
  if (options.scope) fields.scope = options.scope;
  const body = await postForm(options.fetchImpl ?? fetch, GITHUB_DEVICE_CODE_URL, fields);
  const error = knownError(body);
  if (error) throw new GitHubDeviceFlowError(error, githubDeviceFlowErrorMessage(error));
  if (typeof body.device_code !== 'string' || !body.device_code
    || typeof body.user_code !== 'string' || !/^[A-Z0-9-]{4,32}$/i.test(body.user_code)) {
    throw new GitHubDeviceFlowError('invalid_response', 'GitHub returned an invalid device code response');
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: GITHUB_DEVICE_VERIFICATION_URL,
    expiresInSeconds: positiveSeconds(body.expires_in, DEFAULT_EXPIRES_IN_SECONDS, MAX_EXPIRES_IN_SECONDS),
    intervalSeconds: positiveSeconds(body.interval, DEFAULT_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS),
  };
}

/**
 * Step 2, one poll. The caller waits `intervalSeconds` between polls (the
 * returned interval already includes any `slow_down` increase) and stops at
 * the code's expiry.
 */
export async function pollGitHubDeviceToken(options: {
  clientId: string;
  deviceCode: string;
  intervalSeconds: number;
  fetchImpl?: typeof fetch;
}): Promise<GitHubDevicePollResult> {
  const body = await postForm(options.fetchImpl ?? fetch, GITHUB_DEVICE_TOKEN_URL, {
    client_id: options.clientId,
    device_code: options.deviceCode,
    grant_type: GITHUB_DEVICE_GRANT_TYPE,
  });
  if (body.error === 'authorization_pending') {
    return { status: 'pending', intervalSeconds: options.intervalSeconds };
  }
  if (body.error === 'slow_down') {
    const fallback = options.intervalSeconds + GITHUB_DEVICE_SLOW_DOWN_STEP_SECONDS;
    return {
      status: 'slow_down',
      intervalSeconds: Math.max(positiveSeconds(body.interval, fallback, MAX_INTERVAL_SECONDS), options.intervalSeconds),
    };
  }
  const error = knownError(body);
  if (error) return { status: 'failed', error };
  if (body.error !== undefined || typeof body.access_token !== 'string' || !body.access_token) {
    return { status: 'failed', error: 'invalid_response' };
  }
  return {
    status: 'authorized',
    token: {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === 'string' && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
      ...(typeof body.expires_in === 'number' && body.expires_in > 0 ? { expiresInSeconds: body.expires_in } : {}),
      ...(typeof body.refresh_token_expires_in === 'number' && body.refresh_token_expires_in > 0
        ? { refreshTokenExpiresInSeconds: body.refresh_token_expires_in }
        : {}),
    },
  };
}

/**
 * Run the whole flow for a terminal caller: show the code through
 * `onCode`, then poll until GitHub answers or the code expires.
 */
export async function runGitHubDeviceFlow(options: {
  clientId: string;
  scope?: string;
  onCode: (code: Omit<GitHubDeviceCode, 'deviceCode'>) => void | Promise<void>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<GitHubDeviceToken> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const code = await requestGitHubDeviceCode(options);
  const { deviceCode, ...visible } = code;
  await options.onCode(visible);
  const deadline = now() + code.expiresInSeconds * 1000;
  let interval = code.intervalSeconds;
  for (;;) {
    await sleep(interval * 1000);
    if (now() >= deadline) throw new GitHubDeviceFlowError('expired_token', githubDeviceFlowErrorMessage('expired_token'));
    const result = await pollGitHubDeviceToken({ clientId: options.clientId, deviceCode, intervalSeconds: interval, fetchImpl: options.fetchImpl });
    if (result.status === 'authorized') return result.token;
    if (result.status === 'failed') throw new GitHubDeviceFlowError(result.error, githubDeviceFlowErrorMessage(result.error));
    interval = result.intervalSeconds;
  }
}
