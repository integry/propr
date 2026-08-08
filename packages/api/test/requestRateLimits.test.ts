import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import express from 'express';
import {
  createRequestRateLimiter,
  resolveRequestRateLimitPolicies,
} from '../requestRateLimits.js';

async function startTestApp(limit = 2): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = express();
  app.use(createRequestRateLimiter({ identifier: 'test', limit, windowMs: 60_000 }));
  app.all('/resource', (_request, response) => response.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

const openServers: Array<() => Promise<void>> = [];
after(async () => Promise.all(openServers.map(close => close())));

test('returns a standard 429 response after the configured quota', async () => {
  const app = await startTestApp();
  openServers.push(app.close);

  const first = await fetch(`${app.origin}/resource`);
  const second = await fetch(`${app.origin}/resource`);
  const limited = await fetch(`${app.origin}/resource`);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('ratelimit') ?? '', /"test"/);
  assert.deepEqual(await limited.json(), {
    code: 'RATE_LIMIT_EXCEEDED',
    error: 'Too many requests. Please try again later.',
  });
});

test('does not charge CORS preflight requests against the quota', async () => {
  const app = await startTestApp(1);
  openServers.push(app.close);

  assert.equal((await fetch(`${app.origin}/resource`, { method: 'OPTIONS' })).status, 200);
  assert.equal((await fetch(`${app.origin}/resource`)).status, 200);
  assert.equal((await fetch(`${app.origin}/resource`)).status, 429);
});

test('resolves secure defaults and explicit positive-integer overrides', () => {
  const defaults = resolveRequestRateLimitPolicies({});
  assert.deepEqual(defaults.api, { identifier: 'api', limit: 600, windowMs: 60_000 });
  assert.deepEqual(defaults.auth, { identifier: 'auth', limit: 30, windowMs: 900_000 });
  assert.deepEqual(defaults.webhook, { identifier: 'webhook', limit: 300, windowMs: 60_000 });

  const configured = resolveRequestRateLimitPolicies({
    PROPR_API_RATE_LIMIT_MAX: '42',
    PROPR_AUTH_RATE_LIMIT_WINDOW_MS: '120000',
  });
  assert.equal(configured.api.limit, 42);
  assert.equal(configured.auth.windowMs, 120_000);
});

test('rejects invalid overrides instead of silently disabling protection', () => {
  assert.throws(
    () => resolveRequestRateLimitPolicies({ PROPR_WEBHOOK_RATE_LIMIT_MAX: '0' }),
    /must be a positive integer/,
  );
  assert.throws(
    () => resolveRequestRateLimitPolicies({ PROPR_API_RATE_LIMIT_WINDOW_MS: '1.5' }),
    /must be a positive integer/,
  );
});
