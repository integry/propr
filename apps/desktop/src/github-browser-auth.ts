import { validateGithubClientId } from './github-client-config';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { GITHUB_SIGN_IN_REVOKED_MESSAGE, GithubBrowserSignInError as SignInError, type GithubUserCredential } from '@propr/local-setup';

const VERIFICATION_URL = 'https://github.com/login/device';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const OAUTH_TOKEN = /^[A-Za-z0-9_]{1,512}$/;
const MAX_LIFETIME_SECONDS = 366 * 24 * 60 * 60;
const validLifetime = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_LIFETIME_SECONDS;

/** Validate a device-flow or refresh grant. GitHub OAuth apps may issue either
 * non-expiring tokens or (the default for new apps) 8-hour tokens with a
 * rotating refresh token; the response shape decides which. */
export const parseGithubTokenGrant = (result: Record<string, unknown>, now: number): GithubUserCredential => {
  if (result.error || typeof result.access_token !== 'string' || !OAUTH_TOKEN.test(result.access_token)
    || result.token_type !== 'bearer') throw new SignInError('GitHub sign-in failed. Retry or check the OAuth app configuration.');
  if (result.expires_in === undefined && result.refresh_token === undefined && result.refresh_token_expires_in === undefined) {
    return { accessToken: result.access_token };
  }
  if (!validLifetime(result.expires_in) || typeof result.refresh_token !== 'string' || !OAUTH_TOKEN.test(result.refresh_token)
    || result.refresh_token === result.access_token
    || (result.refresh_token_expires_in !== undefined && !validLifetime(result.refresh_token_expires_in))) {
    throw new SignInError('GitHub returned an invalid expiring sign-in. Retry or check the OAuth app configuration.');
  }
  return {
    accessToken: result.access_token,
    expiresAt: now + result.expires_in * 1000,
    refreshToken: result.refresh_token,
    ...(result.refresh_token_expires_in !== undefined ? { refreshTokenExpiresAt: now + result.refresh_token_expires_in * 1000 } : {}),
  };
};

export interface GithubTokenRefreshDependencies {
  clientId?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Exchange a device-flow refresh token for a rotated pair. GitHub does not
 * require a client secret for device-flow grants. The old refresh token and
 * access token stop working once GitHub accepts the exchange, so callers must
 * persist the result before using it. Provider bodies never escape. */
export const createGithubTokenRefresher = (dependencies: GithubTokenRefreshDependencies) =>
  async (refreshToken: string, { signal }: { signal?: AbortSignal } = {}): Promise<GithubUserCredential> => {
    signal?.throwIfAborted();
    let clientId: string;
    try { clientId = validateGithubClientId(dependencies.clientId); } catch {
      throw new SignInError('GitHub browser sign-in is not configured. The desktop distributor must provision PROPR_DESKTOP_GITHUB_CLIENT_ID with a ProPR-owned OAuth app that enables device flow.');
    }
    if (!OAUTH_TOKEN.test(refreshToken)) throw new SignInError(GITHUB_SIGN_IN_REVOKED_MESSAGE);
    let result: Record<string, unknown>;
    let ok: boolean;
    try {
      const response = await (dependencies.fetch ?? fetch)(TOKEN_URL, {
        method: 'POST', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }),
      });
      ok = response.ok;
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
      result = data as Record<string, unknown>;
    } catch {
      signal?.throwIfAborted();
      throw new SignInError('GitHub sign-in could not be renewed. Check your connection and retry.');
    }
    signal?.throwIfAborted();
    // Only fixed protocol errors are recognized; provider descriptions are dropped.
    if (result.error === 'bad_refresh_token' || result.error === 'invalid_grant' || result.error === 'unauthorized_client') {
      throw new SignInError(GITHUB_SIGN_IN_REVOKED_MESSAGE);
    }
    if (result.error === 'incorrect_client_credentials') throw new SignInError('The ProPR GitHub OAuth client configuration is invalid. Contact the desktop distributor.');
    if (!ok || result.error) throw new SignInError('GitHub sign-in could not be renewed. Check your connection and retry.');
    const credential = parseGithubTokenGrant(result, (dependencies.now ?? Date.now)());
    // A refresh grant must rotate into another refresh grant.
    if (!credential.refreshToken) throw new SignInError('GitHub returned an invalid expiring sign-in. Retry or check the OAuth app configuration.');
    return credential;
  };
const browserFailed = () => new SignInError('GitHub browser sign-in could not complete. Check your browser and connection, then retry.');
const cancelled = () => Object.assign(new SignInError('GitHub sign-in was cancelled. Retry when ready.'), { name: 'AbortError' });

export interface GithubBrowserAuthDependencies {
  clientId?: string;
  /** Start trusted native UI and return cleanup without waiting for user action.
   * Never send this code through renderer IPC. Pass browser-failure when native
   * presentation or browser launch fails; omit the reason for user cancellation. */
  presentCode(code: string, url: string, signal: AbortSignal, cancel: (reason?: 'browser-failure') => void): Promise<() => Promise<void>>;
  confirmIdentity(login: string, signal: AbortSignal): Promise<boolean>;
  fetch?: typeof fetch;
  deadlineMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** GitHub device authorization, independent of the local backend and global gh state.
 * The server-generated device secret protects the exchange (no redirect/PKCE).
 * Only this closure can complete its random attempt; deep links cannot complete it.
 */
export const createGithubBrowserLogin = (dependencies: GithubBrowserAuthDependencies) => {
  let active: { nonce: string; controller: AbortController } | undefined;
  return async ({ signal: caller, onLog }: { signal?: AbortSignal; onLog?: (line: string) => void } = {}): Promise<GithubUserCredential> => {
    caller?.throwIfAborted();
    let clientId: string;
    try { clientId = validateGithubClientId(dependencies.clientId); } catch {
      throw new SignInError('GitHub browser sign-in is not configured. The desktop distributor must provision PROPR_DESKTOP_GITHUB_CLIENT_ID with a ProPR-owned OAuth app that enables device flow.');
    }
    active?.controller.abort();
    const attempt = { nonce: randomBytes(32).toString('hex'), controller: new AbortController() };
    active = attempt;
    const cancel = (reason?: 'browser-failure') => attempt.controller.abort(reason === 'browser-failure' ? browserFailed() : cancelled());
    const onCallerAbort = () => cancel();
    caller?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => attempt.controller.abort(new SignInError('GitHub sign-in timed out. Retry to start a new browser sign-in.')), Math.min(dependencies.deadlineMs ?? 900_000, 900_000));
    let closePrompt: (() => Promise<void>) | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = attempt.controller.signal;
    const check = () => {
      signal.throwIfAborted();
      if (active?.nonce !== attempt.nonce) throw cancelled();
    };
    const request = async (url: string, body?: Record<string, string>, token?: string): Promise<Record<string, unknown>> => {
      check();
      const response = await (dependencies.fetch ?? fetch)(url, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: new URLSearchParams(body) } : {}),
      });
      check();
      const data: unknown = await response.json();
      check();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SignInError('Invalid GitHub sign-in response. Retry.');
      const result = data as Record<string, unknown>;
      // Only recognize fixed protocol errors at OAuth endpoints, including HTTP 4xx.
      if (body && result.error === 'device_flow_disabled') throw new SignInError('The ProPR GitHub OAuth app must enable device flow. Contact the desktop distributor.');
      if (body && result.error === 'incorrect_client_credentials') throw new SignInError('The ProPR GitHub OAuth client configuration is invalid. Contact the desktop distributor.');
      if (!response.ok && !(body && typeof result.error === 'string' && ['authorization_pending', 'slow_down', 'access_denied', 'expired_token'].includes(result.error))) {
        throw new SignInError('GitHub could not complete sign-in. Check your connection and retry.');
      }
      return result;
    };
    try {
      onLog?.('Sign in via GitHub in your browser. Choose the intended account, then return to ProPR.');
      const device = await request('https://github.com/login/device/code', { client_id: clientId, scope: 'repo read:org' });
      if (typeof device.device_code !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(device.device_code)
        || typeof device.user_code !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(device.user_code)
        || device.verification_uri !== VERIFICATION_URL
        || !Number.isInteger(device.expires_in) || Number(device.expires_in) <= 0 || Number(device.expires_in) > 900
        || !Number.isInteger(device.interval) || Number(device.interval) <= 0 || Number(device.interval) > 900) {
        throw new SignInError('GitHub browser sign-in is unavailable. Check the OAuth app configuration and retry.');
      }
      expiryTimer = setTimeout(() => attempt.controller.abort(new SignInError('GitHub sign-in expired. Retry to request a new sign-in.')), Number(device.expires_in) * 1000);
      closePrompt = await dependencies.presentCode(device.user_code, VERIFICATION_URL, signal, cancel);
      check();
      onLog?.('Waiting for GitHub approval in your browser. Return to ProPR to confirm your account, or choose Cancel sign-in in the desktop dialog.');
      let interval = Number(device.interval) * 1000;
      for (;;) {
        await (dependencies.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(interval, signal);
        check();
        const result = await request(TOKEN_URL, {
          client_id: clientId, device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        if (result.error === 'authorization_pending') continue;
        if (result.error === 'slow_down') {
          interval = Math.max(interval + 5000, Number.isInteger(result.interval) && Number(result.interval) > 0 && Number(result.interval) <= 900 ? Number(result.interval) * 1000 : 0);
          continue;
        }
        if (result.error === 'access_denied') throw new SignInError('GitHub sign-in was declined. Retry and approve the intended account.');
        if (result.error === 'expired_token') throw new SignInError('GitHub sign-in expired. Retry to request a new sign-in.');
        const credential = parseGithubTokenGrant(result, (dependencies.now ?? Date.now)());
        const user = await request('https://api.github.com/user', undefined, credential.accessToken);
        if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0 || typeof user.login !== 'string'
          || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user.login)) throw new SignInError('GitHub identity could not be verified. Retry sign-in.');
        check();
        await closePrompt();
        closePrompt = undefined;
        check();
        if (!await dependencies.confirmIdentity(user.login, signal)) throw new SignInError('GitHub account was not confirmed. Retry sign-in and choose the intended account in GitHub.');
        check();
        onLog?.('GitHub account confirmed. Refreshing accessible installations…');
        return credential;
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? cancelled();
      // Do not propagate transport/provider exceptions: they can contain request secrets.
      if (error instanceof SignInError) throw error;
      throw browserFailed();
    } finally {
      clearTimeout(timer);
      clearTimeout(expiryTimer);
      caller?.removeEventListener('abort', onCallerAbort);
      if (active?.nonce === attempt.nonce) active = undefined;
      attempt.controller.abort(); // closes native waiting UI; nothing survives relaunch
      await closePrompt?.();
    }
  };
};
