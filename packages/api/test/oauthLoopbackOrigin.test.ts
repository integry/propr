import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { closeConnection } from '@propr/core';
import express, { type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import session from 'express-session';
import passport from 'passport';
import { createConnectCallbackHandler, createOAuthStartHandler, shouldUseSecureSessionCookie } from '../auth.js';
import { configuredLoopbackCallbackOrigin, loopbackOAuthStartRedirect } from '../authLoopbackOrigin.js';
import type { GitHubUser } from '../authTypes.js';

const ENV_KEYS = ['API_PUBLIC_URL', 'FRONTEND_URL', 'GH_OAUTH_CALLBACK_URL', 'PROPR_CONNECT_URL', 'PROPR_GH_RELAY_URL', 'PROPR_GH_RELAY_TOKEN', 'GH_INSTALLATION_ID'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const FRONTEND_URL = 'http://localhost:5174';
const fakeUser: GitHubUser = {
  id: '123', login: 'octocat', username: 'octocat', displayName: 'Octocat', email: null, avatarUrl: null, accessToken: 'gho_fixture',
};

let server: Server;
let port = 0;
let redeemed: string[] = [];

/** Browser-like jar: cookies are scoped by hostname and shared across ports. */
class CookieJar {
  private readonly cookies = new Map<string, string>();
  store(url: URL, response: Response) {
    for (const header of response.headers.getSetCookie()) {
      this.cookies.set(url.hostname, header.split(';', 1)[0]);
    }
  }
  header(url: URL) { return this.cookies.get(url.hostname); }
  hostnames() { return [...this.cookies.keys()]; }
}

async function browse(jar: CookieJar, href: string) {
  const url = new URL(href);
  const cookie = jar.header(url);
  const response = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  jar.store(url, response);
  return { status: response.status, location: response.headers.get('location') ?? '' };
}

/** Follow local redirects until the browser would leave for ProPR Connect. */
async function startLogin(jar: CookieJar, href: string) {
  const hops: string[] = [];
  let next = href;
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await browse(jar, next);
    assert.equal(response.status, 302);
    if (!response.location.startsWith('http://')) return { connect: new URL(response.location), hops };
    hops.push(response.location);
    next = response.location;
  }
  throw new Error('OAuth start did not reach Connect');
}

/** Session cookie attributes the API uses for a plain-HTTP loopback deployment. */
function loopbackSessionCookie() {
  process.env.API_PUBLIC_URL = 'http://localhost:4000';
  const secure = shouldUseSecureSessionCookie(undefined);
  // Secure cookies are never stored over plain HTTP, so loopback Desktop must not set them.
  assert.equal(secure, false);
  return { secure, httpOnly: true, sameSite: 'lax' } as const;
}

before(async () => {
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 100 }));
  const testPassport = new passport.Passport();
  testPassport.serializeUser((user, done) => done(null, user));
  testPassport.deserializeUser((user: Express.User, done) => done(null, user));
  app.use(session({ secret: 'loopback-oauth-origin-test-secret-long-enough', resave: false, saveUninitialized: false, cookie: loopbackSessionCookie() }));
  app.use(testPassport.initialize());
  app.use(testPassport.session());
  app.get('/api/auth/github', createOAuthStartHandler('connect', false));
  app.get('/api/auth/github/callback', createConnectCallbackHandler(async ({ code }) => {
    redeemed.push(code);
    return fakeUser;
  }));
  app.get('/whoami', (req, res) => { res.json({ user: (req.user as GitHubUser | undefined)?.username ?? null }); });
  // Dual-stack listener: one API process reachable on every supported alias.
  server = app.listen(0, '::');
  await new Promise<void>(resolve => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

beforeEach(() => {
  redeemed = [];
  process.env.FRONTEND_URL = FRONTEND_URL;
  process.env.GH_OAUTH_CALLBACK_URL = `http://localhost:${port}/api/auth/github/callback`;
  process.env.PROPR_CONNECT_URL = 'https://connect.propr.dev';
  process.env.PROPR_GH_RELAY_URL = 'https://relay.invalid';
  process.env.PROPR_GH_RELAY_TOKEN = 'fixture-relay-token';
  delete process.env.GH_INSTALLATION_ID;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await closeConnection();
});

for (const alias of ['127.0.0.1', '[::1]', 'localhost']) {
  test(`saved ${alias} profile starts OAuth on the configured callback origin and renews the grant`, async () => {
    const jar = new CookieJar();
    const redirectTo = `${FRONTEND_URL}/review`;
    const { connect, hops } = await startLogin(jar, `http://${alias}:${port}/api/auth/github?redirect_to=${encodeURIComponent(redirectTo)}`);

    const callbackUrl = new URL(connect.searchParams.get('callback_url')!);
    assert.equal(callbackUrl.href, process.env.GH_OAUTH_CALLBACK_URL);
    assert.deepEqual(hops, alias === 'localhost' ? [] : [`http://localhost:${port}/api/auth/github?redirect_to=${encodeURIComponent(redirectTo)}`]);
    // State is created only on the callback host; the alias never gets a session.
    assert.deepEqual(jar.hostnames(), ['localhost']);

    callbackUrl.searchParams.set('state', connect.searchParams.get('state')!);
    callbackUrl.searchParams.set('code', 'fixture-code');
    const callback = await browse(jar, callbackUrl.href);
    assert.equal(callback.status, 302);
    assert.equal(callback.location, redirectTo);
    assert.deepEqual(redeemed, ['fixture-code']);

    const whoami = await fetch(`http://localhost:${port}/whoami`, { headers: { cookie: jar.header(callbackUrl)! } });
    assert.deepEqual(await whoami.json(), { user: 'octocat' });
  });
}

test('a tampered state is rejected before any provider redemption', async () => {
  const jar = new CookieJar();
  const { connect } = await startLogin(jar, `http://127.0.0.1:${port}/api/auth/github`);
  const callbackUrl = new URL(connect.searchParams.get('callback_url')!);
  callbackUrl.searchParams.set('state', `${connect.searchParams.get('state')}x`);
  callbackUrl.searchParams.set('code', 'fixture-code');

  const callback = await browse(jar, callbackUrl.href);
  assert.equal(callback.location, `${FRONTEND_URL}/login?error=oauth_state_mismatch`);
  assert.deepEqual(redeemed, []);

  // The consumed state cannot be replayed with the original value either.
  callbackUrl.searchParams.set('state', connect.searchParams.get('state')!);
  assert.equal((await browse(jar, callbackUrl.href)).location, `${FRONTEND_URL}/login?error=oauth_state_mismatch`);
  assert.deepEqual(redeemed, []);
});

test('a callback without the starting session cookie is still rejected before redemption', async () => {
  const { connect } = await startLogin(new CookieJar(), `http://[::1]:${port}/api/auth/github`);
  const callbackUrl = new URL(connect.searchParams.get('callback_url')!);
  callbackUrl.searchParams.set('state', connect.searchParams.get('state')!);
  callbackUrl.searchParams.set('code', 'fixture-code');

  const callback = await browse(new CookieJar(), callbackUrl.href);
  assert.equal(callback.location, `${FRONTEND_URL}/login?error=oauth_state_mismatch`);
  assert.deepEqual(redeemed, []);
});

test('an IPv6 callback configuration canonicalizes other loopback aliases to [::1]', async () => {
  process.env.GH_OAUTH_CALLBACK_URL = `http://[::1]:${port}/api/auth/github/callback`;
  const jar = new CookieJar();
  const { hops } = await startLogin(jar, `http://localhost:${port}/api/auth/github`);
  assert.deepEqual(hops, [`http://[::1]:${port}/api/auth/github`]);
  assert.deepEqual(jar.hostnames(), ['[::1]']);
});

function requestFor(host: string, query: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return { headers: { host, ...headers }, query } as unknown as Request;
}

test('the canonical start target derives only from validated loopback callback configuration', () => {
  const callback = 'http://localhost:4000/api/auth/github/callback';
  assert.equal(loopbackOAuthStartRedirect(requestFor('127.0.0.1:4000'), callback), 'http://localhost:4000/api/auth/github');
  // The request Host never chooses the destination.
  assert.equal(loopbackOAuthStartRedirect(requestFor('127.0.0.2:9999'), callback), 'http://localhost:4000/api/auth/github');
  // An untrusted redirect_to is dropped rather than forwarded.
  assert.equal(
    loopbackOAuthStartRedirect(requestFor('127.0.0.1:4000', { redirect_to: 'https://attacker.example/steal' }), callback),
    'http://localhost:4000/api/auth/github',
  );
  assert.equal(
    loopbackOAuthStartRedirect(requestFor('127.0.0.1:4000', { redirect_to: `${FRONTEND_URL}/review` }), callback),
    `http://localhost:4000/api/auth/github?redirect_to=${encodeURIComponent(`${FRONTEND_URL}/review`)}`,
  );
});

test('non-loopback, reverse-proxy and spoofed hosts keep the existing same-origin start', () => {
  const loopbackCallback = 'http://localhost:4000/api/auth/github/callback';
  assert.equal(loopbackOAuthStartRedirect(requestFor('localhost:4000'), loopbackCallback), null);
  assert.equal(loopbackOAuthStartRedirect(requestFor('LOCALHOST:4000'), loopbackCallback), null);
  assert.equal(loopbackOAuthStartRedirect(requestFor('attacker.example'), loopbackCallback), null);
  assert.equal(loopbackOAuthStartRedirect(requestFor('2130706433:4000'), loopbackCallback), null);
  assert.equal(loopbackOAuthStartRedirect(requestFor('[::ffff:127.0.0.1]:4000'), loopbackCallback), null);
  assert.equal(loopbackOAuthStartRedirect(requestFor('127.0.0.1:4000', {}, { 'x-forwarded-host': 'propr.example.com' }), loopbackCallback), null);
  assert.equal(loopbackOAuthStartRedirect(requestFor('127.0.0.1:4000', {}, { forwarded: 'host=propr.example.com' }), loopbackCallback), null);
  assert.equal(loopbackOAuthStartRedirect(requestFor('127.0.0.1:4000'), 'https://propr.example.com/api/auth/github/callback'), null);
  assert.equal(loopbackOAuthStartRedirect(requestFor('127.0.0.1:4000'), undefined), null);
});

test('only an exact plain-HTTP loopback callback route is trusted as a canonical origin', () => {
  assert.equal(configuredLoopbackCallbackOrigin('http://localhost:4000/api/auth/github/callback'), 'http://localhost:4000');
  assert.equal(configuredLoopbackCallbackOrigin('http://[::1]:4000/api/auth/github/callback'), 'http://[::1]:4000');
  assert.equal(configuredLoopbackCallbackOrigin('http://localhost:4000/other'), null);
  assert.equal(configuredLoopbackCallbackOrigin('http://localhost:4000/api/auth/github/callback?next=x'), null);
  assert.equal(configuredLoopbackCallbackOrigin('http://user@localhost:4000/api/auth/github/callback'), null);
  assert.equal(configuredLoopbackCallbackOrigin('https://propr.example.com/api/auth/github/callback'), null);
  assert.equal(configuredLoopbackCallbackOrigin('http://0x7f000001:4000/api/auth/github/callback'), null);
});

test('direct GitHub mode redirects aliases before Passport creates session state', async () => {
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 100 }));
  app.use(session({ secret: 'loopback-oauth-origin-test-secret-long-enough', resave: false, saveUninitialized: false, cookie: loopbackSessionCookie() }));
  let passportReached = false;
  app.get('/api/auth/github', createOAuthStartHandler('github', false), () => { passportReached = true; });
  const github = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => github.once('listening', resolve));
  try {
    const githubPort = (github.address() as AddressInfo).port;
    process.env.GH_OAUTH_CALLBACK_URL = `http://localhost:${githubPort}/api/auth/github/callback`;
    const response = await fetch(`http://127.0.0.1:${githubPort}/api/auth/github`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `http://localhost:${githubPort}/api/auth/github`);
    assert.deepEqual(response.headers.getSetCookie(), []);
    assert.equal(passportReached, false);
  } finally {
    await new Promise<void>((resolve, reject) => github.close(error => error ? reject(error) : resolve()));
  }
});
