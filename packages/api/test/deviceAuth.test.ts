/**
 * Dashboard sign-in through GitHub device flow (#3867), end to end through
 * Express sessions with GitHub mocked. Run with:
 * `NODE_ENV=test npx tsx --test packages/api/test/deviceAuth.test.ts`
 */import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { closeConnection } from '@propr/core';
import express from 'express';
import session from 'express-session';
import { pollGitHubDeviceToken, requestGitHubDeviceCode } from '@propr/shared';
import {
  DEVICE_SESSION_START_LIMIT,
  registerDeviceSignInRoutes,
  userCanAccessRelayInstallation,
} from '../deviceAuth.js';
import {
  ACCESS_TOKEN,
  Browser,
  DEVICE_CODE,
  REFRESH_TOKEN,
  RELAY_INSTALLATION_TOKEN,
  fakeGitHub,
  startHarness,
  tokenCalls,
} from './deviceAuthHarness.js';

const logs: string[] = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
const originalEnv = { ...process.env };

beforeEach(() => {
  logs.length = 0;
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      logs.push(args.map(arg => (arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
  }
  delete process.env.GITHUB_USER_WHITELIST;
});

afterEach(() => {
  Object.assign(console, originalConsole);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

after(async () => {
  await closeConnection();
});
test('device sign-in: pending, slow_down and success create the normal session', async () => {
  const harness = await startHarness();
  const browser = new Browser(harness.origin);
  try {
    const start = await browser.post('/api/auth/device/start');
    assert.equal(start.status, 200);
    assert.equal(start.body.userCode, 'WDJB-MJHT');
    assert.equal(start.body.verificationUri, 'https://github.com/login/device');
    assert.equal(start.body.interval, 5);
    assert.equal(typeof start.body.attempt, 'string');
    assert.ok(!start.text.includes(DEVICE_CODE), 'the device code stays server-side');
    const codeRequest = harness.github.calls.find(call => call.url === 'https://github.com/login/device/code');
    assert.equal(new URLSearchParams(codeRequest?.body).get('client_id'), 'Iv23liTCmmSNYyD0NtZA');
    assert.equal(new URLSearchParams(codeRequest?.body).get('client_secret'), null);
    const attempt = start.body.attempt;

    // Before the interval elapses the API does not call GitHub.
    const early = await browser.post('/api/auth/device/poll', { attempt });
    assert.equal(early.body.status, 'pending');
    assert.equal(tokenCalls(harness.github).length, 0);

    harness.clock.now += 5_000;
    harness.github.tokenAnswers.push({ error: 'authorization_pending' });
    const pending = await browser.post('/api/auth/device/poll', { attempt });
    assert.equal(pending.body.status, 'pending');
    assert.equal(pending.body.interval, 5);
    assert.equal(tokenCalls(harness.github).length, 1);
    const pollBody = new URLSearchParams(tokenCalls(harness.github)[0].body);
    assert.equal(pollBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(pollBody.get('device_code'), DEVICE_CODE);

    harness.clock.now += 5_000;
    harness.github.tokenAnswers.push({ error: 'slow_down', interval: 10 });
    const slowed = await browser.post('/api/auth/device/poll', { attempt });
    assert.equal(slowed.body.status, 'pending');
    assert.equal(slowed.body.interval, 10);

    // The slowed interval is honoured: five seconds later is still too early.
    harness.clock.now += 5_000;
    await browser.post('/api/auth/device/poll', { attempt });
    assert.equal(tokenCalls(harness.github).length, 2);

    harness.clock.now += 5_000;
    harness.github.tokenAnswers.push({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: 28_800,
      refresh_token_expires_in: 15_897_600,
      token_type: 'bearer',
    });
    const done = await browser.post('/api/auth/device/poll', { attempt });
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(done.body, { status: 'complete' });

    assert.deepEqual(await browser.get('/me'), { authenticated: true, login: 'octocat', source: 'connect' });
    const stored = await browser.get('/session-user');
    assert.equal(stored.hasAccessToken, true);
    assert.equal(stored.hasRefreshToken, true);
    assert.equal(stored.tokenExpiresAt, harness.clock.now + 28_800_000);
    assert.equal(stored.refreshTokenExpiresAt, harness.clock.now + 15_897_600_000);

    // GitHub saw the user token only on its own API.
    const userCalls = harness.github.calls.filter(call => call.authorization === `Bearer ${ACCESS_TOKEN}`);
    assert.ok(userCalls.length >= 2);
    assert.ok(userCalls.every(call => call.url.startsWith('https://api.github.com/user')));

    // The attempt is spent.
    const replay = await browser.post('/api/auth/device/poll', { attempt });
    assert.equal(replay.body.error, 'device_login_missing');

    for (const line of logs) {
      assert.ok(!line.includes(ACCESS_TOKEN) && !line.includes(REFRESH_TOKEN) && !line.includes(DEVICE_CODE), line);
    }
  } finally {
    await harness.close();
  }
});

test('device sign-in: the code belongs to the browser that started it', async () => {
  const harness = await startHarness();
  const owner = new Browser(harness.origin);
  const other = new Browser(harness.origin);
  try {
    const start = await owner.post('/api/auth/device/start');
    harness.clock.now += 5_000;
    harness.github.tokenAnswers.push({ access_token: ACCESS_TOKEN });
    const stolen = await other.post('/api/auth/device/poll', { attempt: start.body.attempt });
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.error, 'device_login_missing');
    assert.equal(tokenCalls(harness.github).length, 0);

    // A second start replaces the first: one code per attempt.
    const second = await owner.post('/api/auth/device/start');
    assert.notEqual(second.body.attempt, start.body.attempt);
    const stale = await owner.post('/api/auth/device/poll', { attempt: start.body.attempt });
    assert.equal(stale.body.error, 'device_login_missing');

    // Starts must be JSON (forces a CORS preflight cross-origin).
    const form = await fetch(`${harness.origin}/api/auth/device/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'x=1',
    });
    assert.equal(form.status, 415);
  } finally {
    await harness.close();
  }
});

test('device sign-in: terminal GitHub errors end the attempt with clear messages', async () => {
  for (const [answer, code, message] of [
    [{ error: 'access_denied' }, 'access_denied', /cancelled/],
    [{ error: 'expired_token' }, 'expired_token', /expired/],
    [{ error: 'device_flow_disabled' }, 'device_flow_disabled', /Device sign-in isn't enabled for this GitHub App/],
  ] as const) {
    const harness = await startHarness();
    const browser = new Browser(harness.origin);
    try {
      const start = await browser.post('/api/auth/device/start');
      harness.clock.now += 5_000;
      harness.github.tokenAnswers.push(answer);
      const failed = await browser.post('/api/auth/device/poll', { attempt: start.body.attempt });
      assert.equal(failed.body.status, 'failed', code);
      assert.equal(failed.body.error, code);
      assert.match(String(failed.body.message), message);
      assert.deepEqual(await browser.get('/me'), { authenticated: false });
      const again = await browser.post('/api/auth/device/poll', { attempt: start.body.attempt });
      assert.equal(again.body.error, 'device_login_missing');
    } finally {
      await harness.close();
    }
  }
});

test('device sign-in: a code past expires_in is refused without asking GitHub', async () => {
  const harness = await startHarness();
  const browser = new Browser(harness.origin);
  try {
    harness.github.deviceCodeAnswer.expires_in = 60;
    const start = await browser.post('/api/auth/device/start');
    harness.clock.now += 61_000;
    const expired = await browser.post('/api/auth/device/poll', { attempt: start.body.attempt });
    assert.equal(expired.body.error, 'expired_token');
    assert.equal(tokenCalls(harness.github).length, 0);
  } finally {
    await harness.close();
  }
});

test('device sign-in: device_flow_disabled when requesting the code', async () => {
  const harness = await startHarness();
  const browser = new Browser(harness.origin);
  try {
    harness.github.deviceCodeAnswer = { error: 'device_flow_disabled', error_description: 'Device flow is disabled' };
    const start = await browser.post('/api/auth/device/start');
    assert.equal(start.status, 400);
    assert.equal(start.body.error, 'device_flow_disabled');
    assert.equal(start.body.message, "Device sign-in isn't enabled for this GitHub App.");
  } finally {
    await harness.close();
  }
});

test('device sign-in: a user without access to the relay installation gets no session', async () => {
  const harness = await startHarness();
  const browser = new Browser(harness.origin);
  try {
    harness.github.installations = [{ id: 1, account: { id: 99, login: 'acme' } }];
    const start = await browser.post('/api/auth/device/start');
    harness.clock.now += 5_000;
    harness.github.tokenAnswers.push({ access_token: ACCESS_TOKEN });
    const denied = await browser.post('/api/auth/device/poll', { attempt: start.body.attempt });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'installation_access_denied');
    assert.ok(!denied.text.includes(ACCESS_TOKEN));
    assert.deepEqual(await browser.get('/me'), { authenticated: false });
  } finally {
    await harness.close();
  }
});

test('device sign-in: the instance whitelist still applies', async () => {
  const harness = await startHarness();
  const browser = new Browser(harness.origin);
  try {
    process.env.GITHUB_USER_WHITELIST = 'someone-else';
    const start = await browser.post('/api/auth/device/start');
    harness.clock.now += 5_000;
    harness.github.tokenAnswers.push({ access_token: ACCESS_TOKEN });
    const denied = await browser.post('/api/auth/device/poll', { attempt: start.body.attempt });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'not_authorized');
    assert.deepEqual(await browser.get('/me'), { authenticated: false });
  } finally {
    await harness.close();
  }
});

test('device sign-in: starts are limited per session', async () => {
  const harness = await startHarness();
  const browser = new Browser(harness.origin);
  try {
    for (let i = 0; i < DEVICE_SESSION_START_LIMIT; i++) {
      assert.equal((await browser.post('/api/auth/device/start')).status, 200);
    }
    const limited = await browser.post('/api/auth/device/start');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'too_many_attempts');
    // Another browser is not affected by this session's count.
    assert.equal((await new Browser(harness.origin).post('/api/auth/device/start')).status, 200);
    harness.clock.now += 15 * 60_000;
    assert.equal((await browser.post('/api/auth/device/start')).status, 200);
  } finally {
    await harness.close();
  }
});

test('device sign-in: starts are limited per IP', async () => {
  const github = fakeGitHub();
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'device-auth-test-secret-with-sufficient-length', resave: false, saveUninitialized: false }));
  registerDeviceSignInRoutes(app, {
    env: {}, now: Date.now, fetchImpl: github.fetchImpl, requestCode: requestGitHubDeviceCode, pollToken: pollGitHubDeviceToken,
    relayInstallationToken: async () => RELAY_INSTALLATION_TOKEN, finishLogin: () => {},
  }, { PROPR_DEVICE_SIGN_IN_START_RATE_LIMIT_MAX: '2' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Fresh sessions every time: only the IP bucket can stop them.
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await new Browser(origin).post('/api/auth/device/start')).status);
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('installation check without GH_INSTALLATION_ID matches the relay installation account', async () => {
  const github = fakeGitHub();
  const check = () => userCanAccessRelayInstallation({
    accessToken: ACCESS_TOKEN,
    fetchImpl: github.fetchImpl,
    relayInstallationToken: async () => RELAY_INSTALLATION_TOKEN,
  });
  assert.equal(await check(), true);
  const relayCall = github.calls.find(call => call.url.includes('/installation/repositories'));
  assert.equal(relayCall?.authorization, `Bearer ${RELAY_INSTALLATION_TOKEN}`);

  github.installations = [{ id: 7, account: { id: 1234, login: 'elsewhere' } }];
  assert.equal(await check(), false, 'another account’s installation of the App is not the relay’s');
  github.installations = [];
  assert.equal(await check(), false);
  github.installations = [{ id: 4242, account: { id: 99, login: 'acme' } }];
  github.relayRepositories = [];
  assert.equal(await check(), false, 'an undeterminable relay installation fails closed');

  // With GH_INSTALLATION_ID the IDs must match; malformed IDs never do.
  assert.equal(await userCanAccessRelayInstallation({ accessToken: ACCESS_TOKEN, installationId: '4242', fetchImpl: github.fetchImpl, relayInstallationToken: async () => '' }), true);
  assert.equal(await userCanAccessRelayInstallation({ accessToken: ACCESS_TOKEN, installationId: '4243', fetchImpl: github.fetchImpl, relayInstallationToken: async () => '' }), false);
  assert.equal(await userCanAccessRelayInstallation({ accessToken: ACCESS_TOKEN, installationId: '42 42', fetchImpl: github.fetchImpl, relayInstallationToken: async () => '' }), false);
});
