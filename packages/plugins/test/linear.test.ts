import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  PluginDeliveryError, readPluginSettingOptions, validatePluginSettings,
  type PluginEventInput, type PluginHandler, type PluginHttpRequestInit, type PluginJsonValue, type PluginSettingOptionsInput, type PluginSettingValues, type PluginWebhookInput, type RepositoryEvent,
} from '@propr/shared';
import { PLUGINS_ROOT, getOfficialPlugin, loadPluginHandlers } from '../src/index.js';
import { createTestPluginContext, type ScriptedHttpResponse } from '../testing/index.js';
import { SYNC_KINDS, inertQuote, trackerIssueTitle } from '../_shared/tracker.js';
import { readLink } from '../_shared/trackerLinks.js';

/**
 * The Linear plugin: the signed webhook fixtures of `linear/fixtures/webhooks.json`
 * (the signature itself is checked by ProPR before the handler runs, in
 * packages/core/test/linearPluginWebhooks.test.ts), Linear's GraphQL answers of
 * `linear/fixtures/graphql.json`, the sync-back and the configure form's choices.
 */

interface SignedRequest { delivery: string; signature: string; body: string }
const fixture = <T>(file: string): T => JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'linear', 'fixtures', file), 'utf8')) as T;
const HOOKS = fixture<{ receivedAt: number; ids: Record<string, string>; requests: Record<string, SignedRequest> }>('webhooks.json');
const GRAPHQL = fixture<Record<string, ScriptedHttpResponse>>('graphql.json');
const { ids } = HOOKS;

const MAPPED: PluginSettingValues = { repositoryMapping: { 'acme/api': `team:${ids.team}`, 'acme/ops': `project:${ids.project}` } };
const ALL_OFF: PluginSettingValues = { comments: [] };

const plugin = () => getOfficialPlugin('linear', { includeDevelopment: false })!;
function settings(values: PluginSettingValues): PluginSettingValues {
  const { manifest } = plugin();
  const result = validatePluginSettings(manifest.settings, values);
  assert.ok(result.ok, JSON.stringify(result));
  return { ...Object.fromEntries(Object.entries(manifest.settings.properties).flatMap(([key, s]) => (s.default !== undefined ? [[key, s.default]] : []))), ...result.settings } as PluginSettingValues;
}

const operation = (init: PluginHttpRequestInit) => /(?:query|mutation) (\w+)/.exec(String((init.json as { query?: string } | undefined)?.query))?.[1] ?? '';

async function kit(values: PluginSettingValues = MAPPED, options: { connections?: string[]; state?: Record<string, PluginJsonValue>; graphql?: Partial<Record<string, ScriptedHttpResponse>>; headRef?: string } = {}) {
  const { manifest } = plugin();
  let issues = 40;
  const k = createTestPluginContext({
    pluginId: 'linear', settings: settings(values), grantedPermissions: manifest.permissions, outboundHosts: manifest.outboundHosts,
    connections: options.connections ?? manifest.connections.map(c => c.name), connectionDefinitions: manifest.connections, state: options.state,
    propr: {
      createIssue: repository => { issues += 1; return { repository, number: issues, url: `https://github.com/${repository}/issues/${issues}` }; },
      getPullRequest: (repository, number) => ({ repository, number, title: '', state: 'open', url: '', labels: [], author: null, createdAt: '', updatedAt: '', draft: false, merged: false, headRef: options.headRef ?? '41/claude-fix-redirect', baseRef: 'main', headSha: 'abc' }),
    },
  });
  const answers: Record<string, ScriptedHttpResponse> = {
    ProprTeams: GRAPHQL.teams, ProprProjects: GRAPHQL.projects, ProprStates: GRAPHQL.workflowStates, ProprTeamStates: GRAPHQL.teamStates,
    ProprComment: GRAPHQL.commentCreated, ProprMove: GRAPHQL.issueUpdated, ...options.graphql,
  };
  k.respond('https://api.linear.app/graphql', (_url, init) => answers[operation(init)] ?? { status: 400, json: { errors: [{ message: 'unknown', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] } });
  const handlers = (await loadPluginHandlers('linear', { includeDevelopment: false }))!;
  const linear = (op: string) => k.requests.filter(r => operation(r.init) === op).map(r => (r.init.json as { variables: Record<string, PluginJsonValue> }).variables);
  return {
    ...k, linear, answers,
    comments: () => linear('ProprComment').map(v => (v.input as { issueId: string; body: string })),
    issues: () => k.calls.filter(c => c.operation === 'createIssue').map(c => c.args as [string, { title: string; body: string; labels: string[] }]),
    onLinearWebhook: handlers.onLinearWebhook as PluginHandler<PluginWebhookInput>,
    sync: handlers.sync as PluginHandler<PluginEventInput>,
    teamOptions: handlers.teamOptions as PluginHandler<PluginSettingOptionsInput>,
    stateOptions: handlers.stateOptions as PluginHandler<PluginSettingOptionsInput>,
  };
}

let attempts = 0;
const hook = (name: string, attempt = 1): PluginWebhookInput => ({
  kind: 'webhook', webhook: 'linear', headers: { 'content-type': 'application/json', 'linear-event': 'Issue' }, body: HOOKS.requests[name].body,
  receivedAt: HOOKS.receivedAt, deliveryId: `whk-linear:${HOOKS.requests[name].delivery}`, attempt: attempt + (attempts += 0),
});

let seq = 100;
function event(domain: RepositoryEvent['domain'], type: string, fields: Partial<RepositoryEvent> = {}): PluginEventInput {
  seq += 1;
  return {
    kind: 'event', deliveryId: `evt-${seq}-sync`, attempt: 1,
    event: { seq, repository: 'acme/api', domain, type, entityId: String(fields.prNumber ?? 't-1'), prNumber: null, issueNumber: null, planId: null, headSha: null, payload: {}, occurredAt: '2025-11-16T16:10:00.000Z', ...fields },
  };
}
const taskEvent = (type: string, payload: Record<string, unknown> = {}) => event('task', type, { entityId: 'task-41', issueNumber: 41, payload: { taskId: 'task-41', kind: 'implementation', issueNumber: 41, prNumber: null, attempts: 1, ...payload } });
const prEvent = (type: string, prNumber = 77, payload: Record<string, unknown> = {}) => event('pull_request', type, { entityId: String(prNumber), prNumber, payload });

/** A kit whose ticket ENG-123 already created issue acme/api#41. */
async function linked(values: PluginSettingValues = {}, options: Parameters<typeof kit>[1] = {}) {
  const { graphql, ...rest } = options;
  const k = await kit({ ...MAPPED, ...values }, rest);
  await k.onLinearWebhook(hook('labelAdded'), k.ctx);
  Object.assign(k.answers, graphql);
  assert.equal(k.issues().length, 1);
  k.requests.length = 0;
  k.logs.length = 0;
  return k;
}

test('the manifest: Linear webhooks verified with the hex HMAC of Linear-Signature, the API key sent plain to api.linear.app only, a read-only MCP server and choices loaded with optionsFrom', () => {
  const { manifest, assets } = plugin();
  assert.equal(manifest.category, 'issue-tracking');
  assert.deepEqual(manifest.permissions, ['events.read', 'issues.create', 'pull_requests.read']);
  assert.deepEqual(manifest.outboundHosts, ['api.linear.app']);
  assert.deepEqual(manifest.contributes.webhooks.map(w => [w.name, w.handler, w.verification, w.deliveryIdHeader]), [
    ['linear', 'onLinearWebhook', { scheme: 'hmac-sha256', header: 'linear-signature', encoding: 'hex', connection: 'webhook-secret' }, 'linear-delivery'],
  ]);
  const key = manifest.connections.find(c => c.name === 'api-key');
  assert.ok(key?.type === 'token' && key.authorization === 'plain', 'Linear API keys are sent without a Bearer scheme');
  const [server] = manifest.contributes.mcpServers;
  assert.ok(server.kind === 'https');
  assert.deepEqual([server.url, server.capability, server.authentication, server.connection], ['https://mcp.linear.app/mcp/readonly', 'read', 'bearer', 'api-key']);
  assert.equal(server.tools.some(tool => /^(create|update|delete)_/.test(tool)), false, 'only read tools');
  const props = manifest.settings.properties;
  assert.deepEqual([props.repositoryMapping, props.stateOnPullRequestOpened, props.stateOnMerged].map(s => (s.type === 'object' || s.type === 'string' ? s.optionsFrom : null)), ['teamOptions', 'stateOptions', 'stateOptions']);
  assert.equal(props.triggerLabel.type === 'string' && props.triggerLabel.default, 'propr');
  assert.deepEqual(props.comments.type === 'array' && props.comments.items.enum, [...SYNC_KINDS]);
  assert.deepEqual(manifest.contributes.subscriptions.map(s => s.on).sort(), ['pull_request.closed', 'pull_request.merged', 'pull_request.opened', 'pull_request.review_scored', 'task.failed', 'task.started']);
  assert.deepEqual(assets.skills.map(s => s.name), ['linear-ticket']);
});

test('adding the trigger label to a mapped ticket creates exactly one GitHub issue with the ticket\'s text, a link back and only the trigger label', async () => {
  const k = await kit();
  const result = await k.onLinearWebhook(hook('labelAdded'), k.ctx);
  assert.deepEqual(result, { outcome: 'created', reason: null, repository: 'acme/api', issue: 41 });
  const [[repository, issue]] = k.issues();
  assert.equal(repository, 'acme/api');
  assert.equal(issue.title, 'ENG-123: Fix the redirect after login');
  assert.deepEqual(issue.labels, ['AI']);
  assert.match(issue.body, /^Started from Linear ticket ENG-123\./);
  assert.match(issue.body, /^> Users land on \/home instead of the page they asked for\.$/m);
  assert.match(issue.body, /Linear ticket: \[ENG-123\]\(https:\/\/linear\.app\/acme\/issue\/ENG-123\/fix-the-redirect-after-login\)/);
  const link = await readLink(k.ctx, ids.ticket);
  assert.deepEqual([link?.s, link?.r, link?.n, link?.k, link?.g], ['created', 'acme/api', 41, 'ENG-123', ids.team]);
  assert.deepEqual(k.comments(), [{ issueId: ids.ticket, body: 'ProPR created GitHub issue [acme/api#41](https://github.com/acme/api/issues/41) for this ticket. Its task starts from there; progress is posted here.' }]);
  for (const request of k.requests) assert.deepEqual([request.url, request.connection], ['https://api.linear.app/graphql', 'api-key']);

  const created = await kit();
  assert.equal((await created.onLinearWebhook(hook('createdWithLabel'), created.ctx)).outcome, 'created', 'a ticket created with the label');
  assert.match(created.issues()[0][1].title, /^ENG-124: /);
});

test('repeated or replayed webhooks, the label added again and concurrent deliveries create no second issue', async () => {
  const k = await kit();
  const [first, concurrent] = await Promise.all([k.onLinearWebhook(hook('labelAdded'), k.ctx), k.onLinearWebhook(hook('labelAdded'), k.ctx)]);
  assert.deepEqual([first.outcome, concurrent.outcome].sort(), ['created', 'duplicate']);
  assert.deepEqual(await k.onLinearWebhook(hook('labelAdded', 2), k.ctx), { outcome: 'duplicate', reason: null, repository: 'acme/api', issue: 41 }, 'a retry of the delivery');
  assert.equal((await k.onLinearWebhook(hook('labelAddedAgain'), k.ctx)).outcome, 'duplicate', 'the label removed and added again later');
  assert.equal(k.issues().length, 1);
  assert.equal(k.comments().length, 1, 'the issue link is commented once');
});

test('a creation that may have succeeded is not retried, and a refused one leaves no link behind', async () => {
  const k = await kit();
  k.ctx.propr.createIssue = async () => { throw new Error('socket hang up'); };
  await assert.rejects(k.onLinearWebhook(hook('labelAdded'), k.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.permanent);
  assert.equal((await readLink(k.ctx, ids.ticket))?.s, 'pending');
  assert.equal((await k.onLinearWebhook(hook('labelAdded', 2), k.ctx)).outcome, 'duplicate', 'never a second attempt at creating it');
  assert.ok(k.logs.some(l => l.level === 'warn' && /interrupted/.test(l.message)));

  const limited = await kit();
  limited.ctx.propr.createIssue = async () => { const { PluginSdkError } = await import('@propr/shared'); throw new PluginSdkError('repository_not_allowed', 'not enabled for acme/api'); };
  await assert.rejects(limited.onLinearWebhook(hook('labelAdded'), limited.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.permanent);
  assert.equal(await readLink(limited.ctx, ids.ticket), undefined);
});

test('the issue-link comment that failed is posted by the retry, which creates nothing', async () => {
  const k = await kit(MAPPED, { graphql: { ProprComment: GRAPHQL.rateLimited } });
  await assert.rejects(k.onLinearWebhook(hook('labelAdded'), k.ctx), (error: unknown) => error instanceof PluginDeliveryError && !error.permanent);
  k.respond('https://api.linear.app/graphql', GRAPHQL.commentCreated);
  assert.equal((await k.onLinearWebhook(hook('labelAdded', 2), k.ctx)).outcome, 'duplicate');
  assert.equal(k.issues().length, 1);
  assert.equal(k.linear('ProprComment').length, 2, 'the failed comment and its retry');
});

test('unmapped tickets, other label changes, other changes, removed labels, comments and stale webhooks do nothing', async () => {
  const cases: [string, string][] = [
    ['unmappedTeam', 'unmapped'], ['otherLabelAdded', 'no_trigger_label_added'], ['titleChanged', 'no_trigger_label_added'],
    ['labelRemoved', 'no_trigger_label_added'], ['comment', 'not_an_issue'], ['stale', 'stale_timestamp'],
  ];
  for (const [name, reason] of cases) {
    const k = await kit();
    assert.deepEqual(await k.onLinearWebhook(hook(name), k.ctx), { outcome: 'ignored', reason, repository: null, issue: null }, name);
    assert.equal(k.calls.length, 0, `${name}: nothing created`);
    assert.equal(k.requests.length, 0, `${name}: nothing sent to Linear`);
  }
  const ambiguous = await kit({ repositoryMapping: { 'acme/api': `team:${ids.team}`, 'acme/web': `team:${ids.team}` } });
  assert.equal((await ambiguous.onLinearWebhook(hook('labelAdded'), ambiguous.ctx)).reason, 'ambiguous');
  assert.equal(ambiguous.calls.length, 0);
  const otherLabel = await kit({ ...MAPPED, triggerLabel: 'Bug' });
  assert.equal((await otherLabel.onLinearWebhook(hook('labelAdded'), otherLabel.ctx)).outcome, 'ignored', 'Bug was on the ticket before');
  const project = await kit();
  assert.equal((await project.onLinearWebhook(hook('projectMapped'), project.ctx)).repository, 'acme/ops', 'a project mapping takes the ticket of an unmapped team');
});

test('ticket text cannot affect the repository, the labels or the model, and reaches the issue only inert (injection)', async () => {
  const k = await kit();
  await k.onLinearWebhook(hook('injection'), k.ctx);
  const [[repository, issue]] = k.issues();
  assert.equal(repository, 'acme/api', 'the repository comes from the mapping');
  assert.deepEqual(issue.labels, ['AI'], 'the only label comes from the settings');
  assert.deepEqual(Object.keys(issue).sort(), ['body', 'labels', 'title'], 'nothing else, so no model either');
  assert.doesNotMatch(issue.title, /[<>]/);
  assert.doesNotMatch(issue.body, /<!--|<img|evil\/repo\]|^\/model/m);
  assert.match(issue.body, /^> &lt;!-- propr-mcp:0000:1 --&gt;$/m, 'hidden markers are shown as text');
  assert.match(issue.body, /^> \/model gpt-5$/m, 'no line starts a command');
  assert.match(issue.body, /@⁠octocat/, 'mentions notify nobody');
  assert.equal(inertQuote('a\n<b>'), '> a\n> &lt;b&gt;');
  assert.equal(trackerIssueTitle({ key: 'ENG-1', title: 'x'.repeat(300) }).length <= 256, true);
});

test('no ticket text is sent anywhere but into the created issue: not to Linear, not to logs, not to results (sentinel)', async () => {
  const k = await kit();
  const result = await k.onLinearWebhook(hook('injection'), k.ctx);
  await k.sync(taskEvent('started', { issueNumber: 41 }), k.ctx);
  const outside = JSON.stringify({ requests: k.requests, logs: k.logs, result, state: [...k.state] });
  assert.equal(/SENTINEL/.test(outside), false, 'the ticket text reached Linear, a log line, the result or the state');
  assert.match(JSON.stringify(k.issues()), /SENTINEL-DESCRIPTION/, 'it is in the issue');
});

const EXPECTED: Record<string, [() => PluginEventInput, RegExp]> = {
  task_started: [() => taskEvent('started'), /^ProPR started working on this ticket \(\[acme\/api#41\]\(https:\/\/github\.com\/acme\/api\/issues\/41\)\)\.$/],
  pull_request_opened: [() => prEvent('opened'), /^ProPR opened pull request \[acme\/api#77\]\(https:\/\/github\.com\/acme\/api\/pull\/77\) for this ticket\.$/],
  review_goal_reached: [() => prEvent('review_scored', 77, { score: 92, goal: 80, goalReached: true }), /^The review of pull request \[acme\/api#77\].* reached its goal \(score 92, goal 80\)\.$/],
  pull_request_merged: [() => prEvent('merged'), /^Pull request \[acme\/api#77\].* was merged\.$/],
  pull_request_closed: [() => prEvent('closed'), /^Pull request \[acme\/api#77\].* was closed without merging\.$/],
  task_failed: [() => taskEvent('failed', { failureCategory: 'timed_out', status: 'failed' }), /^A ProPR task for this ticket failed \(timed_out\)\. The details are in ProPR, on \[acme\/api#41\]/],
};

test('each sync-back event posts its comment when switched on, once, and nothing when off', async () => {
  for (const [kind, [make, expected]] of Object.entries(EXPECTED)) {
    const on = await linked({ comments: [kind] });
    const input = make();
    const result = await on.sync(input, on.ctx);
    assert.equal(result && typeof result === 'object' && (result as { comment: boolean }).comment, true, kind);
    assert.equal(on.comments().length, 1, kind);
    assert.equal(on.comments()[0].issueId, ids.ticket);
    assert.match(on.comments()[0].body, expected, kind);
    await on.sync({ ...input, attempt: 2 }, on.ctx);
    assert.equal(on.comments().length, 1, `${kind}: a repeated delivery posts nothing twice`);

    const off = await linked(ALL_OFF);
    assert.deepEqual((await off.sync(make(), off.ctx) as { skipped: string }).skipped, 'switched_off', kind);
    assert.equal(off.requests.length + off.calls.filter(c => c.operation !== 'createIssue').length, 0, `${kind}: nothing read or sent when off`);
  }
  const below = await linked();
  assert.equal((await below.sync(prEvent('review_scored', 77, { score: 60, goal: 80, goalReached: false }), below.ctx) as { skipped: string }).skipped, 'not_a_sync_event');
  const followUp = await linked();
  assert.equal((await followUp.sync(event('task', 'started', { payload: { kind: 'follow-up', prNumber: 77 } }), followUp.ctx) as { skipped: string }).skipped, 'not_a_sync_event');
  assert.equal(below.requests.length + followUp.requests.length, 0);
});

test('a pull request is tied to its ticket by the branch of the ticket\'s issue; other pull requests and repositories do nothing', async () => {
  const k = await linked();
  await k.sync(prEvent('opened', 77), k.ctx);
  assert.deepEqual((await readLink(k.ctx, ids.ticket))?.p, [77]);
  await k.sync(prEvent('merged', 77), k.ctx);
  assert.equal(k.calls.filter(c => c.operation === 'getPullRequest').length, 1, 'the second event uses the remembered pull request');
  const other = await linked({}, { headRef: '99/another-issue' });
  assert.equal((await other.sync(prEvent('opened', 78), other.ctx) as { skipped: string }).skipped, 'no_ticket');
  assert.equal(other.comments().length, 0);
  const unmapped = await linked();
  assert.equal((await unmapped.sync({ ...prEvent('opened'), event: { ...prEvent('opened').event, repository: 'acme/elsewhere' } }, unmapped.ctx) as { skipped: string }).skipped, 'repository_not_mapped');
  assert.equal(unmapped.calls.filter(c => c.operation === 'getPullRequest').length, 0);
});

test('the ticket moves to the configured states on "pull request opened" and "merged"; a missing state is reported and blocks nothing', async () => {
  const k = await linked({ comments: [], stateOnPullRequestOpened: 'In Review', stateOnMerged: 'Done' });
  assert.equal((await k.sync(prEvent('opened'), k.ctx) as { state: string }).state, 'moved');
  assert.equal((await k.sync(prEvent('merged'), k.ctx) as { state: string }).state, 'moved');
  assert.deepEqual(k.linear('ProprTeamStates').map(v => v.id), [ids.team, ids.team]);
  assert.deepEqual(k.linear('ProprMove'), [
    { id: ids.ticket, input: { stateId: 'e0e0e0e0-0000-4000-8000-0000000000b2' } },
    { id: ids.ticket, input: { stateId: 'e0e0e0e0-0000-4000-8000-0000000000b3' } },
  ]);
  await k.sync(prEvent('merged', 77), k.ctx);
  assert.equal(k.linear('ProprMove').length, 2, 'a repeated delivery moves nothing again');

  const missing = await linked({ comments: ['pull_request_opened', 'pull_request_merged'], stateOnPullRequestOpened: 'Shipping', stateOnMerged: 'Done' });
  const opened = await missing.sync(prEvent('opened'), missing.ctx) as { state: string; comment: boolean };
  assert.deepEqual([opened.state, opened.comment], ['missing_state', true], 'the comment is still posted and the delivery succeeds');
  assert.ok(missing.logs.some(l => l.level === 'warn' && /"Shipping" does not exist/.test(l.message)), 'reported in Activity');
  assert.equal(missing.linear('ProprMove').length, 0);
  const merged = await missing.sync(prEvent('merged'), missing.ctx) as { state: string };
  assert.equal(merged.state, 'moved', 'the next event is not blocked');
});

test('Linear refusals and rate limits fail the sync-back delivery as permanent or retried, and the retry posts nothing twice', async () => {
  const limited = await linked({}, { graphql: { ProprComment: GRAPHQL.rateLimited } });
  await assert.rejects(limited.sync(prEvent('opened'), limited.ctx), (error: unknown) => error instanceof PluginDeliveryError && !error.permanent);
  const refused = await linked({}, { graphql: { ProprComment: GRAPHQL.authenticationError } });
  await assert.rejects(refused.sync(prEvent('opened'), refused.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.permanent && /API key/.test(error.message));
  const state = await linked({ comments: ['pull_request_merged'], stateOnMerged: 'Done' }, { graphql: { ProprMove: GRAPHQL.rateLimited } });
  const input = prEvent('merged');
  await assert.rejects(state.sync(input, state.ctx));
  state.respond('https://api.linear.app/graphql', (_u, init) => (operation(init) === 'ProprMove' ? GRAPHQL.issueUpdated : operation(init) === 'ProprTeamStates' ? GRAPHQL.teamStates : GRAPHQL.commentCreated));
  await state.sync({ ...input, attempt: 2 }, state.ctx);
  assert.equal(state.comments().length, 1, 'the comment of the first attempt is not posted again');
});

test('the configure form\'s choices: teams and projects, workflow state names, and a clear message without a connection', async () => {
  const k = await kit();
  const teams = readPluginSettingOptions(await k.teamOptions({ kind: 'setting_options', setting: 'repositoryMapping' }, k.ctx));
  assert.deepEqual(teams, { options: [
    { value: `team:${ids.team}`, label: 'Team: Engineering (ENG)' },
    { value: `team:${ids.otherTeam}`, label: 'Team: Ops (OPS)' },
    { value: `project:${ids.project}`, label: 'Project: Login revamp' },
  ] });
  const states = readPluginSettingOptions(await k.stateOptions({ kind: 'setting_options', setting: 'stateOnMerged' }, k.ctx));
  assert.deepEqual(states, { options: [{ value: 'Done', label: 'Done (ENG, OPS)' }, { value: 'In Review', label: 'In Review (ENG)' }, { value: 'Todo', label: 'Todo (ENG, OPS)' }] });
  for (const request of k.requests) assert.equal(request.connection, 'api-key', 'read through ctx.http with the API key');

  const disconnected = await kit(MAPPED, { connections: [] });
  const none = readPluginSettingOptions(await disconnected.teamOptions({ kind: 'setting_options', setting: 'repositoryMapping' }, disconnected.ctx));
  assert.ok(none && 'notConnected' in none && /Set the Linear API key under Connections/.test(none.notConnected));
  const refused = await kit(MAPPED, { graphql: { ProprTeams: GRAPHQL.authenticationError } });
  const bad = readPluginSettingOptions(await refused.teamOptions({ kind: 'setting_options', setting: 'repositoryMapping' }, refused.ctx));
  assert.ok(bad && 'notConnected' in bad && /refused the API key/.test(bad.notConnected));
});
