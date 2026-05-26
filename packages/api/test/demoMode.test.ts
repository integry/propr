import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { DEMO_MODE_READ_ONLY_CODE } from '@propr/shared';
import { db } from '@propr/core';
import { setupAuth, ensureAuthenticated } from '../auth.js';
import { demoModeReadOnlyMiddleware, getDemoUser, isDemoMode } from '../demoMode.js';
import { buildDemoRepositoryMetadata } from '../routes/demoRepositoryMetadata.js';

const originalDemoMode = process.env.PROPR_DEMO_MODE;
const originalFrontendUrl = process.env.FRONTEND_URL;

afterEach(() => {
  if (originalDemoMode === undefined) delete process.env.PROPR_DEMO_MODE;
  else process.env.PROPR_DEMO_MODE = originalDemoMode;
  if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = originalFrontendUrl;
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

test('demoModeReadOnlyMiddleware allows auth metadata mutations for future compatibility', () => {
  process.env.PROPR_DEMO_MODE = 'true';
  let nextCalled = false;

  demoModeReadOnlyMiddleware(
    { method: 'POST', path: '/auth/demo-mode', originalUrl: '/api/auth/demo-mode' } as Request,
    {} as Response,
    (() => { nextCalled = true; }) as NextFunction
  );

  assert.equal(nextCalled, true);
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

  await ensureAuthenticated(request, {} as Response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.deepEqual(request.user, getDemoUser());
  assert.equal(request.user?.login, 'demo');
  assert.equal(request.user?.username, 'demo');
});

test('demo repository metadata only resolves configured repositories', () => {
  const repos = [
    { id: '1', name: 'integry/propr', enabled: true, baseBranch: 'develop', defaultBranch: 'main' },
    { id: '2', name: 'integry/propr', enabled: true, baseBranch: 'release' },
  ];

  assert.equal(buildDemoRepositoryMetadata(repos, 'other/repo'), null);
  assert.deepEqual(buildDemoRepositoryMetadata(repos, 'integry/propr'), {
    repository: 'integry/propr',
    defaultBranch: 'main',
    branches: ['main', 'develop', 'release'],
    isPrivate: false,
    description: 'Repository metadata is unavailable in read-only demo mode.'
  });
});

test('auth demo-mode metadata endpoint reads current environment value', async () => {
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
    assert.deepEqual(await response.json(), { demoMode: false });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
