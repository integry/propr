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
 * The official Jira Cloud plugin through ProPR's real plugin store, webhook
 * receiver and handler runner: the `X-Hub-Signature` (`sha256=` HMAC-SHA256)
 * check against the signed fixtures of
 * packages/plugins/jira/fixtures/webhooks.json before any plugin code runs,
 * `X-Atlassian-Webhook-Identifier` replays refused, the account email and API
 * token sent as HTTP Basic credentials to the configured site only, and a
 * site URL outside `*.atlassian.net` refused when the settings are saved.
 */

interface SignedRequest { body: string; signature: string; identifier: string }
const HOOKS = JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'jira', 'fixtures', 'webhooks.json'), 'utf8')) as { webhookSecret: string; receivedAt: number; ids: { tickets: Record<string, string> }; requests: Record<string, SignedRequest> };
const REST = JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'jira', 'fixtures', 'rest.json'), 'utf8')) as { tickets: Record<string, unknown>; projects: unknown[] };
const API_TOKEN = 'ATATT3xSENTINELjiratoken0123456789';
const CREDENTIAL = `ada@example.com:${API_TOKEN}`;
const SITE = 'https://acme.atlassian.net';
const headers = (request: SignedRequest, extra: IncomingHttpHeaders = {}): IncomingHttpHeaders => ({
  'content-type': 'application/json', 'x-hub-signature': request.signature, 'x-atlassian-webhook-identifier': request.identifier, ...extra,
});

function jiraTransport() {
  const requests: PluginHttpTransportRequest[] = [];
  const transport: PluginHttpTransport = async request => {
    requests.push(request);
    const route = `${request.url.pathname}${request.url.search}`;
    const json = route.startsWith(`/rest/api/3/issue/${HOOKS.ids.tickets.mapped}?`) ? REST.tickets.mapped
      : route.startsWith('/rest/api/3/project/search?startAt=0&') ? REST.projects[0]
        : route.startsWith('/rest/api/3/project/search?startAt=2&') ? REST.projects[1] : null;
    return json ? { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)) } : { status: 404, headers: {}, body: Buffer.from('{}') };
  };
  return { transport, requests };
}
const lookup = async (host: string) => (host.endsWith('.atlassian.net') ? [{ address: '104.192.141.1', family: 4 }] : Promise.reject(new Error('ENOTFOUND')));

async function setup(t: TestContext, options: { enabled?: boolean; apiToken?: boolean } = {}) {
  const connections: Record<string, string> = { 'webhook-secret': HOOKS.webhookSecret, ...(options.apiToken === false ? {} : { 'api-token': CREDENTIAL }) };
  const f = await pluginHandlerFixture(t, {
    pluginId: 'jira', official: true, repositories: null, connections, enabled: options.enabled, hostLookup: lookup,
    settings: { siteUrl: SITE, repositoryProjects: { 'owner/allowed': 'ENG' } },
  });
  const jira = jiraTransport();
  const handlers = (id: string) => loadPluginHandlers(id, { includeDevelopment: false });
  const runOptions = { ...f.options, handlers, transport: jira.transport, lookup };
  return { f, jira, runOptions };
}

test('the Jira manifest\'s verification accepts the signed fixtures and refuses a tampered body, a wrong secret, a missing prefix or no signature', async t => {
  const { f } = await setup(t);
  const { verification } = f.manifest.contributes.webhooks[0];
  for (const [name, request] of Object.entries(HOOKS.requests)) {
    const verify = (body: string, h: IncomingHttpHeaders, secret = HOOKS.webhookSecret) => verifyPluginWebhook({ verification, secret, headers: h, body: Buffer.from(body), now: HOOKS.receivedAt });
    assert.deepEqual(verify(request.body, headers(request)), { ok: true }, name);
    assert.deepEqual(verify(`${request.body} `, headers(request)), { ok: false, reason: 'bad_signature' }, `${name}: tampered`);
    assert.deepEqual(verify(request.body, headers(request), 'another secret'), { ok: false, reason: 'bad_signature' }, `${name}: wrong secret`);
    assert.equal(verify(request.body, headers(request, { 'x-hub-signature': request.signature.slice('sha256='.length) })).ok, false, `${name}: without sha256=`);
    assert.equal(verify(request.body, { 'content-type': 'application/json' }).ok, false, `${name}: unsigned`);
  }
});

test('the receiver rejects an unauthenticated webhook before plugin code runs, refuses a replayed delivery, and a verified label change creates one issue with Basic credentials sent to the site only', async t => {
  const s = await setup(t);
  const clock = { now: HOOKS.receivedAt };
  const runner = new PluginWebhookRunner({ ...s.runOptions, now: () => clock.now, timeoutMs: 5_000, retryDelaysMs: [5, 5], persistRetryMs: [5] });
  t.after(() => runner.stop());
  const receiver = new PluginWebhookReceiver({ database: s.f.database, runner, catalog: s.f.options.catalog, handlers: s.runOptions.handlers, environment: s.f.options.environment, now: () => clock.now });
  const { webhooks } = await pluginWebhookEndpoints(s.f.database, 'jira', { manifest: s.f.manifest, origin: 'https://propr.example.com' });
  assert.deepEqual(webhooks.map(w => [w.name, w.scheme]), [['issues', 'hmac-sha256']]);
  const key = webhooks[0].path.split('/')[3];
  const send = (body: string, h: IncomingHttpHeaders) => receiver.receive({ key, name: 'issues', headers: h, body: Buffer.from(body) });

  const added = HOOKS.requests.labelAdded;
  assert.equal((await send(added.body, headers(added, { 'x-hub-signature': `sha256=${'0'.repeat(64)}` }))).status, 401, 'a forged signature');
  assert.equal((await send(added.body, { 'content-type': 'application/json', 'x-atlassian-webhook-identifier': added.identifier })).status, 401, 'no signature');
  assert.equal((await send(added.body.replace('ENG-123', 'ENG-999'), headers(added))).status, 401, 'a tampered body');
  await runner.idle();
  assert.equal(s.jira.requests.length, 0, 'no plugin code ran: Jira was never asked');
  assert.equal((await listPluginActivity(s.f.database, 'jira')).deliveries.length, 0);

  assert.equal((await send(added.body, headers(added))).status, 202);
  await runner.idle();
  assert.equal((await send(added.body, headers(added))).status, 409, 'the same X-Atlassian-Webhook-Identifier again is a replay');
  const again = HOOKS.requests.labelAddedAgain;
  assert.equal((await send(again.body, headers(again))).status, 202);
  await runner.idle();

  const issues = s.f.calls.filter(c => c.operation === 'createIssue');
  assert.equal(issues.length, 1, 'one issue for the ticket');
  const [repository, issue] = issues[0].args as [string, { title: string; labels: string[]; body: string }];
  assert.deepEqual([repository, issue.title, issue.labels], ['owner/allowed', 'ENG-123: Fix the redirect after login', ['AI']]);
  assert.match(issue.body, /<!-- propr-plugin:jira -->$/, 'attributed to the plugin');
  assert.ok(s.jira.requests.length >= 2);
  for (const request of s.jira.requests) {
    assert.equal(request.url.hostname, 'acme.atlassian.net');
    assert.equal(request.headers.authorization, `Basic ${Buffer.from(CREDENTIAL).toString('base64')}`, 'the email and token as HTTP Basic credentials');
  }
  const deliveries = (await listPluginActivity(s.f.database, 'jira')).deliveries;
  assert.deepEqual(deliveries.map(d => [d.kind, d.status, d.handler]), [['webhook', 'succeeded', 'onJiraWebhook'], ['webhook', 'succeeded', 'onJiraWebhook']]);
  const activity = JSON.stringify(deliveries);
  for (const secret of [API_TOKEN, Buffer.from(CREDENTIAL).toString('base64'), 'Users land on', 'Fix the redirect']) assert.equal(activity.includes(secret), false, `${secret} is not in Activity`);
});

test('a site URL outside *.atlassian.net is refused when the settings are saved; a credential without the email is refused when set', async t => {
  const s = await setup(t);
  const refused = async (run: () => Promise<unknown>) => {
    try { await run(); } catch (error) { assert.ok(error instanceof PluginError); return [error.status, error.message]; }
    return null;
  };
  for (const url of ['https://jira.example.com', 'https://acme.atlassian.net.evil.example', 'https://atlassian.net']) {
    const host = new URL(url).hostname;
    assert.deepEqual(await refused(() => s.f.store.updateSettings('1', 'jira', { siteUrl: url })), [400, `siteUrl must be on *.atlassian.net, not ${host}`], url);
  }
  assert.deepEqual(await refused(() => s.f.store.updateSettings('1', 'jira', { siteUrl: 'https://other.atlassian.net', repositoryProjects: { 'owner/allowed': 'ENG' } })), null, 'another Jira Cloud site is fine');
  assert.deepEqual(await refused(() => s.f.store.setConnection('1', 'jira', 'api-token', API_TOKEN)), [400, 'Account email and API token: enter the user name (the account email), a colon and the API token, such as name@example.com:<token>']);
  assert.deepEqual(await refused(() => s.f.store.setConnection('1', 'jira', 'api-token', 'ada@example.com:')), [400, 'Account email and API token: enter the user name (the account email), a colon and the API token, such as name@example.com:<token>']);
});

test('setting choices load through optionsFrom while the plugin is disabled, with a clear error before the API token is set', async t => {
  const s = await setup(t, { enabled: false });
  const { options } = await loadPluginSettingOptions(s.f.database, 'jira', 'repositoryProjects', s.runOptions);
  assert.deepEqual(options.map(o => o.value), ['DES', 'ENG', 'OPS']);
  assert.equal(s.jira.requests[0].headers.authorization, `Basic ${Buffer.from(CREDENTIAL).toString('base64')}`);
  assert.equal(s.f.calls.length, 0, 'no ProPR call');
  const unset = await setup(t, { enabled: false, apiToken: false });
  await assert.rejects(loadPluginSettingOptions(unset.f.database, 'jira', 'repositoryProjects', unset.runOptions), (error: unknown) => error instanceof PluginError && error.status === 409 && /^Jira is not connected yet/.test(error.message));
  assert.equal(unset.jira.requests.length, 0);
});
