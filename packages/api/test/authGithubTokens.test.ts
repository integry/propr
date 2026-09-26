/* eslint-disable max-lines -- session refresh behavior and persistence regressions share one harness */
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { closeConnection } from '@propr/core';
import knex from 'knex';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { ensureAuthenticated } from '../auth.js';
import { isGitHubTokenExpired, refreshGitHubTokenWithResult } from '../authGithubTokens.js';
import { GitHubUserGrantService } from '../githubUserGrantService.js';
import { VisualPreviewOAuthCredentialService } from '../../core/src/services/visualPreviewOAuthCredentialService.js';
import { up as createGitHubUserGrants } from '../../core/src/db/migrations/20260908000000_create_github_user_grants.js';
import { up as createVisualPreviewOAuthCredentials } from '../../core/src/db/migrations/20260903000000_create_visual_preview_oauth_credentials.js';
import { up as addGitHubOAuthGrantRevision } from '../../core/src/db/migrations/20260908010000_add_github_oauth_grant_revision.js';
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

test('refreshes a Connect-issued session through the relay', async () => {
  configureDemoMode(false);
  const previousRelayUrl = process.env.PROPR_GH_RELAY_URL;
  const previousRelayToken = process.env.PROPR_GH_RELAY_TOKEN;
  process.env.PROPR_GH_RELAY_URL = 'https://relay.example.test/v1';
  process.env.PROPR_GH_RELAY_TOKEN = 'prt_relay';
  const req = createRequest(createUser({
    accessToken: 'connect-access-token',
    oauthSource: 'connect',
  }));
  const { response } = createJsonResponse();
  let refreshRequest: Request | undefined;
  globalThis.fetch = async (input, init) => {
    refreshRequest = new Request(input, init);
    return Response.json({
      access_token: 'gho_fresh-connect-token',
      refresh_token: 'ghr_fresh-connect-refresh',
      expires_in: 3600,
    });
  };

  try {
    assert.equal(await runEnsureAuthenticated(req, response), true);
    assert.equal(refreshRequest?.url, 'https://relay.example.test/v1/auth/instance-grants/refresh');
    assert.equal(refreshRequest?.headers.get('authorization'), 'Bearer prt_relay');
    assert.deepEqual(JSON.parse(await refreshRequest!.text()), { refresh_token: 'refresh-token' });
  } finally {
    if (previousRelayUrl === undefined) delete process.env.PROPR_GH_RELAY_URL;
    else process.env.PROPR_GH_RELAY_URL = previousRelayUrl;
    if (previousRelayToken === undefined) delete process.env.PROPR_GH_RELAY_TOKEN;
    else process.env.PROPR_GH_RELAY_TOKEN = previousRelayToken;
  }
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

test('browser session adopts a desktop-first rotation without refreshing the rotating grant again', async () => {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createGitHubUserGrants(database);
  await createVisualPreviewOAuthCredentials(database);
  await addGitHubOAuthGrantRevision(database);
  let refreshRequests = 0;
  const fetchImpl = (async () => {
    refreshRequests += 1;
    return Response.json({
      access_token: 'gho_desktop-rotated',
      refresh_token: 'ghr_desktop-rotated',
      expires_in: 28_800,
    });
  }) as typeof fetch;
  const environment = {
    SESSION_SECRET: 'test-secret',
    GH_OAUTH_CLIENT_ID: 'client-id',
    GH_OAUTH_CLIENT_SECRET: 'client-secret',
  };
  const shared = new VisualPreviewOAuthCredentialService(database, environment, fetchImpl);
  const durable = new GitHubUserGrantService(database, environment, fetchImpl, shared);
  const oldGrant = {
    ...createUser({
      id: 'desktop-browser-owner',
      accessToken: 'gho_old-access',
      refreshToken: 'ghr_old-refresh',
      oauthSource: 'github',
    }),
    tokenExpiresAt: Date.now() - 1,
  };
  const loginRevision = 100;
  await shared.replace({
    githubUserId: oldGrant.id,
    githubUsername: oldGrant.username,
    source: 'github',
    accessToken: oldGrant.accessToken!,
    refreshToken: oldGrant.refreshToken,
    accessTokenExpiresAt: oldGrant.tokenExpiresAt,
    grantRevision: loginRevision,
  });
  await durable.capture(oldGrant, loginRevision);

  try {
    assert.equal((await durable.resolve(oldGrant.id)).status, 'active');
    const browserRequest = createRequest({ ...oldGrant });
    const result = await refreshGitHubTokenWithResult(browserRequest, true, {
      userGrantService: durable,
      visualPreviewService: shared,
    });

    assert.equal(result.status, 'refreshed');
    assert.equal(browserRequest.user?.accessToken, 'gho_desktop-rotated');
    assert.equal(browserRequest.user?.githubAuthInvalid, undefined);
    assert.equal(refreshRequests, 1);
  } finally {
    await database.destroy();
  }
});

test('browser stale refresh rejection adopts a concurrently refreshed durable grant', async () => {
  const req = createRequest(createUser({
    id: 'concurrent-owner',
    accessToken: 'gho_stale-access',
    refreshToken: 'ghr_stale-refresh',
    oauthSource: 'github',
  }));
  let resolutions = 0;
  const userGrantService = {
    resolve: async () => {
      resolutions += 1;
      return resolutions <= 2
        ? { status: 'missing' as const }
        : {
            status: 'active' as const,
            accessToken: 'gho_concurrently-refreshed',
            refreshToken: 'ghr_concurrently-refreshed',
            tokenExpiresAt: Date.now() + 28_800_000,
          };
    },
    updateIfOwner: async () => false,
  };
  const visualPreviewService = { refreshAndGetForOwner: async () => null };
  globalThis.fetch = async () => Response.json({
    error: 'bad_refresh_token',
    error_description: 'rotated by another request',
  });

  const result = await refreshGitHubTokenWithResult(req, true, {
    userGrantService,
    visualPreviewService,
  });

  assert.equal(result.status, 'refreshed');
  assert.equal(req.user?.accessToken, 'gho_concurrently-refreshed');
  assert.equal(req.user?.githubAuthInvalid, undefined);
  assert.equal(req.logoutCalls, 0);
  assert.ok(resolutions >= 2);
});

test('browser preserves a successful rotation when durable grant persistence is unavailable', async () => {
  const req = createRequest(createUser({
    accessToken: 'ghu_pre-rotation',
    refreshToken: 'ghr_pre-rotation',
    oauthSource: 'github',
  }));
  let resolveCalls = 0;
  const userGrantService = {
    resolve: async () => {
      resolveCalls += 1;
      return resolveCalls <= 2
        ? { status: 'missing' as const }
        : {
            status: 'active' as const,
            accessToken: 'ghu_pre-rotation',
            refreshToken: 'ghr_pre-rotation',
          };
    },
    updateIfOwner: async () => { throw new Error('database write unavailable'); },
  };
  globalThis.fetch = async () => Response.json({
    access_token: 'ghu_successfully-rotated',
    refresh_token: 'ghr_successfully-rotated',
    expires_in: 3600,
  });

  const result = await refreshGitHubTokenWithResult(req, true, {
    userGrantService,
    visualPreviewService: { refreshAndGetForOwner: async () => null },
  });

  assert.equal(result.status, 'refreshed');
  assert.equal(req.user?.accessToken, 'ghu_successfully-rotated');
  assert.equal(req.user?.refreshToken, 'ghr_successfully-rotated');
  assert.equal(req.saveCalls, 1);
  assert.equal(resolveCalls, 2);
});

test('browser saves a successful rotation when the post-CAS verification read fails', async () => {
  const req = createRequest(createUser({
    accessToken: 'ghu_pre-rotation-read-failure',
    refreshToken: 'ghr_pre-rotation-read-failure',
    oauthSource: 'github',
  }));
  let resolveCalls = 0;
  const userGrantService = {
    resolve: async () => {
      resolveCalls += 1;
      if (resolveCalls <= 2) return { status: 'missing' as const };
      throw new Error('database read unavailable');
    },
    updateIfOwner: async () => false,
  };
  globalThis.fetch = async () => Response.json({
    access_token: 'ghu_rotated-before-read-failure',
    refresh_token: 'ghr_rotated-before-read-failure',
    expires_in: 3600,
  });

  const result = await refreshGitHubTokenWithResult(req, true, {
    userGrantService,
    visualPreviewService: { refreshAndGetForOwner: async () => null },
  });

  assert.equal(result.status, 'refreshed');
  assert.equal(req.user?.accessToken, 'ghu_rotated-before-read-failure');
  assert.equal(req.user?.refreshToken, 'ghr_rotated-before-read-failure');
  assert.equal(req.saveCalls, 1);
  assert.equal(resolveCalls, 3);
});
