import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
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
import { PluginWebhookRunner } from '../../core/src/plugins/pluginWebhookRunner.js';
import { PluginWebhookReceiver } from '../../core/src/plugins/pluginWebhookReceiver.js';
import coreLogger from '../../core/src/utils/logger.js';
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

/** The `fixture-webhooks` plugin of the core webhook tests: one webhook per verification scheme. */
const REGISTRY = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'core', 'test', 'fixtures', 'plugins');
const ID = 'fixture-webhooks';
const BASE = '/api/instance/plugins/v1';
const SECRET = 'whsec_route-fixture-secret';

function assertConforms(schema: z.ZodType, body: unknown, label: string): void {
  const result = schema.safeParse(body);
  assert.ok(result.success, `${label} does not match its schema:\n${result.success ? '' : z.prettifyError(result.error)}`);
  assert.deepEqual(result.data, body, `${label} sends fields its schema does not allow`);
}

test('plugin webhook route: verified requests are queued, oversized bodies and unverified requests run nothing, the rate limiter applies, and the Plugins page URL regenerates', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-webhook-api-'));
  process.env.DB_FILENAME = path.join(root, 'fixture.sqlite');
  const { createPluginRoutes } = await import('../routes/pluginRoutes.js');
  const { createPluginActivityRoutes } = await import('../routes/pluginActivityRoutes.js');
  const { createPluginWebhookAdminRoutes, createPluginWebhookHandlers } = await import('../routes/pluginWebhookRoutes.js');
  const { createPluginRouteEntries } = await import('../pluginRouteRegistry.js');
  const { registerRouteEntries } = await import('../routeRegistry.js');
  const schemas = await import('../openapi/schemasPlugins.js');
  const { ROUTE_DOCS } = await import('../openapi/routeDocs.js');
  const { DIRECT_ROUTE_REGISTRATIONS } = await import('../openapi/directRoutes.js');

  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  for (const migrate of [identityMigration, grantMigration, libraryMigration, oauthMigration, pluginMigration, pluginStateMigration, journalMigration, taskDomainMigration, deliveriesMigration, webhookKeysMigration]) await migrate(database);
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  const manifest = getOfficialPlugin(ID, { root: REGISTRY, includeDevelopment: true })!.manifest;
  const catalog = async () => [manifest];
  const environment = { SYSTEM_TASK_SECRET: 'plugin-webhook-custody', API_PUBLIC_URL: 'https://propr.example.com', PROPR_WEBHOOK_RATE_LIMIT_MAX: '16' };
  const store = new PluginStore(database, environment, catalog);
  const loads: string[] = [];
  const handlers = (id: string) => { loads.push(id); return loadPluginHandlers(id, { root: REGISTRY, includeDevelopment: true }); };
  const runner = new PluginWebhookRunner({ database, catalog, handlers, environment, retryDelaysMs: [] });
  const receiver = new PluginWebhookReceiver({ database, runner, catalog, handlers, environment });

  const lines: string[] = [];
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) mock.method(coreLogger, level, (...args: unknown[]) => { lines.push(JSON.stringify(args)); });
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) mock.method(console, level, (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });

  const app = express();
  app.post('/api/plugins/:installationKey/hooks/:webhookName', ...createPluginWebhookHandlers(() => receiver, environment));
  app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor'); if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    const member = req.get('x-test-role') === 'member';
    req.authorization = { role: member ? 'member' : 'admin', permissions: member ? [] : ['instance.manage_settings'], source: 'local' };
    next();
  });
  const entries = createPluginRouteEntries(createPluginRoutes(store, environment), createPluginActivityRoutes(store, database), createPluginWebhookAdminRoutes(store, database, environment));
  registerRouteEntries(app, entries);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => {
    mock.restoreAll();
    await runner.stop();
    await new Promise<void>(r => server.close(() => r())); await database.destroy(); await (await import('@propr/core')).closeConnection(); await fs.rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-plugins': '1' };
  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = admin) => {
    const response = await fetch(origin + BASE + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked against their schemas
    return { status: response.status, body: await response.json() as any };
  };
  const hook = async (url: string, body: string | Buffer, headers: Record<string, string>) => {
    const response = await fetch(url.replace('https://propr.example.com', origin), { method: 'POST', headers, body });
    return { status: response.status, text: await response.text(), retryAfter: response.headers.get('retry-after'), type: response.headers.get('content-type') };
  };
  const signed = (body: string, delivery: string) => ({ 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`, 'x-github-delivery': delivery });
  const seen = async () => {
    const row = await database('plugin_state').where({ plugin_id: ID, state_key: 'seen' }).first() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as unknown[]).length : 0;
  };

  for (const route of ['/:pluginId/webhooks', '/:pluginId/webhooks/regenerate']) {
    const entry = entries.find(([, p]) => p === BASE + route)!;
    assert.ok(ROUTE_DOCS[`${entry[0].toUpperCase()} ${entry[1]}`], `${route} has an OpenAPI entry`);
  }
  assert.ok(DIRECT_ROUTE_REGISTRATIONS.some(r => r.path === '/api/plugins/:installationKey/hooks/:webhookName' && r.auth === 'public'));
  assert.ok(ROUTE_DOCS['POST /api/plugins/:installationKey/hooks/:webhookName']);

  assert.equal((await call('GET', `/${ID}/webhooks`)).status, 409, 'not installed');
  await store.install('1', ID); await store.setConnection('1', ID, 'hook-secret', SECRET); await store.setEnabled('1', ID, true);
  assert.equal((await call('GET', `/${ID}/webhooks`, undefined, { 'x-test-actor': '2', 'x-test-role': 'member' })).status, 403, 'administrators only');
  const listed = await call('GET', `/${ID}/webhooks`);
  assert.equal(listed.status, 200);
  assertConforms(schemas.PluginWebhooksResponse, listed.body, 'webhooks');
  const urls = Object.fromEntries((listed.body.webhooks as { name: string; url: string; scheme: string }[]).map(w => [w.name, w.url]));
  assert.deepEqual((listed.body.webhooks as { name: string; scheme: string }[]).map(w => [w.name, w.scheme]), [['signed', 'hmac-sha256'], ['slack', 'slack-v0'], ['token', 'token-header'], ['probe', 'token-header'], ['answered', 'token-header'], ['a', 'token-header'], ['a-b', 'token-header'], ['leaky', 'token-header']]);
  assert.match(urls.signed, /^https:\/\/propr\.example\.com\/api\/plugins\/[A-Za-z0-9_-]{43}\/hooks\/signed$/);

  // Verified: answered 202 at once, then run from the queue exactly once.
  const body = '{"action":"opened","text":"ROUTE-SENTINEL-BODY"}';
  const accepted = await hook(urls.signed, body, signed(body, 'route-1'));
  assert.equal(accepted.status, 202);
  assert.match(accepted.type ?? '', /application\/json/);
  await runner.idle();
  assert.equal(await seen(), 1);
  assert.equal((await hook(urls.signed, body, signed(body, 'route-1'))).status, 409, 'replay');
  const formBody = 'payload=%7B%7D';
  assert.equal((await hook(urls.signed, formBody, { ...signed(formBody, 'route-form'), 'content-type': 'application/x-www-form-urlencoded' })).status, 202, 'any content type is read raw');

  // A gzip body signed over the bytes as sent: verified before it is inflated, and the handler gets the decoded body.
  const plainZipped = '{"action":"opened","text":"' + 'z'.repeat(4_000) + '"}';
  const zipped = gzipSync(plainZipped);
  const zipSigned = (bytes: Buffer, delivery: string) => ({ 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(bytes).digest('hex')}`, 'x-github-delivery': delivery });
  assert.equal((await hook(urls.signed, zipped, zipSigned(zipped, 'route-gzip'))).status, 202, 'a signature over the compressed bytes verifies');
  await runner.idle();
  const lastSeen = async () => (JSON.parse((await database('plugin_state').where({ plugin_id: ID, state_key: 'seen' }).first() as { value: string }).value) as { id: string; bodyBytes: number; headers: string[] }[]).at(-1);
  const handled = (await lastSeen())!;
  assert.deepEqual([handled.id, handled.bodyBytes, handled.headers.includes('content-type'), handled.headers.includes('content-encoding')], ['whk-signed:route-gzip', plainZipped.length, true, false],
    'the handler gets the inflated body and no Content-Encoding');
  assert.equal((await hook(urls.signed, zipped, zipSigned(Buffer.from(plainZipped), 'route-gzip-2'))).status, 401, 'a signature over the inflated bytes is not the sender\'s');
  const bomb = gzipSync(Buffer.alloc(256 * 1024 + 1, 'a'));
  const loadsBeforeBomb = loads.length;
  assert.equal((await hook(urls.signed, bomb, zipSigned(bomb, 'route-gzip-3'))).status, 413, 'inflated beyond the body limit');
  assert.equal(loads.length, loadsBeforeBomb, 'and no plugin module loaded');

  // Oversized, unverified and unknown requests load no plugin code.
  await runner.idle();
  const loadsBefore = loads.length;
  const big = 'x'.repeat(256 * 1024 + 1);
  const oversized = await hook(urls.signed, big, signed(big, 'route-big'));
  assert.equal(oversized.status, 413);
  assert.doesNotMatch(oversized.text, /xxxx/, 'the body is not echoed');
  assert.equal((await hook(urls.signed, body, { ...signed(body, 'route-2'), 'x-hub-signature-256': 'sha256=ROUTE-SENTINEL-SIGNATURE' })).status, 401);
  assert.equal((await hook(urls.token, body, { 'x-gitlab-token': 'ROUTE-SENTINEL-TOKEN' })).status, 401);
  assert.equal((await hook(urls.signed.replace('/hooks/signed', '/hooks/nope'), body, signed(body, 'route-3'))).status, 404);
  assert.equal(loads.length, loadsBefore, 'no plugin module loaded');
  assert.equal(await seen(), 3);

  // The challenge echo.
  const challenge = JSON.stringify({ type: 'url_verification', challenge: 'route-challenge-123' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const echo = await hook(urls.slack, challenge, { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${timestamp}:${challenge}`).digest('hex')}` });
  assert.deepEqual([echo.status, echo.text, echo.type?.split(';')[0]], [200, 'route-challenge-123', 'text/plain']);

  // Regenerate: the old URL answers 404, the new one works; audited; members and a non-empty body are refused.
  assert.equal((await call('POST', `/${ID}/webhooks/regenerate`, {}, { 'x-test-actor': '1', 'content-type': 'application/json' })).status, 403, 'preflight header required');
  assert.equal((await call('POST', `/${ID}/webhooks/regenerate`, { key: 'mine' })).status, 400);
  const regenerated = await call('POST', `/${ID}/webhooks/regenerate`, {});
  assert.equal(regenerated.status, 200);
  assertConforms(schemas.PluginWebhooksResponse, regenerated.body, 'regenerated webhooks');
  assert.equal(regenerated.body.keyCreatedBy, '1');
  assert.equal(regenerated.body.rejected.count, 0, 'a new key starts a new count');
  const newSigned = (regenerated.body.webhooks as { name: string; url: string }[]).find(w => w.name === 'signed')!.url;
  assert.notEqual(newSigned, urls.signed);
  assert.equal((await hook(urls.signed, body, signed(body, 'route-4'))).status, 404, 'the old URL is dead');
  assert.equal((await hook(newSigned, body, signed(body, 'route-5'))).status, 202);
  assert.ok((await store.get('1', ID)).audit.some(a => a.action === 'regenerate_webhook_key'));

  // Disabled: 404, and nothing runs.
  await runner.idle();
  await store.setEnabled('1', ID, false);
  assert.equal((await hook(newSigned, body, signed(body, 'route-6'))).status, 404);
  await store.setEnabled('1', ID, true);

  // The webhook rate limiter (16 per window here) applies to the route.
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await hook(newSigned, '{}', { 'x-hub-signature-256': 'sha256=00' })).status);
  assert.ok(statuses.includes(429), `the rate limiter answered 429 (${statuses.join(', ')})`);
  await runner.idle();
  assert.equal(await seen(), 4, 'route-1, the form request, the gzip request and route-5 ran; nothing else did');

  // Neither the body nor a signature or token reached a log line.
  for (const sentinel of ['ROUTE-SENTINEL-BODY', 'ROUTE-SENTINEL-SIGNATURE', 'ROUTE-SENTINEL-TOKEN', 'route-challenge-123']) {
    assert.equal(lines.some(line => line.includes(sentinel)), false, `${sentinel} was logged`);
  }
});
