import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { DEMO_MODE_READ_ONLY_CODE } from '@propr/shared';
import { setupAuth, ensureAuthenticated } from '../auth.js';
import { demoModeReadOnlyMiddleware, getDemoUser } from '../demoMode.js';

const originalDemoMode = process.env.PROPR_DEMO_MODE;
const originalFrontendUrl = process.env.FRONTEND_URL;

afterEach(() => {
  if (originalDemoMode === undefined) delete process.env.PROPR_DEMO_MODE;
  else process.env.PROPR_DEMO_MODE = originalDemoMode;
  if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = originalFrontendUrl;
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

test('ensureAuthenticated attaches the synthetic demo user', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  let nextCalled = false;
  const request = { headers: {}, isAuthenticated: () => false } as unknown as Request;

  await ensureAuthenticated(request, {} as Response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.deepEqual(request.user, getDemoUser());
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
