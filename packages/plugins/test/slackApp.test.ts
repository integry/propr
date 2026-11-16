import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  PluginDeliveryError, PluginSdkError, validatePluginSettings,
  type PluginEventInput, type PluginHandler, type PluginJsonValue, type PluginSettingValues, type PluginWebhookInput, type PluginWebhookResponder, type RepositoryEvent,
} from '@propr/shared';
import { PLUGINS_ROOT, getOfficialPlugin, loadPluginHandlers } from '../src/index.js';
import { createTestPluginContext, type ScriptedHttpResponse } from '../testing/index.js';
import { NOTIFICATION_KINDS } from '../_shared/notifications.js';
import { issueTitle, quotedRequest, slackPlainText } from '../slack/mentions.js';
import { MAX_THREADS, findThread, rememberThread } from '../slack/threads.js';
import { CHAT_FIXTURE_EVENTS, CHAT_FIXTURE_SETTINGS, eventInput } from './fixtures/chatEvents.js';

/**
 * Slack app mode: the Events API webhook (mentions create issues), thread
 * mapping in `ctx.state` and posting with the bot token. Requests are the
 * signed fixtures of `slack/fixtures/events.json`; Slack's Web API answers
 * come from `slack/fixtures/webApi.json`. Signature verification itself runs
 * in ProPR before the handler (packages/core/test/slackPluginEvents.test.ts).
 */

interface SignedRequest { timestamp: string; signature: string; body: string; retryHeaders?: Record<string, string> }
const fixture = <T>(file: string): T => JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'slack', 'fixtures', file), 'utf8')) as T;
const EVENTS = fixture<{ botUserId: string; receivedAt: number; requests: Record<string, SignedRequest> }>('events.json');
type Answer = ScriptedHttpResponse & { json?: PluginJsonValue };
const WEB = fixture<{ postMessage: Answer; permalink: Answer; userGroup: Answer; rateLimited: Answer; threadNotFound: Answer; permanent: Answer[]; transient: Answer }>('webApi.json');

const MENTION_TS = '1763301599.000100';
const APP_SETTINGS: PluginSettingValues = {
  mode: 'app', repositoryChannels: { 'acme/api': 'C0APICHAN', 'acme/web': 'c0webchan' }, allowedUsers: ['U0ALLOWED'], allowedUserGroup: 'S0ADMINS', triggerLabel: 'AI',
};

const plugin = () => getOfficialPlugin('slack', { includeDevelopment: false })!;
function settings(values: PluginSettingValues): PluginSettingValues {
  const { manifest } = plugin();
  const result = validatePluginSettings(manifest.settings, { ...CHAT_FIXTURE_SETTINGS, ...values });
  assert.ok(result.ok, JSON.stringify(result));
  return { ...Object.fromEntries(Object.entries(manifest.settings.properties).flatMap(([key, s]) => (s.default !== undefined ? [[key, s.default]] : []))), ...result.settings } as PluginSettingValues;
}

type KitOptions = { state?: Record<string, PluginJsonValue>; createIssue?: (repository: string) => { repository: string; number: number; url: string }; connections?: string[] };
async function kit(values: PluginSettingValues = APP_SETTINGS, options: KitOptions = {}) {
  const { manifest } = plugin();
  let issues = 100;
  const k = createTestPluginContext({
    pluginId: 'slack', settings: settings(values), grantedPermissions: manifest.permissions, outboundHosts: manifest.outboundHosts,
    connections: options.connections ?? manifest.connections.map(c => c.name), connectionDefinitions: manifest.connections,
    secrets: { 'default-webhook': 'https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa' }, state: options.state,
    propr: { createIssue: options.createIssue ?? (repository => { issues += 1; return { repository, number: issues, url: `https://github.com/${repository}/issues/${issues}` }; }) },
  });
  let posts = 0;
  k.respond('https://slack.com/api/chat.postMessage', () => { posts += 1; return { ...WEB.postMessage, json: { ...(WEB.postMessage.json as object), ts: `1763302400.00${1000 + posts}` } }; });
  k.respond('https://slack.com/api/chat.getPermalink', WEB.permalink);
  k.respond('https://slack.com/api/usergroups.users.list', WEB.userGroup);
  k.respond('https://hooks.slack.com/', { status: 200, body: 'ok' });
  const handlers = await loadPluginHandlers('slack', { includeDevelopment: false });
  const posted = () => k.requests.filter(r => r.url === 'https://slack.com/api/chat.postMessage').map(r => r.init.json as Record<string, PluginJsonValue>);
  return {
    ...k, posted,
    notify: handlers!.notify as PluginHandler<PluginEventInput>,
    onSlackEvent: handlers!.onSlackEvent as PluginHandler<PluginWebhookInput>,
    slackChallenge: handlers!.slackChallenge as unknown as PluginWebhookResponder,
    issues: () => k.calls.filter(c => c.operation === 'createIssue'),
  };
}

let deliveries = 0;
const webhookInput = (name: string, attempt = 1, deliveryId = `wh-${(deliveries += 1)}`): PluginWebhookInput => {
  const request = EVENTS.requests[name];
  return { kind: 'webhook', webhook: 'events', headers: { 'content-type': 'application/json', ...request.retryHeaders }, body: request.body, receivedAt: EVENTS.receivedAt, deliveryId, attempt };
};
const deliveryError = (check: (error: PluginDeliveryError) => void) => (error: unknown) => {
  assert.ok(error instanceof PluginDeliveryError, String(error));
  check(error);
  return true;
};

test('the manifest adds the app mode: the Events API webhook verified with slack-v0, a bot token for slack.com and issue creation', async () => {
  const { manifest } = plugin();
  assert.deepEqual(manifest.contributes.webhooks, [{
    name: 'events', description: manifest.contributes.webhooks[0].description, handler: 'onSlackEvent', respond: 'slackChallenge',
    verification: { scheme: 'slack-v0', connection: 'signing-secret' },
  }]);
  assert.deepEqual(manifest.connections.filter(c => !c.name.startsWith('webhook') && c.name !== 'default-webhook').map(c => [c.name, c.type]), [['bot-token', 'token'], ['signing-secret', 'signing_secret']]);
  assert.deepEqual(manifest.outboundHosts, ['slack.com']);
  assert.deepEqual(manifest.permissions, ['events.read', 'issues.create']);
  const mode = manifest.settings.properties.mode;
  assert.ok(mode.type === 'string');
  assert.deepEqual([mode.enum, mode.default], [['incoming-webhook', 'app'], 'incoming-webhook'], 'incoming-webhook stays the default mode');
  assert.deepEqual(Object.keys((await loadPluginHandlers('slack', { includeDevelopment: false }))!), ['notify', 'onSlackEvent', 'slackChallenge']);
});

test('the URL verification challenge is answered at once; other requests go to the handler', async () => {
  const k = await kit();
  const request = (name: string) => ({ webhook: 'events', headers: {}, body: EVENTS.requests[name].body, receivedAt: EVENTS.receivedAt });
  assert.deepEqual(k.slackChallenge(request('urlVerification')), { contentType: 'text/plain', body: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
  assert.equal(k.slackChallenge(request('mention')), null);
  assert.equal(k.slackChallenge({ ...request('mention'), body: 'not json' }), null);
  assert.equal(k.slackChallenge({ ...request('mention'), body: JSON.stringify({ type: 'url_verification', challenge: '<script>alert(1)</script>' }) }), null, 'only a token-shaped challenge is echoed');
  // Delivered to the handler anyway, the challenge creates nothing.
  assert.deepEqual(await k.onSlackEvent(webhookInput('urlVerification'), k.ctx), { outcome: 'ignored', reason: 'not_an_event', repository: null, issue: null });
  assert.equal(k.requests.length + k.calls.length, 0);
});

test('a mention from an allowed user in a mapped channel creates one issue with the trigger label and replies in the thread; retries create no second issue', async () => {
  const k = await kit();
  const first = await k.onSlackEvent(webhookInput('mention'), k.ctx);
  assert.deepEqual(first, { outcome: 'created', reason: null, repository: 'acme/api', issue: 101 });
  assert.equal(k.issues().length, 1);
  const [repository, issue] = k.issues()[0].args as [string, { title: string; body: string; labels: string[] }];
  assert.equal(repository, 'acme/api');
  assert.deepEqual(issue, {
    title: 'Fix the redirect after login',
    body: [
      'Requested in Slack by mentioning the ProPR bot. The request, as written:',
      '',
      '> Fix the redirect after login',
      '> Users land on /home instead of the page they asked for.',
      '',
      '[The Slack message](https://acme.slack.com/archives/C0APICHAN/p1763301599000100)',
      '',
      '_Created by the ProPR Slack plugin. The repository comes from the Slack channel and the label from the plugin\'s settings; the request text chooses neither, nor the model._',
    ].join('\n'),
    labels: ['AI'],
  });
  const replies = k.posted();
  assert.equal(replies.length, 1);
  assert.deepEqual({ ...replies[0], text: undefined }, { channel: 'C0APICHAN', text: undefined, thread_ts: MENTION_TS, unfurl_links: false, unfurl_media: false });
  assert.equal(replies[0].text, ':memo: Created issue <https://github.com/acme/api/issues/101|acme/api#101> with the `AI` label; ProPR starts a task for it. Updates about its pull request will follow in this thread.');
  assert.ok(k.requests.every(r => r.connection === 'bot-token' && r.url.startsWith('https://slack.com/api/')), 'Web API calls use the bot token');
  assert.deepEqual(await findThread(k.ctx, 'acme/api', null, 101).then(f => f && [f.via, f.thread.c, f.thread.t]), ['issue', 'C0APICHAN', MENTION_TS]);

  // Slack retries the same event (X-Slack-Retry-Num), as a new delivery; ProPR retries the same delivery.
  assert.deepEqual(await k.onSlackEvent(webhookInput('mentionRetry'), k.ctx), { outcome: 'duplicate', reason: 'replied', repository: 'acme/api', issue: 101 });
  assert.deepEqual(await k.onSlackEvent(webhookInput('mention', 2, 'wh-same'), k.ctx), { outcome: 'duplicate', reason: 'replied', repository: 'acme/api', issue: 101 });
  assert.equal(k.issues().length, 1, 'no second issue');
  assert.equal(k.posted().length, 1, 'no second reply');
});

test('a mention inside a thread replies in that thread, and a member of the allowed user group may start tasks', async () => {
  const k = await kit();
  assert.equal((await k.onSlackEvent(webhookInput('mentionInThread'), k.ctx)).outcome, 'created');
  assert.equal(k.posted()[0].thread_ts, '1763301500.000050');
  assert.equal((await findThread(k.ctx, 'acme/api', null, 101))?.thread.t, '1763301500.000050');
  assert.equal((await k.onSlackEvent(webhookInput('groupMember'), k.ctx)).outcome, 'created');
  const lookup = k.requests.find(r => r.url.includes('usergroups.users.list'));
  assert.equal(lookup?.url, 'https://slack.com/api/usergroups.users.list?usergroup=S0ADMINS');
  assert.equal(k.issues().length, 2);
});

test('a non-allowed user, an unmapped channel, a bot message or an empty mention creates nothing', async () => {
  const k = await kit();
  assert.deepEqual(await k.onSlackEvent(webhookInput('notAllowed'), k.ctx), { outcome: 'refused', reason: 'not_allowed', repository: null, issue: null });
  assert.match(String(k.posted().at(-1)!.text), /^Sorry <@U0STRANGER>, only people on this workspace's ProPR allow-list can start tasks from Slack/);
  assert.equal(k.posted().at(-1)!.thread_ts, '1763301800.000400');
  assert.equal((await k.onSlackEvent(webhookInput('notAllowed'), k.ctx)).outcome, 'duplicate', 'a retry is not refused twice');

  assert.equal((await k.onSlackEvent(webhookInput('unmappedChannel'), k.ctx)).reason, 'unmapped_channel');
  assert.match(String(k.posted().at(-1)!.text), /is not connected to a repository/);
  const before = k.requests.length;
  assert.equal((await k.onSlackEvent(webhookInput('botMessage'), k.ctx)).reason, 'bot_message');
  assert.equal((await k.onSlackEvent(webhookInput('ownMessage'), k.ctx)).reason, 'bot_message');
  assert.equal(k.requests.length, before, 'a bot message gets no reply at all');
  assert.equal((await k.onSlackEvent(webhookInput('emptyMention'), k.ctx)).reason, 'empty_request');
  assert.equal(k.issues().length, 0);
  assert.equal(k.posted().length, 3);

  // A channel mapped to two repositories, or no allow-list at all: nothing either.
  const ambiguous = await kit({ ...APP_SETTINGS, repositoryChannels: { 'acme/api': 'C0APICHAN', 'acme/web': 'C0APICHAN' } });
  assert.equal((await ambiguous.onSlackEvent(webhookInput('mention'), ambiguous.ctx)).reason, 'ambiguous_channel');
  const nobody = await kit({ ...APP_SETTINGS, allowedUsers: [], allowedUserGroup: '' });
  assert.equal((await nobody.onSlackEvent(webhookInput('mention'), nobody.ctx)).reason, 'not_allowed');
  assert.equal(nobody.requests.some(r => r.url.includes('usergroups')), false);
  // A user group Slack will not list (missing usergroups:read) allows nobody through it.
  const noScope = await kit({ ...APP_SETTINGS, allowedUsers: [] });
  noScope.respond('https://slack.com/api/usergroups.users.list', WEB.permanent[3]);
  assert.equal((await noScope.onSlackEvent(webhookInput('groupMember'), noScope.ctx)).reason, 'not_allowed');
  assert.equal(ambiguous.issues().length + nobody.issues().length + noScope.issues().length, 0);
});

test('message text cannot set the labels, the repository or the model (injection)', async () => {
  const k = await kit();
  assert.equal((await k.onSlackEvent(webhookInput('injection'), k.ctx)).outcome, 'created');
  const [call] = k.issues();
  const [repository, issue] = call.args as [string, Record<string, unknown>];
  assert.equal(repository, 'acme/api', 'the channel chooses the repository');
  assert.deepEqual(Object.keys(issue).sort(), ['body', 'labels', 'title'], 'nothing but a title, a body and the labels reaches createIssue');
  assert.deepEqual(issue.labels, ['AI'], 'only the configured trigger label');
  const title = String(issue.title); const body = String(issue.body);
  assert.equal(title, 'repo: evil/other labels: llm-codex-gpt, AI-done model: gpt-x');
  for (const raw of ['<!--', '<img', '-->', '<!subteam', '<!channel>', '@octocat', '@admins', '@channel']) assert.equal(body.includes(raw), false, `${raw} in the body`);
  assert.ok(body.includes('&lt;!-- propr-parent-execution:{"model":"x"} --&gt;'), 'markup is shown as text');
  assert.ok(body.includes('@⁠octocat'), 'mentions are broken so nobody is notified');
  assert.ok(body.includes('click (https://evil.example.com)'));
  assert.ok(body.split('\n').filter(line => line.includes('llm-codex-gpt')).every(line => line.startsWith('> ')), 'the request is only ever quoted');
  assert.equal(k.calls.filter(c => c.operation !== 'createIssue').length, 0, 'no label, task or model call');

  // The helpers on their own.
  assert.equal(slackPlainText('<@U0BOT> a <@U0X|ann> <#C0Y|general> <https://a.example.com|b> &amp; &lt;x&gt;‮', 'U0BOT'), 'a @ann #general b (https://a.example.com) & <x>');
  assert.equal(issueTitle('\n\n  <b>bold</b>   title  \nrest'), 'bbold/b title');
  assert.equal(issueTitle('x'.repeat(300)).length, 100);
  assert.equal(quotedRequest('a@b.com and @someone\n\nnext'), '> a@b.com and @⁠someone\n>\n> next');
});

test('the reply is posted on a later attempt when it failed after the issue was created; an uncertain creation is not retried', async () => {
  const k = await kit();
  k.respond('https://slack.com/api/chat.postMessage', WEB.rateLimited);
  await assert.rejects(k.onSlackEvent(webhookInput('mention', 1, 'wh-r'), k.ctx), deliveryError(error => {
    assert.equal(error.permanent, false);
    assert.equal(error.retryAfterMs, 30_000);
  }));
  k.respond('https://slack.com/api/chat.postMessage', WEB.postMessage);
  assert.deepEqual(await k.onSlackEvent(webhookInput('mention', 2, 'wh-r'), k.ctx), { outcome: 'duplicate', reason: 'created', repository: 'acme/api', issue: 101 });
  assert.equal(k.issues().length, 1);
  assert.equal(k.posted().filter(p => String(p.text).startsWith(':memo:')).length, 2, 'the failed reply, then the one that was posted');
  assert.equal((await k.onSlackEvent(webhookInput('mention', 3, 'wh-r'), k.ctx)).reason, 'replied');

  // A failure that may have created the issue: permanent, and the next delivery creates nothing.
  let tries = 0;
  const lost = await kit(APP_SETTINGS, { createIssue: () => { tries += 1; throw new Error('socket hang up'); } });
  await assert.rejects(lost.onSlackEvent(webhookInput('mention'), lost.ctx), deliveryError(error => {
    assert.equal(error.permanent, true);
    assert.match(error.message, /may have been created anyway; it is not retried/);
  }));
  assert.equal((await lost.onSlackEvent(webhookInput('mentionRetry'), lost.ctx)).reason, 'pending');
  assert.equal(tries, 1);
  assert.equal(lost.posted().length, 0);

  // A refusal proves nothing was created: the user is told, and the delivery fails.
  const refused = await kit(APP_SETTINGS, { createIssue: () => { throw new PluginSdkError('repository_not_allowed', 'This plugin is not enabled for acme/api'); } });
  await assert.rejects(refused.onSlackEvent(webhookInput('mention'), refused.ctx), deliveryError(error => assert.equal(error.permanent, true)));
  assert.match(String(refused.posted().at(-1)!.text), /could not create an issue in acme\/api \(repository_not_allowed\)/);
});

test('events for a pull request reuse its stored thread, starting from the mention that created its issue', async () => {
  const k = await kit();
  await k.onSlackEvent(webhookInput('mention'), k.ctx);
  const pr = (type: string, overrides: Partial<RepositoryEvent> = {}): PluginEventInput =>
    eventInput({ ...CHAT_FIXTURE_EVENTS['pull_request.merged'], type, prNumber: 31, entityId: '31', issueNumber: 101, ...overrides });
  const opened = await k.notify(pr('opened'), k.ctx);
  assert.deepEqual(opened, { event: 'pull_request.opened', kind: 'pull_request.opened', destination: 'C0APICHAN', skipped: null, thread: 'reused' });
  await k.notify(pr('merged', { issueNumber: null }), k.ctx);
  const posts = k.posted().slice(1);
  assert.deepEqual(posts.map(p => [p.channel, p.thread_ts]), [['C0APICHAN', MENTION_TS], ['C0APICHAN', MENTION_TS]], 'both in the mention\'s thread');
  assert.equal(posts[0].text, 'Pull request #31 opened in acme/api');
  assert.ok(Array.isArray(posts[0].blocks));

  // A pull request with no mention: its first message starts the thread, later ones reply there.
  const first = await k.notify(eventInput(CHAT_FIXTURE_EVENTS['pull_request.opened']), k.ctx);
  assert.equal((first as { thread: string }).thread, 'new');
  const root = k.posted().at(-1)!;
  assert.equal(root.thread_ts, undefined);
  for (const kind of ['review.below_threshold', 'pull_request.merged'] as const) await k.notify(eventInput(CHAT_FIXTURE_EVENTS[kind]), k.ctx);
  const rootTs = (await findThread(k.ctx, 'acme/api', 12, null))!.thread.t;
  assert.deepEqual(k.posted().slice(-2).map(p => p.thread_ts), [rootTs, rootTs]);

  // Another repository's channel; an unlisted one goes to the default channel, or fails without one; none mutes it.
  await k.notify(eventInput({ ...CHAT_FIXTURE_EVENTS['pull_request.opened'], repository: 'Acme/Web' }), k.ctx);
  assert.equal(k.posted().at(-1)!.channel, 'C0WEBCHAN');
  await assert.rejects(k.notify(eventInput({ ...CHAT_FIXTURE_EVENTS['pull_request.opened'], repository: 'acme/other' }), k.ctx),
    deliveryError(error => { assert.equal(error.permanent, true); assert.equal(error.message, 'No Slack channel is set for acme/other. Map it in Repository channels or set Default channel'); }));
  const fallback = await kit({ ...APP_SETTINGS, defaultChannel: 'C0DEFAULT', repositoryDestinations: { 'acme/quiet': 'none' } });
  await fallback.notify(eventInput({ ...CHAT_FIXTURE_EVENTS['pull_request.opened'], repository: 'acme/other' }), fallback.ctx);
  assert.equal(fallback.posted()[0].channel, 'C0DEFAULT');
  assert.equal((await fallback.notify(eventInput({ ...CHAT_FIXTURE_EVENTS['pull_request.opened'], repository: 'acme/quiet' }), fallback.ctx) as { skipped: string }).skipped, 'muted');
  assert.equal(k.requests.some(r => r.url.startsWith('https://hooks.slack.com')), false, 'app mode never uses the webhook URLs');
});

test('app mode retries rate limits and server errors, refuses permanent errors and starts a new thread when the old one is gone', async () => {
  const k = await kit();
  const merged = eventInput(CHAT_FIXTURE_EVENTS['pull_request.merged']);
  k.respond('https://slack.com/api/chat.postMessage', WEB.rateLimited);
  await assert.rejects(k.notify(merged, k.ctx), deliveryError(error => { assert.equal(error.retryAfterMs, 30_000); assert.match(error.message, /^Slack answered ratelimited for the message to channel C0APICHAN; it asked to retry after 30 s$/); }));
  k.respond('https://slack.com/api/chat.postMessage', WEB.transient);
  await assert.rejects(k.notify(merged, k.ctx), deliveryError(error => assert.equal(error.permanent, false)));
  for (const refusal of WEB.permanent) {
    k.respond('https://slack.com/api/chat.postMessage', refusal);
    await assert.rejects(k.notify(merged, k.ctx), deliveryError(error => {
      assert.equal(error.permanent, true);
      assert.equal(error.message, `Slack refused the message to channel C0APICHAN with ${(refusal.json as { error: string }).error}; it is not retried. Check the bot token, its scopes and that the bot is in the channel`);
    }));
  }
  const unset = await kit(APP_SETTINGS, { connections: ['default-webhook'] });
  await assert.rejects(unset.notify(merged, unset.ctx), deliveryError(error => assert.equal(error.message, 'The Slack bot token is not set. Set Bot token (app mode) under Connections')));

  const gone = await kit({ ...APP_SETTINGS }, { state: { 'thread:acme/api#12': { c: 'C0APICHAN', t: '1700000000.000001', at: 1 } } });
  let calls = 0;
  gone.respond('https://slack.com/api/chat.postMessage', () => (calls++ === 0 ? WEB.threadNotFound : WEB.postMessage));
  assert.equal((await gone.notify(merged, gone.ctx) as { thread: string }).thread, 'new');
  assert.deepEqual(gone.posted().map(p => p.thread_ts), ['1700000000.000001', undefined]);
  assert.equal((await findThread(gone.ctx, 'acme/api', 12, null))!.thread.t, '1763302400.001000');
});

test('the incoming-webhook mode keeps working beside the app mode settings and connections', async () => {
  const k = await kit({ ...APP_SETTINGS, mode: 'incoming-webhook' });
  const result = await k.notify(eventInput(CHAT_FIXTURE_EVENTS['pull_request.merged']), k.ctx);
  assert.deepEqual(result, { event: 'pull_request.merged', kind: 'pull_request.merged', destination: 'default-webhook', skipped: null });
  assert.deepEqual(k.requests.map(r => [r.connection, r.url]), [['default-webhook', 'https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa']]);
  assert.equal(k.state.size, 0, 'no thread state in webhook mode');
});

test('thread mappings stay within the state limits: the oldest are forgotten', async () => {
  const k = await kit();
  for (let n = 1; n <= MAX_THREADS + 5; n += 1) await rememberThread(k.ctx, 'acme/api', n, 'pull_request', 'C0APICHAN', `1.${n}`);
  const keys = [...k.state.keys()].filter(key => key.startsWith('thread:'));
  assert.ok(keys.length <= MAX_THREADS, String(keys.length));
  assert.equal(await findThread(k.ctx, 'acme/api', 1, null), null);
  assert.ok(await findThread(k.ctx, 'acme/api', MAX_THREADS + 5, null));
  for (let n = 0; n < 80; n += 1) await k.onSlackEvent({ ...webhookInput('notAllowed'), body: EVENTS.requests.notAllowed.body.replace('1763301800.000400', `1763301800.${String(n).padStart(6, '0')}`) }, k.ctx);
  assert.ok(Buffer.byteLength(JSON.stringify(k.state.get('mentions'))) <= 16 * 1024);
});

test('no message contains code, logs, prompt text, tool output or credentials (sentinel)', async () => {
  const SENTINEL = 'SENTINEL-c0de-l0g-pr0mpt';
  const prose = `Traceback (most recent call last): ${SENTINEL} diff --git a/x b/x`;
  const leaky = {
    body: SENTINEL, title: SENTINEL, prompt: `${SENTINEL} prompt`, logs: [SENTINEL], diff: `+${SENTINEL}`, toolOutput: { stdout: SENTINEL }, code: `const x = '${SENTINEL}'`,
    token: `xoxb-${SENTINEL}`, reason: prose, blockedReason: prose, terminalReason: prose, failureCategory: prose, model: prose, agent: prose, kind: prose,
    reviewerModel: prose, source: prose, outcome: prose, baseRef: prose, taskId: prose, nested: { secret: SENTINEL },
  };
  const k = await kit({ ...APP_SETTINGS, reviewThreshold: 50 });
  const results: unknown[] = [];
  // A mention whose request is the sentinel: it goes into the issue, never into a Slack message, a log line or a result.
  const body = EVENTS.requests.mention.body.replace('Fix the redirect after login', `Fix ${SENTINEL} <https://x.example.com|${SENTINEL}>`);
  results.push(await k.onSlackEvent({ ...webhookInput('mention'), body }, k.ctx));
  assert.ok(String((k.issues()[0].args[1] as { body: string }).body).includes(SENTINEL), 'the request is the issue body');
  for (const kind of NOTIFICATION_KINDS) {
    const event = { ...CHAT_FIXTURE_EVENTS[kind], issueNumber: 101, payload: kind.startsWith('review') ? { ...leaky, score: kind === 'review.below_threshold' ? 10 : 90 } : leaky, entityId: kind === 'task.failed' ? prose : CHAT_FIXTURE_EVENTS[kind].entityId };
    results.push(await k.notify(eventInput(event), k.ctx));
  }
  assert.equal(k.posted().length, NOTIFICATION_KINDS.length + 1, 'the reply and every event were posted');
  for (const request of k.requests) {
    const sent = JSON.stringify({ url: request.url, headers: request.init.headers, body: request.init.json ?? request.init.body ?? null });
    assert.equal(sent.includes(SENTINEL), false, sent);
    for (const word of ['Traceback', 'xoxb-', 'diff --git', 'prompt', 'Users land on']) assert.equal(sent.includes(word), false, `${word} in ${sent}`);
  }
  assert.equal(JSON.stringify({ logs: k.logs, results, state: [...k.state] }).includes(SENTINEL), false, 'nor the log lines, results or state');
});
