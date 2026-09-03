import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import { closeConnection } from '@propr/core';
import type {
  VisualPreviewOAuthCredentialInput,
  VisualPreviewOAuthCredentialService,
} from '@propr/core';
import { createVisualPreviewAuthRoutes } from '../routes/visualPreviewAuthRoutes.js';
import type { GitHubUser } from '../authTypes.js';

after(async () => closeConnection());

function user(overrides: Partial<GitHubUser> = {}): GitHubUser {
  return {
    id: '123',
    login: 'admin',
    username: 'admin',
    displayName: 'Admin',
    email: null,
    avatarUrl: null,
    accessToken: 'gho_browser-secret',
    refreshToken: 'ghr_browser-secret',
    oauthSource: 'github',
    ...overrides,
  };
}

function responseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
    end() { return response; },
  } as unknown as Response;
  return { response, getStatus: () => statusCode, getBody: () => body };
}

test('returns visual-preview auth status without exposing stored token material', async () => {
  const service = {
    getStatus: async () => ({
      configured: true,
      source: 'github' as const,
      status: 'active' as const,
      githubUsername: 'admin',
    }),
  } as unknown as VisualPreviewOAuthCredentialService;
  const routes = createVisualPreviewAuthRoutes({ service });
  const recorder = responseRecorder();

  await routes.getStatus({ user: user() } as Request, recorder.response);

  assert.equal(recorder.getStatus(), 200);
  assert.deepEqual(recorder.getBody(), {
    configured: true,
    source: 'github',
    status: 'active',
    githubUsername: 'admin',
    currentUsername: 'admin',
    currentLoginTokenType: 'supported',
    canUseCurrentLogin: true,
  });
  assert.doesNotMatch(JSON.stringify(recorder.getBody()), /browser-secret/);
});

test('explicitly replaces the uploader grant with the current administrator login', async () => {
  let replaced: VisualPreviewOAuthCredentialInput | undefined;
  const service = {
    replace: async (credential: VisualPreviewOAuthCredentialInput) => { replaced = credential; },
    getStatus: async () => ({ configured: true, source: 'github' as const, status: 'active' as const }),
  } as unknown as VisualPreviewOAuthCredentialService;
  const routes = createVisualPreviewAuthRoutes({ service });
  const recorder = responseRecorder();

  await routes.useCurrentLogin({ user: user() } as Request, recorder.response);

  assert.equal(recorder.getStatus(), 200);
  assert.equal(replaced?.githubUserId, '123');
  assert.equal(replaced?.accessToken, 'gho_browser-secret');
  assert.doesNotMatch(JSON.stringify(recorder.getBody()), /browser-secret/);
});

test('rejects a current login whose GitHub token cannot upload attachments', async () => {
  const routes = createVisualPreviewAuthRoutes({ service: {} as VisualPreviewOAuthCredentialService });
  const recorder = responseRecorder();

  await routes.useCurrentLogin({ user: user({ accessToken: 'ghs_installation-token' }) } as Request, recorder.response);

  assert.equal(recorder.getStatus(), 409);
  assert.deepEqual(recorder.getBody(), {
    error: 'The current GitHub login did not provide an OAuth App token or personal access token supported by GitHub attachment uploads.',
    code: 'VISUAL_PREVIEW_LOGIN_TOKEN_UNSUPPORTED',
  });
});

test('identifies a GitHub App user login without exposing its token', async () => {
  const service = {
    getStatus: async () => ({ configured: false, status: 'missing' as const }),
  } as unknown as VisualPreviewOAuthCredentialService;
  const routes = createVisualPreviewAuthRoutes({ service });
  const recorder = responseRecorder();

  await routes.getStatus({ user: user({ accessToken: 'ghu_browser-secret' }) } as Request, recorder.response);

  assert.deepEqual(recorder.getBody(), {
    configured: false,
    status: 'missing',
    currentUsername: 'admin',
    currentLoginTokenType: 'github_app_user',
    canUseCurrentLogin: false,
  });
  assert.doesNotMatch(JSON.stringify(recorder.getBody()), /browser-secret/);
});

test('explains why a GitHub App user login cannot be selected', async () => {
  const routes = createVisualPreviewAuthRoutes({ service: {} as VisualPreviewOAuthCredentialService });
  const recorder = responseRecorder();

  await routes.useCurrentLogin({ user: user({ accessToken: 'ghu_browser-secret' }) } as Request, recorder.response);

  assert.equal(recorder.getStatus(), 409);
  assert.deepEqual(recorder.getBody(), {
    error: 'The current login uses a GitHub App user token, which GitHub attachment uploads reject. Add a personal access token in Visual preview uploads instead.',
    code: 'VISUAL_PREVIEW_LOGIN_TOKEN_UNSUPPORTED',
  });
});

test('validates and stores a submitted personal access token without returning it', async () => {
  let replaced: VisualPreviewOAuthCredentialInput | undefined;
  let authorization = '';
  const service = {
    getStatus: async () => replaced
      ? { configured: true, source: 'static_token' as const, status: 'active' as const, githubUsername: 'preview-bot' }
      : { configured: false, status: 'missing' as const },
    replace: async (credential: VisualPreviewOAuthCredentialInput) => { replaced = credential; },
  } as unknown as VisualPreviewOAuthCredentialService;
  const fetchImpl = (async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization') || '';
    return Response.json({ id: 456, login: 'preview-bot' });
  }) as typeof fetch;
  const routes = createVisualPreviewAuthRoutes({ service, fetchImpl });
  const recorder = responseRecorder();

  await routes.usePersonalAccessToken({
    user: user({ accessToken: 'ghu_browser-secret' }),
    body: { token: 'github_pat_preview-secret' },
  } as Request, recorder.response);

  assert.equal(recorder.getStatus(), 200);
  assert.equal(authorization, 'Bearer github_pat_preview-secret');
  assert.deepEqual(replaced, {
    githubUserId: '456',
    githubUsername: 'preview-bot',
    source: 'static_token',
    accessToken: 'github_pat_preview-secret',
  });
  assert.doesNotMatch(JSON.stringify(recorder.getBody()), /preview-secret/);
});

test('rejects unsupported submitted tokens before contacting GitHub', async () => {
  let fetched = false;
  const routes = createVisualPreviewAuthRoutes({
    service: {} as VisualPreviewOAuthCredentialService,
    fetchImpl: (async () => { fetched = true; return Response.json({}); }) as typeof fetch,
  });
  const recorder = responseRecorder();

  await routes.usePersonalAccessToken({ body: { token: 'ghu_app-user-token' } } as Request, recorder.response);

  assert.equal(recorder.getStatus(), 400);
  assert.equal((recorder.getBody() as { code: string }).code, 'VISUAL_PREVIEW_TOKEN_UNSUPPORTED');
  assert.equal(fetched, false);
});

test('does not replace an environment-managed preview token', async () => {
  let fetched = false;
  const service = {
    getStatus: async () => ({ configured: true, source: 'environment' as const, status: 'active' as const }),
  } as unknown as VisualPreviewOAuthCredentialService;
  const routes = createVisualPreviewAuthRoutes({
    service,
    fetchImpl: (async () => { fetched = true; return Response.json({}); }) as typeof fetch,
  });
  const recorder = responseRecorder();

  await routes.usePersonalAccessToken({ body: { token: 'ghp_preview-secret' } } as Request, recorder.response);

  assert.equal(recorder.getStatus(), 409);
  assert.equal((recorder.getBody() as { code: string }).code, 'VISUAL_PREVIEW_TOKEN_ENVIRONMENT_MANAGED');
  assert.equal(fetched, false);
});

test('reports a token rejected by GitHub without storing it', async () => {
  let replaced = false;
  const service = {
    getStatus: async () => ({ configured: false, status: 'missing' as const }),
    replace: async () => { replaced = true; },
  } as unknown as VisualPreviewOAuthCredentialService;
  const routes = createVisualPreviewAuthRoutes({
    service,
    fetchImpl: (async () => new Response(null, { status: 401 })) as typeof fetch,
  });
  const recorder = responseRecorder();

  await routes.usePersonalAccessToken({ body: { token: 'ghp_preview-secret' } } as Request, recorder.response);

  assert.equal(recorder.getStatus(), 400);
  assert.equal((recorder.getBody() as { code: string }).code, 'VISUAL_PREVIEW_TOKEN_INVALID');
  assert.equal(replaced, false);
});
