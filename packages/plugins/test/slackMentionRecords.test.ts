import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  PluginDeliveryError, validatePluginSettings,
  type PluginHandler, type PluginJsonValue, type PluginSettingValues, type PluginWebhookInput,
} from '@propr/shared';
import { PLUGINS_ROOT, getOfficialPlugin, loadPluginHandlers } from '../src/index.js';
import { createTestPluginContext, type ScriptedHttpResponse } from '../testing/index.js';
import { MENTION_ACCEPT_MS, MENTION_KEEP_MS, MENTION_SHARDS, mentionKey, readMention, type MentionRecord } from '../slack/mentionRecords.js';
import { CHAT_FIXTURE_SETTINGS } from './fixtures/chatEvents.js';

/**
 * Slack app mode keeps a record of each handled mention for as long as a
 * delivery of it can be retried: later mentions, refused ones included, never
 * push out a record that stands for an issue (created, or possibly created),
 * a mention too old to be retried is ignored, and a full store defers new
 * mentions instead of forgetting.
 */

interface SignedRequest { body: string; retryHeaders?: Record<string, string> }
const fixture = <T>(file: string): T => JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'slack', 'fixtures', file), 'utf8')) as T;
const EVENTS = fixture<{ receivedAt: number; requests: Record<string, SignedRequest> }>('events.json');
type Answer = ScriptedHttpResponse & { json?: PluginJsonValue };
const WEB = fixture<{ postMessage: Answer; permalink: Answer; userGroup: Answer }>('webApi.json');
const MENTION_TS = '1763301599.000100';
const REFUSED_TS = '1763301800.000400';
const APP_SETTINGS: PluginSettingValues = { mode: 'app', repositoryChannels: { 'acme/api': 'C0APICHAN' }, allowedUsers: ['U0ALLOWED'], allowedUserGroup: 'S0ADMINS', triggerLabel: 'AI' };

async function kit(createIssue?: (repository: string) => { repository: string; number: number; url: string }) {
  const { manifest } = getOfficialPlugin('slack', { includeDevelopment: false })!;
  const checked = validatePluginSettings(manifest.settings, { ...CHAT_FIXTURE_SETTINGS, ...APP_SETTINGS });
  assert.ok(checked.ok, JSON.stringify(checked));
  let issues = 100;
  const k = createTestPluginContext({
    pluginId: 'slack', settings: checked.settings as PluginSettingValues, grantedPermissions: manifest.permissions, outboundHosts: manifest.outboundHosts,
    connections: manifest.connections.map(c => c.name), connectionDefinitions: manifest.connections,
    propr: { createIssue: createIssue ?? (repository => { issues += 1; return { repository, number: issues, url: `https://github.com/${repository}/issues/${issues}` }; }) },
  });
  k.respond('https://slack.com/api/chat.postMessage', WEB.postMessage);
  k.respond('https://slack.com/api/chat.getPermalink', WEB.permalink);
  k.respond('https://slack.com/api/usergroups.users.list', WEB.userGroup);
  const handlers = await loadPluginHandlers('slack', { includeDevelopment: false });
  return { ...k, onSlackEvent: handlers!.onSlackEvent as PluginHandler<PluginWebhookInput>, issues: () => k.calls.filter(c => c.operation === 'createIssue').length };
}

let deliveries = 0;
/** The fixture request `name`, its message ts replaced by `ts` when given. */
const input = (name: string, options: { ts?: string; receivedAt?: number } = {}): PluginWebhookInput => {
  const request = EVENTS.requests[name];
  const original = /"ts":"(\d+\.\d+)"/.exec(request.body)![1];
  const body = options.ts ? request.body.split(original).join(options.ts) : request.body;
  return { kind: 'webhook', webhook: 'events', headers: { 'content-type': 'application/json', ...request.retryHeaders }, body, receivedAt: options.receivedAt ?? EVENTS.receivedAt, deliveryId: `wh-${(deliveries += 1)}`, attempt: 1 };
};
const tsOf = (base: string, n: number) => `${base.split('.')[0]}.${String(n).padStart(6, '0')}`;

test('a retry after many later mentions, refused ones included, still creates no second issue', async () => {
  const k = await kit();
  assert.equal((await k.onSlackEvent(input('mention'), k.ctx)).outcome, 'created');
  for (let n = 0; n < 1_000; n += 1) assert.equal((await k.onSlackEvent(input('notAllowed', { ts: tsOf(REFUSED_TS, n) }), k.ctx)).outcome, 'refused');
  assert.deepEqual(await k.onSlackEvent(input('mentionRetry'), k.ctx), { outcome: 'duplicate', reason: 'replied', repository: 'acme/api', issue: 101 });
  assert.equal(k.issues(), 1, 'one issue');
  for (let shard = 0; shard < MENTION_SHARDS; shard += 1) {
    const value = k.state.get(`mentions:${shard}`);
    if (value !== undefined) assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024, `mentions:${shard} within the state value limit`);
  }
});

test('the record of an uncertain creation outlives later mentions: its retry creates nothing', async () => {
  let tries = 0;
  const k = await kit(() => { tries += 1; throw new Error('socket hang up'); });
  await assert.rejects(k.onSlackEvent(input('mention'), k.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.permanent);
  for (let n = 0; n < 1_000; n += 1) await k.onSlackEvent(input('notAllowed', { ts: tsOf(REFUSED_TS, n) }), k.ctx);
  assert.equal((await k.onSlackEvent(input('mentionRetry'), k.ctx)).reason, 'pending');
  assert.equal(tries, 1);
});

test('when the records of issues fill the store, a new mention is deferred, not let in by forgetting one', async () => {
  const k = await kit();
  const created: string[] = [];
  let deferred: string | null = null;
  for (let n = 0; n < 2_000 && deferred === null; n += 1) {
    const ts = tsOf(MENTION_TS, n);
    try {
      assert.equal((await k.onSlackEvent(input('mention', { ts }), k.ctx)).outcome, 'created');
      created.push(ts);
    } catch (error) {
      assert.ok(error instanceof PluginDeliveryError && !error.permanent && error.retryAfterMs! > 0, String(error));
      deferred = ts;
    }
  }
  assert.ok(deferred, 'the store filled');
  const issues = k.issues();
  assert.equal(issues, created.length, 'the deferred mention created nothing');
  assert.equal(await readMention(k.ctx, `C0APICHAN:${deferred}`), undefined);
  // Every issue's message is still remembered: retrying any of them creates nothing.
  for (const ts of created) assert.equal((await k.onSlackEvent(input('mention', { ts }), k.ctx)).outcome, 'duplicate', ts);
  assert.equal(k.issues(), issues);
  // A refused mention for the full shard is still answered; it is simply not remembered.
  const full = mentionKey(`C0APICHAN:${deferred}`);
  const refusedTs = Array.from({ length: 50 }, (_, n) => tsOf(REFUSED_TS, n)).find(ts => mentionKey(`C0APICHAN:${ts}`) === full)!;
  assert.equal((await k.onSlackEvent(input('notAllowed', { ts: refusedTs }), k.ctx)).outcome, 'refused');
  for (let shard = 0; shard < MENTION_SHARDS; shard += 1) assert.ok(Buffer.byteLength(JSON.stringify(k.state.get(`mentions:${shard}`) ?? [])) <= 16 * 1024);
});

test('a mention older than the retry window is ignored before any record is read; expired records are dropped', async () => {
  const k = await kit();
  const posted = Number(MENTION_TS) * 1000;
  // An old delivery whose record would long be gone: it never reaches creation, and nothing is replied.
  assert.deepEqual(await k.onSlackEvent(input('mention', { receivedAt: posted + MENTION_ACCEPT_MS + 1 }), k.ctx), { outcome: 'ignored', reason: 'expired', repository: null, issue: null });
  assert.equal(k.issues(), 0);
  assert.equal(k.requests.length, 0);
  // At the edge of the window it is still taken in.
  assert.equal((await k.onSlackEvent(input('mention', { receivedAt: posted + MENTION_ACCEPT_MS }), k.ctx)).outcome, 'created');

  // A record is kept past every possible retry, then dropped by the next write to its shard.
  assert.ok(MENTION_KEEP_MS > MENTION_ACCEPT_MS + 24 * 60 * 60_000, 'longer than four retries at the longest Retry-After');
  const message = `C0APICHAN:${MENTION_TS}`;
  const key = mentionKey(message);
  const stale: MentionRecord = { m: 'C0APICHAN:1700000000.000001', s: 'replied', at: Date.now() - MENTION_KEEP_MS - 1, r: 'acme/api', n: 7 };
  const fresh: MentionRecord = { m: 'C0APICHAN:1700000000.000002', s: 'pending', at: Date.now() - MENTION_KEEP_MS + 60_000, r: 'acme/api' };
  k.state.set(key, [stale, fresh, ...(k.state.get(key) as unknown as MentionRecord[])] as unknown as PluginJsonValue);
  const sameShard = Array.from({ length: 50 }, (_, n) => tsOf(REFUSED_TS, n)).find(ts => mentionKey(`C0APICHAN:${ts}`) === key)!;
  await k.onSlackEvent(input('notAllowed', { ts: sameShard }), k.ctx);
  const kept = (k.state.get(key) as unknown as MentionRecord[]).map(entry => entry.m);
  assert.ok(!kept.includes(stale.m), 'the expired record is dropped');
  assert.ok(kept.includes(fresh.m) && kept.includes(message) && kept.includes(`C0APICHAN:${sameShard}`));
});
