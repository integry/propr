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
import { getOfficialPlugin, loadPluginHandlers } from '../../plugins/src/index.js';
import { PluginStore } from '../../core/src/plugins/pluginStore.js';
import { PluginDispatcher } from '../../core/src/plugins/pluginDispatcher.js';
import { appendRepositoryEvent } from '../../core/src/services/repositoryEventJournal.js';
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

/** The fixture plugin of the core dispatcher tests: its `flaky` handler fails while state key `fail` is above zero. */
const REGISTRY = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'core', 'test', 'fixtures', 'plugins');
const ID = 'fixture-events';
const BASE = '/api/instance/plugins/v1';

function assertConforms(schema: z.ZodType, body: unknown, label: string): void {
  const result = schema.safeParse(body);
  assert.ok(result.success, `${label} does not match its schema:\n${result.success ? '' : z.prettifyError(result.error)}`);
  assert.deepEqual(result.data, body, `${label} sends fields its schema does not allow`);
}

test('plugin activity API: deliveries and health are listed, a failed delivery is retried and paused deliveries resumed, administrators only', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-activity-api-'));
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
  const manifest = getOfficialPlugin(ID, { root: REGISTRY, includeDevelopment: true })!.manifest;
  const catalog = async () => [manifest];
  const store = new PluginStore(database, { SYSTEM_TASK_SECRET: 'plugin-activity-custody' }, catalog);

  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor'); if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    const member = req.get('x-test-role') === 'member';
    req.authorization = { role: member ? 'member' : 'admin', permissions: member ? [] : ['instance.manage_settings'], source: 'local' };
    next();
  });
  const entries = createPluginRouteEntries(createPluginRoutes(store, {}), createPluginActivityRoutes(store, database, { PROPR_PLUGIN_PAUSE_AFTER_FAILURES: '3' }), createPluginWebhookAdminRoutes(store, database, {}));
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
  for (const route of ['/:pluginId/activity', '/:pluginId/activity/:deliveryId/retry', '/:pluginId/resume']) {
    const entry = entries.find(([, p]) => p === BASE + route)!;
    assert.ok(ROUTE_DOCS[`${entry[0].toUpperCase()} ${entry[1]}`], `${route} has an OpenAPI entry`);
  }

  assert.equal((await call('GET', `/${ID}/activity`)).status, 404, 'not installed');
  await store.install('1', ID); await store.setEnabled('1', ID, true);
  const empty = await call('GET', `/${ID}/activity`);
  assert.equal(empty.status, 200); assert.equal(empty.cache, 'no-store');
  assertConforms(schemas.PluginActivityResponse, empty.body, 'empty activity');
  assert.deepEqual(empty.body.deliveries, []); assert.equal(empty.body.health.state, 'healthy'); assert.equal(empty.body.health.pauseAfterFailures, 3);

  // Three failing deliveries: Degraded at the third failure, which also pauses (threshold 3 here).
  await database('plugin_state').insert({ plugin_id: ID, state_key: 'fail', value: '3', bytes: 1, updated_at: 0 });
  for (const n of [1, 2, 3, 4]) await appendRepositoryEvent(database, { repository: 'owner/repo', domain: 'task', type: 'failed', entityId: `task-${n}`, payload: { body: 'payload-sentinel-77' } }, { publish: false });
  const dispatcher = new PluginDispatcher({
    database, catalog, retryDelaysMs: [], pauseAfterFailures: 3, timeoutMs: 1_000, notify: async () => {},
    handlers: id => loadPluginHandlers(id, { root: REGISTRY, includeDevelopment: true }),
  });
  for (let i = 0; i < 5; i++) await dispatcher.pass();
  await dispatcher.stop();

  const activity = await call('GET', `/${ID}/activity`);
  assertConforms(schemas.PluginActivityResponse, activity.body, 'activity');
  assert.equal(activity.body.health.state, 'paused');
  assert.match(activity.body.health.lastError, /flaky failure/);
  const deliveries = activity.body.deliveries as { id: number; status: string; handler: string; eventType: string; attempt: number; error: string; logs: { message: string }[] }[];
  assert.deepEqual(deliveries.map(d => [d.status, d.handler, d.eventType, d.attempt]), [['failed', 'flaky', 'task.failed', 1], ['failed', 'flaky', 'task.failed', 1], ['failed', 'flaky', 'task.failed', 1]], 'newest first; the fourth waits for Resume');
  assert.equal(deliveries[0].logs[0].message, 'failing on purpose');

  // Members, a missing preflight header, a non-empty body, an unknown record and a delivery that has not failed are refused.
  assert.equal((await call('GET', `/${ID}/activity`, undefined, { 'x-test-actor': '2', 'x-test-role': 'member' })).status, 403);
  assert.equal((await call('POST', `/${ID}/activity/${deliveries[0].id}/retry`, {}, { 'x-test-actor': '1', 'content-type': 'application/json' })).status, 403);
  assert.equal((await call('POST', `/${ID}/activity/${deliveries[0].id}/retry`, { now: 1 })).status, 400);
  assert.equal((await call('POST', `/${ID}/activity/999/retry`, {})).status, 404);
  assert.equal((await call('POST', `/${ID}/activity/abc/retry`, {})).status, 400);
  assert.equal((await call('GET', '/Not_A_Plugin/activity')).status, 404);

  const retried = await call('POST', `/${ID}/activity/${deliveries[0].id}/retry`, {});
  assert.equal(retried.status, 200);
  assertConforms(schemas.PluginDeliveryResponse, retried.body, 'retry');
  assert.equal(retried.body.delivery.status, 'pending');
  assert.equal((await call('POST', `/${ID}/activity/${deliveries[0].id}/retry`, {})).status, 409);

  const resumed = await call('POST', `/${ID}/resume`, {});
  assert.equal(resumed.status, 200);
  assertConforms(schemas.PluginHealthResponse, resumed.body, 'resume');
  assert.equal(resumed.body.health.state, 'healthy');
  assert.equal((await call('POST', `/${ID}/resume`, {})).status, 409, 'not paused any more');

  // After Resume the retried delivery and the waiting event are delivered (the fixture's failures are used up).
  const after = new PluginDispatcher({ database, catalog, notify: async () => {}, handlers: id => loadPluginHandlers(id, { root: REGISTRY, includeDevelopment: true }) });
  for (let i = 0; i < 3; i++) await after.pass();
  await after.stop();
  const final = await call('GET', `/${ID}/activity`);
  assert.deepEqual((final.body.deliveries as { status: string; attempt: number }[]).map(d => [d.status, d.attempt]), [['succeeded', 1], ['succeeded', 2], ['failed', 1], ['failed', 1]]);

  // Retry and resume are audited; no response or record carries the event payload.
  const audit = (await store.get('1', ID)).audit.map(a => a.action);
  assert.ok(audit.includes('retry_delivery') && audit.includes('resume_deliveries'));
  assert.equal(bodies.some(text => text.includes('payload-sentinel-77')), false);
  assert.equal(JSON.stringify(await database('plugin_deliveries').select()).includes('payload-sentinel-77'), false);
});
