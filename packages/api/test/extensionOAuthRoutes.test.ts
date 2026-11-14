import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import knex from 'knex';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ExtensionLibraryStore } from '../../core/src/extensions/extensionProfileStore.js';
import { ExtensionOAuthStore, setExtensionOAuth } from '../../core/src/extensions/extensionOAuthStore.js';
import { up } from '../../core/src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../../core/src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../../core/src/db/migrations/20261113000000_extension_library.js';
import { up as oauthMigration } from '../../core/src/db/migrations/20261113120000_extension_oauth.js';
import { OAUTH_MCP_URL, syntheticOAuthProvider } from '../../../test/fixtures/extensionOAuthFixture.js';

test('OAuth sign-in routes: durable administrators only, session-bound callback, public client metadata, secret-free projections', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-oauth-api-'));
  process.env.DB_FILENAME = path.join(root, 'fixture.sqlite');
  const { createExtensionLibraryRoutes } = await import('../routes/extensionProfileRoutes.js');
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await up(database); await grantMigration(database); await libraryMigration(database); await oauthMigration(database);
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }, { github_user_id: '3', role: 'admin' }]);
  const environment: NodeJS.ProcessEnv = { SYSTEM_TASK_SECRET: 'synthetic-oauth-api-custody', API_PUBLIC_URL: 'https://propr.example.com' };
  const store = new ExtensionLibraryStore(database, environment);
  const synthetic = syntheticOAuthProvider({ advertise: { metadataDocument: true }, issParameter: true });
  setExtensionOAuth(store, new ExtensionOAuthStore(store, { transport: synthetic.transport, notify: async () => {} }));
  await store.saveLibrary('1', { version: 1, skills: [], servers: [{ kind: 'https', name: 'docs', url: OAUTH_MCP_URL, enabled: true, tools: ['lookup'], capability: 'read', authentication: 'oauth', repositories: [], agents: [], autoApply: true }] }, {}, 0);

  const routes = createExtensionLibraryRoutes(store);
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 600 }));
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor'); if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    // The browser session the request belongs to.
    Object.defineProperty(req, 'sessionID', { value: req.get('x-test-session') ?? '', configurable: true });
    req.authorization = { role: 'admin', permissions: req.get('x-test-no-permission') ? [] : ['instance.manage_settings'], source: 'local' }; next();
  });
  app.get('/', routes.list);
  app.post('/oauth/check', routes.oauthCheck);
  app.post('/oauth/start', routes.oauthStart);
  app.post('/oauth/disconnect', routes.oauthDisconnect);
  app.get('/oauth/audit', routes.oauthAudit);
  app.get('/oauth/callback', routes.oauthCallback);
  app.get('/oauth/client-metadata.json', routes.clientMetadata);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await database.destroy(); await (await import('@propr/core')).closeConnection(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = { 'x-test-actor': '1', 'x-test-session': 'browser-session-a', 'content-type': 'application/json', 'x-propr-extensions': '1' };
  const post = (route: string, body: unknown, headers: Record<string, string> = admin) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  const bodies: string[] = [];
  const read = async (response: Response) => { const text = await response.text(); bodies.push(text); return text; };

  // ProPR's own client metadata is public and names only ProPR and this instance's redirect URI.
  const metadata = JSON.parse(await read(await fetch(base + '/oauth/client-metadata.json')));
  assert.deepEqual(metadata.redirect_uris, ['https://propr.example.com/api/instance/extensions/v1/oauth/callback']);
  assert.equal(metadata.client_id, 'https://propr.example.com/api/instance/extensions/v1/oauth/client-metadata.json');
  assert.equal(metadata.client_name, 'ProPR');

  const list = JSON.parse(await read(await fetch(base + '/', { headers: admin })));
  assert.equal(list.oauth.redirectUri, 'https://propr.example.com/api/instance/extensions/v1/oauth/callback');
  assert.deepEqual(list.oauth.connections, { docs: { state: 'not_connected' } });

  // Only durable administrators with instance.manage_settings, through the preflight JSON contract.
  assert.equal((await post('/oauth/start', { name: 'docs' }, { ...admin, 'x-test-actor': '2' })).status, 403);
  assert.equal((await post('/oauth/start', { name: 'docs' }, { ...admin, 'x-test-no-permission': '1' })).status, 403);
  assert.equal((await post('/oauth/start', { name: 'docs' }, { ...admin, 'x-propr-extensions': '0' })).status, 403);
  assert.equal((await post('/oauth/check', { url: OAUTH_MCP_URL }, { ...admin, 'x-test-actor': '2' })).status, 403);

  const check = JSON.parse(await read(await post('/oauth/check', { url: OAUTH_MCP_URL })));
  assert.equal(check.check.registration, 'metadata_document');
  assert.equal(check.check.redirectUri, list.oauth.redirectUri);

  // A sign-in started in session A cannot be completed from session B or by another administrator.
  const startedA = JSON.parse(await read(await post('/oauth/start', { name: 'docs' })));
  const params = synthetic.authorize(startedA.authorizationUrl);
  const query = (values: Record<string, string>) => new URLSearchParams(values).toString();
  const otherSession = await fetch(`${base}/oauth/callback?${query(params)}`, { headers: { 'x-test-actor': '1', 'x-test-session': 'browser-session-b' } });
  assert.equal(otherSession.status, 403);
  assert.match(await read(otherSession), /another session/);
  assert.deepEqual(await database('extension_oauth_connections').select(), []);

  const second = synthetic.authorize(JSON.parse(await read(await post('/oauth/start', { name: 'docs' }))).authorizationUrl);
  const otherAdmin = await fetch(`${base}/oauth/callback?${query(second)}`, { headers: { 'x-test-actor': '3', 'x-test-session': 'browser-session-a' } });
  assert.equal(otherAdmin.status, 403);
  await read(otherAdmin);

  const third = synthetic.authorize(JSON.parse(await read(await post('/oauth/start', { name: 'docs' }))).authorizationUrl);
  const completed = await fetch(`${base}/oauth/callback?${query(third)}`, { headers: { 'x-test-actor': '1', 'x-test-session': 'browser-session-a' } });
  assert.equal(completed.status, 200);
  assert.match(completed.headers.get('content-type') ?? '', /text\/html/);
  assert.match(completed.headers.get('content-security-policy') ?? '', /default-src 'none'; script-src 'nonce-/);
  assert.equal(completed.headers.get('cache-control'), 'no-store');
  const page = await read(completed);
  assert.match(page, /Connected/);
  assert.match(page, /propr-extension-oauth/);
  const replay = await fetch(`${base}/oauth/callback?${query(third)}`, { headers: { 'x-test-actor': '1', 'x-test-session': 'browser-session-a' } });
  assert.equal(replay.status, 400); await read(replay);

  const connected = JSON.parse(await read(await fetch(base + '/', { headers: admin })));
  assert.equal(connected.oauth.connections.docs.state, 'connected');
  assert.equal(connected.oauth.connections.docs.connectedBy, '1');
  assert.equal(connected.oauth.connections.docs.registration, 'metadata_document');
  assert.equal(connected.library.revision, list.library.revision, 'connecting creates no library revision');
  const audit = JSON.parse(await read(await fetch(base + '/oauth/audit', { headers: admin })));
  assert.deepEqual(audit.events.map((e: { action: string; actor: string }) => [e.action, e.actor]), [['connect', '1']]);

  const disconnected = JSON.parse(await read(await post('/oauth/disconnect', { name: 'docs' })));
  assert.equal(disconnected.revoked, true);
  assert.deepEqual(JSON.parse(await read(await fetch(base + '/', { headers: admin }))).oauth.connections, { docs: { state: 'not_connected' } });

  // No API response ever carried a token, a refresh token, a code verifier or a client secret.
  assert.ok(synthetic.state.issued.length >= 2);
  for (const value of synthetic.state.issued) assert.ok(!bodies.join('\n').includes(value));

  // Without a public base URL Connect is unavailable and explained.
  delete environment.API_PUBLIC_URL;
  assert.equal((await fetch(base + '/oauth/client-metadata.json')).status, 404);
  assert.equal(JSON.parse(await read(await fetch(base + '/', { headers: admin }))).oauth.redirectUri, null);
  const unavailable = await post('/oauth/start', { name: 'docs' });
  assert.equal(unavailable.status, 409);
  assert.match(await read(unavailable), /public HTTPS base URL/);
});
