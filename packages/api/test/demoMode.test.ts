import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { DEMO_MODE_READ_ONLY_CODE } from '@propr/shared';
import { db } from '@propr/core';
import * as configManager from '@propr/core';
import { setupAuth, ensureAuthenticated } from '../auth.js';
import { demoModeReadOnlyMiddleware, getDemoUser, isDemoMode } from '../demoMode.js';
import { buildDemoRepositoryMetadata } from '../routes/demoRepositoryMetadata.js';
import { createGitHubRoutes } from '../routes/githubRoutes.js';
import { createPlannerRoutes } from '../routes/plannerRoutes.js';

const originalDemoMode = process.env.PROPR_DEMO_MODE;
const originalFrontendUrl = process.env.FRONTEND_URL;

async function cleanupDemoData(): Promise<void> {
  if (await db.schema.hasTable('task_drafts')) await db('task_drafts').delete();
  if (await db.schema.hasTable('system_configs')) await db('system_configs').where({ key: 'repos_to_monitor' }).delete();
}

function createJsonResponse(): { response: Response; status: () => number; body: () => unknown } {
  let statusCode = 200;
  let payload: unknown;
  const response = {
    set() { return response; },
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      payload = body;
      return response;
    }
  } as unknown as Response;
  return { response, status: () => statusCode, body: () => payload };
}

afterEach(async () => {
  if (originalDemoMode === undefined) delete process.env.PROPR_DEMO_MODE;
  else process.env.PROPR_DEMO_MODE = originalDemoMode;
  if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = originalFrontendUrl;
  await cleanupDemoData();
});

after(async () => {
  await db.destroy();
});

test('demoModeReadOnlyMiddleware rejects mutating requests in demo mode', () => {
  process.env.PROPR_DEMO_MODE = 'true';
  let statusCode: number | undefined;
  let payload: unknown;
  let nextCalled = false;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      payload = body;
      return response;
    }
  } as unknown as Response;

  demoModeReadOnlyMiddleware({ method: 'POST' } as Request, response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
  assert.deepEqual(payload, {
    code: DEMO_MODE_READ_ONLY_CODE,
    error: 'Demo mode is read-only. Mutating requests are disabled.'
  });
});

test('demoModeReadOnlyMiddleware blocks auth metadata mutations', () => {
  process.env.PROPR_DEMO_MODE = 'true';
  const { response, status, body } = createJsonResponse();

  demoModeReadOnlyMiddleware(
    { method: 'POST', path: '/auth/demo-mode', originalUrl: '/api/auth/demo-mode' } as Request,
    response,
    (() => { assert.fail('next should not be called'); }) as NextFunction
  );

  assert.equal(status(), 403);
  assert.deepEqual(body(), {
    code: DEMO_MODE_READ_ONLY_CODE,
    error: 'Demo mode is read-only. Mutating requests are disabled.'
  });
});

test('isDemoMode accepts common truthy environment values', () => {
  process.env.PROPR_DEMO_MODE = 'TRUE';
  assert.equal(isDemoMode(), true);
  process.env.PROPR_DEMO_MODE = '1';
  assert.equal(isDemoMode(), true);
});

test('ensureAuthenticated attaches the synthetic demo user', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  let nextCalled = false;
  const request = { headers: {}, isAuthenticated: () => false } as unknown as Request;
  const response = { set() { return response; } } as unknown as Response;

  await ensureAuthenticated(request, response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.deepEqual(request.user, getDemoUser());
  assert.equal(request.user?.login, 'demo');
  assert.equal(request.user?.username, 'demo');
});

test('ensureAuthenticated rejects bearer auth in demo mode', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  let nextCalled = false;
  const request = { headers: { authorization: 'Bearer ghp_test' }, isAuthenticated: () => false } as unknown as Request;
  const { response, status, body } = createJsonResponse();

  await ensureAuthenticated(request, response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(status(), 403);
  assert.deepEqual(body(), {
    error: 'Bearer token authentication is disabled in demo mode',
    code: 'DEMO_MODE_BEARER_AUTH_DISABLED'
  });
});

test('demo repository metadata resolves enabled configured repositories', () => {
  const repos = [
    { id: '1', name: 'integry/propr', enabled: true, baseBranch: 'develop', defaultBranch: 'main' },
    { id: '2', name: 'integry/propr', enabled: true, baseBranch: 'release' },
    { id: '3', name: 'integry/private', enabled: true, baseBranch: 'main' },
    { id: '4', name: 'integry/disabled', enabled: false, baseBranch: 'main' },
  ];

  assert.equal(buildDemoRepositoryMetadata(repos, 'other/repo'), null);
  assert.equal(buildDemoRepositoryMetadata(repos, 'integry/disabled'), null);
  assert.deepEqual(buildDemoRepositoryMetadata(repos, 'integry/private')?.branches, ['main']);
  assert.deepEqual(buildDemoRepositoryMetadata(repos, 'integry/propr'), {
    repository: 'integry/propr',
    defaultBranch: 'main',
    branches: ['main', 'develop', 'release'],
    isPrivate: null,
    description: 'Repository metadata is unavailable in read-only demo mode.'
  });
});

test('/api/github/repos returns enabled configured repositories in demo mode', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  await db.migrate.latest();
  await configManager.saveMonitoredRepos([
    { id: '1', name: 'integry/propr', enabled: true },
    { id: '2', name: 'integry/private', enabled: true },
    { id: '3', name: 'integry/disabled', enabled: false },
  ]);
  const routes = createGitHubRoutes({ redisClient: {} as never, taskQueue: {} as never, db });
  const { response, body } = createJsonResponse();

  await routes.getRepos({ user: getDemoUser() } as Request, response);

  assert.deepEqual(body(), { repos: ['integry/private', 'integry/propr'] });
});

test('planner demo reads use the curated database without owner or repository allowlists', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  await db.migrate.latest();
  await configManager.saveMonitoredRepos([
    { id: '1', name: 'integry/propr', enabled: true },
    { id: '2', name: 'integry/private', enabled: true },
  ]);
  const visibleDraftId = randomUUID();
  const otherOwnerDraftId = randomUUID();
  const otherRepoDraftId = randomUUID();
  await db('task_drafts').insert([
    { draft_id: visibleDraftId, user_id: 'demo', repository: 'integry/propr', name: 'Visible draft' },
    { draft_id: otherOwnerDraftId, user_id: 'real-user', repository: 'integry/propr', name: 'Other owner draft' },
    { draft_id: otherRepoDraftId, user_id: 'demo', repository: 'integry/private', name: 'Other repo draft' },
  ]);
  const routes = createPlannerRoutes({ db });
  const listResponse = createJsonResponse();

  await routes.listDrafts({ query: {}, user: getDemoUser() } as Request, listResponse.response);

  const listedDraftIds = (listResponse.body() as { drafts: Array<{ draft_id: string }> }).drafts
    .map(draft => draft.draft_id)
    .sort();
  assert.deepEqual(listedDraftIds, [
    visibleDraftId,
    otherOwnerDraftId,
    otherRepoDraftId,
  ].sort());

  const otherOwnerResponse = createJsonResponse();
  await routes.getDraft({ params: { id: otherOwnerDraftId }, user: getDemoUser() } as unknown as Request, otherOwnerResponse.response);

  assert.equal(otherOwnerResponse.status(), 200);
  assert.equal((otherOwnerResponse.body() as { draft_id: string }).draft_id, otherOwnerDraftId);
});

test('auth demo-mode metadata endpoint reports startup environment value', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  const app = express();
  setupAuth(app);
  process.env.PROPR_DEMO_MODE = 'false';

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/demo-mode`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { demoMode: true });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
