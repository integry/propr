import test, { after } from 'node:test';
import { closeConnection } from '@propr/core';
after(closeConnection);
import assert from 'node:assert/strict';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AddressInfo } from 'node:net';
import { createSessionCsrfProtection } from '../auth.js';

test('extension session CSRF protection leaves consent, desktop and unrelated API behavior intact', async t => {
  const app = express();
  const session = {} as express.Request['session'];
  // Bound fixture requests before session authentication and CSRF authorization.
  app.use(rateLimit({ windowMs: 60_000, limit: 100 }));
  app.use((req, _res, next) => { req.isAuthenticated = (() => true) as typeof req.isAuthenticated; req.session = session; next(); });
  app.use(createSessionCsrfProtection('https://ui.example.com', undefined));
  app.use((_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const route of ['/authorize', '/mcp/consent', '/api/desktop/session', '/api/tasks', '/api/instance/extensions/v10']) {
    const get = await fetch(base + route); assert.equal(get.status, 200); assert.equal(get.headers.get('cache-control'), null); assert.equal(get.headers.get('x-csrf-token'), null);
    for (const headers of [{}, { Origin: 'https://mcp.example.com' }]) assert.equal((await fetch(base + route, { method: 'POST', headers })).status, 200);
  }
  for (const path of ['/api/instance/extensions/v1/profiles', '/API/Instance/Extensions/V1/Profiles']) {
  const get = await fetch(base + path); assert.equal(get.headers.get('cache-control'), 'no-store');
  const token = get.headers.get('x-csrf-token'); assert.ok(token);
  assert.equal((await fetch(base + path, { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + path, { method: 'POST', headers: { Origin: 'https://evil.example.com' } })).status, 403);
  assert.equal((await fetch(base + path, { method: 'POST', headers: { Origin: 'https://ui.example.com' } })).status, 200);
  assert.equal((await fetch(base + path, { method: 'POST', headers: { 'X-CSRF-Token': token! } })).status, 200);
  }
});
