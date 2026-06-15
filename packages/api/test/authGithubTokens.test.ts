import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { ensureAuthenticated } from '../auth.js';
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
  globalThis.fetch = async () => {
    throw new Error('fetch should not be called without a refresh token');
  };

  const nextCalled = await runEnsureAuthenticated(req, response);

  assert.equal(nextCalled, false);
  assert.equal(status(), 401);
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
