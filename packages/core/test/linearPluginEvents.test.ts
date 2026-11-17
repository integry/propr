import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { PLUGINS_ROOT, loadPluginHandlers } from '../../plugins/src/index.js';
import { pluginHandlerFixture } from './helpers/pluginHandlerFixture.js';
import { pluginWebhookEndpoints, verifyPluginWebhook } from '../src/plugins/pluginWebhooks.js';
import { PluginWebhookRunner } from '../src/plugins/pluginWebhookRunner.js';
import { PluginWebhookReceiver } from '../src/plugins/pluginWebhookReceiver.js';
import { listPluginActivity } from '../src/plugins/pluginDeliveries.js';
import { loadPluginSettingOptions } from '../src/plugins/pluginSettingOptions.js';
import { PluginError } from '../src/plugins/pluginState.js';
import type { PluginHttpTransport, PluginHttpTransportRequest } from '../src/plugins/pluginHttp.js';

/**
 * The official Linear plugin through ProPR's real webhook receiver and
 * handler runner: the `Linear-Signature` HMAC-SHA256 check against the signed
 * fixtures of packages/plugins/linear/fixtures/webhooks.json before any
 * plugin code runs, `Linear-Delivery` replays refused, the API key sent as
 * the bare `Authorization` value to api.linear.app only, and the settings
 * options loader (`optionsFrom`) running for a disabled installation.
 */

interface SignedRequest { body: string; signature: string; delivery: string }
const HOOKS = JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'linear', 'fixtures', 'webhooks.json'), 'utf8')) as { signingSecret: string; receivedAt: number; requests: Record<string, SignedRequest> };
const GQL = JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'linear', 'fixtures', 'graphql.json'), 'utf8')) as Record<string, { data?: unknown }> & { tickets: Record<string, unknown> };
const API_KEY = 'lin_api_SENTINELlinearkey0123456789';
const headers = (request: SignedRequest, extra: IncomingHttpHeaders = {}): IncomingHttpHeaders => ({
  'content-type': 'application/json', 'linear-event': 'Issue', 'linear-signature': request.signature, 'linear-delivery': request.delivery, ...extra,
});

function linearTransport() {
  const requests: PluginHttpTransportRequest[] = [];
  const transport: PluginHttpTransport = async request => {
    requests.push(request);
    const { query } = JSON.parse(request.body?.toString() ?? '{}') as { query: string };
    const json = query.includes('query ProprTicket(') ? GQL.tickets.mapped : query.includes('ProprTeams') ? GQL.teams : { errors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)) };
  };
  return { transport, requests };
}
const lookup = async (host: string) => (host === 'api.linear.app' ? [{ address: '35.0.0.1', family: 4 }] : Promise.reject(new Error('ENOTFOUND')));

async function setup(t: TestContext, options: { enabled?: boolean; apiKey?: boolean } = {}) {
  const connections: Record<string, string> = { 'webhook-secret': HOOKS.signingSecret, ...(options.apiKey === false ? {} : { 'api-key': API_KEY }) };
  const f = await pluginHandlerFixture(t, { pluginId: 'linear', official: true, repositories: null, connections, enabled: options.enabled });
  await f.store.updateSettings('1', 'linear', { repositoryTeams: { 'owner/allowed': '3f1c2a9e-1b2c-4d5e-8f90-aaaaaaaaaaaa' } });
  const linear = linearTransport();
  const handlers = (id: string) => loadPluginHandlers(id, { includeDevelopment: false });
  const runOptions = { ...f.options, handlers, transport: linear.transport, lookup };
  return { f, linear, runOptions };
}

test('the Linear manifest\'s hmac-sha256 verification accepts the signed fixtures and refuses a tampered body, a wrong secret or a missing signature', async t => {
  const { f } = await setup(t);
  const { verification } = f.manifest.contributes.webhooks[0];
  for (const [name, request] of Object.entries(HOOKS.requests)) {
    const verify = (body: string, h: IncomingHttpHeaders, secret = HOOKS.signingSecret) => verifyPluginWebhook({ verification, secret, headers: h, body: Buffer.from(body), now: HOOKS.receivedAt });
    assert.deepEqual(verify(request.body, headers(request)), { ok: true }, name);
    assert.deepEqual(verify(`${request.body} `, headers(request)), { ok: false, reason: 'bad_signature' }, `${name}: tampered`);
    assert.deepEqual(verify(request.body, headers(request), 'another secret'), { ok: false, reason: 'bad_signature' }, `${name}: wrong secret`);
    assert.equal(verify(request.body, { 'content-type': 'application/json' }).ok, false, `${name}: unsigned`);
  }
});

test('the receiver rejects an invalid signature before plugin code runs, refuses a replayed delivery, and a verified label change creates one issue with the key sent raw to api.linear.app', async t => {
  const s = await setup(t);
  const clock = { now: HOOKS.receivedAt };
  const runner = new PluginWebhookRunner({ ...s.runOptions, now: () => clock.now, timeoutMs: 5_000, retryDelaysMs: [5, 5], persistRetryMs: [5] });
  t.after(() => runner.stop());
  const receiver = new PluginWebhookReceiver({ database: s.f.database, runner, catalog: s.f.options.catalog, handlers: s.runOptions.handlers, environment: s.f.options.environment, now: () => clock.now });
  const { webhooks } = await pluginWebhookEndpoints(s.f.database, 'linear', { manifest: s.f.manifest, origin: 'https://propr.example.com' });
  assert.deepEqual(webhooks.map(w => [w.name, w.scheme]), [['issues', 'hmac-sha256']]);
  const key = webhooks[0].path.split('/')[3];
  const send = (body: string, h: IncomingHttpHeaders) => receiver.receive({ key, name: 'issues', headers: h, body: Buffer.from(body) });

  const added = HOOKS.requests.labelAdded;
  assert.equal((await send(added.body, headers(added, { 'linear-signature': '0'.repeat(64) }))).status, 401, 'a forged signature');
  assert.equal((await send(added.body, { 'content-type': 'application/json', 'linear-delivery': added.delivery })).status, 401, 'no signature');
  assert.equal((await send(added.body.replace('ENG-123', 'ENG-999'), headers(added))).status, 401, 'a tampered body');
  await runner.idle();
  assert.equal(s.linear.requests.length, 0, 'no plugin code ran: Linear was never asked');
  assert.equal((await listPluginActivity(s.f.database, 'linear')).deliveries.length, 0);

  assert.equal((await send(added.body, headers(added))).status, 202);
  await runner.idle();
  assert.equal((await send(added.body, headers(added))).status, 409, 'the same Linear-Delivery again is a replay');
  const again = HOOKS.requests.labelAddedAgain;
  assert.equal((await send(again.body, headers(again))).status, 202);
  await runner.idle();

  const issues = s.f.calls.filter(c => c.operation === 'createIssue');
  assert.equal(issues.length, 1, 'one issue for the ticket');
  const [repository, issue] = issues[0].args as [string, { title: string; labels: string[]; body: string }];
  assert.deepEqual([repository, issue.title, issue.labels], ['owner/allowed', 'ENG-123: Fix the redirect after login', ['AI']]);
  assert.match(issue.body, /<!-- propr-plugin:linear -->$/, 'attributed to the plugin');
  for (const request of s.linear.requests) {
    assert.equal(request.url.hostname, 'api.linear.app');
    assert.equal(request.headers.authorization, API_KEY, 'the API key is the whole Authorization value, as Linear requires');
  }
  const deliveries = (await listPluginActivity(s.f.database, 'linear')).deliveries;
  assert.deepEqual(deliveries.map(d => [d.kind, d.status, d.handler]), [['webhook', 'succeeded', 'onLinearWebhook'], ['webhook', 'succeeded', 'onLinearWebhook']]);
  const activity = JSON.stringify(deliveries);
  for (const secret of [API_KEY, 'Users land on', 'Fix the redirect']) assert.equal(activity.includes(secret), false, `${secret} is not in Activity`);
});

test('setting choices load through optionsFrom while the plugin is disabled, with a clear error before the API key is set', async t => {
  const s = await setup(t, { enabled: false });
  const { options } = await loadPluginSettingOptions(s.f.database, 'linear', 'repositoryTeams', s.runOptions);
  assert.deepEqual(options.map(o => o.label), ['Design (DES)', 'Engineering (ENG)', 'Operations (OPS)']);
  assert.equal(s.linear.requests[0].headers.authorization, API_KEY);
  assert.equal(s.f.calls.length, 0, 'no ProPR call');

  const refused = async (key: string, run = s.runOptions, database = s.f.database) => {
    try { await loadPluginSettingOptions(database, 'linear', key, run); } catch (error) { assert.ok(error instanceof PluginError); return [error.status, error.message]; }
    return null;
  };
  assert.deepEqual(await refused('triggerLabel'), [404, 'Setting triggerLabel has no choices to load']);
  assert.deepEqual(await refused('nope'), [404, 'Setting nope has no choices to load']);

  const unset = await setup(t, { enabled: false, apiKey: false });
  assert.deepEqual(await refused('repositoryTeams', unset.runOptions, unset.f.database), [409, 'Linear is not connected yet. Set the Linear API key under Connections, then choose Reload choices.']);
  assert.equal(unset.linear.requests.length, 0);
  await unset.f.store.uninstall('1', 'linear', 'linear');
  assert.deepEqual(await refused('repositoryTeams', unset.runOptions, unset.f.database), [409, 'Install the plugin first']);
});
