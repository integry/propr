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
import { getOfficialPlugin } from '../../plugins/src/index.js';
import { PluginStore } from '../../core/src/plugins/pluginStore.js';
import { FIXTURE_REGISTRY } from '../../core/test/helpers/pluginHandlerFixture.js';
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

const BASE = '/api/instance/plugins/v1';
const ONE = 'fixture-deploy-one';
const TWO = 'fixture-deploy-two';

function assertConforms(schema: z.ZodType, body: unknown, label: string): void {
  const result = schema.safeParse(body);
  assert.ok(result.success, `${label} does not match its schema:\n${result.success ? '' : z.prettifyError(result.error)}`);
  assert.deepEqual(result.data, body, `${label} sends fields its schema does not allow`);
}

test('the command write switch and the shared command owner: administrators only, the JSON contract, audited and schema-conformant', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-command-api-'));
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
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  const manifests = [ONE, TWO].map(id => getOfficialPlugin(id, { root: FIXTURE_REGISTRY, includeDevelopment: true })!.manifest);
  const store = new PluginStore(database, { SYSTEM_TASK_SECRET: 'plugin-command-api' }, async () => manifests);

  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor'); if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    const member = req.get('x-test-role') === 'member';
    req.authorization = { role: member ? 'member' : 'admin', permissions: member ? [] : ['instance.manage_settings'], source: 'local' };
    next();
  });
  const entries = createPluginRouteEntries(createPluginRoutes(store, {}), createPluginActivityRoutes(store, database), createPluginWebhookAdminRoutes(store, database, {}));
  registerRouteEntries(app, entries);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await database.destroy(); await (await import('@propr/core')).closeConnection(); await fs.rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-plugins': '1' };
  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = admin) => {
    const response = await fetch(origin + BASE + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };

  for (const route of [`PUT ${BASE}/:pluginId/commands/:commandName/write`, `PUT ${BASE}/:pluginId/commands/:commandName/owner`]) {
    assert.ok(entries.some(([method, path]) => `${method.toUpperCase()} ${path}` === route), `${route} is registered`);
    assert.ok(ROUTE_DOCS[route], `${route} has an OpenAPI entry`);
  }
  for (const id of [ONE, TWO]) {
    assert.equal((await call('POST', `/${id}/install`, {})).status, 200);
    assert.equal((await call('PUT', `/${id}/enabled`, { enabled: true })).status, 200);
  }

  // The switch is off at install, for the command that needs write access.
  const detail = await call('GET', `/${ONE}`, undefined, { 'x-test-actor': '1' });
  assertConforms(schemas.PluginDetailResponse, detail.body, 'GET plugin');
  assert.deepEqual(detail.body.plugin.commands.map((c: { name: string; needsWrite: boolean; writeAllowed: boolean }) => [c.name, c.needsWrite, c.writeAllowed]), [
    ['deploy', false, false], ['deploy-one', false, false], ['deploy-one-release', true, false],
  ]);

  // Members, sessions without the durable role and calls without the JSON contract are refused; nothing changes.
  assert.equal((await call('PUT', `/${ONE}/commands/deploy-one-release/write`, { allowed: true }, { ...admin, 'x-test-actor': '2' })).status, 403);
  assert.equal((await call('PUT', `/${ONE}/commands/deploy-one-release/write`, { allowed: true }, { ...admin, 'x-test-role': 'member' })).status, 403);
  assert.equal((await call('PUT', `/${ONE}/commands/deploy-one-release/write`, { allowed: true }, { 'x-test-actor': '1', 'content-type': 'application/json' })).status, 403);
  assert.equal((await call('PUT', `/${ONE}/commands/deploy/owner`, { owner: TWO }, { ...admin, 'x-test-actor': '2' })).status, 403);
  assert.equal((await call('PUT', `/${ONE}/commands/deploy-one-release/write`, { allowed: true, extra: 1 })).status, 400);
  assert.equal((await call('PUT', `/${ONE}/commands/deploy-one/write`, { allowed: true })).status, 409);
  assert.equal((await call('PUT', `/${ONE}/commands/deploy-one/owner`, { owner: ONE })).status, 409);

  const allowed = await call('PUT', `/${ONE}/commands/deploy-one-release/write`, { allowed: true });
  assert.equal(allowed.status, 200);
  assertConforms(schemas.PluginResponse, allowed.body, 'set command write');
  assert.equal(allowed.body.plugin.commands.find((c: { name: string }) => c.name === 'deploy-one-release').writeAllowed, true);

  const owned = await call('PUT', `/${ONE}/commands/deploy/owner`, { owner: TWO });
  assert.equal(owned.status, 200);
  assertConforms(schemas.PluginResponse, owned.body, 'set shared command owner');
  const shared = owned.body.plugin.commands.find((c: { name: string }) => c.name === 'deploy').sharedOwner;
  assert.equal(shared.owner, TWO);
  assert.deepEqual(shared.candidates.map((c: { pluginId: string; specific: string[] }) => [c.pluginId, c.specific]), [[ONE, ['deploy-one']], [TWO, ['deploy-two']]]);
  assert.equal((await call('PUT', `/${TWO}/commands/deploy/owner`, { owner: 'nobody' })).status, 409);

  const audit = (await call('GET', `/${ONE}`, undefined, { 'x-test-actor': '1' })).body.plugin.audit as { action: string; actor: string; detail: Record<string, unknown> }[];
  assert.deepEqual(audit.filter(e => e.action === 'set_command_write' || e.action === 'set_shared_command_owner').map(e => [e.action, e.actor, e.detail]), [
    ['set_shared_command_owner', '1', { command: 'deploy', owner: TWO, previous: null }],
    ['set_command_write', '1', { command: 'deploy-one-release', allowWrite: true, previous: false }],
  ]);
  const ownerAudit = (await call('GET', `/${TWO}`, undefined, { 'x-test-actor': '1' })).body.plugin.audit as { action: string }[];
  assert.ok(ownerAudit.some(e => e.action === 'set_shared_command_owner'), 'recorded on the new owner too');
});
