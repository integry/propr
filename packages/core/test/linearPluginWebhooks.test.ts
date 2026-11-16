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
import type { PluginHandlerModule } from '@propr/shared';

/**
 * The official Linear plugin through ProPR's real webhook receiver and
 * handler context: the `hmac-sha256` check of `Linear-Signature` against the
 * signed fixtures of packages/plugins/linear/fixtures/webhooks.json (an
 * invalid signature is refused before any plugin code runs), `Linear-Delivery`
 * replays refused, one issue created through the ProPR backend, the API key
 * sent to api.linear.app as a plain `Authorization` value, and the configure
 * form's choices loaded through `ctx.http` before the plugin is enabled.
 */

interface SignedRequest { delivery: string; signature: string; body: string }
const HOOKS = JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'linear', 'fixtures', 'webhooks.json'), 'utf8')) as { signingSecret: string; receivedAt: number; ids: Record<string, string>; requests: Record<string, SignedRequest> };
const API_KEY = 'lin_api_SENTINELlinearapikey0000000000000000';
const headers = (request: SignedRequest, extra: IncomingHttpHeaders = {}): IncomingHttpHeaders => ({
  'content-type': 'application/json', 'linear-event': 'Issue', 'linear-delivery': request.delivery, 'linear-signature': request.signature, ...extra,
});

function linearTransport() {
  const requests: PluginHttpTransportRequest[] = [];
  const transport: PluginHttpTransport = async request => {
    requests.push(request);
    const query = String((JSON.parse(request.body?.toString() ?? '{}') as { query?: string }).query);
    const data = query.includes('commentCreate') ? { commentCreate: { success: true } }
      : query.includes('teams(') ? { teams: { nodes: [{ id: HOOKS.ids.team, key: 'ENG', name: 'Engineering' }] } }
        : query.includes('projects(') ? { projects: { nodes: [] } } : {};
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ data })) };
  };
  return { transport, requests };
}

const lookup = async (host: string) => (host === 'api.linear.app' ? [{ address: '35.0.0.1', family: 4 }] : Promise.reject(new Error('ENOTFOUND')));

async function setup(t: TestContext, options: { probe?: boolean } = {}) {
  const f = await pluginHandlerFixture(t, { pluginId: 'linear', official: true, repositories: null, connections: { 'api-key': API_KEY, 'webhook-secret': HOOKS.signingSecret } });
  await f.store.updateSettings('1', 'linear', { repositoryMapping: { 'owner/allowed': `team:${HOOKS.ids.team}` } });
  const linear = linearTransport();
  const clock = { now: HOOKS.receivedAt };
  let ran = 0;
  // Counts every handler call, so a refused request is shown to run no plugin code.
  const handlers = async (id: string): Promise<PluginHandlerModule | null> => {
    const module = await loadPluginHandlers(id, { includeDevelopment: false });
    if (!module || !options.probe) return module;
    return Object.fromEntries(Object.entries(module).map(([name, handler]) => [name, (async (input, ctx) => { ran += 1; return handler(input, ctx); }) as typeof handler]));
  };
  const runOptions = { ...f.options, handlers, transport: linear.transport, lookup };
  const runner = new PluginWebhookRunner({ ...runOptions, now: () => clock.now, timeoutMs: 5_000, retryDelaysMs: [5, 5], persistRetryMs: [5] });
  t.after(() => runner.stop());
  const receiver = new PluginWebhookReceiver({ database: f.database, runner, catalog: f.options.catalog, handlers, environment: f.options.environment, now: () => clock.now });
  const { webhooks } = await pluginWebhookEndpoints(f.database, 'linear', { manifest: f.manifest, origin: 'https://propr.example.com' });
  assert.deepEqual(webhooks.map(w => [w.name, w.scheme]), [['linear', 'hmac-sha256']]);
  const key = webhooks[0].path.split('/')[3];
  const send = (body: string, h: IncomingHttpHeaders) => receiver.receive({ key, name: 'linear', headers: h, body: Buffer.from(body) });
  return { f, linear, runner, send, runOptions, ran: () => ran };
}

test('the Linear manifest\'s verification accepts the signed fixtures and refuses a tampered body, a wrong secret or a missing signature', async t => {
  const { f } = await setup(t);
  const { verification } = f.manifest.contributes.webhooks[0];
  for (const [name, request] of Object.entries(HOOKS.requests)) {
    const verify = (body: string, h: IncomingHttpHeaders, secret = HOOKS.signingSecret) => verifyPluginWebhook({ verification, secret, headers: h, body: Buffer.from(body), now: HOOKS.receivedAt });
    assert.deepEqual(verify(request.body, headers(request)), { ok: true }, name);
    assert.deepEqual(verify(`${request.body} `, headers(request)), { ok: false, reason: 'bad_signature' }, `${name}: tampered`);
    assert.deepEqual(verify(request.body, headers(request), 'another secret'), { ok: false, reason: 'bad_signature' }, `${name}: wrong secret`);
    assert.equal(verify(request.body, { 'linear-delivery': request.delivery }).ok, false, `${name}: no signature`);
  }
});

test('the receiver refuses an invalid signature before any plugin code runs, creates one issue for a verified label, and refuses a replayed delivery', async t => {
  const s = await setup(t, { probe: true });
  const request = HOOKS.requests.labelAdded;
  const forged = await s.send(request.body, headers(request, { 'linear-signature': '0'.repeat(64) }));
  assert.equal(forged.status, 401);
  const unsigned = await s.send(request.body, headers(request, { 'linear-signature': undefined }));
  assert.equal(unsigned.status, 401);
  await s.runner.idle();
  assert.equal(s.ran(), 0, 'no plugin code ran for the refused requests');
  assert.equal(s.f.calls.length, 0);

  assert.equal((await s.send(request.body, headers(request))).status, 202);
  await s.runner.idle();
  assert.equal((await s.send(request.body, headers(request))).status, 409, 'the same Linear-Delivery again is a replay');
  // Linear sends the change again under a new delivery id: the ticket still has its one issue.
  assert.equal((await s.send(request.body, headers(request, { 'linear-delivery': 'a0000000-0000-4000-8000-0000000000ff' }))).status, 202);
  await s.runner.idle();

  const issues = s.f.calls.filter(c => c.operation === 'createIssue');
  assert.equal(issues.length, 1, 'one issue for the ticket');
  const [repository, issue] = issues[0].args as [string, { title: string; body: string; labels: string[] }];
  assert.equal(repository, 'owner/allowed');
  assert.equal(issue.title, 'ENG-123: Fix the redirect after login');
  assert.deepEqual(issue.labels, ['AI']);
  assert.match(issue.body, /Linear ticket: \[ENG-123\]\(https:\/\/linear\.app\//);

  assert.equal(s.linear.requests.length, 1, 'one comment with the issue link');
  for (const sent of s.linear.requests) {
    assert.equal(sent.url.hostname, 'api.linear.app');
    assert.equal(sent.headers.authorization, API_KEY, 'the API key is injected by ProPR, without a Bearer scheme');
  }
  const deliveries = (await listPluginActivity(s.f.database, 'linear')).deliveries;
  assert.deepEqual(deliveries.map(d => [d.kind, d.status, d.handler]), [['webhook', 'succeeded', 'onLinearWebhook'], ['webhook', 'succeeded', 'onLinearWebhook']]);
  assert.equal(JSON.stringify(deliveries).includes(API_KEY), false);
  assert.equal(JSON.stringify(deliveries).includes('Users land on'), false, 'the ticket text is not in Activity');
});

test('the configure form\'s choices are loaded through ctx.http before the plugin is enabled, and refused clearly without a connection', async t => {
  const s = await setup(t);
  await s.f.store.setEnabled('1', 'linear', false);
  const deps = { ...s.runOptions, database: s.f.database };
  const loaded = await loadPluginSettingOptions(deps, 'linear', 'repositoryMapping');
  assert.deepEqual(loaded, { options: [{ value: `team:${HOOKS.ids.team}`, label: 'Team: Engineering (ENG)' }] });
  assert.deepEqual(s.linear.requests.map(r => [r.url.hostname, r.headers.authorization]), [['api.linear.app', API_KEY], ['api.linear.app', API_KEY]]);

  const refusal = async (setting: string) => { try { await loadPluginSettingOptions(deps, 'linear', setting); } catch (error) { return error; } return null; };
  for (const setting of ['triggerLabel', 'nope', '../x']) {
    const error = await refusal(setting);
    assert.ok(error instanceof PluginError && error.status === 404, `${setting} has no choices`);
  }
  await s.f.store.setConnection('1', 'linear', 'api-key', null);
  const disconnected = await refusal('stateOnMerged');
  assert.ok(disconnected instanceof PluginError && disconnected.status === 409 && /Set the Linear API key under Connections/.test(disconnected.message), String(disconnected));
  await s.f.store.uninstall('1', 'linear', 'linear');
  const uninstalled = await refusal('repositoryMapping');
  assert.ok(uninstalled instanceof PluginError && uninstalled.status === 409);
});
