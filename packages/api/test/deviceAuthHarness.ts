/**
 * Shared harness for the device sign-in suites (#3867): Express sessions,
 * Passport and a fake GitHub that can hold its answers mid-request.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { pollGitHubDeviceToken, requestGitHubDeviceCode } from '@propr/shared';
import { createDeviceFinishLogin } from '../auth.js';
import { registerDeviceSignInRoutes, type DeviceSignInDependencies } from '../deviceAuth.js';
import type { GitHubUser } from '../authTypes.js';

export const ACCESS_TOKEN = 'ghu_device_secret_access_token';
export const REFRESH_TOKEN = 'ghr_device_secret_refresh_token';
export const DEVICE_CODE = 'device-code-never-leaves-the-server';
export const RELAY_INSTALLATION_TOKEN = 'ghs_relay_installation_token';

export type TokenAnswer = Record<string, unknown>;

export interface FakeGitHub {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body?: string; authorization?: string }>;
  tokenAnswers: TokenAnswer[];
  deviceCodeAnswer: Record<string, unknown>;
  /** Per-request device code answers and holds, taken in request order before `deviceCodeAnswer`. */
  deviceCodeRequests: Array<{ answer?: Record<string, unknown>; hold?: Promise<void> }>;
  installations: Array<{ id: number; account: { id: number; login: string } }>;
  relayRepositories: Array<{ owner: { id: number } }>;
  /** Awaited before GitHub answers a token poll or an installation listing. */
  holds: { tokenPoll?: Promise<void>; installations?: Promise<void> };
}

export function fakeGitHub(): FakeGitHub {
  const fake: FakeGitHub = {
    calls: [],
    tokenAnswers: [],
    deviceCodeAnswer: {
      device_code: DEVICE_CODE,
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    },
    deviceCodeRequests: [],
    installations: [{ id: 4242, account: { id: 99, login: 'acme' } }],
    relayRepositories: [{ owner: { id: 99 } }],
    holds: {},
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      fake.calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined, authorization: headers.get('authorization') ?? undefined });
      if (url === 'https://github.com/login/device/code') {
        const request = fake.deviceCodeRequests.shift();
        await request?.hold;
        return Response.json(request?.answer ?? fake.deviceCodeAnswer);
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        await fake.holds.tokenPoll;
        return Response.json(fake.tokenAnswers.shift() ?? { error: 'authorization_pending' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({ id: 583231, login: 'octocat', name: 'The Octocat', avatar_url: 'https://avatars.example/octocat' });
      }
      if (url.startsWith('https://api.github.com/user/installations')) {
        await fake.holds.installations;
        return Response.json({ total_count: fake.installations.length, installations: fake.installations });
      }
      if (url.startsWith('https://api.github.com/installation/repositories')) {
        return Response.json({ repositories: fake.relayRepositories });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  };
  return fake;
}

export interface Harness {
  origin: string;
  github: FakeGitHub;
  clock: { now: number };
  close: () => Promise<void>;
}

export async function startHarness(
  env: NodeJS.ProcessEnv = {},
  captureGrants: (req: express.Request) => Promise<void> = async () => {},
): Promise<Harness> {
  const github = fakeGitHub();
  const clock = { now: Date.parse('2026-11-28T10:00:00Z') };
  const app = express();
  const testPassport = new passport.Passport();
  testPassport.serializeUser((user, done) => done(null, user));
  testPassport.deserializeUser((user: Express.User, done) => done(null, user));
  app.use(express.json());
  app.use(session({ secret: 'device-auth-test-secret-with-sufficient-length', resave: false, saveUninitialized: false }));
  app.use(testPassport.initialize());
  app.use(testPassport.session());
  const deps: DeviceSignInDependencies = {
    env: { GH_INSTALLATION_ID: '4242', ...env },
    now: () => clock.now,
    fetchImpl: github.fetchImpl,
    requestCode: requestGitHubDeviceCode,
    pollToken: pollGitHubDeviceToken,
    relayInstallationToken: async () => RELAY_INSTALLATION_TOKEN,
    finishLogin: createDeviceFinishLogin(captureGrants),
  };
  registerDeviceSignInRoutes(app, deps, { PROPR_DEVICE_SIGN_IN_START_RATE_LIMIT_MAX: '100' });
  app.get('/me', (req, res) => {
    const user = req.user as GitHubUser | undefined;
    res.json({ authenticated: req.isAuthenticated(), login: user?.login, source: user?.oauthSource });
  });
  app.get('/session-user', (req, res) => {
    // Test-only peek at the stored credential shape.
    const user = req.user as GitHubUser | undefined;
    res.json({ hasAccessToken: user?.accessToken === ACCESS_TOKEN, hasRefreshToken: user?.refreshToken === REFRESH_TOKEN, tokenExpiresAt: user?.tokenExpiresAt, refreshTokenExpiresAt: user?.refreshTokenExpiresAt });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    github,
    clock,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

export class Browser {
  cookie = '';
  constructor(private readonly origin: string) {}
  /** Another tab of the same browser: it shares this session cookie. */
  tab(): Browser {
    const tab = new Browser(this.origin);
    tab.cookie = this.cookie;
    return tab;
  }
  async post(path: string, body: unknown = {}) {
    const response = await fetch(`${this.origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: JSON.stringify(body),
    });
    this.remember(response);
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  }
  async get(path: string) {
    const response = await fetch(`${this.origin}${path}`, { headers: this.cookie ? { cookie: this.cookie } : {} });
    this.remember(response);
    return response.json() as Promise<Record<string, unknown>>;
  }
  private remember(response: Response) {
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
  }
}

/** A promise the fake GitHub waits on, and the call that lets it answer. */
export function hold(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

export async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), 'the poll reached GitHub');
}

export function tokenCalls(github: FakeGitHub) {
  return github.calls.filter(call => call.url === 'https://github.com/login/oauth/access_token');
}
