import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  PluginDeliveryError, PluginSdkError, parsePluginManifest, validatePluginSettings,
  type PluginEventInput, type PluginSettingValues, type RepositoryEvent,
} from '@propr/shared';
import { PLUGINS_ROOT, getOfficialPlugin } from '../src/index.js';
import { createTestPluginContext, type RecordedHttpRequest } from '../testing/index.js';
import { deliver } from '../webhooks/handlers.js';
import { WEBHOOK_HEADERS, webhookEnvelope, webhookTargets } from '../webhooks/envelope.js';
import { eventSelected, readEventSelection, repositorySelected } from '../_shared/eventSelection.js';

const manifest = getOfficialPlugin('webhooks', { includeDevelopment: false })!.manifest;
const ALL_EVENTS = manifest.contributes.subscriptions.map(s => s.on);
const SECRETS = { 'target-1-secret': 'whsec-target-one-0123456789abcdef', 'target-2-secret': 'whsec-target-two-0123456789abcdef', 'target-3-secret': 'whsec-target-three-0123456789abcd' };

let seq = 100;
function event(on: string, overrides: Partial<RepositoryEvent> = {}): PluginEventInput {
  const [domain, type] = on.split('.') as [RepositoryEvent['domain'], string];
  const s = overrides.seq ?? ++seq;
  const base: RepositoryEvent = {
    seq: s, repository: 'acme/api', domain, type, entityId: domain === 'task' ? 'task-42' : domain === 'epic_queue' ? '7' : '12',
    prNumber: domain === 'pull_request' ? 12 : null, issueNumber: domain === 'epic_queue' ? 30 : null, planId: domain === 'epic_queue' ? 'plan-1' : null,
    headSha: domain === 'pull_request' ? '0123456789abcdef0123456789abcdef01234567' : null, payload: {}, occurredAt: '2026-11-16T12:00:00.000Z',
  };
  return { kind: 'event', event: { ...base, ...overrides, seq: s }, deliveryId: `evt-${s}-deliver`, attempt: 1 };
}

/** Settings as the Plugins page saves them, validated against the manifest. */
function settings(values: PluginSettingValues): PluginSettingValues {
  const result = validatePluginSettings(manifest.settings, values);
  assert.ok(result.ok, JSON.stringify(result));
  return { ...Object.fromEntries(Object.entries(manifest.settings.properties).flatMap(([key, s]) => (s.default !== undefined ? [[key, s.default]] : []))), ...result.settings } as PluginSettingValues;
}

function kit(values: PluginSettingValues, secrets: Record<string, string> = SECRETS) {
  const k = createTestPluginContext({
    pluginId: 'webhooks', settings: settings(values), grantedPermissions: manifest.permissions,
    outboundHosts: manifest.outboundHosts, outboundHostsFromSettings: manifest.outboundHostsFromSettings,
    connections: manifest.connections.map(c => c.name), secrets,
  });
  k.respond(() => true, { status: 204 });
  return k;
}

const verify = (request: RecordedHttpRequest, secret: string) => {
  const headers = request.init.headers!;
  const expected = `sha256=${createHmac('sha256', secret).update(`${headers[WEBHOOK_HEADERS.timestamp]}.${request.init.body}`).digest('hex')}`;
  return headers[WEBHOOK_HEADERS.signature] === expected;
};

test('the manifest is valid, derives its outbound hosts from the three target URL settings and subscribes every documented event', () => {
  const parsed = parsePluginManifest(JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'webhooks', 'manifest.json'), 'utf8')));
  assert.ok(parsed.ok);
  assert.deepEqual(manifest.outboundHosts, []);
  assert.deepEqual(manifest.outboundHostsFromSettings, ['target1Url', 'target2Url', 'target3Url']);
  assert.deepEqual(manifest.permissions, ['events.read']);
  assert.deepEqual(ALL_EVENTS, [
    'pull_request.opened', 'pull_request.review_scored', 'pull_request.ultrafix_ended', 'pull_request.merged', 'pull_request.closed',
    'task.queued', 'task.started', 'task.completed', 'task.failed', 'task.cancelled', 'epic_queue.blocked', 'epic_queue.completed',
  ]);
  assert.ok(manifest.contributes.subscriptions.every(s => s.handler === 'deliver'));
  assert.deepEqual(manifest.connections.map(c => [c.name, c.type]), [['target-1-secret', 'signing_secret'], ['target-2-secret', 'signing_secret'], ['target-3-secret', 'signing_secret']]);
});

test('every selected event produces one POST to each matching target; unselected events and filtered repositories produce none', async () => {
  const k = kit({
    target1Url: 'https://hooks.one.example/propr',
    target2Url: 'https://hooks.two.example/in?source=propr', target2Events: ['pull_request.merged', 'task.failed'],
    target3Url: 'https://hooks.three.example/x', target3Repositories: ['Acme/Web'],
  });
  for (const on of ALL_EVENTS) {
    const before = k.requests.length;
    const result = await deliver(event(on), k.ctx);
    const sent = k.requests.slice(before);
    const expected = ['https://hooks.one.example/propr', ...(['pull_request.merged', 'task.failed'].includes(on) ? ['https://hooks.two.example/in?source=propr'] : [])];
    assert.deepEqual(sent.map(r => r.url), expected, on);
    assert.deepEqual(result.delivered, expected.map((_, i) => (i === 0 ? 'target-1' : 'target-2')), on);
    for (const request of sent) {
      assert.equal(request.init.method, 'POST');
      assert.equal(request.init.headers!['content-type'], 'application/json');
      assert.equal(request.init.headers![WEBHOOK_HEADERS.event], on);
      assert.equal(JSON.parse(request.init.body!).event, on);
      assert.equal(request.connection, request.url.includes('two') ? 'target-2-secret' : 'target-1-secret');
      assert.ok(verify(request, SECRETS[request.connection as keyof typeof SECRETS]), `${on}: the signature verifies with the target's secret`);
    }
  }
  // Another repository: target 3's filter takes it (without letter case), target 1 takes every repository.
  const before = k.requests.length;
  await deliver(event('pull_request.opened', { repository: 'acme/web' }), k.ctx);
  assert.deepEqual(k.requests.slice(before).map(r => r.url), ['https://hooks.one.example/propr', 'https://hooks.three.example/x']);

  // Targets with no events selected, or without a URL, receive nothing.
  const quiet = kit({ target1Url: 'https://hooks.one.example/propr', target1Events: [] });
  assert.deepEqual(await deliver(event('task.completed'), quiet.ctx), { event: 'task.completed', delivered: [] });
  assert.equal(quiet.requests.length, 0);
});

test('a delivery id is stable per event and target; the envelope is versioned and carries identifiers, links, states and scores', async () => {
  const k = kit({ target1Url: 'https://hooks.one.example/propr' });
  const input = event('pull_request.review_scored', { seq: 5000, payload: { score: 87.5, goal: 90, goalReached: false, source: 'ultrafix', cycle: 2, reviewerModel: 'claude-opus-5-5' } });
  await deliver(input, k.ctx);
  const [request] = k.requests;
  assert.equal(request.init.headers![WEBHOOK_HEADERS.delivery], 'evt-5000-deliver.target-1');
  assert.equal(request.init.headers![WEBHOOK_HEADERS.version], '1');
  assert.match(request.init.headers![WEBHOOK_HEADERS.timestamp], /^\d{10}$/);
  assert.deepEqual(JSON.parse(request.init.body!), {
    version: 1, id: 'evt-5000-deliver.target-1', event: 'pull_request.review_scored', occurredAt: '2026-11-16T12:00:00.000Z', sequence: 5000,
    repository: { fullName: 'acme/api', url: 'https://github.com/acme/api' },
    pullRequest: { number: 12, url: 'https://github.com/acme/api/pull/12', headSha: '0123456789abcdef0123456789abcdef01234567', state: null },
    issue: null, task: null,
    review: { score: 87.5, goal: 90, goalReached: false, source: 'ultrafix', cycle: 2, reviewerModel: 'claude-opus-5-5' },
    ultrafix: null, epicQueue: null,
  });
  const task = webhookEnvelope(event('task.failed', { payload: { taskId: 'task-42', kind: 'implementation', issueNumber: 9, prNumber: null, agent: 'claude', model: 'claude-opus-5-5', attempts: 2, status: 'failed', terminalReason: 'timed_out', durationMs: 61000, pullRequest: null, failureCategory: 'timed_out' } }).event, 'x');
  assert.deepEqual(task.task, { id: 'task-42', kind: 'implementation', state: 'failed', agent: 'claude', model: 'claude-opus-5-5', attempts: 2, terminalReason: 'timed_out', failureCategory: 'timed_out', durationMs: 61000, pullRequestOutcome: null });
  assert.deepEqual(task.issue, { number: 9, url: 'https://github.com/acme/api/issues/9' });
  const blocked = webhookEnvelope(event('epic_queue.blocked', { payload: { headIssue: 31, blockedReason: 'Waiting for review' } }).event, 'x');
  assert.deepEqual(blocked.epicQueue, { id: '7', planId: 'plan-1', state: 'blocked', headIssue: 31 });
  const merged = webhookEnvelope(event('pull_request.merged').event, 'x');
  assert.equal(merged.pullRequest!.state, 'merged');
});

test('a 429 with Retry-After is retried after the delay, and the retry sends only to the targets still owed', async () => {
  const k = kit({ target1Url: 'https://hooks.one.example/propr', target2Url: 'https://hooks.two.example/in' });
  k.respond('https://hooks.two.example/', { status: 429, headers: { 'Retry-After': '120' } });
  const input = event('pull_request.merged');
  await assert.rejects(deliver(input, k.ctx), (error: unknown) => {
    assert.ok(error instanceof PluginDeliveryError);
    assert.equal(error.permanent, false);
    assert.equal(error.retryAfterMs, 120_000);
    assert.equal(error.message, 'Target 2 (hooks.two.example) answered HTTP 429; it asked to retry after 120 s');
    return true;
  });
  assert.deepEqual(k.requests.map(r => r.url), ['https://hooks.one.example/propr', 'https://hooks.two.example/in']);

  // The dispatcher's next attempt: target 2 accepts now; target 1 already has it.
  k.respond('https://hooks.two.example/', { status: 200 });
  const result = await deliver({ ...input, attempt: 2 }, k.ctx);
  assert.deepEqual(result.delivered, ['target-1', 'target-2']);
  assert.deepEqual(k.requests.map(r => r.url), ['https://hooks.one.example/propr', 'https://hooks.two.example/in', 'https://hooks.two.example/in']);
  assert.equal(k.requests[1].init.headers![WEBHOOK_HEADERS.delivery], k.requests[2].init.headers![WEBHOOK_HEADERS.delivery], 'the same delivery id on the retry');
  assert.deepEqual([...k.state.keys()], [], 'nothing is kept once every target has it');

  // A server error without Retry-After is retried on the dispatcher's schedule; an HTTP date is honoured too.
  const busy = kit({ target1Url: 'https://hooks.one.example/propr' });
  busy.respond(() => true, { status: 503 });
  await assert.rejects(deliver(event('task.started'), busy.ctx), (error: unknown) => error instanceof PluginDeliveryError && !error.permanent && error.retryAfterMs === undefined);
  busy.respond(() => true, { status: 503, headers: { 'retry-after': new Date(Date.now() + 60_000).toUTCString() } });
  await assert.rejects(deliver(event('task.started'), busy.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.retryAfterMs! > 55_000 && error.retryAfterMs! <= 60_000);
});

test('a permanent error marks the delivery failed with a readable message', async () => {
  const k = kit({ target1Url: 'https://hooks.one.example/propr' });
  k.respond(() => true, { status: 410, body: 'gone' });
  await assert.rejects(deliver(event('pull_request.closed'), k.ctx), (error: unknown) => {
    assert.ok(error instanceof PluginDeliveryError);
    assert.equal(error.permanent, true);
    assert.equal(error.message, 'Target 1 (hooks.one.example) refused the delivery with HTTP 410; it is not retried. Check the target URL and the endpoint\'s configuration');
    return true;
  });
  // A target without its signing secret is never sent anything unsigned.
  const unsigned = kit({ target1Url: 'https://hooks.one.example/propr' }, {});
  await assert.rejects(deliver(event('pull_request.closed'), unsigned.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.permanent
    && /^Target 1 \(hooks\.one\.example\) was not sent the delivery: .*signing_secret.*Check the target's settings and signing secret$/.test(error.message));
  assert.equal(unsigned.requests.length, 0);

  // One target refuses for good while another is only busy: retried for the busy one, and failed once it is done.
  const mixed = kit({ target1Url: 'https://hooks.one.example/propr', target2Url: 'https://hooks.two.example/in' });
  mixed.respond('https://hooks.one.example/', { status: 404 });
  mixed.respond('https://hooks.two.example/', { status: 502 });
  const input = event('task.completed');
  await assert.rejects(deliver(input, mixed.ctx), (error: unknown) => error instanceof PluginDeliveryError && !error.permanent && /HTTP 502.*HTTP 404/.test(error.message));
  mixed.respond('https://hooks.two.example/', { status: 200 });
  await assert.rejects(deliver({ ...input, attempt: 2 }, mixed.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.permanent && /^Target 1 .*HTTP 404/.test(error.message));
  assert.deepEqual(mixed.requests.map(r => r.url), ['https://hooks.one.example/propr', 'https://hooks.two.example/in', 'https://hooks.two.example/in'], 'the refusing target is not asked again');
});

test('a manual Retry skips the targets that have the event and asks again a target that refused it', async () => {
  // Target 1 accepts; target 2 refuses for good: the delivery fails at once, but which target has it is kept.
  const k = kit({ target1Url: 'https://hooks.one.example/propr', target2Url: 'https://hooks.two.example/in' });
  k.respond('https://hooks.two.example/', { status: 410 });
  const input = event('pull_request.merged');
  await assert.rejects(deliver(input, k.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.permanent && /^Target 2 .*HTTP 410/.test(error.message));
  assert.deepEqual([...k.state.keys()], [`progress:${input.deliveryId}`]);
  // The administrator fixes target 2 and selects Retry: only target 2 is sent the event.
  k.respond('https://hooks.two.example/', { status: 202 });
  const result = await deliver({ ...input, attempt: 2, manual: true }, k.ctx);
  assert.deepEqual(result.delivered, ['target-1', 'target-2']);
  assert.deepEqual(k.requests.map(r => r.url), ['https://hooks.one.example/propr', 'https://hooks.two.example/in', 'https://hooks.two.example/in']);
  assert.deepEqual([...k.state.keys()], [], 'nothing is kept once every target has it');

  // Target 1 refuses for good, target 2 stays busy until the retries run out: progress holds target 1's refusal.
  const busy = kit({ target1Url: 'https://hooks.one.example/propr', target2Url: 'https://hooks.two.example/in' });
  busy.respond('https://hooks.one.example/', { status: 404 });
  busy.respond('https://hooks.two.example/', { status: 503 });
  const other = event('task.completed');
  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(deliver({ ...other, attempt }, busy.ctx), (error: unknown) => error instanceof PluginDeliveryError && !error.permanent);
  }
  assert.equal(busy.requests.filter(r => r.url.startsWith('https://hooks.one.example/')).length, 1, 'automatic retries do not ask the refusing target again');
  // Both are fixed; the manual Retry contacts target 1 again instead of failing on its old refusal.
  busy.respond(() => true, { status: 200 });
  const retried = await deliver({ ...other, attempt: 6, manual: true }, busy.ctx);
  assert.deepEqual(retried.delivered, ['target-1', 'target-2']);
  assert.equal(busy.requests.filter(r => r.url.startsWith('https://hooks.one.example/')).length, 2);
  assert.deepEqual([...busy.state.keys()], []);

  // A target still refusing on the manual Retry fails it again with the new reason; the one that has it is still skipped.
  const again = kit({ target1Url: 'https://hooks.one.example/propr', target2Url: 'https://hooks.two.example/in' });
  again.respond('https://hooks.two.example/', { status: 410 });
  const third = event('task.failed');
  await assert.rejects(deliver(third, again.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.permanent);
  again.respond('https://hooks.two.example/', { status: 403 });
  await assert.rejects(deliver({ ...third, attempt: 2, manual: true }, again.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.permanent && /^Target 2 .*HTTP 403/.test(error.message));
  again.respond('https://hooks.two.example/', { status: 200 });
  await deliver({ ...third, attempt: 3, manual: true }, again.ctx);
  assert.deepEqual(again.requests.map(r => r.url), ['https://hooks.one.example/propr', 'https://hooks.two.example/in', 'https://hooks.two.example/in', 'https://hooks.two.example/in']);
});

test('progress makes room in full plugin state by dropping the oldest other progress record', async () => {
  const k = kit({ target1Url: 'https://hooks.one.example/propr', target2Url: 'https://hooks.two.example/in' });
  for (let i = 0; i < 256; i++) await k.ctx.state.set(i < 2 ? `progress:old-${i}` : `other:${i}`, i < 2 ? { at: Date.now() - (2 - i) * 1000, sent: ['target-1'], refused: {} } : 1);
  k.respond('https://hooks.two.example/', { status: 410 });
  const input = event('pull_request.closed');
  await assert.rejects(deliver({ ...input, attempt: 2 }, k.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.permanent);
  const keys = [...k.state.keys()];
  assert.ok(keys.includes(`progress:${input.deliveryId}`));
  assert.ok(!keys.includes('progress:old-0') && keys.includes('progress:old-1'), 'the oldest record made room');
});

test('a host not derived from the settings is refused at call time; plain HTTP and private targets are refused at save time', async () => {
  const k = kit({ target1Url: 'https://hooks.one.example/propr' });
  const fetch = k.ctx.http('target-1-secret');
  await assert.rejects(fetch('https://elsewhere.example/', { method: 'POST', body: '{}', signature: { header: 'x-sig' } }), (error: unknown) => error instanceof PluginSdkError && error.code === 'host_not_allowed');
  await assert.rejects(fetch('http://hooks.one.example/propr', { method: 'POST', body: '{}', signature: { header: 'x-sig' } }), (error: unknown) => error instanceof PluginSdkError && error.code === 'insecure_url');

  for (const [url, pattern] of [
    ['http://hooks.example.com/propr', /target1Url must be an https:\/\/ URL, not http/],
    ['https://10.0.0.5/hook', /target1Url must name a public host such as hooks\.example\.com, not an IP address/],
    ['https://[::1]/hook', /not an IP address/],
    ['https://localhost/hook', /must name a public host/],
    ['https://printer.local/hook', /not the local name printer\.local/],
    ['https://metadata.google.internal/x', /not the local name/],
    ['https://user:pass@hooks.example.com/x', /must not carry a user name or password/],
    ['https://hooks.example.com:8443/x', /default HTTPS port/],
    ['not a url', /must be an https:\/\/ URL/],
  ] as const) {
    const result = validatePluginSettings(manifest.settings, { target1Url: url });
    assert.ok(!result.ok, url);
    assert.match(result.errors.join('; '), pattern, url);
  }
  const unknownEvent = validatePluginSettings(manifest.settings, { target1Events: ['pull_request.merged', 'pull_request.head_changed'] });
  assert.ok(!unknownEvent.ok);
  assert.match(unknownEvent.errors[0], /^target1Events has pull_request\.head_changed, which is not one of /);
});

test('no payload contains code, logs, prompt text, tool output or credentials', async () => {
  const SENTINEL = 'SENTINEL-c0de-l0g-pr0mpt';
  const prose = `Traceback (most recent call last): ${SENTINEL} diff --git a/x b/x`;
  const leaky = {
    body: SENTINEL, prompt: `${SENTINEL} prompt`, logs: [SENTINEL], diff: `+${SENTINEL}`, toolOutput: { stdout: SENTINEL }, code: `const x = '${SENTINEL}'`,
    token: `ghp_${SENTINEL}`, reason: prose, blockedReason: prose, terminalReason: prose, failureCategory: prose, model: prose, agent: prose, kind: prose,
    reviewerModel: prose, source: prose, outcome: prose, baseRef: prose, taskId: prose, score: SENTINEL, attempts: SENTINEL, nested: { secret: SENTINEL },
  };
  const secrets = { 'target-1-secret': `${SENTINEL}-signing-secret` };
  const k = kit({ target1Url: 'https://hooks.one.example/propr' }, secrets);
  for (const on of ALL_EVENTS) await deliver(event(on, { payload: leaky, entityId: on.startsWith('task') ? prose : '12' }), k.ctx);
  assert.equal(k.requests.length, ALL_EVENTS.length);
  for (const request of k.requests) {
    const sent = JSON.stringify({ url: request.url, headers: request.init.headers, body: request.init.body });
    assert.equal(sent.includes(SENTINEL), false, `${request.init.headers![WEBHOOK_HEADERS.event]}: ${sent}`);
    assert.equal(sent.includes('Traceback'), false);
    assert.equal(sent.includes('ghp_'), false);
    assert.equal(request.init.headers!.authorization, undefined, 'no credential header');
  }
  assert.equal(JSON.stringify(k.logs).includes(SENTINEL), false, 'nor do the log lines');
});

test('the signature test vector in the docs verifies with the documented algorithm', () => {
  const docs = readFileSync(path.join(PLUGINS_ROOT, '..', '..', 'docs', 'docs', 'plugins', 'webhooks.md'), 'utf8');
  const vector = /```text test-vector\n([\s\S]*?)\n```/.exec(docs)?.[1];
  assert.ok(vector, 'the docs page has a test-vector block');
  const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(vector)![1];
  const secret = field('Secret'); const timestamp = field('X-ProPR-Timestamp'); const body = field('Body'); const signature = field('X-ProPR-Signature');
  assert.equal(signature, `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`);
  assert.equal(signature, 'sha256=0cd0e98a705d1a6619a32f0aac9963a02f059fe3d1b09630b3587b82036003dc');
  // The body is the envelope the handler builds for that event.
  const input = event('pull_request.merged', { seq: 4211, headSha: null, occurredAt: '2025-11-16T12:00:00.000Z' });
  assert.equal(JSON.stringify(webhookEnvelope(input.event, 'evt-4211-deliver.target-1')), body);
});

test('the shared event selection matches event names and repositories without letter case', () => {
  const selection = readEventSelection({ e: ['task.completed', 'not.an-event', 'task.completed'], r: [' Acme/API ', ''] }, 'e', 'r');
  assert.deepEqual(selection, { events: ['task.completed'], repositories: ['Acme/API'] });
  assert.equal(eventSelected(selection, { domain: 'task', type: 'completed', repository: 'acme/api' }), true);
  assert.equal(eventSelected(selection, { domain: 'task', type: 'failed', repository: 'acme/api' }), false);
  assert.equal(eventSelected(selection, { domain: 'task', type: 'completed', repository: 'acme/web' }), false);
  assert.equal(repositorySelected([], 'any/repo'), true);
  assert.deepEqual(webhookTargets({ target1Url: 'http://insecure.example/x', target2Url: 'https://ok.example/x' }).map(t => t.name), ['target-2']);
});
