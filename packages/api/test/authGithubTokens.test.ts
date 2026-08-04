/* eslint-disable max-lines -- auth lifecycle ordering shares stateful request fixtures */
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { closeConnection } from '@propr/core';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { createEnsureAuthenticated, ensureAuthenticated } from '../auth.js';
import { isGitHubTokenExpired } from '../authGithubTokens.js';
import { configureDemoMode, resetConfiguredDemoMode } from '../demoMode.js';
import { handleAuthError } from '../routes/githubRoutes.js';
import type { GitHubUser } from '../authTypes.js';

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

function createUser(overrides: Partial<GitHubUser> = {}): GitHubUser {
  return {
    id: '123',
    login: 'octocat',
    username: 'octocat',
    displayName: 'Octocat',
    email: null,
    avatarUrl: null,
    accessToken: 'expired-token',
    refreshToken: 'refresh-token',
    tokenExpiresAt: Date.now() - 1000,
    ...overrides,
  };
}

function createRequest(user: GitHubUser): Request & {
  saveCalls: number;
  logoutCalls: number;
  destroyCalls: number;
} {
  const request = {
    user,
    sessionID: 'session-1',
    headers: {},
    isAuthenticated: () => true,
    saveCalls: 0,
    logoutCalls: 0,
    destroyCalls: 0,
    session: {
      save(callback: (err?: Error) => void) {
        request.saveCalls += 1;
        callback();
      },
      destroy(callback: (err?: Error) => void) {
        request.destroyCalls += 1;
        callback();
      },
    },
    logout(callback: (err?: Error) => void) {
      request.logoutCalls += 1;
      callback();
    },
  };

  return request as unknown as Request & {
    saveCalls: number;
    logoutCalls: number;
    destroyCalls: number;
  };
}

function createJsonResponse(): { response: ExpressResponse; status: () => number; body: () => unknown } {
  let statusCode = 200;
  let payload: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      payload = body;
      return response;
    },
    clearCookie() {
      return response;
    },
  } as unknown as ExpressResponse;
  return { response, status: () => statusCode, body: () => payload };
}

async function runEnsureAuthenticated(req: Request, res: ExpressResponse): Promise<boolean> {
  let nextCalled = false;
  await ensureAuthenticated(req, res, (() => { nextCalled = true; }) as NextFunction);
  return nextCalled;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  resetConfiguredDemoMode();
});

after(async () => {
  await closeConnection();
});

test('isGitHubTokenExpired handles missing, future, exact, and past expiry values', () => {
  Date.now = () => 1000;

  assert.equal(isGitHubTokenExpired(createRequest(createUser({ tokenExpiresAt: undefined }))), false);
  assert.equal(isGitHubTokenExpired(createRequest(createUser({ tokenExpiresAt: 1001 }))), false);
  assert.equal(isGitHubTokenExpired(createRequest(createUser({ tokenExpiresAt: 1000 }))), true);
  assert.equal(isGitHubTokenExpired(createRequest(createUser({ tokenExpiresAt: 999 }))), true);
});

test('ensureAuthenticated refreshes an expired GitHub token before continuing', async () => {
  configureDemoMode(false);
  const user = createUser();
  const req = createRequest(user);
  const { response, status } = createJsonResponse();
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: 'fresh-token',
    refresh_token: 'fresh-refresh-token',
    expires_in: 3600,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const nextCalled = await runEnsureAuthenticated(req, response);

  assert.equal(nextCalled, true);
  assert.equal(status(), 200);
  assert.equal(req.user?.accessToken, 'fresh-token');
  assert.equal(req.user?.refreshToken, 'fresh-refresh-token');
  assert.equal(req.saveCalls, 1);
});

test('ensureAuthenticated reports a temporary error when refresh fails recoverably', async () => {
  configureDemoMode(false);
  const req = createRequest(createUser());
  const { response, status, body } = createJsonResponse();
  globalThis.fetch = async () => new Response('{}', { status: 503 });

  const nextCalled = await runEnsureAuthenticated(req, response);

  assert.equal(nextCalled, false);
  assert.equal(status(), 503);
  assert.deepEqual(body(), {
    error: 'GitHub token refresh unavailable',
    code: 'GITHUB_TOKEN_REFRESH_UNAVAILABLE',
    message: 'GitHub authentication could not be refreshed right now. Please retry shortly.',
  });
  assert.equal(req.logoutCalls, 0);
  assert.equal(req.destroyCalls, 0);
});

test('ensureAuthenticated coalesces concurrent expired-token refreshes for one session', async () => {
  configureDemoMode(false);
  const req1 = createRequest(createUser({ accessToken: 'expired-token-1' }));
  const req2 = createRequest(createUser({ accessToken: 'expired-token-2' }));
  const response1 = createJsonResponse();
  const response2 = createJsonResponse();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(JSON.stringify({
      access_token: 'fresh-token',
      refresh_token: 'fresh-refresh-token',
      expires_in: 3600,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const [next1, next2] = await Promise.all([
    runEnsureAuthenticated(req1, response1.response),
    runEnsureAuthenticated(req2, response2.response),
  ]);

  assert.equal(next1, true);
  assert.equal(next2, true);
  assert.equal(fetchCalls, 1);
  assert.equal(req1.user?.accessToken, 'fresh-token');
  assert.equal(req2.user?.accessToken, 'fresh-token');
  assert.equal(req1.saveCalls, 1);
  assert.equal(req2.saveCalls, 1);
});

test('ensureAuthenticated rejects an expired GitHub token with no refresh token', async () => {
  configureDemoMode(false);
  const req = createRequest(createUser({ refreshToken: undefined }));
  const { response, status } = createJsonResponse();
  let invalidations = 0;
  const middleware = createEnsureAuthenticated({
    invalidateNotificationEntitlements: async () => { invalidations++; },
  });
  globalThis.fetch = async () => {
    throw new Error('fetch should not be called without a refresh token');
  };

  let nextCalled = false;
  await middleware(req, response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(status(), 401);
  assert.equal(invalidations, 1);
  assert.equal(req.logoutCalls, 1);
  assert.equal(req.destroyCalls, 1);
});

test('ensureAuthenticated reports a temporary error when refresh omits an access token', async () => {
  configureDemoMode(false);
  const req = createRequest(createUser());
  const { response, status } = createJsonResponse();
  globalThis.fetch = async () => new Response(JSON.stringify({
    refresh_token: 'fresh-refresh-token',
    expires_in: 3600,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const nextCalled = await runEnsureAuthenticated(req, response);

  assert.equal(nextCalled, false);
  assert.equal(status(), 503);
  assert.equal(req.user?.accessToken, 'expired-token');
});

test('ensureAuthenticated clears the session after an unrecoverable refresh error', async () => {
  configureDemoMode(false);
  const req = createRequest(createUser());
  const { response, status } = createJsonResponse();
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'bad_refresh_token',
    error_description: 'The refresh token is invalid.',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const nextCalled = await runEnsureAuthenticated(req, response);

  assert.equal(nextCalled, false);
  assert.equal(status(), 401);
  assert.equal(req.logoutCalls, 1);
  assert.equal(req.destroyCalls, 1);
  assert.equal(req.user?.githubAuthInvalid, true);
  assert.equal(req.user?.accessToken, '');
  assert.equal(req.user?.refreshToken, undefined);
});

test('authentication lifecycle hooks stay local to their application middleware', async () => {
  configureDemoMode(false);
  const firstInvalidations: string[] = [];
  const secondInvalidations: string[] = [];
  const first = createEnsureAuthenticated({
    invalidateNotificationEntitlements: async userId => { firstInvalidations.push(userId); },
  });
  createEnsureAuthenticated({
    invalidateNotificationEntitlements: async userId => { secondInvalidations.push(userId); },
  });
  const req = createRequest(createUser({ githubAuthInvalid: true }));
  const response = createJsonResponse();

  await first(req, response.response, (() => undefined) as NextFunction);

  assert.deepEqual(firstInvalidations, ['123']);
  assert.deepEqual(secondInvalidations, []);
  assert.equal(req.logoutCalls, 1);
  assert.equal(req.destroyCalls, 1);
});

test('a valid existing session does not perform entitlement activation writes', async () => {
  configureDemoMode(false);
  const activations: string[] = [];
  const middleware = createEnsureAuthenticated({
    activateNotificationEntitlements: async userId => { activations.push(userId); },
  });
  const req = createRequest(createUser({ tokenExpiresAt: undefined }));
  const { response } = createJsonResponse();
  let nextCalls = 0;

  await middleware(req, response, (() => { nextCalls++; }) as NextFunction);

  assert.deepEqual(activations, []);
  assert.equal(nextCalls, 1);
});

test('ordinary authenticated traffic is independent of login-only activation persistence', async () => {
  configureDemoMode(false);
  const middleware = createEnsureAuthenticated({
    activateNotificationEntitlements: async () => { throw new Error('database unavailable'); },
  });
  const req = createRequest(createUser({ tokenExpiresAt: undefined }));
  const { response, status, body } = createJsonResponse();
  let nextCalls = 0;

  await middleware(req, response, (() => { nextCalls++; }) as NextFunction);

  assert.equal(nextCalls, 1);
  assert.equal(status(), 200);
  assert.equal(body(), undefined);
});

test('a proactive OAuth refresh updates the scheduled entitlement credential', async () => {
  configureDemoMode(false);
  let resolveCredential!: (value: string) => void;
  const updatedCredential = new Promise<string>(resolve => { resolveCredential = resolve; });
  const middleware = createEnsureAuthenticated({
    updateNotificationCredential: (_userId, accessToken) => resolveCredential(accessToken),
  });
  const req = createRequest(createUser({ tokenExpiresAt: Date.now() + 60_000 }));
  const { response } = createJsonResponse();
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: 'proactively-refreshed-token',
    refresh_token: 'new-refresh-token',
    expires_in: 3600,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  let nextCalls = 0;

  await middleware(req, response, (() => { nextCalls++; }) as NextFunction);

  assert.equal(nextCalls, 1);
  assert.equal(await updatedCredential, 'proactively-refreshed-token');
});

test('failed entitlement invalidation does not prevent session cleanup', async () => {
  configureDemoMode(false);
  const middleware = createEnsureAuthenticated({
    invalidateNotificationEntitlements: async () => { throw new Error('database unavailable'); },
  });
  const req = createRequest(createUser({ githubAuthInvalid: true }));
  const { response, status, body } = createJsonResponse();

  await middleware(req, response, (() => undefined) as NextFunction);

  assert.equal(status(), 401);
  assert.deepEqual(body(), {
    error: 'GitHub authentication expired',
    code: 'GITHUB_REAUTH_REQUIRED',
    message: 'Your GitHub session has expired. Please log in again.',
  });
  assert.equal(req.logoutCalls, 1);
  assert.equal(req.destroyCalls, 1);
});

test('session cleanup waits for durable entitlement invalidation to settle', async () => {
  configureDemoMode(false);
  let releaseInvalidation!: () => void;
  let markInvalidationStarted!: () => void;
  const invalidationStarted = new Promise<void>(resolve => { markInvalidationStarted = resolve; });
  const invalidationGate = new Promise<void>(resolve => { releaseInvalidation = resolve; });
  const middleware = createEnsureAuthenticated({
    invalidateNotificationEntitlements: async () => {
      markInvalidationStarted();
      await invalidationGate;
    },
  });
  const req = createRequest(createUser({ githubAuthInvalid: true }));
  const { response } = createJsonResponse();

  const authentication = middleware(req, response, (() => undefined) as NextFunction);
  await invalidationStarted;
  assert.equal(req.logoutCalls, 0);
  assert.equal(req.destroyCalls, 0);
  releaseInvalidation();
  await authentication;
  assert.equal(req.logoutCalls, 1);
  assert.equal(req.destroyCalls, 1);
});

test('GitHub route auth error emits TOKEN_REFRESHED after a successful refresh', async () => {
  const req = createRequest(createUser());
  const { response, status, body } = createJsonResponse();
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: 'fresh-token',
    refresh_token: 'fresh-refresh-token',
    expires_in: 3600,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await handleAuthError(req, response);

  assert.equal(status(), 401);
  assert.deepEqual(body(), {
    error: 'Token refreshed',
    code: 'TOKEN_REFRESHED',
    message: 'Your GitHub token has been refreshed. Please retry your request.',
  });
  assert.equal(req.user?.accessToken, 'fresh-token');
  assert.equal(req.logoutCalls, 0);
  assert.equal(req.destroyCalls, 0);
});

test('GitHub route session invalidation invokes entitlement cancellation before logout', async () => {
  const req = createRequest(createUser());
  const { response, status } = createJsonResponse();
  const invalidatedUsers: string[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'bad_refresh_token',
    error_description: 'The refresh token is invalid.',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await handleAuthError(req, response, async (userId) => { invalidatedUsers.push(userId); });

  assert.equal(status(), 401);
  assert.deepEqual(invalidatedUsers, ['123']);
  assert.equal(req.logoutCalls, 1);
  assert.equal(req.destroyCalls, 1);
});

test('GitHub route clears the session when durable entitlement invalidation fails', async () => {
  const req = createRequest(createUser());
  const { response, status, body } = createJsonResponse();
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'bad_refresh_token',
    error_description: 'The refresh token is invalid.',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await handleAuthError(req, response, async () => { throw new Error('database unavailable'); });

  assert.equal(status(), 401);
  assert.deepEqual(body(), {
    error: 'GitHub authentication expired',
    code: 'TOKEN_EXPIRED',
    message: 'Your GitHub session has expired. Please log in again.',
  });
  assert.equal(req.logoutCalls, 1);
  assert.equal(req.destroyCalls, 1);
});

test('GitHub auth-error cleanup waits for durable entitlement invalidation', async () => {
  const req = createRequest(createUser());
  const { response } = createJsonResponse();
  let releaseInvalidation!: () => void;
  let markInvalidationStarted!: () => void;
  const invalidationStarted = new Promise<void>(resolve => { markInvalidationStarted = resolve; });
  const invalidationGate = new Promise<void>(resolve => { releaseInvalidation = resolve; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'bad_refresh_token',
    error_description: 'The refresh token is invalid.',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const cleanup = handleAuthError(req, response, async () => {
    markInvalidationStarted();
    await invalidationGate;
  });
  await invalidationStarted;
  assert.equal(req.logoutCalls, 0);
  assert.equal(req.destroyCalls, 0);
  releaseInvalidation();
  await cleanup;
  assert.equal(req.logoutCalls, 1);
  assert.equal(req.destroyCalls, 1);
});
