import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, mock, test } from 'node:test';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import passport from 'passport';
import type { Profile } from 'passport-github2';
import { createCorsOriginValidator } from '../corsValidation.js';
import { configureApiProxyTrust } from '../requestRateLimits.js';

// Replace infrastructure only: setupAuth installs the real GitHub strategy,
// OAuth state store, Passport session manager and express-session middleware.
// No deployed Redis, GitHub credentials, or backend jobs are involved.
const store = new session.MemoryStore();
await mock.module('connect-redis', {
  namedExports: {
    RedisStore: function RedisStore() { return store; },
  },
});
await mock.module('redis', {
  namedExports: {
    createClient: () => ({ on() {}, async connect() {} }),
  },
});
const { setupAuth } = await import('../auth.js');
const { closeConnection } = await import('@propr/core');
const { resetConfiguredDemoMode } = await import('../demoMode.js');

const environment = {
  FRONTEND_URL: 'https://ui.gitfix.dev',
  API_PUBLIC_URL: 'https://api.gitfix.dev',
  COOKIE_DOMAIN: '.gitfix.dev',
  SESSION_SECRET: 'github-callback-integration-session-secret-long-enough',
  GH_OAUTH_CLIENT_ID: 'integration-client',
  GH_OAUTH_CLIENT_SECRET: 'integration-secret',
  GH_OAUTH_CALLBACK_URL: 'https://api.gitfix.dev/api/auth/github/callback',
  PROPR_UI_TUNNEL_ENABLED: 'false',
  PROPR_DEMO_MODE: 'false',
  PROPR_ADMIN_USERS: 'pairing-user',
  GITHUB_USER_WHITELIST: '',
  AUTH_REDIRECT_ALLOWED_HOSTS: '',
  AUTH_ALLOW_HTTP_REDIRECT: 'false',
  PROPR_AUTH_RATE_LIMIT_MAX: '1000',
};
const originalEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
const pairingReturn = 'https://ui.gitfix.dev/desktop/pairing?pairing_id=integration-pairing-2286';
const accessToken = 'integration-only-access-token';
const refreshToken = 'integration-only-refresh-token';
let tokenExchanges = 0;
let origin: string;
let server: ReturnType<express.Express['listen']>;

interface StrategyTransport {
  _oauth2: {
    getOAuthAccessToken(code: string, params: object, done: (
      error: Error | null, accessToken?: string, refreshToken?: string, params?: object
    ) => void): void;
  };
  userProfile(token: string, done: (error: Error | null, profile?: Profile) => void): void;
}

before(async () => {
  Object.assign(process.env, environment);
  const app = express();
  configureApiProxyTrust(app, { PROPR_TRUSTED_PROXY_PEERS: 'loopback' });
  app.use(cors({
    origin: createCorsOriginValidator(environment.FRONTEND_URL, environment.COOKIE_DOMAIN),
    credentials: true,
  }));
  setupAuth(app, false);

  const strategy = (passport as unknown as { _strategy(name: string): StrategyTransport })._strategy('github');
  // Stub only GitHub's token/profile network boundary. State verification,
  // success(), req.login(), regeneration, serialization and deserialization run.
  strategy._oauth2.getOAuthAccessToken = (_code, _params, done) => {
    tokenExchanges += 1;
    done(null, accessToken, refreshToken, {});
  };
  strategy.userProfile = (_token, done) => done(null, {
    provider: 'github', id: '2286', username: 'pairing-user', displayName: 'Pairing User',
    profileUrl: 'https://github.com/pairing-user', _raw: '', _json: {},
  } as Profile);

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  Object.assign(process.env, environment);
  tokenExchanges = 0;
  await new Promise<void>((resolve, reject) => store.clear(error => error ? reject(error) : resolve()));
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfiguredDemoMode();
  mock.restoreAll();
  await closeConnection();
});

function request(path: string, cookie?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    redirect: 'manual',
    headers: {
      'x-forwarded-proto': 'https',
      origin: environment.FRONTEND_URL,
      ...(cookie ? { cookie } : {}),
    },
  });
}

function responseCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header);
  assert.match(header, /; Domain=\.gitfix\.dev;/);
  assert.match(header, /; HttpOnly;/);
  assert.match(header, /; Secure;/);
  assert.match(header, /; SameSite=Lax/);
  return header.split(';', 1)[0];
}

function sessionId(cookie: string): string {
  return decodeURIComponent(cookie.slice('connect.sid='.length)).slice(2).split('.')[0];
}

function storedSession(cookie: string): Promise<session.SessionData | null | undefined> {
  return new Promise((resolve, reject) => {
    store.get(sessionId(cookie), (error, value) => error ? reject(error) : resolve(value));
  });
}

async function startLogin(redirectTo?: string, cookie?: string) {
  const response = await request(`/api/auth/github${redirectTo === undefined ? '' : `?redirect_to=${encodeURIComponent(redirectTo)}`}`, cookie);
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.ok(location);
  const authorizationUrl = new URL(location);
  assert.equal(authorizationUrl.origin, 'https://github.com');
  const state = authorizationUrl.searchParams.get('state');
  assert.ok(state);
  assert.ok(!location.includes('pairing_id'));
  assert.ok(!location.includes(accessToken));
  return { cookie: responseCookie(response), state };
}

function callbackPath(state: string): string {
  return `/api/auth/github/callback?code=integration-code&state=${encodeURIComponent(state)}`;
}

test('GitHub login preserves the exact pairing return and authenticates subsequent browser requests after regeneration', async () => {
  assert.equal((await request('/api/auth/user')).status, 401);
  const start = await startLogin(pairingReturn);
  const anonymousSession = await storedSession(start.cookie);
  assert.ok(anonymousSession);
  // An unrelated anonymous field must not survive a successful login.
  await new Promise<void>((resolve, reject) => store.set(sessionId(start.cookie), {
    ...anonymousSession, anonymousSecret: 'do-not-preserve',
  } as session.SessionData, error => error ? reject(error) : resolve()));

  const callback = await request(`${callbackPath(start.state)}&redirect_to=https://evil.example/`, start.cookie);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), pairingReturn);
  assert.equal(tokenExchanges, 1);
  const authenticatedCookie = responseCookie(callback);
  assert.notEqual(sessionId(authenticatedCookie), sessionId(start.cookie));
  assert.equal(await storedSession(start.cookie), undefined);
  const authenticatedSession = await storedSession(authenticatedCookie);
  assert.ok(authenticatedSession);
  assert.deepEqual(Object.keys(authenticatedSession).sort(), ['cookie', 'passport']);

  // This is the actual endpoint App.tsx uses to populate browser user context,
  // on a separate request requiring Passport's persisted user deserialization.
  const userResponse = await request('/api/auth/user', authenticatedCookie);
  assert.equal(userResponse.status, 200);
  assert.equal(userResponse.headers.get('access-control-allow-origin'), environment.FRONTEND_URL);
  assert.equal(userResponse.headers.get('access-control-allow-credentials'), 'true');
  const user = await userResponse.json();
  assert.equal(user.id, '2286');
  assert.equal(user.username, 'pairing-user');
  assert.equal(user.accessToken, undefined);
  assert.equal(user.refreshToken, undefined);
  assert.ok(!JSON.stringify(user).includes(accessToken));
  assert.ok(!callback.headers.get('location')!.includes(refreshToken));
  assert.equal((await request('/api/auth/user', start.cookie)).status, 401);
});

test('ordinary GitHub login still uses the default frontend return', async () => {
  const start = await startLogin();
  const callback = await request(callbackPath(start.state), start.cookie);
  assert.equal(callback.headers.get('location'), `${environment.FRONTEND_URL}/`);
  assert.equal((await request('/api/auth/user', responseCookie(callback))).status, 200);
});

test('untrusted and insecure return URLs cannot survive OAuth login', async () => {
  for (const redirectTo of ['https://evil.example/desktop/pairing', 'https://ui.gitfix.dev.evil.example/', 'http://ui.gitfix.dev/', '//evil.example/', 'javascript:alert(1)']) {
    const start = await startLogin(redirectTo);
    const callback = await request(callbackPath(start.state), start.cookie);
    assert.equal(callback.headers.get('location'), `${environment.FRONTEND_URL}/`, redirectTo);
  }
});

test('a new login without a valid return clears an abandoned pairing return', async () => {
  for (const redirectTo of [undefined, 'https://evil.example/']) {
    const abandoned = await startLogin(pairingReturn);
    const start = await startLogin(redirectTo, abandoned.cookie);
    const callback = await request(callbackPath(start.state), start.cookie);
    assert.equal(callback.headers.get('location'), `${environment.FRONTEND_URL}/`);
  }
});

test('callback revalidates stored intent against the current redirect allowlist', async () => {
  process.env.AUTH_REDIRECT_ALLOWED_HOSTS = 'temporary.example';
  const start = await startLogin('https://temporary.example/desktop/pairing?pairing_id=2286');
  process.env.AUTH_REDIRECT_ALLOWED_HOSTS = '';
  const callback = await request(callbackPath(start.state), start.cookie);
  assert.equal(callback.headers.get('location'), `${environment.FRONTEND_URL}/`);
});

test('missing, mismatched, and sessionless OAuth state fail before token exchange', async () => {
  for (const mode of ['missing', 'mismatched', 'sessionless']) {
    const start = await startLogin(pairingReturn);
    const path = mode === 'missing' ? '/api/auth/github/callback?code=integration-code'
      : callbackPath(mode === 'mismatched' ? 'wrong-state' : start.state);
    const callback = await request(path, mode === 'sessionless' ? undefined : start.cookie);
    assert.equal(callback.headers.get('location'), '/login', mode);
    assert.equal(tokenExchanges, 0, mode);
    assert.equal((await request('/api/auth/user', start.cookie)).status, 401);
  }
});

test('successful OAuth state cannot be replayed with the old or regenerated cookie', async () => {
  const start = await startLogin(pairingReturn);
  const path = callbackPath(start.state);
  const callback = await request(path, start.cookie);
  for (const cookie of [start.cookie, responseCookie(callback)]) {
    const replay = await request(path, cookie);
    assert.equal(replay.headers.get('location'), '/login');
    assert.equal(tokenExchanges, 1);
  }
});

test('GitHub denial does not authenticate or return to pairing', async () => {
  const start = await startLogin(pairingReturn);
  const callback = await request(`/api/auth/github/callback?error=access_denied&state=${start.state}`, start.cookie);
  assert.equal(callback.headers.get('location'), '/login');
  assert.equal(tokenExchanges, 0);
  assert.equal((await request('/api/auth/user', start.cookie)).status, 401);
  assert.equal((await storedSession(start.cookie) as { redirectTo?: string }).redirectTo, undefined);
});

test('a non-whitelisted GitHub account cannot complete the pairing return or keep a browser login', async () => {
  process.env.GITHUB_USER_WHITELIST = 'someone-else';
  const start = await startLogin(pairingReturn);
  const callback = await request(callbackPath(start.state), start.cookie);
  assert.equal(callback.headers.get('location'), `${environment.FRONTEND_URL}/login?error=not_authorized`);
  assert.equal((await request('/api/auth/user', start.cookie)).status, 401);
  const sessionCount = await new Promise((resolve, reject) => store.length((error, value) => error ? reject(error) : resolve(value)));
  assert.equal(sessionCount, 0);
});
