import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import knex from 'knex';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { pluginManifestSchema, type PluginManifest } from '@propr/shared';
import { getOfficialPlugin } from '../../plugins/src/index.js';
import { PluginStore } from '../../core/src/plugins/pluginStore.js';
import { up as identityMigration } from '../../core/src/db/migrations/20261013210000_extension_profiles.js';
import { up as pluginMigration } from '../../core/src/db/migrations/20261114000000_plugin_installations.js';
import { up as grantMigration } from '../../core/src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../../core/src/db/migrations/20261113000000_extension_library.js';
import { up as oauthMigration } from '../../core/src/db/migrations/20261113120000_extension_oauth.js';
import { ExtensionOAuthStore, setExtensionOAuth } from '../../core/src/extensions/extensionOAuthStore.js';
import { OAUTH_MCP_URL, syntheticOAuthProvider } from '../../../test/fixtures/extensionOAuthFixture.js';

const SENTINEL = 'plugin-api-token-sentinel-41c7';
const ID = 'example-pack';
const BASE = '/api/instance/plugins/v1';

function assertConforms(schema: z.ZodType, body: unknown, label: string): void {
  const result = schema.safeParse(body);
  assert.ok(result.success, `${label} does not match its schema:\n${result.success ? '' : z.prettifyError(result.error)}`);
  assert.deepEqual(result.data, body, `${label} sends fields its schema does not allow`);
}

test('plugin REST API and MCP read tools: administrators only, audited, secret-free and schema-conformant', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-api-'));
  process.env.DB_FILENAME = path.join(root, 'fixture.sqlite');
  const { createPluginRoutes } = await import('../routes/pluginRoutes.js');
  const { createPluginRouteEntries } = await import('../pluginRouteRegistry.js');
  const { registerRouteEntries } = await import('../routeRegistry.js');
  const { addPluginTools } = await import('../mcp/toolsPlugins.js');
  const schemas = await import('../openapi/schemasPlugins.js');
  const { ROUTE_DOCS } = await import('../openapi/routeDocs.js');

  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await identityMigration(database); await grantMigration(database); await libraryMigration(database); await oauthMigration(database); await pluginMigration(database);
  // 3 holds the admin role in the session but is no longer a durable administrator.
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }, { github_user_id: '3', role: 'member' }]);
  // The remote server at the synthetic OAuth provider's address literal: no DNS in tests.
  const official = structuredClone(getOfficialPlugin(ID, { includeDevelopment: true })!.manifest);
  official.contributes.mcpServers[0] = { ...official.contributes.mcpServers[0], url: OAUTH_MCP_URL } as typeof official.contributes.mcpServers[0];
  const example = pluginManifestSchema.parse(official);
  let catalog: PluginManifest[] = [example];
  const store = new PluginStore(database, { SYSTEM_TASK_SECRET: 'plugin-api-custody' }, async () => catalog);
  const synthetic = syntheticOAuthProvider({ advertise: { dynamic: true } });
  setExtensionOAuth(store.library, new ExtensionOAuthStore(store.library, { transport: synthetic.transport, retryDelayMs: 1 }));

  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor'); if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    const member = req.get('x-test-role') === 'member';
    req.authorization = { role: member ? 'member' : 'admin', permissions: member ? [] : ['instance.manage_settings'], source: 'local' };
    (req as { sessionID?: string }).sessionID = req.get('x-test-session') ?? 'session-a'; next();
  });
  const entries = createPluginRouteEntries(createPluginRoutes(store, { API_PUBLIC_URL: 'https://propr.example.com' }));
  registerRouteEntries(app, entries);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await database.destroy(); await (await import('@propr/core')).closeConnection(); await fs.rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bodies: string[] = [];
  const admin = { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-plugins': '1' };
  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = admin) => {
    const response = await fetch(origin + BASE + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); bodies.push(text);
    return { status: response.status, body: JSON.parse(text), cache: response.headers.get('cache-control') };
  };

  // Every route is documented.
  for (const [method, route] of entries) assert.ok(ROUTE_DOCS[`${method.toUpperCase()} ${route}`], `${method} ${route} has an OpenAPI entry`);

  const list = await call('GET', '');
  assert.equal(list.status, 200);
  assert.equal(list.cache, 'no-store');
  assertConforms(schemas.PluginList, list.body, 'GET plugins');
  assert.equal(list.body.plugins[0].state, 'available');

  // Install needs the package server acknowledgement.
  const unacknowledged = await call('POST', `/${ID}/install`, {});
  assert.equal(unacknowledged.status, 400);
  assert.match(unacknowledged.body.error, /example-local/);
  const installed = await call('POST', `/${ID}/install`, { acknowledgements: ['example-local'] });
  assert.equal(installed.status, 200);
  assertConforms(schemas.PluginResponse, installed.body, 'install');
  assert.equal(installed.body.plugin.state, 'installed');

  const refusedEnable = await call('PUT', `/${ID}/enabled`, { enabled: true });
  assert.equal(refusedEnable.status, 409);
  assert.match(refusedEnable.body.error, /Connection Example API token \(example-token\) is not set/);
  assert.equal((await call('PUT', `/${ID}/settings`, { settings: { verbosity: 'loud' } })).status, 400);
  assert.equal((await call('PUT', `/${ID}/settings`, { settings: { verbosity: 'quiet', maxItems: 3 } })).status, 200);
  assert.equal((await call('PUT', `/${ID}/repositories`, { repositories: ['acme/app'] })).body.plugin.installation.repositories[0], 'acme/app');
  const connected = await call('PUT', `/${ID}/connections/example-token`, { value: SENTINEL });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.plugin.connections.find((c: { name: string }) => c.name === 'example-token').state, 'connected');
  assert.equal((await call('PUT', `/${ID}/connections/example-account`, { value: SENTINEL })).status, 400);
  assert.equal((await call('PUT', `/${ID}/connections/missing`, { value: SENTINEL })).status, 404);
  const enabled = await call('PUT', `/${ID}/enabled`, { enabled: true });
  assert.equal(enabled.body.plugin.state, 'enabled');
  assertConforms(schemas.PluginResponse, enabled.body, 'enable');
  // The read model lists the contributions with their managed library items; the plugin's repository limit applies to them.
  const contributions = enabled.body.plugin.contributions;
  assert.deepEqual(contributions.mcpServers.map((s: { name: string; managed: unknown }) => [s.name, s.managed]), [
    ['example-remote', { kind: 'server', name: 'example-remote', enabled: true, active: true }],
    ['example-local', { kind: 'server', name: 'example-local', enabled: true, active: true }],
  ]);
  assert.equal(contributions.skills[0].managed.kind, 'skill');
  assert.equal(contributions.mcpServers[0].href, '/api/instance/extensions/v1');
  assert.deepEqual(contributions.automationTemplates.map((t: { catalogId: string; available: boolean }) => [t.catalogId, t.available]), [['example-weekly-digest', true]]);
  const libraryItems = (await store.library.readLibrary('1'));
  assert.deepEqual([...libraryItems.servers, ...libraryItems.skills].map(item => item.repositories), [['acme/app'], ['acme/app'], ['acme/app']]);

  // OAuth connections: start, complete (as the provider's redirect would) and disconnect.
  assert.equal(enabled.body.plugin.connections.find((c: { name: string }) => c.name === 'example-account').state, 'not_connected');
  assert.equal((await call('POST', `/${ID}/connections/example-token/oauth/start`, {})).status, 404);
  assert.equal((await call('POST', `/${ID}/connections/example-account/oauth/start`, { extra: 1 })).status, 400);
  const started = await call('POST', `/${ID}/connections/example-account/oauth/start`, {});
  assert.equal(started.status, 200);
  assertConforms(schemas.PluginOAuthStartResponse, started.body, 'start OAuth');
  assert.equal(started.body.server, 'example-remote');
  const params = synthetic.authorize(started.body.authorizationUrl);
  assert.equal((await call('POST', `/${ID}/connections/example-account/oauth/complete`, params, { ...admin, 'x-test-session': 'session-b' })).status, 403, 'only the session that started it completes it');
  const second = await call('POST', `/${ID}/connections/example-account/oauth/start`, {});
  const oauthDone = await call('POST', `/${ID}/connections/example-account/oauth/complete`, synthetic.authorize(second.body.authorizationUrl));
  assert.equal(oauthDone.status, 200, JSON.stringify(oauthDone.body));
  assertConforms(schemas.PluginResponse, oauthDone.body, 'complete OAuth');
  assert.equal(oauthDone.body.plugin.connections.find((c: { name: string }) => c.name === 'example-account').state, 'connected');
  const oauthOff = await call('POST', `/${ID}/connections/example-account/oauth/disconnect`, {});
  assert.equal(oauthOff.body.plugin.connections.find((c: { name: string }) => c.name === 'example-account').state, 'not_connected');

  const disabled = await call('PUT', `/${ID}/enabled`, { enabled: false });
  assert.equal(disabled.body.plugin.state, 'installed');
  assert.deepEqual(disabled.body.plugin.contributions.mcpServers.map((s: { managed: { active: boolean } }) => s.managed.active), [false, false]);
  assert.equal(disabled.body.plugin.contributions.automationTemplates[0].available, false);
  const reenabled = await call('PUT', `/${ID}/enabled`, { enabled: true });
  assert.equal(reenabled.body.plugin.state, 'enabled');
  assert.equal(reenabled.body.plugin.installation.settings.verbosity, 'quiet', 'settings survive disable');

  // An upgraded manifest that adds a permission: Needs approval, old grant kept until approved.
  catalog = [pluginManifestSchema.parse({ ...structuredClone(example), version: '0.2.0', permissions: [...example.permissions, 'pull_requests.read'] })];
  const pending = await call('GET', `/${ID}`);
  assertConforms(schemas.PluginDetailResponse, pending.body, 'GET plugin');
  assert.equal(pending.body.plugin.needsApproval, true);
  assert.deepEqual(pending.body.plugin.pendingPermissions, ['pull_requests.read']);
  assert.deepEqual(pending.body.plugin.installation.grantedPermissions, ['events.read', 'tasks.read']);
  const approved = await call('POST', `/${ID}/approve`, {});
  assert.equal(approved.body.plugin.needsApproval, false);
  assert.equal(approved.body.plugin.installation.installedVersion, '0.2.0');

  // Non-administrators are refused on every route, reads included; mutations need the preflight-protected JSON contract.
  const routes = entries.map(([method, route]) => [method.toUpperCase(), route.replace(BASE, '').replace(':pluginId', ID).replace(':connectionName', 'example-token')] as const);
  for (const [method, route] of routes) {
    const body = method === 'GET' ? undefined : {};
    for (const headers of [
      { ...admin, 'x-test-role': 'member' },
      { ...admin, 'x-test-actor': '3' },
      { ...admin, 'x-test-actor': '2', 'x-test-role': 'admin' },
      { 'content-type': 'application/json', 'x-propr-plugins': '1' },
    ]) {
      const response = await call(method, route, body, headers);
      assert.ok([401, 403].includes(response.status), `${method} ${route} as ${JSON.stringify(headers)} answered ${response.status}`);
    }
    if (method !== 'GET') assert.equal((await call(method, route, body, { 'x-test-actor': '1', 'content-type': 'application/json' })).status, 403, `${method} ${route} without X-ProPR-Plugins`);
  }

  // MCP read-only tools project the same state, without secrets.
  const tools: { name: string; readOnly?: boolean; permission?: string; run: (input: { principal: unknown; args: Record<string, unknown> }) => Promise<{ data: unknown }> }[] = [];
  addPluginTools(tools as never, { db: database } as never);
  assert.deepEqual(tools.map(tool => [tool.name, tool.readOnly, tool.permission]), [['list_plugins', true, 'instance.manage_settings'], ['get_plugin', true, 'instance.manage_settings']]);
  const principal = { user: { id: '1' } };
  // The MCP tools use the default official catalog, which includes the example plugin only with the development flag.
  process.env.PROPR_PLUGINS_DEVELOPMENT = '1';
  t.after(() => { delete process.env.PROPR_PLUGINS_DEVELOPMENT; });
  const listed = await tools[0].run({ principal, args: {} }) as { data: { plugins: { id: string; state: string; connections: { name: string; state: string }[] }[] } };
  const row = listed.data.plugins.find(p => p.id === ID)!;
  assert.equal(row.state, 'enabled');
  assert.equal(row.connections.find(c => c.name === 'example-token')?.state, 'connected');
  const detail = await tools[1].run({ principal, args: { pluginId: ID } }) as { data: { plugin: { audit: { action: string }[] } } };
  assert.ok(detail.data.plugin.audit.some(event => event.action === 'set_connection'));
  await assert.rejects(tools[1].run({ principal: { user: { id: '2' } }, args: { pluginId: ID } }), /administrator/);
  await assert.rejects(tools[1].run({ principal, args: { pluginId: 'no-such-plugin' } }), (error: { code?: string }) => error.code === 'NOT_FOUND');
  bodies.push(JSON.stringify(listed), JSON.stringify(detail));

  // Uninstall needs the confirmation, deletes settings and connections, and is audited.
  assert.equal((await call('POST', `/${ID}/uninstall`, { confirm: 'nope' })).status, 400);
  const disabledBeforeUninstall = await call('POST', `/${ID}/uninstall`, { confirm: ID });
  assert.equal(disabledBeforeUninstall.body.plugin.state, 'available');
  assert.equal((await database('plugin_secrets').count({ n: '*' }))[0].n, 0);
  const emptied = await store.library.readLibrary('1');
  assert.deepEqual([emptied.servers, emptied.skills], [[], []], 'uninstall removes the managed items');
  bodies.push(JSON.stringify(await store.library.history('1')));
  const audit = await call('GET', `/${ID}`);
  assert.deepEqual(audit.body.plugin.audit.map((e: { action: string }) => e.action).reverse(), [
    'install', 'update_settings', 'set_repositories', 'set_connection', 'enable', 'start_oauth', 'start_oauth', 'complete_oauth', 'disconnect_oauth', 'disable', 'enable', 'approve', 'uninstall',
  ]);

  for (const text of bodies) assert.ok(!text.includes(SENTINEL), 'no response carries a connection secret');
});
