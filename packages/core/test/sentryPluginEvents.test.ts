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
import { PluginError } from '../src/plugins/pluginState.js';
import type { PluginHttpTransport, PluginHttpTransportRequest } from '../src/plugins/pluginHttp.js';

/**
 * The official Sentry plugin through ProPR's real plugin store, webhook
 * receiver and handler runner: the `Sentry-Hook-Signature` (hex HMAC-SHA256
 * of the body with the integration's client secret) check against the signed
 * fixtures of packages/plugins/sentry/fixtures/webhooks.json before any
 * plugin code runs, `Request-ID` replays refused, the internal integration
 * token sent as a Bearer token to the configured Sentry host only, and a
 * Sentry URL on a local or private host refused when the settings are saved.
 */

interface SignedRequest { resource: string; requestId: string; body: string; signature: string }
const HOOKS = JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'sentry', 'fixtures', 'webhooks.json'), 'utf8')) as { webhookSecret: string; receivedAt: number; sentinels: string[]; requests: Record<string, SignedRequest> };
const API = JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'sentry', 'fixtures', 'api.json'), 'utf8')) as { issues: Record<string, unknown>; latestEvents: Record<string, unknown> };
const TOKEN = 'sntrys_SENTINELsentrytoken0123456789';
const headers = (request: SignedRequest, extra: IncomingHttpHeaders = {}): IncomingHttpHeaders => ({
  'content-type': 'application/json', 'sentry-hook-resource': request.resource, 'sentry-hook-signature': request.signature, 'request-id': request.requestId, 'sentry-hook-timestamp': '1763380800', ...extra,
});

function sentryTransport() {
  const requests: PluginHttpTransportRequest[] = [];
  const transport: PluginHttpTransport = async request => {
    requests.push(request);
    const match = /^\/api\/0\/organizations\/acme\/issues\/(\d+)\/(events\/latest\/)?$/.exec(request.url.pathname);
    const json = match ? (match[2] ? API.latestEvents[match[1]] : API.issues[match[1]]) : null;
    return json ? { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)) } : { status: 404, headers: {}, body: Buffer.from('{}') };
  };
  return { transport, requests };
}
const lookup = async (host: string) => (host === 'sentry.io' ? [{ address: '35.186.247.156', family: 4 }] : Promise.reject(new Error('ENOTFOUND')));

async function setup(t: TestContext) {
  const f = await pluginHandlerFixture(t, {
    pluginId: 'sentry', official: true, repositories: null, connections: { 'client-secret': HOOKS.webhookSecret, 'auth-token': TOKEN }, hostLookup: lookup,
    settings: { baseUrl: 'https://sentry.io', organization: 'acme', repositoryProjects: { 'owner/allowed': 'api' } },
  });
  const sentry = sentryTransport();
  const handlers = (id: string) => loadPluginHandlers(id, { includeDevelopment: false });
  return { f, sentry, runOptions: { ...f.options, handlers, transport: sentry.transport, lookup } };
}

test('the Sentry manifest\'s verification accepts the signed fixtures and refuses a tampered body, a wrong secret, a prefixed or missing signature', async t => {
  const { f } = await setup(t);
  const { verification } = f.manifest.contributes.webhooks[0];
  for (const [name, request] of Object.entries(HOOKS.requests)) {
    const verify = (body: string, h: IncomingHttpHeaders, secret = HOOKS.webhookSecret) => verifyPluginWebhook({ verification, secret, headers: h, body: Buffer.from(body), now: HOOKS.receivedAt });
    assert.deepEqual(verify(request.body, headers(request)), { ok: true }, name);
    assert.deepEqual(verify(`${request.body} `, headers(request)), { ok: false, reason: 'bad_signature' }, `${name}: tampered`);
    assert.deepEqual(verify(request.body, headers(request), 'another secret'), { ok: false, reason: 'bad_signature' }, `${name}: wrong secret`);
    assert.equal(verify(request.body, headers(request, { 'sentry-hook-signature': `sha256=${request.signature}` })).ok, false, `${name}: with a prefix`);
    assert.equal(verify(request.body, { 'content-type': 'application/json', 'request-id': request.requestId }).ok, false, `${name}: unsigned`);
  }
});

test('the receiver rejects a badly signed webhook before plugin code runs, refuses a replayed Request-ID, and a verified issue webhook creates one issue with the token sent to Sentry only', async t => {
  const s = await setup(t);
  const clock = { now: HOOKS.receivedAt };
  const runner = new PluginWebhookRunner({ ...s.runOptions, now: () => clock.now, timeoutMs: 5_000, retryDelaysMs: [5, 5], persistRetryMs: [5] });
  t.after(() => runner.stop());
  const receiver = new PluginWebhookReceiver({ database: s.f.database, runner, catalog: s.f.options.catalog, handlers: s.runOptions.handlers, environment: s.f.options.environment, now: () => clock.now });
  const { webhooks } = await pluginWebhookEndpoints(s.f.database, 'sentry', { manifest: s.f.manifest, origin: 'https://propr.example.com' });
  assert.deepEqual(webhooks.map(w => [w.name, w.scheme]), [['sentry', 'hmac-sha256']]);
  const key = webhooks[0].path.split('/')[3];
  const send = (body: string, h: IncomingHttpHeaders) => receiver.receive({ key, name: 'sentry', headers: h, body: Buffer.from(body) });

  const created = HOOKS.requests.issueCreated;
  assert.equal((await send(created.body, headers(created, { 'sentry-hook-signature': '0'.repeat(64) }))).status, 401, 'a forged signature');
  assert.equal((await send(created.body, { 'content-type': 'application/json', 'request-id': created.requestId })).status, 401, 'no signature');
  assert.equal((await send(created.body.replace('API-1A', 'API-9Z'), headers(created))).status, 401, 'a tampered body');
  await runner.idle();
  assert.equal(s.sentry.requests.length, 0, 'no plugin code ran: Sentry was never asked');
  assert.equal(s.f.calls.length, 0);
  assert.equal((await listPluginActivity(s.f.database, 'sentry')).deliveries.length, 0);

  assert.equal((await send(created.body, headers(created))).status, 202);
  await runner.idle();
  assert.equal((await send(created.body, headers(created))).status, 409, 'the same Request-ID again is a replay');
  for (const name of ['issueCreatedAgain', 'alertTriggered']) {
    assert.equal((await send(HOOKS.requests[name].body, headers(HOOKS.requests[name]))).status, 202, name);
    await runner.idle();
  }

  const issues = s.f.calls.filter(c => c.operation === 'createIssue');
  assert.equal(issues.length, 1, 'one issue for the Sentry issue');
  const [repository, issue] = issues[0].args as [string, { title: string; labels: string[]; body: string }];
  assert.deepEqual([repository, issue.title, issue.labels], ['owner/allowed', "API-1A: TypeError: Cannot read properties of undefined (reading 'id')", []]);
  assert.match(issue.body, /<!-- propr-plugin:sentry -->$/, 'attributed to the plugin');
  for (const sentinel of HOOKS.sentinels) assert.equal(issue.body.includes(sentinel), false, sentinel);
  assert.equal(s.sentry.requests.length, 2, 'the issue and its latest event, once');
  for (const request of s.sentry.requests) {
    assert.equal(request.url.hostname, 'sentry.io');
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  }
  const deliveries = (await listPluginActivity(s.f.database, 'sentry')).deliveries;
  assert.deepEqual(deliveries.map(d => [d.kind, d.status, d.handler]), [['webhook', 'succeeded', 'onSentryWebhook'], ['webhook', 'succeeded', 'onSentryWebhook'], ['webhook', 'succeeded', 'onSentryWebhook']]);
  const activity = JSON.stringify(deliveries);
  for (const secret of [TOKEN, HOOKS.webhookSecret, created.signature, ...HOOKS.sentinels]) assert.equal(activity.includes(secret), false, `${secret} is not in Activity`);
});

test('a Sentry URL on a local, private or non-https host is refused when the settings are saved', async t => {
  const s = await setup(t);
  const refused = async (run: () => Promise<unknown>) => {
    try { await run(); } catch (error) { assert.ok(error instanceof PluginError); return error.status; }
    return null;
  };
  for (const url of ['http://sentry.example.com', 'https://localhost', 'https://10.1.2.3', 'https://sentry.internal']) {
    assert.equal(await refused(() => s.f.store.updateSettings('1', 'sentry', { baseUrl: url, organization: 'acme' })), 400, url);
  }
});
