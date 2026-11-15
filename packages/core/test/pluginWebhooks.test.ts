import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { parsePluginManifest, type PluginWebhookVerification } from '@propr/shared';
import { loadPluginHandlers } from '../../plugins/src/index.js';
import { FIXTURE_REGISTRY, pluginHandlerFixture } from './helpers/pluginHandlerFixture.js';
import { verifyPluginWebhook, pluginWebhookEndpoints, regeneratePluginWebhookKey } from '../src/plugins/pluginWebhooks.js';
import { PluginWebhookRunner } from '../src/plugins/pluginWebhookRunner.js';
import { PluginWebhookReceiver } from '../src/plugins/pluginWebhookReceiver.js';
import { listPluginActivity } from '../src/plugins/pluginDeliveries.js';
import logger from '../src/utils/logger.js';

const ID = 'fixture-webhooks';
const SECRET = 'whsec_fixture-signing-secret';
const NOW = 1_700_000_000_000;
const verify = (verification: PluginWebhookVerification, secret: string, headers: IncomingHttpHeaders, body: string, now = NOW) =>
  verifyPluginWebhook({ verification, secret, headers, body: Buffer.from(body), now });
const scheme = (value: Record<string, unknown>) => {
  const parsed = parsePluginManifest({
    manifestVersion: 1, id: 'vectors', name: 'Vectors', description: 'Test vectors', version: '1.0.0', category: 'other', homepage: 'https://example.com', icon: 'icon.svg',
    connections: [{ type: 'signing_secret', name: 'secret', label: 'Secret', help: 'Secret', helpUrl: 'https://example.com' }],
    contributes: { webhooks: [{ name: 'hook', description: 'Hook', handler: 'run', verification: { ...value, connection: 'secret' } }] },
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('; '));
  return parsed.manifest.contributes.webhooks[0].verification;
};

test('each verification scheme accepts its documented test vector and refuses a tampered one', () => {
  // GitHub, "Validating webhook deliveries": secret "It's a Secret to Everybody", payload "Hello, World!".
  const github = scheme({ scheme: 'hmac-sha256', header: 'X-Hub-Signature-256', prefix: 'sha256=' });
  const githubSignature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
  assert.deepEqual(verify(github, "It's a Secret to Everybody", { 'x-hub-signature-256': githubSignature }, 'Hello, World!'), { ok: true });
  assert.deepEqual(verify(github, "It's a Secret to Everybody", { 'x-hub-signature-256': githubSignature }, 'Hello, World?'), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify(github, "It's a Secret to Everybody", { 'x-hub-signature-256': githubSignature.replace('sha256=', 'sha1=') }, 'Hello, World!'), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify(github, 'another secret', { 'x-hub-signature-256': githubSignature }, 'Hello, World!'), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify(github, "It's a Secret to Everybody", {}, 'Hello, World!'), { ok: false, reason: 'missing_signature' });
  assert.deepEqual(verify(github, "It's a Secret to Everybody", { 'x-hub-signature-256': [githubSignature, githubSignature] }, 'Hello, World!'), { ok: false, reason: 'missing_signature' }, 'a repeated header is no signature');

  // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?"; no prefix, hex and base64.
  const rfcHex = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
  assert.deepEqual(verify(scheme({ scheme: 'hmac-sha256', header: 'x-signature' }), 'Jefe', { 'x-signature': rfcHex }, 'what do ya want for nothing?'), { ok: true });
  assert.deepEqual(verify(scheme({ scheme: 'hmac-sha256', header: 'x-signature' }), 'Jefe', { 'x-signature': rfcHex.toUpperCase() }, 'what do ya want for nothing?'), { ok: true });
  const base64 = scheme({ scheme: 'hmac-sha256', header: 'x-signature', encoding: 'base64' });
  assert.deepEqual(verify(base64, 'Jefe', { 'x-signature': Buffer.from(rfcHex, 'hex').toString('base64') }, 'what do ya want for nothing?'), { ok: true });
  assert.deepEqual(verify(base64, 'Jefe', { 'x-signature': rfcHex }, 'what do ya want for nothing?'), { ok: false, reason: 'bad_signature' }, 'hex is not base64');

  // Slack, "Verifying requests from Slack": the documented slash command request.
  const slack = scheme({ scheme: 'slack-v0' });
  const slackSecret = '8f742231b10e8888abcd99yyyzzz85a5';
  const slackBody = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
  const slackHeaders = { 'x-slack-request-timestamp': '1531420618', 'x-slack-signature': 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503' };
  const slackNow = 1531420618 * 1000;
  assert.deepEqual(verify(slack, slackSecret, slackHeaders, slackBody, slackNow), { ok: true });
  assert.deepEqual(verify(slack, slackSecret, slackHeaders, slackBody, slackNow + 300_000), { ok: true }, 'five minutes is within the tolerance');
  assert.deepEqual(verify(slack, slackSecret, slackHeaders, slackBody, slackNow + 301_000), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verify(slack, slackSecret, slackHeaders, slackBody, slackNow - 301_000), { ok: false, reason: 'stale_timestamp' }, 'a timestamp from the future is refused too');
  assert.deepEqual(verify(slack, slackSecret, { ...slackHeaders, 'x-slack-request-timestamp': '1531420619' }, slackBody, slackNow), { ok: false, reason: 'bad_signature' }, 'the timestamp is signed');
  assert.deepEqual(verify(slack, slackSecret, slackHeaders, `${slackBody}&x=1`, slackNow), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify(slack, slackSecret, { 'x-slack-signature': slackHeaders['x-slack-signature'] }, slackBody, slackNow), { ok: false, reason: 'missing_signature' });

  // A token header, as GitLab's X-Gitlab-Token: the header is the secret itself (optionally behind a prefix).
  const gitlab = scheme({ scheme: 'token-header', header: 'X-Gitlab-Token' });
  assert.deepEqual(verify(gitlab, 'glwt-3f9a1c', { 'x-gitlab-token': 'glwt-3f9a1c' }, '{}'), { ok: true });
  assert.deepEqual(verify(gitlab, 'glwt-3f9a1c', { 'x-gitlab-token': 'glwt-3f9a1' }, '{}'), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verify(gitlab, 'glwt-3f9a1c', { 'x-gitlab-token': 'glwt-3f9a1cc' }, '{}'), { ok: false, reason: 'bad_signature' });
  const bearer = scheme({ scheme: 'token-header', header: 'authorization', prefix: 'Bearer ' });
  assert.deepEqual(verify(bearer, 'glwt-3f9a1c', { authorization: 'Bearer glwt-3f9a1c' }, ''), { ok: true });
  assert.deepEqual(verify(bearer, 'glwt-3f9a1c', { authorization: 'glwt-3f9a1c' }, ''), { ok: false, reason: 'bad_signature' });
});

const hubSignature = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const slackSignature = (timestamp: string, body: string, secret = SECRET) => `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;

async function setup(t: TestContext, options: { retryDelaysMs?: number[] } = {}) {
  const f = await pluginHandlerFixture(t, { pluginId: ID, repositories: null });
  await f.store.setConnection('1', ID, 'hook-secret', SECRET);
  const clock = { now: NOW };
  const loads: string[] = [];
  const handlers = (id: string) => { loads.push(id); return loadPluginHandlers(id, { root: FIXTURE_REGISTRY, includeDevelopment: true }); };
  const runner = new PluginWebhookRunner({ ...f.options, handlers, now: () => clock.now, timeoutMs: 500, retryDelaysMs: options.retryDelaysMs ?? [5, 5] });
  t.after(() => runner.stop());
  const receiver = new PluginWebhookReceiver({ database: f.database, runner, catalog: f.options.catalog, handlers, environment: f.options.environment, now: () => clock.now });
  const { webhooks } = await pluginWebhookEndpoints(f.database, ID, { manifest: f.manifest, origin: null });
  const key = webhooks[0].path.split('/')[3];
  const send = (name: string, body: string, headers: IncomingHttpHeaders, onKey = key) => receiver.receive({ key: onKey, name, headers, body: Buffer.from(body) });
  const seen = async () => {
    const row = await f.database('plugin_state').where({ plugin_id: ID, state_key: 'seen' }).first() as { value: string } | undefined;
    return row ? JSON.parse(row.value) as { id: string; webhook: string; attempt: number; bodyBytes: number; headers: string[] }[] : [];
  };
  const deliveries = async () => (await listPluginActivity(f.database, ID)).deliveries;
  const rejected = async () => Number((await f.database('plugin_webhook_keys').where({ plugin_id: ID }).first('rejected_count')).rejected_count);
  return { f, clock, loads, runner, receiver, key, send, seen, deliveries, rejected };
}

test('a verified request runs its handler once; a bad signature, a stale timestamp and a replayed delivery id run no plugin code', async t => {
  const s = await setup(t);
  const body = '{"action":"opened"}';
  const accepted = await s.send('signed', body, { 'x-hub-signature-256': hubSignature(body), 'x-github-delivery': 'd-1', 'content-type': 'application/json', cookie: 'sid=1', authorization: 'Basic eA==' });
  assert.equal(accepted.status, 202);
  assert.deepEqual(JSON.parse(accepted.body), { accepted: true, deliveryId: 'whk-signed:d-1' });
  await s.runner.idle();
  const seen = await s.seen();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { id: 'whk-signed:d-1', webhook: 'signed', attempt: 1, bodyBytes: Buffer.byteLength(body), headers: ['content-type', 'x-github-delivery'] },
    'the handler gets the body, but not the signature, cookie or authorization headers');
  const [delivery] = await s.deliveries();
  assert.deepEqual({ kind: delivery.kind, status: delivery.status, eventType: delivery.eventType, handler: delivery.handler, attempt: delivery.attempt, deliveryId: delivery.deliveryId },
    { kind: 'webhook', status: 'succeeded', eventType: 'webhook.signed', handler: 'onWebhook', attempt: 1, deliveryId: 'whk-signed:d-1' });

  const loadsBefore = s.loads.length;
  const replay = await s.send('signed', body, { 'x-hub-signature-256': hubSignature(body), 'x-github-delivery': 'd-1' });
  assert.equal(replay.status, 409, 'a replayed delivery id is refused');
  const forged = await s.send('signed', body, { 'x-hub-signature-256': hubSignature(body, 'wrong secret'), 'x-github-delivery': 'd-2' });
  assert.equal(forged.status, 401);
  const tampered = await s.send('signed', `${body} `, { 'x-hub-signature-256': hubSignature(body), 'x-github-delivery': 'd-3' });
  assert.equal(tampered.status, 401);
  const unsigned = await s.send('signed', body, { 'x-github-delivery': 'd-4' });
  assert.equal(unsigned.status, 401);
  const slackBody = '{"type":"event_callback"}';
  const stale = String(Math.floor(NOW / 1000) - 301);
  const staleReply = await s.send('slack', slackBody, { 'x-slack-request-timestamp': stale, 'x-slack-signature': slackSignature(stale, slackBody) });
  assert.equal(staleReply.status, 401, 'a correctly signed but stale Slack request is refused');
  const malformed = await s.send('signed', body, { 'x-hub-signature-256': hubSignature(body), 'x-github-delivery': 'has space' });
  assert.equal(malformed.status, 400);
  await s.runner.idle();
  assert.equal(s.loads.length, loadsBefore, 'no plugin module was loaded for any refused request');
  assert.equal((await s.seen()).length, 1, 'the handler ran exactly once');
  assert.equal((await s.deliveries()).length, 1);
  assert.equal(await s.rejected(), 4, 'each unverified request is counted');
  const endpoints = await pluginWebhookEndpoints(s.f.database, ID, { manifest: s.f.manifest, origin: 'https://propr.example.com' });
  assert.deepEqual({ count: endpoints.rejected.count, lastReason: endpoints.rejected.lastReason }, { count: 4, lastReason: 'stale_timestamp' });
  assert.equal(endpoints.webhooks[0].url, `https://propr.example.com/api/plugins/${s.key}/hooks/signed`);

  const fresh = String(Math.floor(NOW / 1000) - 10);
  const slack = await s.send('slack', slackBody, { 'x-slack-request-timestamp': fresh, 'x-slack-signature': slackSignature(fresh, slackBody) });
  assert.equal(slack.status, 202);
  const noDeliveryHeader = await s.send('signed', body, { 'x-hub-signature-256': hubSignature(body) });
  assert.equal(noDeliveryHeader.status, 202, 'without a delivery id header ProPR assigns one');
  await s.runner.idle();
  assert.equal((await s.seen()).length, 3);
});

test('the synchronous challenge response answers at once, runs no handler and cannot reach ctx', async t => {
  const s = await setup(t);
  const body = JSON.stringify({ type: 'url_verification', challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
  const timestamp = String(Math.floor(NOW / 1000));
  const reply = await s.send('slack', body, { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': slackSignature(timestamp, body) });
  assert.deepEqual(reply, { status: 200, contentType: 'text/plain', body: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
  const unsigned = await s.send('slack', body, { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': slackSignature(timestamp, body, 'wrong') });
  assert.equal(unsigned.status, 401, 'the challenge is answered only after verification');

  const probe = await s.send('probe', '{"hello":1}', { 'x-gitlab-token': SECRET });
  assert.equal(probe.status, 500, 'the respond function failed: it got no ctx to call');
  const module = await loadPluginHandlers(ID, { root: FIXTURE_REGISTRY, includeDevelopment: true });
  assert.deepEqual((module!.respondProbes as unknown as () => unknown[])(), [{ args: 1, keys: ['body', 'headers', 'receivedAt', 'webhook'], frozen: true }],
    'it was called with the frozen request as its only argument');
  await s.runner.idle();
  assert.equal(await s.f.database('plugin_state').where({ plugin_id: ID, state_key: 'respond' }).first(), undefined);
  assert.deepEqual(await s.seen(), [], 'no handler ran');
  assert.deepEqual(await s.deliveries(), [], 'nothing was queued');
});

test('a disabled or uninstalled plugin answers 404, and regenerating the key invalidates the old URL', async t => {
  const s = await setup(t);
  const send = (key = s.key) => s.send('token', '{}', { 'x-gitlab-token': SECRET }, key);
  assert.equal((await send()).status, 202);
  await s.runner.idle();
  assert.equal((await s.send('missing', '{}', { 'x-gitlab-token': SECRET })).status, 404, 'an undeclared webhook');
  assert.equal((await send('A'.repeat(43))).status, 404, 'an unknown key');

  const regenerated = await regeneratePluginWebhookKey(s.f.database, ID, '1', { manifest: s.f.manifest, origin: null });
  const newKey = regenerated.webhooks[0].path.split('/')[3];
  assert.notEqual(newKey, s.key);
  assert.equal((await send()).status, 404, 'the old URL is dead');
  assert.equal((await send(newKey)).status, 202);
  await s.runner.idle();
  const audit = await s.f.database('plugin_audit').where({ plugin_id: ID, action: 'regenerate_webhook_key' }).select('actor');
  assert.deepEqual(audit, [{ actor: '1' }]);

  await s.f.store.setEnabled('1', ID, false);
  assert.equal((await send(newKey)).status, 404, 'a disabled plugin runs nothing');
  await s.f.store.setEnabled('1', ID, true);
  assert.equal((await send(newKey)).status, 202, 'enabled again, the same URL works');
  await s.runner.idle();
  const ran = (await s.seen()).length;
  await s.f.store.uninstall('1', ID, ID);
  assert.equal((await send(newKey)).status, 404, 'an uninstalled plugin runs nothing');
  assert.equal(await s.f.database('plugin_webhook_keys').where({ plugin_id: ID }).first(), undefined, 'the key is deleted with the installation');
  await s.f.store.install('1', ID);
  await s.f.store.setConnection('1', ID, 'hook-secret', SECRET);
  await s.f.store.setEnabled('1', ID, true);
  assert.equal((await send(newKey)).status, 404, 'a reinstall gets a new key');
  assert.notEqual((await pluginWebhookEndpoints(s.f.database, ID, { manifest: s.f.manifest, origin: null })).webhooks[0].path.split('/')[3], newKey);
  assert.equal(ran, 3);
});

test('a failing webhook handler is retried on the delivery schedule, then marked failed; deliveries left by a stopped process are failed', async t => {
  const s = await setup(t, { retryDelaysMs: [5, 5] });
  await s.f.database('plugin_state').insert({ plugin_id: ID, state_key: 'fail', value: '1', bytes: 1, updated_at: 0 });
  assert.equal((await s.send('token', '{"n":1}', { 'x-gitlab-token': SECRET })).status, 202);
  const settle = async () => { for (let i = 0; i < 50 && (s.runner.pending || (await s.runner.idle(), s.runner.pending)); i++) await new Promise(r => setTimeout(r, 10)); };
  await settle();
  let [delivery] = await s.deliveries();
  assert.deepEqual({ status: delivery.status, attempt: delivery.attempt }, { status: 'succeeded', attempt: 2 }, 'the second attempt succeeds');
  assert.deepEqual((await s.seen()).map(x => x.attempt), [1, 2]);
  assert.equal(new Set((await s.seen()).map(x => x.id)).size, 1, 'the delivery id is the same on every attempt');

  await s.f.database('plugin_state').where({ plugin_id: ID, state_key: 'fail' }).update({ value: '10' });
  assert.equal((await s.send('token', '{"n":2}', { 'x-gitlab-token': SECRET })).status, 202);
  await settle();
  [delivery] = await s.deliveries();
  assert.deepEqual({ status: delivery.status, attempt: delivery.attempt, error: delivery.error }, { status: 'failed', attempt: 3, error: 'The webhook handler failed (its error is not kept: it may contain the request)' }, 'three attempts with two retry delays, then failed, without the error text of the handler');

  const orphan = new PluginWebhookRunner({ ...s.f.options, retryDelaysMs: [60_000] });
  t.after(() => orphan.stop());
  await s.f.database('plugin_deliveries').insert({ plugin_id: ID, delivery_id: 'whk-token-orphan', kind: 'webhook', repository: '', event_seq: 0, event_type: 'webhook.token', handler: 'flakyWebhook', status: 'retrying', attempt: 1, created_at: NOW, logs: '[]' });
  assert.equal(await orphan.recover(), 1);
  const lost = (await s.deliveries()).find(d => d.deliveryId === 'whk-token-orphan')!;
  assert.equal(lost.status, 'failed');
  assert.match(lost.error!, /not kept/);
});

test('request bodies and signature headers are never stored or logged (sentinel)', async t => {
  const s = await setup(t);
  const lines: string[] = [];
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    mock.method(logger, level, (...args: unknown[]) => { lines.push(JSON.stringify(args, (_k, v: unknown) => (v instanceof Error ? `${v.name}: ${v.message}` : v))); });
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) mock.method(console, level, (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  t.after(() => mock.restoreAll());
  const BODY = 'SENTINEL-BODY-5f0c2e';
  const TOKEN_GUESS = 'SENTINEL-TOKEN-91ab';
  const body = JSON.stringify({ text: BODY });
  const signature = hubSignature(body);
  const forgedSignature = hubSignature(body, 'SENTINEL-WRONG');
  const timestamp = String(Math.floor(NOW / 1000));
  const slackSig = slackSignature(timestamp, body);
  const replies = [
    await s.send('signed', body, { 'x-hub-signature-256': signature, 'x-github-delivery': 'sentinel-1' }),
    await s.send('signed', body, { 'x-hub-signature-256': signature, 'x-github-delivery': 'sentinel-1' }),
    await s.send('signed', body, { 'x-hub-signature-256': forgedSignature }),
    await s.send('token', body, { 'x-gitlab-token': TOKEN_GUESS }),
    await s.send('slack', body, { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': slackSig }),
    await s.send('probe', body, { 'x-gitlab-token': SECRET }),
  ];
  assert.deepEqual(replies.map(r => r.status), [202, 409, 401, 401, 202, 500]);
  await s.runner.idle();
  assert.equal((await s.seen()).length, 2);
  assert.ok(lines.length > 0, 'the sentinel watched real log output');
  const tables = (await s.f.database.raw("SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[]).map(row => row.name);
  const dump: string[] = [];
  for (const table of tables) dump.push(JSON.stringify(await s.f.database(table).select()));
  for (const sentinel of [BODY, TOKEN_GUESS, signature, signature.slice(7), forgedSignature.slice(7), slackSig.slice(3), 'SENTINEL-WRONG']) {
    assert.ok(!dump.some(text => text.includes(sentinel)), `${sentinel} is not stored in any table`);
    assert.ok(!lines.some(line => line.includes(sentinel)), `${sentinel} is not logged`);
  }
});

test('a responder runs only after its delivery id is reserved: a replay, challenge or not, runs no plugin code', async t => {
  const s = await setup(t);
  const module = await loadPluginHandlers(ID, { root: FIXTURE_REGISTRY, includeDevelopment: true });
  const calls = () => (module!.challengeCalls as unknown as () => number)();
  const send = (body: string, id: string) => s.send('answered', body, { 'x-gitlab-token': SECRET, 'x-delivery-id': id });
  const event = '{"type":"event_callback"}';
  const before = calls();
  assert.equal((await send(event, 'r-1')).status, 202);
  await s.runner.idle();
  assert.equal(calls(), before + 1);
  const loads = s.loads.length;
  assert.equal((await send(event, 'r-1')).status, 409, 'the replayed ordinary event is refused');
  assert.equal(calls(), before + 1, 'without running the responder again');
  assert.equal(s.loads.length, loads, 'or loading the plugin module');

  const challenge = JSON.stringify({ type: 'url_verification', challenge: 'c-123' });
  assert.deepEqual(await send(challenge, 'r-2'), { status: 200, contentType: 'text/plain', body: 'c-123' });
  assert.equal(calls(), before + 2);
  assert.equal((await send(challenge, 'r-2')).status, 409, 'an answered challenge keeps its delivery id taken');
  assert.equal(calls(), before + 2, 'its replay runs no responder');
  assert.equal(s.loads.length, loads + 1);
  const answered = (await s.deliveries()).find(d => d.deliveryId === 'whk-answered:r-2')!;
  assert.deepEqual({ status: answered.status, handler: answered.handler }, { status: 'succeeded', handler: 'countedChallenge' });

  // Refused before delivery (paused): the reservation is given back, so the sender's retry is delivered.
  const installedAt = Number((await s.f.database('plugin_installations').where({ plugin_id: ID }).first('installed_at')).installed_at);
  await s.f.database('plugin_dispatch').insert({ plugin_id: ID, installed_at: installedAt, start_seq: 0, updated_at: NOW, paused_at: NOW }).onConflict('plugin_id').merge(['paused_at']);
  assert.equal((await send(event, 'r-3')).status, 503);
  await s.f.database('plugin_dispatch').where({ plugin_id: ID }).update({ paused_at: null });
  assert.equal((await send(event, 'r-3')).status, 202, 'the retry of a refused request is not a replay');
  await s.runner.idle();
  assert.deepEqual((await s.seen()).map(x => x.id), ['whk-answered:r-1', 'whk-answered:r-3']);
});

test('delivery ids of different webhooks never collide', async t => {
  const s = await setup(t);
  const a = await s.send('a', '{}', { 'x-gitlab-token': SECRET, 'x-delivery-id': 'b-c' });
  const ab = await s.send('a-b', '{}', { 'x-gitlab-token': SECRET, 'x-delivery-id': 'c' });
  assert.deepEqual([a.status, ab.status], [202, 202], 'webhook a with id b-c and webhook a-b with id c are two deliveries');
  assert.notEqual(JSON.parse(a.body).deliveryId, JSON.parse(ab.body).deliveryId);
  const propr = await s.send('a', '{}', { 'x-gitlab-token': SECRET });
  assert.match(JSON.parse(propr.body).deliveryId as string, /^whk-a\/[0-9a-f-]{36}$/, 'a ProPR id is spelled apart from any sender id');
  await s.runner.idle();
  assert.deepEqual((await s.seen()).map(x => [x.webhook, x.id]).slice(0, 2), [['a', 'whk-a:b-c'], ['a-b', 'whk-a-b:c']]);
});

test('a handler that logs or throws the request body has neither stored nor logged (sentinel)', async t => {
  const s = await setup(t, { retryDelaysMs: [] });
  const lines: string[] = [];
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    mock.method(logger, level, (...args: unknown[]) => { lines.push(JSON.stringify(args, (_k, v: unknown) => (v instanceof Error ? `${v.name}: ${v.message}` : v))); });
  }
  t.after(() => mock.restoreAll());
  const BODY = 'customer-private-message-123';
  assert.equal((await s.send('leaky', JSON.stringify({ text: BODY }), { 'x-gitlab-token': SECRET })).status, 202);
  await s.runner.idle();
  const [delivery] = await s.deliveries();
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.error, 'The webhook handler failed (its error is not kept: it may contain the request)');
  assert.deepEqual(delivery.logs.map(line => [line.level, line.fields]), [['info', undefined], ['warn', undefined]], 'the lines are kept as levels and times only');
  const tables = (await s.f.database.raw("SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[]).map(row => row.name);
  for (const table of tables) assert.ok(!JSON.stringify(await s.f.database(table).select()).includes(BODY), `the body is not stored in ${table}`);
  assert.ok(lines.length > 0);
  assert.ok(!lines.some(line => line.includes(BODY)), 'the body is not logged');
});

test('starting another runner leaves a live runner\'s deliveries alone and fails only those of a stopped one', async t => {
  const s = await setup(t, { retryDelaysMs: [30] });
  await s.f.database('plugin_state').insert({ plugin_id: ID, state_key: 'fail', value: '1', bytes: 1, updated_at: 0 });
  assert.equal((await s.send('token', '{}', { 'x-gitlab-token': SECRET })).status, 202);
  await s.runner.idle();
  assert.equal((await s.deliveries())[0].status, 'retrying', 'A holds a delivery waiting for its retry');

  // B starts against the same database while A is alive.
  const other = new PluginWebhookRunner({ ...s.f.options, now: () => s.clock.now });
  t.after(() => other.stop());
  assert.equal(await other.recover(), 0, 'B fails nothing of A');
  assert.equal((await s.deliveries())[0].status, 'retrying');
  for (let i = 0; i < 50 && (s.runner.pending || (await s.runner.idle(), s.runner.pending)); i++) await new Promise(r => setTimeout(r, 10));
  const [delivery] = await s.deliveries();
  assert.deepEqual({ status: delivery.status, attempt: delivery.attempt }, { status: 'succeeded', attempt: 2 }, 'A\'s retry ran');

  // A runner whose heartbeat lapsed has stopped: its unfinished delivery is failed by the next recovery.
  await s.f.database('plugin_webhook_runners').insert({ owner: 'webhooks-stopped', heartbeat_at: NOW - 121_000 });
  await s.f.database('plugin_deliveries').insert({ plugin_id: ID, delivery_id: 'whk-token/stopped', kind: 'webhook', repository: '', event_seq: 0, event_type: 'webhook.token', handler: 'flakyWebhook', status: 'retrying', attempt: 1, created_at: NOW, logs: '[]', webhook_owner: 'webhooks-stopped' });
  assert.equal(await other.recover(), 1);
  const lost = (await s.deliveries()).find(d => d.deliveryId === 'whk-token/stopped')!;
  assert.equal(lost.status, 'failed');
  assert.equal(await s.f.database('plugin_webhook_runners').where({ owner: 'webhooks-stopped' }).first(), undefined, 'the stopped runner is forgotten');
  assert.ok(await s.f.database('plugin_webhook_runners').where({ owner: s.runner.owner }).first(), 'A is still registered');
});
