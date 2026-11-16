import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  PLUGIN_CONNECTION_URL, PluginDeliveryError, PluginSdkError, parsePluginManifest, pluginSecretUrlProblem, validatePluginSettings,
  type PluginHandler, type PluginEventInput, type PluginSettingValues, type RepositoryEvent,
} from '@propr/shared';
import { PLUGINS_ROOT, getOfficialPlugin, loadPluginHandlers } from '../src/index.js';
import { createTestPluginContext, type ScriptedHttpResponse } from '../testing/index.js';
import { NOTIFICATION_KINDS, NOTIFICATION_SUBSCRIPTIONS, buildNotification, notificationKind } from '../_shared/notifications.js';
import { resolveDestination } from '../_shared/chatDelivery.js';
import { CHAT_FIXTURE_EVENTS, CHAT_FIXTURE_SETTINGS, eventInput } from './fixtures/chatEvents.js';

/**
 * The Slack (incoming webhook), Discord and Microsoft Teams notification
 * plugins, each against hand-written fixtures of its service's payload
 * format (`<plugin>/fixtures/messages.json`) and error responses
 * (`<plugin>/fixtures/responses.json`).
 */

interface ResponseFixture { status: number; headers?: Record<string, string>; body: string; detail?: string }
interface Responses { accepted: ResponseFixture; rateLimited: ResponseFixture; rateLimitedBodyOnly?: ResponseFixture; permanent: ResponseFixture[] }

const PLUGINS = {
  slack: {
    service: 'Slack',
    urls: ['https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa', 'https://hooks.slack.com/services/T0001/B0002/bbbbbbbbbbbbbbbbbbbbbbbb',
      'https://hooks.slack.com/services/T0001/B0003/cccccccccccccccccccccccc', 'https://hooks.slack.com/services/T0001/B0004/dddddddddddddddddddddddd'],
    elsewhere: ['https://hooks.example.com/services/T/B/x', 'https://hooks.slack.com/workflows/x', 'http://hooks.slack.com/services/T/B/x'],
  },
  discord: {
    service: 'Discord',
    urls: ['https://discord.com/api/webhooks/1111/tok-aaaaaaaaaaaaaaaa', 'https://discord.com/api/webhooks/2222/tok-bbbbbbbbbbbbbbbb',
      'https://discordapp.com/api/webhooks/3333/tok-cccccccccccccccc', 'https://discord.com/api/v10/webhooks/4444/tok-dddddddddddddddd'],
    elsewhere: ['https://discord.example.com/api/webhooks/1/x', 'https://discord.com/api/v10/channels/1/messages', 'https://evil-discord.com/api/webhooks/1/x'],
  },
  teams: {
    service: 'Teams',
    urls: [
      'https://default0123456789abcdef0123456789ab.cd.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/aaaa/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=sig-aaaaaaaaaaaa',
      'https://default0123456789abcdef0123456789ab.cd.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/bbbb/triggers/manual/paths/invoke?api-version=1&sig=sig-bbbbbbbbbbbb',
      'https://prod-12.westus.logic.azure.com:443/workflows/cccc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=sig-cccccccccccc',
      'https://prod-34.westeurope.logic.azure.com/workflows/dddd/triggers/manual/paths/invoke?api-version=2016-06-01&sig=sig-dddddddddddd',
    ],
    elsewhere: ['https://contoso.webhook.office.com/webhookb2/x', 'https://environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x', 'https://logic.azure.com.example.com/workflows/x'],
  },
} as const;
type PluginId = keyof typeof PLUGINS;
const IDS = Object.keys(PLUGINS) as PluginId[];
const DESTINATIONS = ['default-webhook', 'webhook-2', 'webhook-3', 'webhook-4'] as const;

const fixture = <T>(id: PluginId, file: string): T => JSON.parse(readFileSync(path.join(PLUGINS_ROOT, id, 'fixtures', file), 'utf8')) as T;
const plugin = (id: PluginId) => getOfficialPlugin(id, { includeDevelopment: false })!;

/** Settings as the Plugins page saves them, validated against the manifest, with its defaults. */
function settings(id: PluginId, values: PluginSettingValues = {}): PluginSettingValues {
  const { manifest } = plugin(id);
  const result = validatePluginSettings(manifest.settings, { ...CHAT_FIXTURE_SETTINGS, ...values });
  assert.ok(result.ok, JSON.stringify(result));
  return { ...Object.fromEntries(Object.entries(manifest.settings.properties).flatMap(([key, s]) => (s.default !== undefined ? [[key, s.default]] : []))), ...result.settings } as PluginSettingValues;
}

async function kit(id: PluginId, values: PluginSettingValues = {}, secrets: Record<string, string> = Object.fromEntries(DESTINATIONS.map((name, i) => [name, PLUGINS[id].urls[i]]))) {
  const { manifest } = plugin(id);
  const k = createTestPluginContext({
    pluginId: id, settings: settings(id, values), grantedPermissions: manifest.permissions, outboundHosts: manifest.outboundHosts,
    connections: manifest.connections.map(c => c.name), connectionDefinitions: manifest.connections, secrets,
  });
  const accepted = fixture<Responses>(id, 'responses.json').accepted;
  k.respond(() => true, { status: accepted.status, headers: accepted.headers, body: accepted.body });
  const handlers = await loadPluginHandlers(id, { includeDevelopment: false });
  return { ...k, notify: handlers.notify as PluginHandler<PluginEventInput> };
}

const scripted = (r: ResponseFixture): ScriptedHttpResponse => ({ status: r.status, headers: r.headers, body: r.body });
const deliveryError = (check: (error: PluginDeliveryError) => void) => (error: unknown) => {
  assert.ok(error instanceof PluginDeliveryError, String(error));
  check(error);
  return true;
};

for (const id of IDS) {
  const { service } = PLUGINS[id];

  test(`${id}: the manifest is valid, posts through webhook URL connections on the vendor's hosts and subscribes the notification events`, () => {
    const parsed = parsePluginManifest(JSON.parse(readFileSync(path.join(PLUGINS_ROOT, id, 'manifest.json'), 'utf8')));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    const { manifest, development } = plugin(id);
    assert.equal(development, false);
    assert.equal(manifest.category, 'messaging');
    assert.deepEqual(manifest.permissions, ['events.read']);
    assert.deepEqual(manifest.outboundHosts, [], 'the only hosts are those of the webhook URLs');
    assert.deepEqual(manifest.connections.map(c => [c.name, c.type]), DESTINATIONS.map(name => [name, 'token']));
    for (const connection of manifest.connections) assert.ok(connection.type === 'token' && connection.secretUrl, `${connection.name} is a secret URL connection`);
    assert.deepEqual(manifest.contributes.subscriptions.map(s => s.on), [...NOTIFICATION_SUBSCRIPTIONS]);
    assert.ok(manifest.contributes.subscriptions.every(s => s.handler === 'notify'));
    const events = manifest.settings.properties.events;
    assert.ok(events.type === 'array');
    assert.deepEqual(events.items.enum, [...NOTIFICATION_KINDS]);
    assert.deepEqual(events.default, [...NOTIFICATION_KINDS]);
    assert.equal(manifest.settings.properties.repositoryDestinations.type, 'object');
  });

  test(`${id}: webhook URLs are accepted only on the vendor's documented webhook host and path`, () => {
    const [connection] = plugin(id).manifest.connections;
    assert.ok(connection.type === 'token' && connection.secretUrl);
    for (const url of PLUGINS[id].urls) assert.equal(pluginSecretUrlProblem(connection.secretUrl, url), null, url);
    for (const url of PLUGINS[id].elsewhere) {
      const problem = pluginSecretUrlProblem(connection.secretUrl, url);
      assert.ok(problem, url);
      assert.equal(problem.includes(new URL(url).pathname.slice(1, 12)) && new URL(url).pathname.length > 12, false, 'the refusal does not repeat the secret path');
    }
  });

  test(`${id}: every selected event produces the expected request; unselected events produce none`, async () => {
    const messages = fixture<Record<string, unknown>>(id, 'messages.json');
    assert.deepEqual(Object.keys(messages), [...NOTIFICATION_KINDS], 'one fixture message per notification kind');
    const k = await kit(id);
    for (const kind of NOTIFICATION_KINDS) {
      const before = k.requests.length;
      const result = await k.notify(eventInput(CHAT_FIXTURE_EVENTS[kind]), k.ctx);
      const sent = k.requests.slice(before);
      assert.equal(sent.length, 1, kind);
      const [request] = sent;
      assert.equal(request.url, PLUGINS[id].urls[0], `${kind} goes to the default webhook URL`);
      assert.equal(request.connection, 'default-webhook');
      assert.equal(request.init.method, 'POST');
      assert.equal(request.init.headers!['content-type'], 'application/json');
      assert.equal(request.init.headers!.authorization, undefined);
      assert.deepEqual(JSON.parse(request.init.body!), messages[kind], `${kind} matches ${id}/fixtures/messages.json`);
      assert.deepEqual(result, { event: `${CHAT_FIXTURE_EVENTS[kind].domain}.${CHAT_FIXTURE_EVENTS[kind].type}`, kind, destination: 'default-webhook', skipped: null });
    }

    // Each kind alone selected: only events of that kind are posted.
    for (const kind of NOTIFICATION_KINDS) {
      const only = await kit(id, { events: [kind] });
      for (const other of NOTIFICATION_KINDS) await only.notify(eventInput(CHAT_FIXTURE_EVENTS[other]), only.ctx);
      assert.equal(only.requests.length, 1, kind);
      assert.deepEqual(JSON.parse(only.requests[0].init.body!), messages[kind]);
    }
    const quiet = await kit(id, { events: [] });
    for (const kind of NOTIFICATION_KINDS) {
      assert.deepEqual(await quiet.notify(eventInput(CHAT_FIXTURE_EVENTS[kind]), quiet.ctx), { event: `${CHAT_FIXTURE_EVENTS[kind].domain}.${CHAT_FIXTURE_EVENTS[kind].type}`, kind: null, destination: null, skipped: 'not_selected' });
    }
    assert.equal(quiet.requests.length, 0);
    // A journal event the plugins do not cover (task.completed) posts nothing, even if delivered.
    const unsubscribed = { ...CHAT_FIXTURE_EVENTS['task.failed'], type: 'completed' };
    assert.equal((await k.notify(eventInput(unsubscribed), k.ctx) as { skipped: string }).skipped, 'not_selected');
  });

  test(`${id}: per-repository destinations send a repository's events to its webhook, or nowhere`, async () => {
    const k = await kit(id, { repositoryDestinations: { 'acme/web': 'webhook-2', 'Acme/Docs': 'webhook-4', 'acme/sandbox': 'none' } });
    const merged = (repository: string): RepositoryEvent => ({ ...CHAT_FIXTURE_EVENTS['pull_request.merged'], repository });
    const sentTo = async (repository: string) => {
      const before = k.requests.length;
      const result = await k.notify(eventInput(merged(repository)), k.ctx) as { destination: string | null; skipped: string | null };
      return { urls: k.requests.slice(before).map(r => r.url), result };
    };
    assert.deepEqual((await sentTo('acme/api')).urls, [PLUGINS[id].urls[0]], 'an unlisted repository uses the default webhook');
    assert.deepEqual((await sentTo('acme/web')).urls, [PLUGINS[id].urls[1]]);
    assert.deepEqual((await sentTo('acme/docs')).urls, [PLUGINS[id].urls[3]], 'repositories compare without letter case');
    const muted = await sentTo('acme/sandbox');
    assert.deepEqual(muted.urls, []);
    assert.equal(muted.result.skipped, 'muted');
    // The links follow the event's repository.
    assert.match(k.requests.at(-1)!.init.body!, /github\.com\/acme\/docs\/pull\/12/);

    // A map naming no destination fails the delivery with a readable message.
    const typo = await kit(id, { repositoryDestinations: { 'acme/api': 'webhook-9' } });
    await assert.rejects(typo.notify(eventInput(merged('acme/api')), typo.ctx), deliveryError(error => {
      assert.equal(error.permanent, true);
      assert.equal(error.message, 'Repository destinations map acme/api to webhook-9, which is not one of default-webhook, webhook-2, webhook-3, webhook-4, none. Fix the plugin\'s settings');
    }));
    assert.equal(typo.requests.length, 0);
    assert.deepEqual(resolveDestination({ destinations: [{ connection: 'default-webhook', label: 'd' }] }, { repositoryDestinations: { 'acme/api': '' } }, 'acme/api'), { destination: { connection: 'default-webhook', label: 'd' } });
  });

  test(`${id}: a 429 with Retry-After is retried after the delay`, async () => {
    const responses = fixture<Responses>(id, 'responses.json');
    const k = await kit(id);
    k.respond(() => true, scripted(responses.rateLimited));
    const input = eventInput(CHAT_FIXTURE_EVENTS['pull_request.merged']);
    const delay = Number(responses.rateLimited.headers!['retry-after']);
    await assert.rejects(k.notify(input, k.ctx), deliveryError(error => {
      assert.equal(error.permanent, false);
      assert.equal(error.retryAfterMs, delay * 1000);
      assert.match(error.message, new RegExp(`^${service} answered HTTP 429.* for the default webhook; it asked to retry after ${delay} s$`));
    }));
    // The dispatcher's next attempt, after the delay: the service accepts it.
    const accepted = responses.accepted;
    k.respond(() => true, scripted(accepted));
    const result = await k.notify({ ...input, attempt: 2 }, k.ctx);
    assert.equal((result as { destination: string }).destination, 'default-webhook');
    assert.equal(k.requests.length, 2);
    assert.equal(k.requests[0].init.body, k.requests[1].init.body, 'the same message on the retry');

    if (responses.rateLimitedBodyOnly) {
      // Discord also gives the delay in the body (`retry_after`, in seconds).
      k.respond(() => true, scripted(responses.rateLimitedBodyOnly));
      await assert.rejects(k.notify(input, k.ctx), deliveryError(error => assert.equal(error.retryAfterMs, 4250)));
    }
    // A server error without Retry-After is retried on the dispatcher's schedule.
    k.respond(() => true, { status: 503 });
    await assert.rejects(k.notify(input, k.ctx), deliveryError(error => { assert.equal(error.permanent, false); assert.equal(error.retryAfterMs, undefined); }));
  });

  test(`${id}: a permanent error marks the delivery failed with a readable message`, async () => {
    const responses = fixture<Responses>(id, 'responses.json');
    for (const refusal of responses.permanent) {
      const k = await kit(id);
      k.respond(() => true, scripted(refusal));
      await assert.rejects(k.notify(eventInput(CHAT_FIXTURE_EVENTS['task.failed']), k.ctx), deliveryError(error => {
        assert.equal(error.permanent, true);
        assert.equal(error.message, `${service} refused the message to the default webhook with HTTP ${refusal.status} (${refusal.detail}); it is not retried. Check its webhook URL and that the channel still exists`);
      }));
    }
    // An unset webhook URL, or one the connection's hosts do not take.
    const unset = await kit(id, {}, {});
    await assert.rejects(unset.notify(eventInput(CHAT_FIXTURE_EVENTS['task.failed']), unset.ctx), deliveryError(error => {
      assert.equal(error.permanent, true);
      assert.equal(error.message, `The ${service} webhook URL of the default webhook is not set. Set it under Connections`);
    }));
    const wrongHost = await kit(id, {}, { 'default-webhook': PLUGINS[id].elsewhere[0] });
    await assert.rejects(wrongHost.notify(eventInput(CHAT_FIXTURE_EVENTS['task.failed']), wrongHost.ctx), deliveryError(error => {
      assert.equal(error.permanent, true);
      assert.match(error.message, new RegExp(`^The message was not sent to the default webhook: The stored URL is not allowed: .*Check its ${service} webhook URL$`));
      assert.equal(error.message.includes(PLUGINS[id].elsewhere[0]), false);
    }));
    assert.equal(unset.requests.length + wrongHost.requests.length, 0);
    // A network failure is retried.
    const down = await kit(id);
    down.respond(() => true, () => { throw new PluginSdkError('http_failed', 'Request failed'); });
    await assert.rejects(down.notify(eventInput(CHAT_FIXTURE_EVENTS['task.failed']), down.ctx), deliveryError(error => assert.equal(error.permanent, false)));
  });

  test(`${id}: no message contains code, logs, prompt text, tool output or credentials`, async () => {
    const SENTINEL = 'SENTINEL-c0de-l0g-pr0mpt';
    const prose = `Traceback (most recent call last): ${SENTINEL} diff --git a/x b/x`;
    const leaky = {
      body: SENTINEL, title: SENTINEL, prompt: `${SENTINEL} prompt`, logs: [SENTINEL], diff: `+${SENTINEL}`, toolOutput: { stdout: SENTINEL }, code: `const x = '${SENTINEL}'`,
      token: `ghp_${SENTINEL}`, reason: prose, blockedReason: prose, terminalReason: prose, failureCategory: prose, model: prose, agent: prose, kind: prose,
      reviewerModel: prose, source: prose, outcome: prose, baseRef: prose, taskId: prose, score: SENTINEL, goal: SENTINEL, attempts: SENTINEL, durationMs: SENTINEL,
      headIssue: SENTINEL, cycle: SENTINEL, finalScore: SENTINEL, nested: { secret: SENTINEL },
    };
    const secretUrls = PLUGINS[id].urls.map(url => url.replace(/[a-d]{12,}|tok-[a-d]+|sig-[a-d]+/, match => `${match}${SENTINEL}`));
    const k = await kit(id, { reviewThreshold: 50 }, Object.fromEntries(DESTINATIONS.map((name, i) => [name, secretUrls[i]])));
    const results: unknown[] = [];
    for (const kind of NOTIFICATION_KINDS) {
      const event = { ...CHAT_FIXTURE_EVENTS[kind], payload: kind.startsWith('review') ? { ...leaky, score: kind === 'review.below_threshold' ? 10 : 90 } : leaky, entityId: kind === 'task.failed' ? prose : CHAT_FIXTURE_EVENTS[kind].entityId };
      results.push(await k.notify(eventInput(event), k.ctx));
    }
    assert.equal(k.requests.length, NOTIFICATION_KINDS.length, 'every event was still posted');
    for (const request of k.requests) {
      const sent = JSON.stringify({ headers: request.init.headers, body: request.init.body });
      assert.equal(sent.includes(SENTINEL), false, sent);
      for (const word of ['Traceback', 'ghp_', 'diff --git', 'prompt', 'hooks.slack.com/services', 'api/webhooks', 'sig=']) assert.equal(sent.includes(word), false, `${word} in ${sent}`);
    }
    assert.equal(JSON.stringify({ logs: k.logs, results }).includes(SENTINEL), false, 'nor the log lines or results');
    // A failure message names the destination, never its URL.
    k.respond(() => true, { status: 404, body: 'no_service' });
    await assert.rejects(k.notify(eventInput(CHAT_FIXTURE_EVENTS['pull_request.merged']), k.ctx), deliveryError(error => assert.equal(error.message.includes(SENTINEL), false)));
  });
}

test('the shared formatting compares a review with the threshold setting, else the review goal, else 80', () => {
  const review = (score: number, goal: number | null): RepositoryEvent => ({ ...CHAT_FIXTURE_EVENTS['review.below_threshold'], payload: { score, goal } });
  assert.equal(notificationKind({}, review(85, 90)), 'review.below_threshold');
  assert.equal(notificationKind({}, review(90, 90)), 'review.at_or_above_threshold', 'at the threshold is at or above it');
  assert.equal(notificationKind({ reviewThreshold: 85 }, review(85, 90)), 'review.at_or_above_threshold');
  assert.equal(notificationKind({}, review(79, null)), 'review.below_threshold');
  assert.equal(notificationKind({}, review(80, null)), 'review.at_or_above_threshold');
  assert.equal(notificationKind({}, { ...review(1, 1), payload: { score: 'high' } }), null, 'a review without a numeric score is not posted');
  // Without a ProPR address, or with an unacceptable one, messages carry only GitHub links.
  const task = CHAT_FIXTURE_EVENTS['task.failed'];
  const links = (proprUrl?: string) => buildNotification(task, { events: ['task.failed'], ...(proprUrl === undefined ? {} : { proprUrl }) })!.links.map(l => l.url);
  assert.deepEqual(links(), ['https://github.com/acme/api/issues/9']);
  assert.deepEqual(links('https://user:pass@propr.example.com'), ['https://github.com/acme/api/issues/9']);
  assert.deepEqual(links('javascript:alert(1)'), ['https://github.com/acme/api/issues/9']);
  assert.deepEqual(links('http://propr.internal:8080/app/'), ['https://github.com/acme/api/issues/9', 'http://propr.internal:8080/app/tasks/task-42']);
  // A handler passing any URL other than the placeholder through a webhook URL connection is refused.
  const { manifest } = getOfficialPlugin('slack', { includeDevelopment: false })!;
  const k = createTestPluginContext({ connectionDefinitions: manifest.connections, secrets: { 'default-webhook': PLUGINS.slack.urls[0] } });
  return assert.rejects(k.ctx.http('default-webhook')('https://hooks.slack.com/services/T/B/x', { method: 'POST', body: '{}' }), (error: unknown) => error instanceof PluginSdkError && error.code === 'invalid_input'
    && error.message.includes(PLUGIN_CONNECTION_URL));
});
