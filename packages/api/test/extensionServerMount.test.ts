import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// Import the real server composition without connecting to Redis/background jobs.
// Only infrastructure startup uses demo facades; requests use the real member
// guard, durable authorization, extension handlers and body parsers.
test('server mounts extension gateway before auth, management after auth, and archive parser at 7 MB', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-server-'));
  process.env.DB_FILENAME = path.join(root, 'fixture.sqlite');
  process.env.DATA_DIR = root;
  process.env.FRONTEND_URL = 'http://localhost:3000';
  process.env.SESSION_SECRET = 'synthetic-test-session-secret-with-enough-entropy-123456789';
  process.env.SYSTEM_TASK_SECRET = 'synthetic-test-custody-root';
  process.env.PROPR_API_RATE_LIMIT_MAX = '100';
  const demo = await import('../demoMode.js');
  mock.module('../demoMode.js', { namedExports: { ...demo, configureDemoMode: () => true, isDemoMode: () => false } });
  const auth = await import('../auth.js');
  mock.module('../auth.js', { namedExports: { ...auth, setupAuth: () => ({ engineMiddleware: [], authenticate: () => undefined }) } });
  const endpoint = await import('../../core/src/extensions/endpointPolicy.js');
  mock.module('../../core/src/extensions/endpointPolicy.js', { namedExports: { ...endpoint, requestExtensionMcp: async (_url: string, body: { method?: string; id?: unknown }) => body.method === 'tools/call' ? ({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'upstream-secret', data: { secret: 'upstream-secret' } } }) : ({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] } }) } });
  process.env.PROPR_API_DISABLE_AUTOSTART = '1';
  const { app, setupRoutes, initRedis } = await import('../server.js');
  const core = await import('@propr/core');
  await core.runMigrations();
  await core.db('instance_members').insert({ github_user_id: '1', github_username: 'fixture', role: 'admin' });
  // Simulate a validated Passport session, retaining the production auth guard.
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor');
    req.isAuthenticated = (() => !!actor) as typeof req.isAuthenticated;
    if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    next();
  });
  await initRedis(); setupRoutes();
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await core.closeConnection(); mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The retired Connect-managed extension transport has no public, tunnel or
  // session-authenticated route. Its former paths are ordinary unknown routes.
  for (const extra of [{}, { 'x-test-actor': '1', 'x-forwarded-host': 'synthetic.tunnel.invalid' }]) {
    for (const retired of ['/extensions/v1/invoke', '/extensions/authority/v1/prove', '/extensions/authority/v2/invoke', '/extensions/authority/v2/prove']) {
      const response = await fetch(base + retired, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: '{}' });
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /extension_authority_unavailable|fleet_extensions_unavailable/);
    }
  }
  const preflight = await fetch(base + '/api/task-submissions', { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-propr-extensions,idempotency-key' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers')!, /x-propr-extensions/i);
  const unauthenticated = await fetch(base + '/api/instance/extensions/v1');
  assert.equal(unauthenticated.status, 401);
  const headers = { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-extensions': '1' };
  assert.equal((await fetch(base + '/api/instance/extensions/v1', { headers })).status, 200);
  assert.equal((await fetch(base + '/api/instance/extensions/v1', { headers: { 'x-test-actor': '2' } })).status, 403);
  const gateway = await fetch(base + '/api/extensions/mcp/docs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(gateway.status, 401);
  assert.equal((await gateway.json()).error, 'Extension MCP unavailable'); // Handler, rather than member guard, refused it.
  const { ExtensionProfileStore } = await import('../../core/src/extensions/extensionProfileStore.js');
  const store = new ExtensionProfileStore(core.db);
  const profile = await store.save('1', { version: 1, name: 'Fixture', enabled: true, agentScope: [], repositoryScope: [], mcpServers: [{ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'none' }], skillBundleIds: [] }, {});
  const token = await store.createGrant('1', profile, 'fixture-task');
  await store.activateGrant(token, '1', { instanceId: profile.instanceId, profileId: profile.profileId, revision: profile.revision });
  const authorizedGateway = await fetch(base + '/api/extensions/mcp/docs', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(authorizedGateway.status, 200); // No member session is supplied.
  assert.equal((await authorizedGateway.json()).result.tools[0].name, 'lookup');
  const protocolError = await fetch(base + '/api/extensions/mcp/docs', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lookup' } }) });
  assert.equal(protocolError.status, 200);
  assert.deepEqual(await protocolError.json(), { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'MCP request failed' } });
  for (const suffix of ['', '/', '?upload=1']) {
    const unauthenticatedArchive = await fetch(base + '/api/instance/extensions/v1/skills/archive' + suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid-json' });
    assert.equal(unauthenticatedArchive.status, 401, 'authentication precedes JSON parsing');
  }
  const payload = JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) });
  const archive = await fetch(base + '/api/instance/extensions/v1/skills/archive', { method: 'POST', headers, body: payload });
  assert.equal(archive.status, 400); // Parsed successfully, then invalid archive input.
  const normal = await fetch(base + '/api/instance/extensions/v1/profiles', { method: 'POST', headers, body: payload });
  assert.equal(normal.status, 413);
  const oversized = await fetch(base + '/api/instance/extensions/v1/skills/archive', { method: 'POST', headers, body: JSON.stringify({ padding: 'x'.repeat(7 * 1024 * 1024) }) });
  assert.equal(oversized.status, 413);
});
