/**
 * setupAuth wiring for device sign-in (#3867): a relay-only instance on a
 * public host resolves to device mode, advertises it, and serves the routes.
 * Run with: `NODE_ENV=test npx tsx --experimental-test-module-mocks --test packages/api/test/deviceAuthSetup.test.ts`
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, mock, test } from 'node:test';
import express from 'express';
import session from 'express-session';

const store = new session.MemoryStore();
await mock.module('connect-redis', { namedExports: { RedisStore: function RedisStore() { return store; } } });
await mock.module('redis', { namedExports: { createClient: () => ({ on() {}, async connect() {} }) } });
const { setupAuth } = await import('../auth.js');
const { closeConnection } = await import('@propr/core');
const { resetConfiguredDemoMode } = await import('../demoMode.js');

const environment: Record<string, string> = {
  FRONTEND_URL: 'https://my-propr.fly.dev',
  API_PUBLIC_URL: 'https://my-propr.fly.dev',
  SESSION_SECRET: 'device-setup-integration-session-secret-long-enough',
  GH_OAUTH_CALLBACK_URL: 'https://my-propr.fly.dev/api/auth/github/callback',
  PROPR_GH_RELAY_URL: 'https://webhook.propr.dev/v1',
  PROPR_GH_RELAY_TOKEN: 'prt_integration',
  PROPR_UI_TUNNEL_ENABLED: 'false',
  PROPR_DEMO_MODE: 'false',
  PROPR_AUTH_RATE_LIMIT_MAX: '1000',
};
const cleared = ['GH_OAUTH_CLIENT_ID', 'GH_OAUTH_CLIENT_SECRET', 'PROPR_WEB_AUTH_MODE', 'COOKIE_DOMAIN'];
const originalEnvironment = Object.fromEntries([...Object.keys(environment), ...cleared].map(key => [key, process.env[key]]));
let origin: string;
let server: ReturnType<express.Express['listen']>;
let close: () => Promise<void>;

before(async () => {
  for (const key of cleared) delete process.env[key];
  Object.assign(process.env, environment);
  const app = express();
  app.use(express.json());
  ({ close } = setupAuth(app, false));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await close();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfiguredDemoMode();
  await closeConnection();
});

test('a relay-only instance on a public host advertises device sign-in', async () => {
  const response = await fetch(`${origin}/api/auth/sign-in-method`);
  assert.deepEqual(await response.json(), { mode: 'device' });
});

test('the OAuth start and callback send browsers back to the login page', async () => {
  for (const path of ['/api/auth/github', '/api/auth/github/callback?code=x&state=y']) {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('location'), 'https://my-propr.fly.dev/login', path);
  }
});

test('device routes are mounted and bound to a session', async () => {
  const response = await fetch(`${origin}/api/auth/device/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ attempt: 'not-this-browser' }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, 'device_login_missing');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
