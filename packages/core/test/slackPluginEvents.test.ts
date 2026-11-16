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
import type { PluginHttpTransport, PluginHttpTransportRequest } from '../src/plugins/pluginHttp.js';

/**
 * The official Slack plugin's Events API webhook through ProPR's real
 * receiver: the `slack-v0` signature and timestamp check against the signed
 * fixtures of packages/plugins/slack/fixtures/events.json, the URL
 * verification challenge, and a verified mention running the handler with a
 * real `ctx` (the bot token injected for slack.com only, the issue created
 * through the ProPR backend).
 */

interface SignedRequest { timestamp: string; signature: string; body: string; retryHeaders?: Record<string, string> }
const EVENTS = JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'slack', 'fixtures', 'events.json'), 'utf8')) as { signingSecret: string; receivedAt: number; requests: Record<string, SignedRequest> };
const BOT_TOKEN = 'xoxb-1111-2222-SENTINELbottoken';
const headers = (request: SignedRequest, extra: IncomingHttpHeaders = {}): IncomingHttpHeaders => ({
  'content-type': 'application/json', 'x-slack-request-timestamp': request.timestamp, 'x-slack-signature': request.signature, ...request.retryHeaders, ...extra,
});

function slackTransport() {
  const requests: PluginHttpTransportRequest[] = [];
  let posts = 0;
  const transport: PluginHttpTransport = async request => {
    requests.push(request);
    const method = request.url.pathname.replace('/api/', '');
    const json = method === 'chat.postMessage' ? { ok: true, channel: 'C0APICHAN', ts: `1763302400.00${1000 + (posts += 1)}` }
      : method === 'chat.getPermalink' ? { ok: true, channel: 'C0APICHAN', permalink: 'https://acme.slack.com/archives/C0APICHAN/p1763301599000100' }
        : { ok: false, error: 'unknown_method' };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)) };
  };
  return { transport, requests };
}

async function setup(t: TestContext) {
  const f = await pluginHandlerFixture(t, { pluginId: 'slack', official: true, repositories: null });
  await f.store.setConnection('1', 'slack', 'signing-secret', EVENTS.signingSecret);
  await f.store.setConnection('1', 'slack', 'bot-token', BOT_TOKEN);
  await f.store.updateSettings('1', 'slack', { mode: 'app', repositoryChannels: { 'owner/allowed': 'C0APICHAN' }, allowedUsers: ['U0ALLOWED'], triggerLabel: 'AI' });
  const slack = slackTransport();
  const clock = { now: EVENTS.receivedAt };
  const handlers = (id: string) => loadPluginHandlers(id, { includeDevelopment: false });
  const options = { ...f.options, handlers, transport: slack.transport, lookup: async (host: string) => (host === 'slack.com' ? [{ address: '52.0.0.1', family: 4 }] : Promise.reject(new Error('ENOTFOUND'))) };
  const runner = new PluginWebhookRunner({ ...options, now: () => clock.now, timeoutMs: 5_000, retryDelaysMs: [5, 5], persistRetryMs: [5] });
  t.after(() => runner.stop());
  const receiver = new PluginWebhookReceiver({ database: f.database, runner, catalog: f.options.catalog, handlers, environment: f.options.environment, now: () => clock.now });
  const { webhooks } = await pluginWebhookEndpoints(f.database, 'slack', { manifest: f.manifest, origin: 'https://propr.example.com' });
  assert.deepEqual(webhooks.map(w => [w.name, w.scheme]), [['events', 'slack-v0']]);
  const key = webhooks[0].path.split('/')[3];
  const send = (body: string, h: IncomingHttpHeaders) => receiver.receive({ key, name: 'events', headers: h, body: Buffer.from(body) });
  return { f, slack, clock, runner, send };
}

test('the Slack manifest\'s slack-v0 verification accepts the signed fixtures and refuses a tampered body, a wrong secret or a stale timestamp', async t => {
  const { f } = await setup(t);
  const { verification } = f.manifest.contributes.webhooks[0];
  assert.deepEqual(verification, { scheme: 'slack-v0', connection: 'signing-secret' });
  const now = EVENTS.receivedAt;
  for (const [name, request] of Object.entries(EVENTS.requests)) {
    const verify = (body: string, h: IncomingHttpHeaders, secret = EVENTS.signingSecret, at = now) => verifyPluginWebhook({ verification, secret, headers: h, body: Buffer.from(body), now: at });
    assert.deepEqual(verify(request.body, headers(request)), { ok: true }, name);
    assert.deepEqual(verify(`${request.body} `, headers(request)), { ok: false, reason: 'bad_signature' }, `${name}: tampered`);
    assert.deepEqual(verify(request.body, headers(request), 'another secret'), { ok: false, reason: 'bad_signature' }, `${name}: wrong secret`);
    assert.deepEqual(verify(request.body, headers(request), EVENTS.signingSecret, now + 301_000), { ok: false, reason: 'stale_timestamp' }, `${name}: stale`);
    assert.deepEqual(verify(request.body, { 'x-slack-signature': request.signature }), { ok: false, reason: 'missing_signature' }, `${name}: no timestamp`);
  }
});

test('the receiver answers the URL verification challenge, refuses unsigned or stale requests, and a verified mention creates one issue and replies in its thread', async t => {
  const s = await setup(t);
  const challenge = EVENTS.requests.urlVerification;
  assert.deepEqual(await s.send(challenge.body, headers(challenge)), { status: 200, contentType: 'text/plain', body: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
  const forged = await s.send(challenge.body, headers(challenge, { 'x-slack-signature': `v0=${'0'.repeat(64)}` }));
  assert.equal(forged.status, 401, 'an unsigned challenge is not answered');
  s.clock.now += 6 * 60_000;
  assert.equal((await s.send(challenge.body, headers(challenge))).status, 401, 'a stale timestamp is refused');
  s.clock.now = EVENTS.receivedAt;

  const mention = EVENTS.requests.mention;
  const accepted = await s.send(mention.body, headers(mention));
  assert.equal(accepted.status, 202);
  await s.runner.idle();
  // Slack retries the event (it timed out waiting): a new delivery, the same message.
  const retry = EVENTS.requests.mentionRetry;
  assert.equal((await s.send(retry.body, headers(retry))).status, 202);
  await s.runner.idle();

  const issues = s.f.calls.filter(c => c.operation === 'createIssue');
  assert.equal(issues.length, 1, 'one issue for the event and its retry');
  const [repository, issue] = issues[0].args as [string, { title: string; body: string; labels: string[] }];
  assert.equal(repository, 'owner/allowed');
  assert.equal(issue.title, 'Fix the redirect after login');
  assert.deepEqual(issue.labels, ['AI']);
  assert.match(issue.body, /^Requested in Slack by mentioning the ProPR bot/);
  assert.match(issue.body, /<!-- propr-plugin:slack -->$/, 'attributed to the plugin');

  const posts = s.slack.requests.filter(r => r.url.pathname === '/api/chat.postMessage');
  assert.equal(posts.length, 1, 'one reply');
  const reply = JSON.parse(posts[0].body!.toString()) as { channel: string; thread_ts: string; text: string };
  assert.deepEqual([reply.channel, reply.thread_ts], ['C0APICHAN', '1763301599.000100']);
  assert.match(reply.text, /owner\/allowed#11/);
  for (const request of s.slack.requests) {
    assert.equal(request.url.hostname, 'slack.com');
    assert.equal(request.headers.authorization, `Bearer ${BOT_TOKEN}`, 'the bot token is injected by ProPR');
  }
  const deliveries = (await listPluginActivity(s.f.database, 'slack')).deliveries;
  assert.deepEqual(deliveries.map(d => [d.kind, d.status, d.handler]), [['webhook', 'succeeded', 'onSlackEvent'], ['webhook', 'succeeded', 'onSlackEvent']]);
  assert.equal(JSON.stringify(deliveries).includes(BOT_TOKEN), false);
  assert.equal(JSON.stringify(deliveries).includes('Users land on'), false, 'the request text is not in Activity');
});
