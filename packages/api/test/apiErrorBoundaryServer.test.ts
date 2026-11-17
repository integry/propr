import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Imports the real server composition (parsers, CORS, guards, route registry)
// with demo infrastructure facades, as extensionServerMount.test.ts does.
test('API process answers errors, unknown routes and 401s as JSON with security headers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-error-boundary-'));
  process.env.DB_FILENAME = path.join(root, 'fixture.sqlite');
  process.env.DATA_DIR = root;
  process.env.FRONTEND_URL = 'http://localhost:3000';
  process.env.SESSION_SECRET = 'synthetic-test-session-secret-with-enough-entropy-123456789';
  process.env.SYSTEM_TASK_SECRET = 'synthetic-test-custody-root';
  process.env.PROPR_API_RATE_LIMIT_MAX = '1000';
  const demo = await import('../demoMode.js');
  mock.module('../demoMode.js', { namedExports: { ...demo, configureDemoMode: () => true, isDemoMode: () => false } });
  const auth = await import('../auth.js');
  mock.module('../auth.js', { namedExports: { ...auth, setupAuth: () => ({ engineMiddleware: [], authenticate: () => undefined }) } });
  process.env.PROPR_API_DISABLE_AUTOSTART = '1';
  const { app, setupRoutes, initRedis } = await import('../server.js');
  const core = await import('@propr/core');
  await core.runMigrations();
  await core.db('instance_members').insert({ github_user_id: '1', github_username: 'fixture', role: 'admin' });
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor');
    req.isAuthenticated = (() => !!actor) as typeof req.isAuthenticated;
    if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    next();
  });
  await initRedis(); setupRoutes();
  // A route mounted after setupRoutes (as the lazy MCP browser routes are) is
  // still reachable, and its errors still reach the JSON final handler.
  app.get('/mcp/late-route', () => { throw new Error('/usr/src/app/secret/path.js exploded'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await core.closeConnection(); mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const member = { 'x-test-actor': '1' };
  const port = (server.address() as AddressInfo).port;
  const rawGet = (requestPath: string, headers: Record<string, string>) => new Promise<{ status: number; contentType: string; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: requestPath, headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, contentType: String(response.headers['content-type'] ?? ''), body }));
    }).on('error', reject);
  });

  async function expectJsonError(response: Response, status: number, code: string): Promise<void> {
    assert.equal(response.status, status, `${response.url} status`);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/, `${response.url} content type`);
    const text = await response.text();
    assert.doesNotMatch(text, /<pre>|<html|node_modules|\/usr\/src|at [\w.]+ \(|SyntaxError|zlib/i, `${response.url} leaks internals: ${text}`);
    const body = JSON.parse(text) as { error?: unknown; code?: unknown };
    assert.equal(typeof body.error, 'string');
    assert.equal(body.code, code);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-powered-by'), null);
  }

  // 1. Body parser failures, before authentication.
  const json = { 'content-type': 'application/json' };
  await expectJsonError(await fetch(`${base}/api/tasks/revert`, { method: 'POST', headers: json, body: '{"a":' }), 400, 'INVALID_JSON');
  await expectJsonError(await fetch(`${base}/api/tasks/revert`, { method: 'POST', headers: { ...json, 'content-encoding': 'gzip' }, body: 'not gzip at all' }), 400, 'INVALID_REQUEST_BODY');
  await expectJsonError(await fetch(`${base}/api/tasks/revert`, { method: 'POST', headers: { ...json, 'content-encoding': 'compress' }, body: '{}' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  await expectJsonError(await fetch(`${base}/api/tasks/revert`, { method: 'POST', headers: { 'content-type': 'application/json; charset=klingon' }, body: '{}' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  await expectJsonError(await fetch(`${base}/api/tasks/revert`, { method: 'POST', headers: json, body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 10) }) }), 413, 'PAYLOAD_TOO_LARGE');
  // A valid gzip body still parses and reaches the guard.
  const gzipped = await fetch(`${base}/api/tasks/revert`, { method: 'POST', headers: { ...json, 'content-encoding': 'gzip' }, body: zlib.gzipSync('{}') });
  assert.equal(gzipped.status, 401);
  // The 7 MB archive parser runs after the member guard; its errors are JSON too.
  await expectJsonError(await fetch(`${base}/api/instance/extensions/v1/skills/archive`, { method: 'POST', headers: { ...json, ...member, 'x-propr-extensions': '1' }, body: '{invalid' }), 400, 'INVALID_JSON');

  // 2. Unknown routes.
  await expectJsonError(await fetch(`${base}/api/config`, { headers: member }), 404, 'NOT_FOUND');
  await expectJsonError(await fetch(`${base}/api/definitely/not/a/route`, { method: 'POST', headers: { ...json, ...member }, body: '{}' }), 404, 'NOT_FOUND');
  await expectJsonError(await fetch(`${base}/health/extra`), 404, 'NOT_FOUND');
  await expectJsonError(await fetch(`${base}/mcp/unknown`), 404, 'NOT_FOUND');
  await expectJsonError(await fetch(`${base}/mcp/late-route`), 500, 'INTERNAL_ERROR');
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

  // 5. The deprecated alias serves the template catalog like the canonical route.
  const canonical = await fetch(`${base}/api/automation-definitions/templates`, { headers: member });
  const alias = await fetch(`${base}/api/agent-definitions/templates`, { headers: member });
  assert.equal(canonical.status, 200);
  assert.equal(alias.status, 200);
  assert.deepEqual(await alias.json(), await canonical.json());

  // 6. Security headers and CORS credentials.
  const unauthenticated = await fetch(`${base}/api/tasks`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('www-authenticate'), 'Bearer');
  assert.equal(unauthenticated.headers.get('x-powered-by'), null);
  assert.equal(unauthenticated.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(unauthenticated.headers.get('access-control-allow-credentials'), null, 'no Origin, no credentials header');
  const allowed = await fetch(`${base}/api/tasks`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  const preflight = await fetch(`${base}/api/tasks`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  const rejected = await fetch(`${base}/api/tasks`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-credentials'), null);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);

  // 3. /api/activity paging bounds.
  for (const query of ['offset=99999999999999999999', 'limit=99999999999999999999', 'limit=-1', 'limit=0', 'limit=201', 'limit=1000000000', 'limit=abc', 'offset=-1', 'offset=1.5', 'limit=']) {
    await expectJsonError(await fetch(`${base}/api/activity?${query}`, { headers: member }), 400, 'INVALID_PAGINATION');
  }
  for (const query of ['', 'limit=1', 'limit=200&offset=0', 'offset=5']) {
    const response = await fetch(`${base}/api/activity?${query}`, { headers: member });
    assert.equal(response.status, 200, query);
    assert.ok(Array.isArray(await response.json()));
  }

  // 4. Owner/repo path segments of the GitHub proxy.
  for (const suffix of ['branches', 'workflows']) {
    for (const repository of ['..%2f..%2fetc%2fpasswd/propr', 'integry/..', 'integry/.', 'in%20tegry/propr', 'integry/pro%3Fpr']) {
      // fetch() would resolve `..` and `.` segments before sending; send the path verbatim.
      const raw = await rawGet(`/api/github/repos/${repository}/${suffix}`, member);
      assert.equal(raw.status, 400, `${repository}/${suffix}`);
      assert.match(raw.contentType, /^application\/json/);
      assert.equal((JSON.parse(raw.body) as { code?: string }).code, 'INVALID_REPOSITORY');
    }
  }

  // 7. Task detail routes for an id ProPR has never seen. file-changes reads
  // core's own Redis cache first; apiTaskNotFound.test.ts covers it.
  for (const route of ['history', 'live-details']) {
    await expectJsonError(await fetch(`${base}/api/task/no-such-task-3617/${route}`, { headers: member }), 404, 'TASK_NOT_FOUND');
  }
  await core.db('tasks').insert({ task_id: 'known-task-3617', repository: 'acme/app', task_type: 'issue', issue_number: 7, created_at: new Date().toISOString() });
  await core.db('task_history').insert({ task_id: 'known-task-3617', state: 'pending', timestamp: new Date().toISOString() });
  for (const route of ['history', 'live-details']) {
    const response = await fetch(`${base}/api/task/known-task-3617/${route}`, { headers: member });
    assert.equal(response.status, 200, `${route} of a known task`);
  }
});
