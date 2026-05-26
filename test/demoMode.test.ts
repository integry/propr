import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ensureAuthenticated } from '../packages/api/auth.ts';
import { demoModeReadOnlyMiddleware } from '../packages/api/demoMode.ts';

const originalDemoMode = process.env.PROPR_DEMO_MODE;

afterEach(() => {
  if (originalDemoMode === undefined) {
    delete process.env.PROPR_DEMO_MODE;
  } else {
    process.env.PROPR_DEMO_MODE = originalDemoMode;
  }
});

async function fetchFromApp(app: express.Express, path: string, init?: RequestInit): Promise<Response> {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

test('demo mode attaches a synthetic user without OAuth', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  const app = express();
  app.use('/api', ensureAuthenticated);
  app.get('/api/auth/user', (req, res) => res.json(req.user));

  const response = await fetchFromApp(app, '/api/auth/user');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: 'demo',
    username: 'demo',
    displayName: 'Demo User',
    email: null,
    avatarUrl: null,
    accessToken: 'demo-mode',
  });
});

test('demo mode allows GET requests and blocks mutating requests', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  const app = express();
  app.use(express.json());
  app.use('/api', ensureAuthenticated);
  app.use('/api', demoModeReadOnlyMiddleware);
  app.get('/api/tasks', (_req, res) => res.json({ ok: true }));
  app.post('/api/tasks', (_req, res) => res.json({ created: true }));

  const getResponse = await fetchFromApp(app, '/api/tasks');
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await getResponse.json(), { ok: true });

  const postResponse = await fetchFromApp(app, '/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'blocked' }),
  });
  assert.equal(postResponse.status, 403);
  assert.deepEqual(await postResponse.json(), {
    code: 'DEMO_MODE_READ_ONLY',
    error: 'Demo mode is read-only. Mutating requests are disabled.'
  });
});

test('demo mode middleware blocks webhook POST requests outside /api', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  const app = express();
  app.post('/webhook', demoModeReadOnlyMiddleware);

  const response = await fetchFromApp(app, '/webhook', { method: 'POST', body: '{}' });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    code: 'DEMO_MODE_READ_ONLY',
    error: 'Demo mode is read-only. Mutating requests are disabled.'
  });
});
