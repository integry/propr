import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import knex from 'knex';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { getOfficialPlugin, loadPluginHandlers } from '../../plugins/src/index.js';
import { PluginStore } from '../../core/src/plugins/pluginStore.js';
import type { PluginHttpTransport, PluginHttpTransportRequest } from '../../core/src/plugins/pluginHttp.js';
import { up as identityMigration } from '../../core/src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../../core/src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../../core/src/db/migrations/20261113000000_extension_library.js';
import { up as oauthMigration } from '../../core/src/db/migrations/20261113120000_extension_oauth.js';
import { up as pluginMigration } from '../../core/src/db/migrations/20261114000000_plugin_installations.js';
import { up as pluginStateMigration } from '../../core/src/db/migrations/20261114180000_plugin_state.js';
import { up as journalMigration } from '../../core/src/db/migrations/20261112160000_create_repository_events.js';
import { up as taskDomainMigration } from '../../core/src/db/migrations/20261114120000_add_task_repository_event_domain.js';
import { up as deliveriesMigration } from '../../core/src/db/migrations/20261115000000_plugin_event_deliveries.js';
import { up as webhookKeysMigration } from '../../core/src/db/migrations/20261116000000_plugin_webhook_keys.js';
import { up as commandSettingsMigration } from '../../core/src/db/migrations/20261116120000_plugin_command_settings.js';

const BASE = '/api/instance/plugins/v1';
const API_KEY = 'lin_api_route0000000000000000000000000000';

test('plugin settings-options route: administrators only, the choices read through ctx.http with the saved key, and a clear refusal without a connection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-options-api-'));
  process.env.DB_FILENAME = path.join(root, 'fixture.sqlite');
  const { createPluginRoutes } = await import('../routes/pluginRoutes.js');
  const { createPluginActivityRoutes } = await import('../routes/pluginActivityRoutes.js');
  const { createPluginWebhookAdminRoutes } = await import('../routes/pluginWebhookRoutes.js');
  const { createPluginRouteEntries } = await import('../pluginRouteRegistry.js');
  const { registerRouteEntries } = await import('../routeRegistry.js');
  const schemas = await import('../openapi/schemasPlugins.js');
  const { ROUTE_DOCS } = await import('../openapi/routeDocs.js');

  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  for (const migrate of [identityMigration, grantMigration, libraryMigration, oauthMigration, pluginMigration, pluginStateMigration, journalMigration, taskDomainMigration, deliveriesMigration, webhookKeysMigration, commandSettingsMigration]) await migrate(database);
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  const manifest = getOfficialPlugin('linear', { includeDevelopment: false })!.manifest;
  const catalog = async () => [manifest];
  const environment = { SYSTEM_TASK_SECRET: 'plugin-options-route' };
  const store = new PluginStore(database, environment, catalog);
  const requests: PluginHttpTransportRequest[] = [];
  const transport: PluginHttpTransport = async request => {
    requests.push(request);
    const query = String((JSON.parse(request.body?.toString() ?? '{}') as { query?: string }).query);
    const data = query.includes('workflowStates') ? { workflowStates: { nodes: [{ id: 's1', name: 'Done', team: { id: 't1', key: 'ENG' } }] } } : {};
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ data })) };
  };
  const optionDeps = {
    transport, handlers: (id: string) => loadPluginHandlers(id, { includeDevelopment: false }),
    lookup: async (host: string) => (host === 'api.linear.app' ? [{ address: '35.0.0.1', family: 4 }] : Promise.reject(new Error('ENOTFOUND'))),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor'); if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    const member = req.get('x-test-role') === 'member';
    req.authorization = { role: member ? 'member' : 'admin', permissions: member ? [] : ['instance.manage_settings'], source: 'local' };
    next();
  });
  const entries = createPluginRouteEntries(createPluginRoutes(store, environment, optionDeps), createPluginActivityRoutes(store, database), createPluginWebhookAdminRoutes(store, database, environment));
  registerRouteEntries(app, entries);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => {
    await new Promise<void>(r => server.close(() => r())); await database.destroy(); await (await import('@propr/core')).closeConnection(); await fs.rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const route = '/:pluginId/settings/:settingKey/options';
  assert.ok(entries.some(([method, p]) => method === 'get' && p === BASE + route), 'the route is registered');
  assert.ok(ROUTE_DOCS[`GET ${BASE}${route}`], 'the route has an OpenAPI entry');
  const options = async (setting: string, headers: Record<string, string> = { 'x-test-actor': '1' }) => {
    const response = await fetch(`${origin}${BASE}/linear/settings/${setting}/options`, { headers });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked below
    return { status: response.status, body: await response.json() as any };
  };

  assert.equal((await options('stateOnMerged')).status, 409, 'not installed');
  await store.install('1', 'linear');
  const member = await options('stateOnMerged', { 'x-test-actor': '2', 'x-test-role': 'member' });
  assert.equal(member.status, 403, 'a non-administrator is refused');
  assert.equal((await options('stateOnMerged', {})).status, 401, 'a signed-out request is refused');
  const notAdmin = await options('stateOnMerged', { 'x-test-actor': '2' });
  assert.equal(notAdmin.status, 403, 'an instance member without durable administrator access is refused');
  assert.equal(requests.length, 0, 'refused requests read nothing from Linear');

  const disconnected = await options('stateOnMerged');
  assert.equal(disconnected.status, 409);
  assert.match(disconnected.body.error, /Set the Linear API key under Connections/);
  assert.equal((await options('triggerLabel')).status, 404, 'a setting without optionsFrom');

  await store.setConnection('1', 'linear', 'api-key', API_KEY);
  const loaded = await options('stateOnMerged');
  assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
  assert.deepEqual(loaded.body, { options: [{ value: 'Done', label: 'Done (ENG)' }] });
  assert.ok(schemas.PluginSettingOptionsResponse.safeParse(loaded.body).success);
  assert.deepEqual(requests.map(r => [r.url.hostname, r.headers.authorization]), [['api.linear.app', API_KEY]]);
  assert.equal(JSON.stringify(loaded.body).includes(API_KEY), false);
});
