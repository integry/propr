import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import knex from 'knex';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { getOfficialPlugin, loadPluginHandlers } from '../../plugins/src/index.js';
import { PluginStore } from '../../core/src/plugins/pluginStore.js';
import type { PluginHttpTransport, PluginHttpTransportRequest } from '../../core/src/plugins/pluginHttp.js';
import { up as identityMigration } from '../../core/src/db/migrations/20261013210000_extension_profiles.js';
import { up as pluginMigration } from '../../core/src/db/migrations/20261114000000_plugin_installations.js';
import { up as pluginStateMigration } from '../../core/src/db/migrations/20261114180000_plugin_state.js';
import { up as journalMigration } from '../../core/src/db/migrations/20261112160000_create_repository_events.js';
import { up as deliveriesMigration } from '../../core/src/db/migrations/20261115000000_plugin_event_deliveries.js';
import { up as webhookKeysMigration } from '../../core/src/db/migrations/20261116000000_plugin_webhook_keys.js';
import { up as commandSettingsMigration } from '../../core/src/db/migrations/20261116120000_plugin_command_settings.js';
import { up as grantMigration } from '../../core/src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../../core/src/db/migrations/20261113000000_extension_library.js';
import { up as oauthMigration } from '../../core/src/db/migrations/20261113120000_extension_oauth.js';

/**
 * `GET /api/instance/plugins/v1/:pluginId/settings/:settingKey/options`: the
 * choices of an `optionsFrom` setting, here the official Linear plugin's
 * teams and workflow states. Administrators only; the handler's refusal
 * before the API key is set is the response's error, for the form to show.
 */

const BASE = '/api/instance/plugins/v1';
const API_KEY = 'lin_api_ROUTEsentinel0123456789';
const TEAMS = { data: { teams: { nodes: [{ id: '3f1c2a9e-1b2c-4d5e-8f90-aaaaaaaaaaaa', key: 'ENG', name: 'Engineering' }] } } };
const STATES = { data: { workflowStates: { nodes: [{ id: 's1', name: 'In Review', team: { key: 'ENG' } }, { id: 's2', name: 'Done', team: { key: 'ENG' } }] } } };

test('the settings options route loads choices through the plugin for administrators only, with the plugin\'s message when not connected', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-options-api-'));
  process.env.DB_FILENAME = path.join(root, 'fixture.sqlite');
  const { createPluginRoutes } = await import('../routes/pluginRoutes.js');
  const { createPluginRouteEntries } = await import('../pluginRouteRegistry.js');
  const { registerRouteEntries } = await import('../routeRegistry.js');
  const { createPluginActivityRoutes } = await import('../routes/pluginActivityRoutes.js');
  const { createPluginWebhookAdminRoutes } = await import('../routes/pluginWebhookRoutes.js');
  const schemas = await import('../openapi/schemasPlugins.js');
  const { ROUTE_DOCS } = await import('../openapi/routeDocs.js');

  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  for (const migrate of [identityMigration, grantMigration, libraryMigration, oauthMigration, pluginMigration, pluginStateMigration, journalMigration, deliveriesMigration, webhookKeysMigration, commandSettingsMigration]) await migrate(database);
  // 3 holds the admin role in the session but is no longer a durable administrator.
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }, { github_user_id: '3', role: 'member' }]);
  const manifest = getOfficialPlugin('linear', { includeDevelopment: false })!.manifest;
  const catalog = async () => [manifest];
  const environment = { SYSTEM_TASK_SECRET: 'plugin-options-custody' };
  const store = new PluginStore(database, environment, catalog);
  const requests: PluginHttpTransportRequest[] = [];
  const transport: PluginHttpTransport = async request => {
    requests.push(request);
    const { query } = JSON.parse(request.body?.toString() ?? '{}') as { query: string };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(query.includes('ProprTeams') ? TEAMS : STATES)) };
  };
  const runOptions = {
    catalog, transport, handlers: (id: string) => loadPluginHandlers(id, { includeDevelopment: false }),
    lookup: async (host: string) => (host === 'api.linear.app' ? [{ address: '35.0.0.1', family: 4 }] : Promise.reject(new Error('ENOTFOUND'))),
  };

  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor'); if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    const member = req.get('x-test-role') === 'member';
    req.authorization = { role: member ? 'member' : 'admin', permissions: member ? [] : ['instance.manage_settings'], source: 'local' };
    next();
  });
  const entries = createPluginRouteEntries(createPluginRoutes(store, environment, database, runOptions), createPluginActivityRoutes(store, database), createPluginWebhookAdminRoutes(store, database, {}));
  registerRouteEntries(app, entries);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await database.destroy(); await (await import('@propr/core')).closeConnection(); await fs.rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (route: string, headers: Record<string, string> = { 'x-test-actor': '1' }) => {
    const response = await fetch(origin + BASE + route, { headers });
    return { status: response.status, body: await response.json() as Record<string, unknown>, cache: response.headers.get('cache-control') };
  };
  assert.ok(ROUTE_DOCS[`GET ${BASE}/:pluginId/settings/:settingKey/options`], 'the route is documented');

  assert.deepEqual(await get('/linear/settings/repositoryTeams/options'), { status: 409, body: { error: 'Install the plugin first' }, cache: 'no-store' });
  await store.install('1', 'linear');
  // Installed, disabled and not connected yet: the plugin's own message.
  assert.deepEqual((await get('/linear/settings/repositoryTeams/options')).body, { error: 'Linear is not connected yet. Set the Linear API key under Connections, then choose Reload choices.' });
  await store.setConnection('1', 'linear', 'api-key', API_KEY);

  const teams = await get('/linear/settings/repositoryTeams/options');
  assert.equal(teams.status, 200);
  assert.deepEqual(teams.body, { options: [{ value: '3f1c2a9e-1b2c-4d5e-8f90-aaaaaaaaaaaa', label: 'Engineering (ENG)' }] });
  assert.ok(schemas.PluginSettingOptionsResponse.safeParse(teams.body).success);
  assert.deepEqual((await get('/linear/settings/openedState/options')).body, { options: [{ value: 'Done', label: 'Done (ENG)' }, { value: 'In Review', label: 'In Review (ENG)' }] });
  assert.equal((await get('/linear/settings/triggerLabel/options')).status, 404, 'a setting without optionsFrom');
  assert.equal((await get('/missing/settings/repositoryTeams/options')).status, 404);
  const sent = requests.length;

  // Not an administrator: refused before the plugin runs.
  assert.equal((await get('/linear/settings/repositoryTeams/options', { 'x-test-actor': '2', 'x-test-role': 'member' })).status, 403, 'a member');
  assert.equal((await get('/linear/settings/repositoryTeams/options', { 'x-test-actor': '3' })).status, 403, 'an administrator session without durable administrator access');
  assert.equal((await get('/linear/settings/repositoryTeams/options', {})).status, 401, 'signed out');
  assert.equal(requests.length, sent, 'no request reached Linear for a refused caller');
  for (const request of requests) assert.equal(request.headers.authorization, API_KEY);
  assert.equal(JSON.stringify(teams.body).includes(API_KEY), false);
});
