import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import type { Knex } from 'knex';
import { parsePluginManifest, type PluginWebhookVerification } from '@propr/shared';
import { loadPluginHandlers } from '../../plugins/src/index.js';
import { FIXTURE_REGISTRY, pluginHandlerFixture } from './helpers/pluginHandlerFixture.js';
import { decodePluginWebhookBody, verifyPluginWebhook, pluginWebhookEndpoints, senderDeliveryId, regeneratePluginWebhookKey, resolvePluginWebhook } from '../src/plugins/pluginWebhooks.js';
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

async function setup(t: TestContext, options: { retryDelaysMs?: number[]; wrap?: (database: Knex) => Knex } = {}) {
  const f = await pluginHandlerFixture(t, { pluginId: ID, repositories: null });
  await f.store.setConnection('1', ID, 'hook-secret', SECRET);
  const clock = { now: NOW };
  const loads: string[] = [];
  const handlers = (id: string) => { loads.push(id); return loadPluginHandlers(id, { root: FIXTURE_REGISTRY, includeDevelopment: true }); };
  const database = options.wrap ? options.wrap(f.database) : f.database;
  /** Another API process: its own runner and receiver, on the same database. */
  const api = () => {
    const runner = new PluginWebhookRunner({ ...f.options, database, handlers, now: () => clock.now, timeoutMs: 500, retryDelaysMs: options.retryDelaysMs ?? [5, 5], persistRetryMs: [5] });
    t.after(() => runner.stop());
    const receiver = new PluginWebhookReceiver({ database: f.database, runner, catalog: f.options.catalog, handlers, environment: f.options.environment, now: () => clock.now });
    const send = (name: string, body: string, headers: IncomingHttpHeaders, onKey = key) => receiver.receive({ key: onKey, name, headers, body: Buffer.from(body) });
    return { runner, receiver, send };
  };
  const { webhooks } = await pluginWebhookEndpoints(f.database, ID, { manifest: f.manifest, origin: null });
  const key = webhooks[0].path.split('/')[3];
  const { runner, receiver, send } = api();
  const seen = async () => {
    const row = await f.database('plugin_state').where({ plugin_id: ID, state_key: 'seen' }).first() as { value: string } | undefined;
    return row ? JSON.parse(row.value) as { id: string; webhook: string; attempt: number; bodyBytes: number; headers: string[] }[] : [];
  };
  const deliveries = async () => (await listPluginActivity(f.database, ID)).deliveries;
  const rejected = async () => Number((await f.database('plugin_webhook_keys').where({ plugin_id: ID }).first('rejected_count')).rejected_count);
  return { f, clock, loads, runner, receiver, key, send, seen, deliveries, rejected, api };
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

test('an async respond function that throws, before or after an await, answers 500 and leaves no unhandled rejection', async t => {
  const s = await setup(t);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });
  const throwers = {
    // eslint-disable-next-line @typescript-eslint/require-await -- deliberately async: it rejects without awaiting
    async throwsAtOnce(): Promise<never> { throw new Error('responder failed at once'); },
    async throwsAfterAwait(): Promise<never> { await new Promise(resolve => setTimeout(resolve, 5)); throw new Error('responder failed after an await'); },
  };
  for (const [name, responder] of Object.entries(throwers)) {
    const handlers = async (id: string) => ({ ...(await loadPluginHandlers(id, { root: FIXTURE_REGISTRY, includeDevelopment: true }))!, slackChallenge: responder as never });
    const receiver = new PluginWebhookReceiver({ database: s.f.database, runner: s.runner, catalog: s.f.options.catalog, handlers, environment: s.f.options.environment, now: () => s.clock.now });
    const body = JSON.stringify({ type: 'url_verification', challenge: name });
    const timestamp = String(Math.floor(NOW / 1000));
    const reply = await receiver.receive({ key: s.key, name: 'slack', headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': slackSignature(timestamp, body) }, body: Buffer.from(body) });
    assert.deepEqual(reply, { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The webhook could not answer' }) }, `${name}: an asynchronous answer is refused`);
  }
  // Let both rejections settle, and Node report any left unhandled.
  await new Promise(resolve => setTimeout(resolve, 30));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, [], 'each rejection was consumed');
  await s.runner.idle();
  assert.deepEqual(await s.deliveries(), [], 'nothing was queued, and the reservations were given back');
  assert.deepEqual(await s.seen(), []);
});

test('concurrent requests at the limit are admitted against one count; a duplicate or refused reservation gives its slot back', async t => {
  const s = await setup(t);
  const runner = new PluginWebhookRunner({ ...s.f.options, now: () => s.clock.now, maxPending: 2 });
  t.after(() => runner.stop());
  const resolved = (await resolvePluginWebhook(s.f.database, s.key, 'a', await s.f.options.catalog!()))!;
  const reserve = (id: string, target = resolved.target) => runner.reserve({ target, handler: 'onWebhook', deliveryId: `whk-a:${id}`, webhook: 'a' });
  const burst = await Promise.all(['c-1', 'c-2', 'c-3', 'c-4', 'c-5'].map(id => reserve(id)));
  assert.equal(burst.filter(r => r.accepted).length, 2, 'only maxPending of a concurrent burst are admitted');
  assert.deepEqual(burst.filter(r => !r.accepted).map(r => !r.accepted && r.reason), ['busy', 'busy', 'busy']);
  assert.equal((await s.deliveries()).length, 2, 'the refused requests recorded nothing');
  assert.deepEqual(await reserve('c-6'), { accepted: false, reason: 'busy' });

  const [first, second] = burst.filter(r => r.accepted).map(r => (r as { recordId: number }).recordId);
  await runner.release(first);
  const secondId = (await s.deliveries()).find(d => d.id === second)!.deliveryId.slice('whk-a:'.length);
  assert.deepEqual(await reserve(secondId), { accepted: false, reason: 'duplicate' }, 'a replay takes no slot');
  const stale = { ...resolved.target, record: { ...resolved.target.record, installedAt: resolved.target.record.installedAt - 1 } };
  assert.deepEqual(await reserve('c-7', stale), { accepted: false, reason: 'gone' }, 'a stale installation takes no slot');
  const again = await Promise.all([reserve('c-8'), reserve('c-9')]);
  assert.deepEqual(again.map(r => r.accepted), [true, false], 'the released slot, and only it, is free again');
});

test('a request resolved before an uninstall and reinstall records nothing, and does not poison the new installation\'s delivery ids', async t => {
  const s = await setup(t);
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  let waiting!: () => void;
  const resolvedA = new Promise<void>(resolve => { waiting = resolve; });
  // Suspends a verified request of installation A after its key was resolved, before its delivery is reserved.
  const connectionSecret = async () => { waiting(); await gate; return SECRET; };
  const receiver = new PluginWebhookReceiver({ database: s.f.database, runner: s.runner, catalog: s.f.options.catalog, connectionSecret, now: () => s.clock.now });
  const headers = { 'x-gitlab-token': SECRET, 'x-delivery-id': 'u-1' };
  const old = receiver.receive({ key: s.key, name: 'a', headers, body: Buffer.from('{}') });
  await resolvedA;

  await s.f.store.uninstall('1', ID, ID);
  await s.f.store.install('1', ID);
  await s.f.store.setConnection('1', ID, 'hook-secret', SECRET);
  await s.f.store.setEnabled('1', ID, true);
  open();
  assert.equal((await old).status, 404, 'A\'s request is answered as to a dead URL');
  assert.deepEqual(await s.f.database('plugin_deliveries').where({ plugin_id: ID }).select('delivery_id'), [], 'and records nothing');

  const { webhooks } = await pluginWebhookEndpoints(s.f.database, ID, { manifest: s.f.manifest, origin: null });
  const keyB = webhooks.find(w => w.name === 'a')!.path.split('/')[3];
  assert.notEqual(keyB, s.key);
  const fresh = await s.send('a', '{}', headers, keyB);
  assert.equal(fresh.status, 202, 'B receives the delivery id A never delivered');
  await s.runner.idle();
  assert.deepEqual((await s.seen()).map(x => x.id), ['whk-a:u-1']);
});

/**
 * The runner's database, failing chosen `plugin_deliveries` writes (and
 * `first` reads, whose `when` gets no values) once each: `reject` before the
 * query, `lost` after it ran (for a write: committed, but the reply was lost).
 */
function failingWrites(rules: Array<{ method: 'update' | 'delete' | 'first'; when: (values: Record<string, unknown> | undefined) => boolean; mode: 'reject' | 'lost' }>) {
  const fired: string[] = [];
  const wrap = (real: Knex) => new Proxy(real, {
    apply(target, self, args: unknown[]) {
      const query = Reflect.apply(target, self, args) as Knex.QueryBuilder;
      if (args[0] !== 'plugin_deliveries') return query;
      for (const method of ['update', 'delete', 'first'] as const) {
        const original = query[method].bind(query) as (...a: unknown[]) => Promise<unknown>;
        (query as unknown as Record<string, unknown>)[method] = (...a: unknown[]) => {
          const values = method === 'first' ? undefined : a[0] as Record<string, unknown> | undefined;
          const rule = rules.find(r => r.method === method && r.when(values));
          if (!rule) return original(...a);
          rules.splice(rules.indexOf(rule), 1);
          fired.push(`${method}:${rule.mode}`);
          if (rule.mode === 'reject') return Promise.reject(new Error('transient database write failure'));
          return original(...a).then(() => { throw new Error('connection reset after commit'); });
        };
      }
      return query;
    },
  });
  return { wrap, fired };
}

const settled = async (s: Awaited<ReturnType<typeof setup>>) => {
  for (let i = 0; i < 100 && (s.runner.pending || (await s.runner.idle(), s.runner.pending)); i++) await new Promise(r => setTimeout(r, 10));
};

test('a failed outcome write is retried without running the handler again, and the delivery reaches its final state', async t => {
  const writes = failingWrites([
    { method: 'update', mode: 'reject', when: v => v?.status === 'retrying' },
    { method: 'update', mode: 'lost', when: v => v?.status === 'succeeded' && 'duration_ms' in v },
  ]);
  const s = await setup(t, { retryDelaysMs: [5], wrap: writes.wrap });
  await s.f.database('plugin_state').insert({ plugin_id: ID, state_key: 'fail', value: '1', bytes: 1, updated_at: 0 });
  assert.equal((await s.send('token', '{}', { 'x-gitlab-token': SECRET })).status, 202);
  await settled(s);
  assert.deepEqual(writes.fired, ['update:reject', 'update:lost'], 'both outcome writes failed once');
  assert.deepEqual((await s.seen()).map(x => x.attempt), [1, 2], 'one handler run per attempt: the failed writes ran nothing again');
  const [delivery] = await s.deliveries();
  assert.deepEqual({ status: delivery.status, attempt: delivery.attempt }, { status: 'succeeded', attempt: 2 });
  assert.equal(s.runner.pending, 0, 'nothing is held once the delivery is final');
});

test('a failed write before the handler ran retries the attempt, once, even when the write committed', async t => {
  for (const mode of ['reject', 'lost'] as const) {
    await t.test(mode, async t => {
      const writes = failingWrites([{ method: 'update', mode, when: v => v?.status === 'running' }]);
      const s = await setup(t, { wrap: writes.wrap });
      assert.equal((await s.send('token', '{}', { 'x-gitlab-token': SECRET })).status, 202);
      await settled(s);
      assert.deepEqual(writes.fired, [`update:${mode}`]);
      assert.deepEqual((await s.seen()).map(x => x.attempt), [1], 'the handler ran once, as attempt 1');
      const [delivery] = await s.deliveries();
      assert.deepEqual({ status: delivery.status, attempt: delivery.attempt }, { status: 'succeeded', attempt: 1 });
    });
  }
});

test('a reservation is kept until its release or answer is written: the sender can deliver again', async t => {
  const writes = failingWrites([
    { method: 'delete', mode: 'reject', when: () => true },
    { method: 'update', mode: 'reject', when: v => v?.handler === 'countedChallenge' },
  ]);
  const s = await setup(t, { wrap: writes.wrap });
  const send = (body: string, id: string) => s.send('answered', body, { 'x-gitlab-token': SECRET, 'x-delivery-id': id });

  // Refused while paused, and the reservation's delete fails once: it is retried, so the sender's retry is delivered.
  const installedAt = Number((await s.f.database('plugin_installations').where({ plugin_id: ID }).first('installed_at')).installed_at);
  await s.f.database('plugin_dispatch').insert({ plugin_id: ID, installed_at: installedAt, start_seq: 0, updated_at: NOW, paused_at: NOW }).onConflict('plugin_id').merge(['paused_at']);
  assert.equal((await send('{}', 'p-1')).status, 503);
  await s.runner.idle();
  assert.deepEqual(writes.fired, ['delete:reject']);
  assert.deepEqual(await s.deliveries(), [], 'the release was retried until the record was given back');
  await s.f.database('plugin_dispatch').where({ plugin_id: ID }).update({ paused_at: null });
  assert.equal((await send('{}', 'p-1')).status, 202, 'not a replay');
  await s.runner.idle();

  // The challenge answer fails to record: the request fails, and its reservation is given back rather than left pending.
  const challenge = JSON.stringify({ type: 'url_verification', challenge: 'c-9' });
  await assert.rejects(send(challenge, 'p-2'), /transient database write failure/);
  await s.runner.idle();
  assert.equal((await s.deliveries()).find(d => d.deliveryId === 'whk-answered:p-2'), undefined, 'no unfinished record is left');
  assert.deepEqual(await send(challenge, 'p-2'), { status: 200, contentType: 'text/plain', body: 'c-9' }, 'the sender\'s retry is answered');
  assert.equal((await s.deliveries()).find(d => d.deliveryId === 'whk-answered:p-2')!.status, 'succeeded');
});

test('a challenge answer recorded although its write reported failure is still sent; when that cannot be told, the sender may send it again', async t => {
  const challenge = (id: string) => JSON.stringify({ type: 'url_verification', challenge: `challenge-${id}` });
  const answer = (id: string) => ({ status: 200, contentType: 'text/plain', body: `challenge-${id}` });
  const record = (s: Awaited<ReturnType<typeof setup>>, id: string) => s.deliveries().then(rows => rows.find(d => d.deliveryId === `whk-answered:${id}`));

  await t.test('the answer committed: the original request gets it, and the delivery id stays taken', async t => {
    const writes = failingWrites([{ method: 'update', mode: 'lost', when: v => v?.handler === 'countedChallenge' }]);
    const s = await setup(t, { wrap: writes.wrap });
    const send = (id: string) => s.send('answered', challenge(id), { 'x-gitlab-token': SECRET, 'x-delivery-id': id });
    assert.deepEqual(await send('k-1'), answer('k-1'));
    assert.deepEqual(writes.fired, ['update:lost']);
    await s.runner.idle();
    assert.deepEqual({ status: (await record(s, 'k-1'))?.status, handler: (await record(s, 'k-1'))?.handler }, { status: 'succeeded', handler: 'countedChallenge' });
    assert.equal((await send('k-1')).status, 409, 'its replay is refused');
  });

  await t.test('the answer committed but cannot be read back: 500, and its record is given back for the sender\'s retry', async t => {
    const writes = failingWrites([
      { method: 'update', mode: 'lost', when: v => v?.handler === 'countedChallenge' },
      { method: 'first', mode: 'reject', when: (): boolean => writes.fired.includes('update:lost') },
    ]);
    const s = await setup(t, { wrap: writes.wrap });
    const send = (id: string) => s.send('answered', challenge(id), { 'x-gitlab-token': SECRET, 'x-delivery-id': id });
    await assert.rejects(send('k-2'), /connection reset after commit/, 'the answer is not sent');
    assert.deepEqual(writes.fired, ['update:lost', 'first:reject']);
    await s.runner.idle();
    assert.equal(await record(s, 'k-2'), undefined, 'the committed answer, never sent, is given back');
    assert.deepEqual(await send('k-2'), answer('k-2'), 'the sender\'s retry is answered');
    assert.equal((await record(s, 'k-2'))?.status, 'succeeded');
    assert.equal((await send('k-2')).status, 409);
  });
});

test('a live runner fails its own unfinished records it no longer holds, and leaves the ones it holds', async t => {
  const s = await setup(t, { retryDelaysMs: [60_000] });
  await s.f.database('plugin_state').insert({ plugin_id: ID, state_key: 'fail', value: '1', bytes: 1, updated_at: 0 });
  assert.equal((await s.send('token', '{}', { 'x-gitlab-token': SECRET })).status, 202);
  await s.runner.idle();
  assert.equal((await s.deliveries())[0].status, 'retrying', 'held, waiting for its retry');
  await s.f.database('plugin_deliveries').insert({ plugin_id: ID, delivery_id: 'whk-token/orphaned', kind: 'webhook', repository: '', event_seq: 0, event_type: 'webhook.token', handler: 'flakyWebhook', status: 'running', attempt: 1, created_at: NOW, logs: '[]', webhook_owner: s.runner.owner });
  assert.equal(await s.runner.recover(), 1);
  const rows = await s.deliveries();
  assert.equal(rows.find(d => d.deliveryId === 'whk-token/orphaned')!.status, 'failed', 'the record this runner lost track of is final');
  assert.equal(rows.find(d => d.deliveryId !== 'whk-token/orphaned')!.status, 'retrying', 'the held delivery is untouched');
});

test('a failed delivery can be sent again with its delivery id; a succeeded or unfinished one is still a replay', async t => {
  const s = await setup(t);
  const body = '{"action":"opened"}';
  const headers = (id: string) => ({ 'x-hub-signature-256': hubSignature(body), 'x-github-delivery': id });
  const row = async (id: string) => await s.f.database('plugin_deliveries').where({ plugin_id: ID, delivery_id: `whk-signed:${id}` }).first('id', 'status', 'webhook_owner', 'error') as { id: number; status: string; webhook_owner: string; error: string | null } | undefined;

  // Accepted, then the API process stops before the handler runs: the delivery is failed and its request is gone.
  assert.equal((await s.send('signed', body, headers('d-lost'))).status, 202);
  await s.runner.stop();
  const lost = (await row('d-lost'))!;
  assert.equal(lost.status, 'failed');
  assert.match(lost.error!, /stopped before the delivery finished/);
  assert.equal((await s.seen()).length, 0, 'the handler never ran');

  // The sender redelivers it, with the same delivery id, to the next API process: it is delivered.
  const next = s.api();
  const redelivered = await next.send('signed', body, headers('d-lost'));
  assert.equal(redelivered.status, 202, 'a failed delivery is not a replay');
  assert.deepEqual(JSON.parse(redelivered.body), { accepted: true, deliveryId: 'whk-signed:d-lost' });
  await next.runner.idle();
  assert.deepEqual((await s.seen()).map(x => x.id), ['whk-signed:d-lost'], 'the handler ran once, for the redelivery');
  const delivered = (await row('d-lost'))!;
  assert.deepEqual({ status: delivered.status, owner: delivered.webhook_owner }, { status: 'succeeded', owner: next.runner.owner });
  assert.notEqual(delivered.id, lost.id, 'the failed record was replaced, not reused');
  assert.equal((await s.deliveries()).filter(d => d.deliveryId === 'whk-signed:d-lost').length, 1);
  assert.equal((await next.send('signed', body, headers('d-lost'))).status, 409, 'once delivered, it is a replay again');

  // Unfinished or succeeded deliveries, in this process or another, are still replays; only a failed one is replaced.
  for (const status of ['pending', 'running', 'retrying', 'succeeded', 'failed'] as const) {
    await s.f.database('plugin_deliveries').insert({ plugin_id: ID, delivery_id: `whk-signed:d-${status}`, kind: 'webhook', repository: '', event_seq: 0, event_type: 'webhook.signed', handler: 'onWebhook', status, attempt: 1, created_at: NOW, logs: '[]', webhook_owner: next.runner.owner });
  }
  for (const status of ['pending', 'running', 'retrying', 'succeeded'] as const) {
    assert.equal((await next.send('signed', body, headers(`d-${status}`))).status, 409, `a ${status} delivery is a replay`);
    assert.equal((await row(`d-${status}`))!.status, status, `the ${status} record is untouched`);
  }
  // Two redeliveries of one failed delivery at once: one is delivered, the other is its replay.
  const both = await Promise.all([next.send('signed', body, headers('d-failed')), next.send('signed', body, headers('d-failed'))]);
  assert.deepEqual(both.map(r => r.status).sort(), [202, 409]);
  await next.runner.idle();
  assert.equal((await s.seen()).filter(x => x.id === 'whk-signed:d-failed').length, 1);
  assert.equal((await row('d-failed'))!.status, 'succeeded');
});

test('a runner still holding a failed delivery writes nothing to its redelivery', async t => {
  const s = await setup(t);
  const body = '{}';
  const target = (await resolvePluginWebhook(s.f.database, s.key, 'signed', [s.f.manifest]))!.target;
  const job = { target, handler: 'onWebhook', deliveryId: 'whk-signed:d-stale', input: { kind: 'webhook' as const, webhook: 'signed', headers: {}, body, receivedAt: NOW } };
  // A reserved the delivery; another process failed it (A's heartbeat had lapsed) before A started it.
  const reserved = await s.runner.reserve({ ...job, webhook: 'signed' });
  assert.ok(reserved.accepted);
  await s.f.database('plugin_deliveries').where({ id: reserved.recordId }).update({ status: 'failed', finished_at: NOW });
  const next = s.api();
  assert.equal((await next.send('signed', body, { 'x-hub-signature-256': hubSignature(body), 'x-github-delivery': 'd-stale' })).status, 202);
  await next.runner.idle();
  // A goes on with the record it held: it is gone, so A drops it and runs nothing.
  assert.equal(await s.runner.start(reserved.recordId, job), true);
  await s.runner.idle();
  assert.equal(s.runner.pending, 0);
  assert.deepEqual((await s.seen()).map(x => x.id), ['whk-signed:d-stale'], 'the handler ran once, in the process that accepted the redelivery');
  const rows = await s.f.database('plugin_deliveries').where({ plugin_id: ID, delivery_id: 'whk-signed:d-stale' }).select('status', 'webhook_owner', 'attempt');
  assert.deepEqual(rows.map(r => ({ status: r.status, owner: r.webhook_owner, attempt: Number(r.attempt) })), [{ status: 'succeeded', owner: next.runner.owner, attempt: 1 }]);
});

test('a credential or verification header is never taken as the sender\'s delivery id', () => {
  const webhook = (deliveryIdHeader: string, verification: PluginWebhookVerification = { scheme: 'token-header', header: 'x-hook-token', connection: 'secret' }) =>
    ({ name: 'hook', description: 'Hook', handler: 'run', verification, deliveryIdHeader });
  const headers = { authorization: 'Bearer secret-credential', 'proxy-authorization': 'Basic c2VjcmV0', 'x-hook-token': 'secret-token', 'x-delivery': 'd-1' };
  // Refused by the manifest schema; also never read at run time, so a stored value can never be a credential.
  assert.equal(senderDeliveryId(headers, webhook('authorization')), undefined);
  assert.equal(senderDeliveryId(headers, webhook('proxy-authorization')), undefined);
  assert.equal(senderDeliveryId(headers, webhook('x-hook-token')), undefined);
  assert.equal(senderDeliveryId(headers, webhook('x-delivery')), 'd-1');
});

test('a compressed body is verified over the bytes as sent, then decoded (bounded) before its delivery id is taken or plugin code runs', async t => {
  const s = await setup(t);
  const text = '{"action":"opened","padding":"' + 'p'.repeat(2_000) + '"}';
  const gzipped = gzipSync(text);
  const receive = (body: Buffer, headers: IncomingHttpHeaders, name = 'signed') => s.receiver.receive({ key: s.key, name, headers, body });
  const sign = (bytes: Buffer) => `sha256=${createHmac('sha256', SECRET).update(bytes).digest('hex')}`;

  const accepted = await receive(gzipped, { 'content-encoding': 'gzip', 'content-type': 'application/json', 'x-hub-signature-256': sign(gzipped), 'x-github-delivery': 'z-1' });
  assert.equal(accepted.status, 202, 'a signature over the gzip bytes as sent verifies');
  await s.runner.idle();
  assert.deepEqual((await s.seen()).map(e => [e.id, e.bodyBytes, e.headers]), [['whk-signed:z-1', Buffer.byteLength(text), ['content-type', 'x-github-delivery']]],
    'the handler gets the decoded body, without the Content-Encoding that described the sent bytes');
  const overDecoded = await receive(gzipped, { 'content-encoding': 'gzip', 'x-hub-signature-256': sign(Buffer.from(text)), 'x-github-delivery': 'z-2' });
  assert.equal(overDecoded.status, 401, 'a signature over the decoded bytes is not the one the sender made');

  const loadsBefore = s.loads.length;
  const bomb = gzipSync(Buffer.alloc(256 * 1024 + 1, 'a'));
  assert.ok(bomb.length < 2_000, 'small as sent');
  const tooLarge = await receive(bomb, { 'content-encoding': 'gzip', 'x-hub-signature-256': sign(bomb), 'x-github-delivery': 'z-3' });
  assert.equal(tooLarge.status, 413, 'decoded beyond the body limit');
  const corrupt = gzipped.subarray(0, 20);
  assert.equal((await receive(corrupt, { 'content-encoding': 'gzip', 'x-hub-signature-256': sign(corrupt), 'x-github-delivery': 'z-4' })).status, 400);
  assert.equal((await receive(gzipped, { 'content-encoding': 'compress', 'x-hub-signature-256': sign(gzipped), 'x-github-delivery': 'z-5' })).status, 415);
  assert.equal((await receive(gzipped, { 'content-encoding': 'gzip, gzip', 'x-hub-signature-256': sign(gzipped), 'x-github-delivery': 'z-6' })).status, 415, 'one encoding only');
  assert.equal(s.loads.length, loadsBefore, 'no plugin module was loaded for an undecodable body');
  assert.equal((await s.deliveries()).length, 1, 'an undecodable body takes no delivery id');
  assert.equal(await s.rejected(), 1, 'only the bad signature counts as unverified');
  const plain = Buffer.from(text);
  assert.equal((await receive(plain, { 'x-hub-signature-256': sign(plain), 'x-github-delivery': 'z-3' })).status, 202, 'the refused delivery id can be sent again');

  // Slack signs the transmitted bytes too; deflate and br decode as gzip does.
  const challenge = deflateSync(JSON.stringify({ type: 'url_verification', challenge: 'zipped-challenge' }));
  const timestamp = String(Math.floor(NOW / 1000));
  const slack = await receive(challenge, { 'content-encoding': 'deflate', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${timestamp}:`).update(challenge).digest('hex')}` }, 'slack');
  assert.deepEqual([slack.status, slack.body], [200, 'zipped-challenge']);
  assert.deepEqual(await decodePluginWebhookBody(brotliCompressSync(text), { 'content-encoding': 'BR' }), { ok: true, body: Buffer.from(text) });
  assert.deepEqual(await decodePluginWebhookBody(plain, { 'content-encoding': 'identity' }), { ok: true, body: plain });
});
