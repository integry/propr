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
    error: 'The current GitHub login did not provide an OAuth token supported by GitHub media uploads. Log out and sign in again.',
    code: 'VISUAL_PREVIEW_LOGIN_TOKEN_UNSUPPORTED',
  });
});
