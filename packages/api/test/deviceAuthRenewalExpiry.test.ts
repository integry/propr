/**
 * Device sign-in (#3867): a device sign-in renews by sending its refresh token
 * to the relay's `/auth/instance-grants/refresh`. Until the relay serves that
 * route (integry/propr-routing#340) it answers 404, which can never succeed
 * on retry, so the session must ask for a new sign-in instead of keeping an
 * expired token. Relay 5xx, timeouts and network errors stay temporary, and
 * Connect and GitHub OAuth sessions keep their classification. Run with:
 * `NODE_ENV=test npx tsx --test packages/api/test/deviceAuthRenewalExpiry.test.ts`
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { Request } from 'express';
import { closeConnection } from '@propr/core';
import { up as createGitHubUserGrants } from '../../core/src/db/migrations/20260908000000_create_github_user_grants.js';
import { up as addGitHubOAuthGrantRevision } from '../../core/src/db/migrations/20260908010000_add_github_oauth_grant_revision.js';
import { up as addRelayRenewal } from '../../core/src/db/migrations/20261029180000_add_github_user_grant_relay_renewal.js';
import { refreshGitHubTokenWithResult } from '../authGithubTokens.js';
import type { GitHubUser } from '../authTypes.js';
import { configureDemoMode, resetConfiguredDemoMode } from '../demoMode.js';
import { DEVICE_SIGN_IN_EXPIRED, DEVICE_SIGN_IN_EXPIRED_MESSAGE, deviceRefreshRequiresReauth } from '../deviceGrantRenewal.js';
import { GitHubUserGrantService } from '../githubUserGrantService.js';
import { ACCESS_TOKEN, Browser, REFRESH_TOKEN, startHarness } from './deviceAuthHarness.js';

const RELAY = 'https://relay.example.test/v1';
const REFRESH_URL = `${RELAY}/auth/instance-grants/refresh`;
const USER_ID = '583231';
const EIGHT_HOURS_S = 28_800;
const originalFetch = globalThis.fetch;
const previousEnv = { url: process.env.PROPR_GH_RELAY_URL, token: process.env.PROPR_GH_RELAY_TOKEN };

type RelayAnswer = () => Response | Promise<Response>;
let relayAnswer: RelayAnswer;
let relayBodies: unknown[];

const relayFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  assert.equal(request.url, REFRESH_URL, 'device grants renew only through the refresh route');
  relayBodies.push(await request.json());
  return relayAnswer();
}) as typeof fetch;

beforeEach(() => {
  configureDemoMode(false);
  process.env.PROPR_GH_RELAY_URL = RELAY;
  process.env.PROPR_GH_RELAY_TOKEN = 'prt_relay';
  relayBodies = [];
  // The session fallback uses global fetch; the test browser still reaches the local server.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith(RELAY) ? relayFetch(input, init) : originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetConfiguredDemoMode();
  if (previousEnv.url === undefined) delete process.env.PROPR_GH_RELAY_URL;
  else process.env.PROPR_GH_RELAY_URL = previousEnv.url;
  if (previousEnv.token === undefined) delete process.env.PROPR_GH_RELAY_TOKEN;
  else process.env.PROPR_GH_RELAY_TOKEN = previousEnv.token;
});

after(async () => {
  await closeConnection();
});

/** Signs a browser in with a device code issued nine hours ago: its 8-hour token has expired. */
async function expiredDeviceSession() {
  const harness = await startHarness();
  harness.clock.now = Date.now() - 9 * 60 * 60 * 1000;
  const browser = new Browser(harness.origin);
  const start = await browser.post('/api/auth/device/start');
  harness.clock.now += 5_000;
  harness.github.tokenAnswers.push({
    access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: EIGHT_HOURS_S, refresh_token_expires_in: 15_897_600,
  });
  const done = await browser.post('/api/auth/device/poll', { attempt: start.body.attempt });
  assert.deepEqual(done.body, { status: 'complete' }, done.text);
  assert.equal((await browser.get('/me')).authenticated, true);
  return { harness, browser };
}

const reauthCases: Array<{ name: string; answer: RelayAnswer }> = [
  { name: 'relay 404 (no refresh route yet)', answer: () => new Response('Not Found', { status: 404 }) },
  { name: 'relay 405', answer: () => new Response('', { status: 405 }) },
  { name: 'relay 501', answer: () => Response.json({ error: 'not_implemented' }, { status: 501 }) },
  { name: 'relay 400 bad_refresh_token', answer: () => Response.json({ error: 'bad_refresh_token' }, { status: 400 }) },
  { name: 'relay 401 invalid_grant', answer: () => Response.json({ error: 'invalid_grant' }, { status: 401 }) },
  { name: 'relay 409 reauth_required', answer: () => Response.json({ error: 'reauth_required' }, { status: 409 }) },
  { name: 'relay 200 bad_refresh_token', answer: () => Response.json({ error: 'bad_refresh_token' }) },
];

for (const { name, answer } of reauthCases) {
  test(`expired device session, ${name}: /api/auth/user requires a new device sign-in`, async () => {
    const { harness, browser } = await expiredDeviceSession();
    relayAnswer = answer;
    try {
      const user = await browser.getWithStatus('/api/auth/user');
      assert.equal(user.status, 401);
      assert.deepEqual(user.body, {
        error: 'GitHub authentication expired',
        code: 'GITHUB_REAUTH_REQUIRED',
        reason: DEVICE_SIGN_IN_EXPIRED,
        message: DEVICE_SIGN_IN_EXPIRED_MESSAGE,
      });
      assert.deepEqual(relayBodies, [{ refresh_token: REFRESH_TOKEN }]);
      // The expired session is gone: the next load is signed out, and the relay is not asked again.
      assert.equal((await browser.get('/me')).authenticated, false);
      assert.equal((await browser.getWithStatus('/api/auth/user')).status, 401);
      assert.equal(relayBodies.length, 1);
      // A new device sign-in still works on the same browser.
      const restart = await browser.post('/api/auth/device/start');
      assert.equal(restart.status, 200, restart.text);
    } finally {
      await harness.close();
    }
  });
}

const temporaryCases: Array<{ name: string; answer: RelayAnswer }> = [
  { name: 'relay 503', answer: () => new Response('Service Unavailable', { status: 503 }) },
  { name: 'relay 500 bad_refresh_token', answer: () => Response.json({ error: 'bad_refresh_token' }, { status: 500 }) },
  { name: 'relay 429', answer: () => Response.json({ error: 'rate_limited' }, { status: 429 }) },
  { name: 'network error', answer: () => { throw new TypeError('fetch failed'); } },
  { name: 'timeout', answer: () => { throw new DOMException('The operation timed out.', 'TimeoutError'); } },
];

for (const { name, answer } of temporaryCases) {
  test(`expired device session, ${name}: renewal stays temporarily unavailable`, async () => {
    const { harness, browser } = await expiredDeviceSession();
    relayAnswer = answer;
    try {
      const user = await browser.getWithStatus('/api/auth/user');
      assert.equal(user.status, 503);
      assert.equal(user.body.code, 'GITHUB_TOKEN_REFRESH_UNAVAILABLE');
      // Still signed in, so a later retry can renew.
      assert.equal((await browser.get('/me')).authenticated, true);
      await browser.getWithStatus('/api/auth/user');
      assert.equal(relayBodies.length, 2, 'the next request retries the renewal');
    } finally {
      await harness.close();
    }
  });
}

function requestFor(user: GitHubUser): Request & { destroyed: boolean } {
  const request = {
    user,
    sessionID: `session-${Math.random()}`,
    headers: {},
    destroyed: false,
    isAuthenticated: () => true,
    session: { save: (done: (err?: Error) => void) => done(), destroy: (done: (err?: Error) => void) => { request.destroyed = true; done(); } },
    logout: (done: (err?: Error) => void) => done(),
  };
  return request as unknown as Request & { destroyed: boolean };
}

function expiredUser(overrides: Partial<GitHubUser> = {}): GitHubUser {
  return {
    id: USER_ID, login: 'octocat', username: 'octocat', displayName: 'octocat', email: null, avatarUrl: null,
    accessToken: 'ghu_expired_access', refreshToken: 'ghr_device_refresh', tokenExpiresAt: Date.now() - 1_000,
    oauthSource: 'connect', ...overrides,
  };
}

const noSharedGrant = { refreshAndGetForOwner: async () => null };

test('Connect and GitHub OAuth sessions keep treating a relay 404 as temporary', async () => {
  relayAnswer = () => new Response('Not Found', { status: 404 });
  const missingGrant = { resolve: async () => ({ status: 'missing' as const }), updateIfOwner: async () => false };
  const connect = requestFor(expiredUser());
  const connectResult = await refreshGitHubTokenWithResult(connect, true, { userGrantService: missingGrant, visualPreviewService: noSharedGrant });
  assert.equal(connectResult.status, 'temporarily-unavailable');
  assert.equal(connect.user?.githubAuthInvalid, undefined);
  assert.equal(relayBodies.length, 1);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as typeof fetch;
  try {
    const github = requestFor(expiredUser({ oauthSource: 'github' }));
    const githubResult = await refreshGitHubTokenWithResult(github, true, { userGrantService: missingGrant, visualPreviewService: noSharedGrant });
    assert.equal(githubResult.status, 'temporarily-unavailable');
    assert.equal(github.user?.githubAuthInvalid, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('classification: missing route or a refusal requires re-auth, server errors stay temporary', () => {
  for (const status of [404, 405, 501]) assert.equal(deviceRefreshRequiresReauth({ status }), true, String(status));
  for (const error of ['bad_refresh_token', 'invalid_grant', 'reauth_required']) {
    assert.equal(deviceRefreshRequiresReauth({ status: 400, error }), true, error);
    assert.equal(deviceRefreshRequiresReauth({ error }), true, `200 ${error}`);
    assert.equal(deviceRefreshRequiresReauth({ status: 502, error }), false, `502 ${error}`);
  }
  for (const status of [400, 401, 403, 429, 500, 502, 503, 504]) assert.equal(deviceRefreshRequiresReauth({ status }), false, String(status));
  assert.equal(deviceRefreshRequiresReauth({ status: 400, error: 'slow_down' }), false);
});

// The durable grant (desktop, MCP, agent runs, and the session's first stop).
let database: Knex;

async function grantDatabase(): Promise<Knex> {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createGitHubUserGrants(database);
  await addGitHubOAuthGrantRevision(database);
  await addRelayRenewal(database);
  return database;
}

const grantEnvironment = { SESSION_SECRET: 'device-renewal-expiry-secret', PROPR_GH_RELAY_URL: RELAY, PROPR_GH_RELAY_TOKEN: 'prt_relay' };

async function grantRow() {
  return database('github_user_grants').where({ github_user_id: USER_ID }).first() as Promise<{ status: string; last_error_code: string | null; renewal: string | null }>;
}

test('durable device grant: relay 404 marks it for a new sign-in, and the session follows', async () => {
  const db = await grantDatabase();
  relayAnswer = () => new Response('Not Found', { status: 404 });
  try {
    const service = new GitHubUserGrantService(db, grantEnvironment, relayFetch);
    const user = expiredUser({ signInMethod: 'device' });
    await service.capture(user);
    assert.equal((await grantRow()).renewal, 'device');

    const req = requestFor({ ...user });
    const result = await refreshGitHubTokenWithResult(req, true, { userGrantService: service, visualPreviewService: noSharedGrant });
    assert.equal(result.status, 'reauth-required');
    assert.equal(req.user?.githubAuthInvalid, true);
    assert.equal(req.user?.accessToken, '', 'the expired token is not kept');
    assert.deepEqual(relayBodies, [{ refresh_token: 'ghr_device_refresh' }]);
    const row = await grantRow();
    assert.equal(row.status, 'reauth_required');
    assert.equal(row.last_error_code, DEVICE_SIGN_IN_EXPIRED);
    assert.deepEqual(await service.resolve(USER_ID), { status: 'reauth_required', reason: DEVICE_SIGN_IN_EXPIRED });
    assert.equal(relayBodies.length, 1, 'a grant that needs a new sign-in is not renewed again');
  } finally {
    await db.destroy();
  }
});

test('durable device grant: relay 503 keeps it active and retryable', async () => {
  const db = await grantDatabase();
  relayAnswer = () => new Response('Service Unavailable', { status: 503 });
  try {
    const service = new GitHubUserGrantService(db, grantEnvironment, relayFetch);
    await service.capture(expiredUser({ signInMethod: 'device' }));
    assert.deepEqual(await service.resolve(USER_ID), { status: 'temporarily_unavailable' });
    assert.equal((await grantRow()).status, 'active');
    const req = requestFor(expiredUser({ signInMethod: 'device' }));
    const result = await refreshGitHubTokenWithResult(req, true, { userGrantService: service, visualPreviewService: noSharedGrant });
    assert.equal(result.status, 'temporarily-unavailable');
    assert.equal(req.user?.githubAuthInvalid, undefined);
  } finally {
    await db.destroy();
  }
});

test('durable device grant: relay bad_refresh_token requires a new sign-in', async () => {
  const db = await grantDatabase();
  relayAnswer = () => Response.json({ error: 'bad_refresh_token' }, { status: 400 });
  try {
    const service = new GitHubUserGrantService(db, grantEnvironment, relayFetch);
    await service.capture(expiredUser({ signInMethod: 'device' }));
    assert.deepEqual(await service.resolve(USER_ID), { status: 'reauth_required', reason: DEVICE_SIGN_IN_EXPIRED });
  } finally {
    await db.destroy();
  }
});

test('durable Connect grant: relay 404 stays temporary', async () => {
  const db = await grantDatabase();
  relayAnswer = () => new Response('Not Found', { status: 404 });
  try {
    const service = new GitHubUserGrantService(db, grantEnvironment, relayFetch);
    await service.capture(expiredUser());
    assert.equal((await grantRow()).renewal, null);
    assert.deepEqual(await service.resolve(USER_ID), { status: 'temporarily_unavailable' });
    assert.equal((await grantRow()).status, 'active');
  } finally {
    await db.destroy();
  }
});
