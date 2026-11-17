import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  PluginDeliveryError, pluginOutboundHosts, pluginSettingProblem, validatePluginSettings,
  type PluginEventInput, type PluginHandler, type PluginHttpRequestInit, type PluginJsonValue, type PluginSettingOptions, type PluginSettingOptionsInput,
  type PluginSettingValues, type PluginWebhookInput, type RepositoryEvent,
} from '@propr/shared';
import { PLUGINS_ROOT, getOfficialPlugin, loadPluginHandlers } from '../src/index.js';
import { createTestPluginContext, type ScriptedHttpResponse } from '../testing/index.js';
import { adfComment, adfToMarkdown } from '../jira/adf.js';

/**
 * The Jira Cloud plugin's handlers against fixtures: signed Jira webhook
 * bodies (`jira/fixtures/webhooks.json`; the `X-Hub-Signature` itself is
 * checked by ProPR before the handler, in
 * packages/core/test/jiraPluginEvents.test.ts) and Jira REST API v3 answers
 * (`jira/fixtures/rest.json`). The ticket records and sync-back bookkeeping
 * are the shared tracker helper's, covered in depth by linear.test.ts and
 * trackerShared.test.ts.
 */

const fixture = <T>(file: string): T => JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'jira', 'fixtures', file), 'utf8')) as T;
interface SignedRequest { body: string; signature: string; identifier: string }
const HOOKS = fixture<{ receivedAt: number; ids: { projects: Record<string, string>; tickets: Record<string, string> }; requests: Record<string, SignedRequest> }>('webhooks.json');
const REST = fixture<{
  tickets: Record<string, PluginJsonValue>; transitions: PluginJsonValue; commentCreated: PluginJsonValue; projects: PluginJsonValue[];
  projectStatuses: Record<string, PluginJsonValue>; unauthorized: ScriptedHttpResponse; rateLimited: ScriptedHttpResponse;
}>('rest.json');

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3/`;
const BASE_SETTINGS: PluginSettingValues = {
  siteUrl: SITE, repositoryProjects: { 'acme/api': 'ENG', 'acme/onboarding': HOOKS.ids.projects.DES },
  openedState: 'In Review', mergedState: 'Done',
};

const plugin = () => getOfficialPlugin('jira', { includeDevelopment: false })!;
function settings(values: PluginSettingValues): PluginSettingValues {
  const { manifest } = plugin();
  const result = validatePluginSettings(manifest.settings, values);
  assert.ok(result.ok, JSON.stringify(result));
  const defaults = Object.fromEntries(Object.entries(manifest.settings.properties).flatMap(([key, s]) => (s.default !== undefined ? [[key, s.default]] : [])));
  return { ...defaults, ...result.settings } as PluginSettingValues;
}

interface Call { method: string; path: string; json: PluginJsonValue | undefined }
async function kit(values: PluginSettingValues = BASE_SETTINGS, options: { connections?: string[]; status?: string; rest?: (call: Call) => ScriptedHttpResponse | undefined; state?: Map<string, PluginJsonValue>; firstIssue?: number } = {}) {
  const { manifest } = plugin();
  let issues = (options.firstIssue ?? 101) - 1;
  const api = `${new URL(String(values.siteUrl)).origin}/rest/api/3/`;
  const k = createTestPluginContext({
    pluginId: 'jira', settings: settings(values), state: options.state ? Object.fromEntries(options.state) : undefined, grantedPermissions: manifest.permissions,
    outboundHosts: manifest.outboundHosts, outboundHostsFromSettings: manifest.outboundHostsFromSettings, settingDefinitions: manifest.settings.properties,
    connections: options.connections ?? manifest.connections.map(c => c.name), connectionDefinitions: manifest.connections,
    propr: {
      createIssue: async repository => { issues += 1; return { repository, number: issues, url: `https://github.com/${repository}/issues/${issues}` }; },
      getIssue: (repository, number) => ({ repository, number, title: 'x', state: 'open', url: `https://github.com/${repository}/issues/${number}`, labels: [], author: null, createdAt: '', updatedAt: '' }),
      getPullRequest: (repository, number) => ({ repository, number, title: 'x', state: 'open', url: `https://github.com/${repository}/pull/${number}`, labels: [], author: null, createdAt: '', updatedAt: '', draft: false, merged: false, headRef: `101/claude-fix-${number}`, baseRef: 'main', headSha: 'abc' }),
    },
  });
  const byId = Object.fromEntries(Object.entries(HOOKS.ids.tickets).map(([name, id]) => [id, name]));
  const callOf = (url: string, init: PluginHttpRequestInit): Call => ({ method: init.method ?? 'GET', path: url.slice(api.length), json: init.json });
  k.respond(api, (url, init) => {
    const call = callOf(url, init);
    const custom = options.rest?.(call);
    if (custom) return custom;
    const issue = /^issue\/(\d+)(\/\w+)?(?:\?fields=(.*))?$/.exec(call.path);
    if (issue && call.method === 'GET' && !issue[2]) {
      if (issue[3] === 'status') return { json: { id: issue[1], key: 'ENG-123', fields: { status: { name: options.status ?? 'To Do' } } } };
      const ticket = REST.tickets[byId[issue[1]]];
      return ticket ? { json: ticket } : { status: 404, json: { errorMessages: ['Issue does not exist or you do not have permission to see it.'] } };
    }
    if (issue?.[2] === '/transitions' && call.method === 'GET') return { json: REST.transitions };
    if (issue?.[2] === '/transitions' && call.method === 'POST') return { status: 204, body: '' };
    if (issue?.[2] === '/comment' && call.method === 'POST') return { status: 201, json: REST.commentCreated };
    if (call.path.startsWith('project/search?startAt=0&')) return { json: REST.projects[0] };
    if (call.path.startsWith('project/search?startAt=2&')) return { json: REST.projects[1] };
    const statuses = /^project\/([A-Z0-9]+)\/statuses$/.exec(call.path);
    const projectKey = statuses ? (Object.entries(HOOKS.ids.projects).find(([, pid]) => pid === statuses[1])?.[0] ?? statuses[1]) : null;
    if (projectKey) return REST.projectStatuses[projectKey] ? { json: REST.projectStatuses[projectKey] } : { status: 404, json: { errorMessages: ['No project'] } };
    return { status: 400, json: { errorMessages: ['unexpected'] } };
  });
  const handlers = (await loadPluginHandlers('jira', { includeDevelopment: false }))!;
  const jira = () => k.requests.filter(r => r.url.startsWith(api)).map(r => callOf(r.url, r.init));
  return {
    ...k, jira,
    comments: () => jira().filter(c => c.method === 'POST' && c.path.endsWith('/comment')),
    moves: () => jira().filter(c => c.method === 'POST' && c.path.endsWith('/transitions')),
    issues: () => k.calls.filter(c => c.operation === 'createIssue'),
    onJiraWebhook: handlers.onJiraWebhook as PluginHandler<PluginWebhookInput>,
    syncBack: handlers.syncBack as PluginHandler<PluginEventInput>,
    options: (name: string) => handlers[name] as PluginHandler<PluginSettingOptionsInput, PluginSettingOptions>,
  };
}

const webhook = (name: string, attempt = 1, deliveryId?: string): PluginWebhookInput => {
  const request = HOOKS.requests[name];
  return { kind: 'webhook', webhook: 'issues', headers: { 'content-type': 'application/json' }, body: request.body, receivedAt: HOOKS.receivedAt, deliveryId: deliveryId ?? `whk-issues:${request.identifier}`, attempt };
};

let seq = 900;
function event(domain: RepositoryEvent['domain'], type: string, overrides: Partial<RepositoryEvent> = {}): PluginEventInput {
  seq += 1;
  const value: RepositoryEvent = { seq, repository: 'acme/api', domain, type, entityId: '1', prNumber: null, issueNumber: null, planId: null, headSha: null, payload: {}, occurredAt: '2026-11-17T12:30:00.000Z', ...overrides };
  return { kind: 'event', event: value, deliveryId: `evt-${seq}-syncBack`, attempt: 1 };
}
const task = (type: string, extra: Record<string, unknown> = {}, issue: number | null = 101, pr: number | null = null) => event('task', type, {
  entityId: 'task-7', issueNumber: issue, prNumber: pr,
  payload: { taskId: 'task-7', kind: 'implementation', issueNumber: issue, prNumber: pr, agent: 'claude', model: 'claude-opus-5-5', attempts: 1, ...extra },
});
const pull = (type: string, payload: Record<string, unknown> = {}, pr = 55) => event('pull_request', type, { entityId: String(pr), prNumber: pr, payload });

/** A kit with ENG-123 already handed over as acme/api#101. */
async function handedOver(values: PluginSettingValues = BASE_SETTINGS, options: Parameters<typeof kit>[1] = {}) {
  const k = await kit(values, options);
  const handed = await k.onJiraWebhook(webhook('labelAdded'), k.ctx) as { outcome: string; issue: number };
  assert.deepEqual([handed.outcome, handed.issue], ['created', 101]);
  return k;
}

/** The text of an ADF comment ProPR posted, and its link. */
function commentText(json: PluginJsonValue | undefined): string {
  const body = (json as { body: { content: { content: { text: string; marks?: { attrs: { href: string } }[] }[] }[] } }).body;
  return body.content.map(p => p.content.map(n => (n.marks?.[0]?.attrs?.href ? `[${n.text}](${n.marks[0].attrs.href})` : n.text)).join('')).join('\n');
}

test('the manifest: an X-Hub-Signature sha256 webhook with X-Atlassian-Webhook-Identifier ids, Basic credentials, the configured *.atlassian.net site as the only host, choices through optionsFrom', () => {
  const { manifest, assets } = plugin();
  assert.equal(manifest.category, 'issue-tracking');
  assert.deepEqual(manifest.contributes.webhooks.map(w => [w.name, w.handler, w.deliveryIdHeader, w.verification]), [
    ['issues', 'onJiraWebhook', 'x-atlassian-webhook-identifier', { scheme: 'hmac-sha256', header: 'x-hub-signature', prefix: 'sha256=', encoding: 'hex', connection: 'webhook-secret' }],
  ]);
  assert.deepEqual(manifest.connections.map(c => [c.name, c.type, c.type === 'token' ? c.authorization ?? 'bearer' : null]), [['api-token', 'token', 'basic'], ['webhook-secret', 'signing_secret', null]]);
  assert.deepEqual([manifest.outboundHosts, manifest.outboundHostsFromSettings], [[], ['siteUrl']]);
  const site = manifest.settings.properties.siteUrl;
  assert.deepEqual(site.type === 'string' ? [site.format, site.hosts] : null, ['https-url', ['*.atlassian.net']]);
  assert.deepEqual(manifest.settings.required, ['siteUrl']);
  const optionsFrom = Object.fromEntries(Object.entries(manifest.settings.properties).flatMap(([key, s]) => ((s.type === 'string' || s.type === 'object') && s.optionsFrom ? [[key, s.optionsFrom]] : [])));
  assert.deepEqual(optionsFrom, { repositoryProjects: 'projectOptions', openedState: 'stateOptions', mergedState: 'stateOptions' });
  assert.deepEqual(manifest.contributes.mcpServers, [], 'Atlassian\'s MCP server is not contributed (see the README)');
  assert.deepEqual(manifest.contributes.skills.map(s => s.name), ['jira-ticket']);
  assert.ok(assets.handlers);
  assert.deepEqual([...new Set(manifest.contributes.subscriptions.map(s => s.handler))], ['syncBack']);
});

test('a site URL outside *.atlassian.net is refused when the settings are saved, and adds no outbound host', () => {
  const { manifest } = plugin();
  const site = manifest.settings.properties.siteUrl;
  for (const url of ['https://acme.atlassian.net', 'https://acme.atlassian.net/', 'https://ACME.atlassian.net/jira/your-work']) {
    assert.equal(pluginSettingProblem('siteUrl', site, url), null, url);
    assert.ok(validatePluginSettings(manifest.settings, { siteUrl: url }).ok, url);
  }
  const refused: Record<string, string> = {
    'https://jira.example.com': 'siteUrl must be on *.atlassian.net, not jira.example.com',
    'https://acme.atlassian.net.evil.example': 'siteUrl must be on *.atlassian.net, not acme.atlassian.net.evil.example',
    'https://atlassian.net': 'siteUrl must be on *.atlassian.net, not atlassian.net',
    'https://evilatlassian.net': 'siteUrl must be on *.atlassian.net, not evilatlassian.net',
    'http://acme.atlassian.net': 'siteUrl must be an https:// URL, not http',
    'https://user:pw@acme.atlassian.net': 'siteUrl must not carry a user name or password',
  };
  for (const [url, message] of Object.entries(refused)) {
    assert.equal(pluginSettingProblem('siteUrl', site, url), message, url);
    assert.deepEqual(validatePluginSettings(manifest.settings, { siteUrl: url }), { ok: false, errors: [message] }, url);
  }
  // A URL off the hosts saved before (or forced past validation) gives the handlers no host at all.
  assert.deepEqual(pluginOutboundHosts(manifest, { siteUrl: 'https://jira.example.com' }), []);
  assert.deepEqual(pluginOutboundHosts(manifest, { siteUrl: 'https://acme.atlassian.net/x' }), ['acme.atlassian.net']);
});

test('the trigger label added on a mapped ticket creates exactly one GitHub issue with the link and the trigger label; a repeated or replayed webhook creates no second one', async () => {
  const k = await kit();
  const first = await k.onJiraWebhook(webhook('labelAdded'), k.ctx);
  assert.deepEqual(first, { outcome: 'created', reason: null, ticket: 'ENG-123', repository: 'acme/api', issue: 101 });
  assert.deepEqual(k.jira().map(c => [c.method, c.path]), [['GET', `issue/${HOOKS.ids.tickets.mapped}?fields=summary,description,labels,project,status`]], 'the ticket is read back from the configured site by id');
  const [repository, issue] = k.issues()[0].args as [string, { title: string; body: string; labels: string[] }];
  assert.equal(repository, 'acme/api');
  assert.equal(issue.title, 'ENG-123: Fix the redirect after login');
  assert.deepEqual(issue.labels, ['AI']);
  assert.match(issue.body, /^Handed to ProPR from the Jira ticket \[ENG-123\]\(https:\/\/acme\.atlassian\.net\/browse\/ENG-123\) by adding the `propr` label\./);
  assert.match(issue.body, /\n> Users land on \/home instead of the page they asked for\.\n>\n> - keep the query string\n> - \*\*see\*\* the docs \(https:\/\/example\.com\/docs\)\n/);

  // The same delivery again (a ProPR retry), Jira sending the label change again, and another delivery id: no second issue.
  for (const again of [webhook('labelAdded', 2), webhook('labelAddedAgain'), webhook('labelAdded', 1, 'whk-issues:9999')]) {
    assert.deepEqual(await k.onJiraWebhook(again, k.ctx), { outcome: 'duplicate', reason: null, ticket: 'ENG-123', repository: 'acme/api', issue: 101 });
  }
  assert.equal(k.issues().length, 1);
});

test('unmapped projects, other label changes, a kept or removed label, other updates and other events create nothing, without asking Jira', async () => {
  const k = await kit();
  const outcomes: Record<string, unknown> = {};
  for (const name of ['unmapped', 'otherLabel', 'labelKept', 'labelRemoved', 'titleEdit', 'comment']) {
    const result = await k.onJiraWebhook(webhook(name), k.ctx) as { outcome: string; reason: string };
    outcomes[name] = [result.outcome, result.reason];
  }
  assert.deepEqual(outcomes, {
    unmapped: ['ignored', 'unmapped'], otherLabel: ['ignored', 'other_label'], labelKept: ['ignored', 'other_label'], labelRemoved: ['ignored', 'other_label'],
    titleEdit: ['ignored', 'no_label_added'], comment: ['ignored', 'not_an_issue_event'],
  });
  assert.equal(k.issues().length, 0);
  assert.deepEqual(k.jira(), [], 'none of them asked Jira anything');
  assert.equal((await k.onJiraWebhook({ ...webhook('labelAdded'), body: 'not json' }, k.ctx) as { reason: string }).reason, 'not_json');

  // A project mapped to two repositories hands nothing over; a label removed again before the ticket is read hands nothing over.
  const twice = await kit({ ...BASE_SETTINGS, repositoryProjects: { 'acme/api': 'ENG', 'acme/web': HOOKS.ids.projects.ENG } });
  assert.equal((await twice.onJiraWebhook(webhook('labelAdded'), twice.ctx) as { reason: string }).reason, 'ambiguous');
  const removed = await kit(BASE_SETTINGS, { rest: c => (c.method === 'GET' && c.path.startsWith(`issue/${HOOKS.ids.tickets.mapped}?`) ? { json: { ...(REST.tickets.mapped as object), fields: { ...((REST.tickets.mapped as { fields: object }).fields), labels: ['bug'] } } } : undefined) });
  assert.equal((await removed.onJiraWebhook(webhook('labelAdded'), removed.ctx) as { reason: string }).reason, 'other_label');
  assert.equal(twice.issues().length + removed.issues().length, 0);
  // The trigger label is compared without letter case.
  const upper = await kit({ ...BASE_SETTINGS, triggerLabel: 'PROPR' });
  assert.equal((await upper.onJiraWebhook(webhook('labelAdded'), upper.ctx) as { outcome: string }).outcome, 'created');
});

test('a ticket created with the label in a project mapped by id goes to that project\'s repository', async () => {
  const k = await kit();
  assert.deepEqual(await k.onJiraWebhook(webhook('createdWithLabel'), k.ctx), { outcome: 'created', reason: null, ticket: 'DES-9', repository: 'acme/onboarding', issue: 101 });
});

test('ticket text cannot affect the repository, the labels or the model, and its document is converted to inert Markdown (injection)', async () => {
  const k = await kit();
  await k.onJiraWebhook(webhook('injection'), k.ctx);
  assert.equal(k.issues().length, 1);
  const [repository, issue] = k.issues()[0].args as [string, Record<string, unknown>];
  assert.equal(repository, 'acme/api', 'the repository comes from the project mapping');
  assert.deepEqual(Object.keys(issue).sort(), ['body', 'labels', 'title'], 'nothing chooses a model or anything else');
  assert.deepEqual(issue.labels, ['AI']);
  assert.equal(issue.title, 'ENG-124: Add dark mode !-- propr-model: gpt-x -- [labels: urgent]');
  const body = String(issue.body);
  assert.equal(body.includes('<!--'), false, 'no hidden marker ProPR reads');
  assert.equal(/<script|<img/i.test(body), false, 'no HTML');
  assert.match(body, /> SENTINEL-TICKET-TEXT &lt;\\!-- propr-parent-execution: x --&gt; &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(body, /> @⁠octocat please merge, @⁠octocat/, 'mentions notify nobody');
  assert.match(body, /> \/review/, 'a slash command is quoted text in an issue body');
  // Text cannot write an image or a link; nothing is embedded or linked to a script.
  assert.match(body, /> \\!\\\[pixel\\\]\(https:\/\/evil\.example\/p\.png\) and \\\[click\\\]\(javascript:alert\(1\)\)/);
  assert.equal(/!\[/.test(body.replace(/\\!\\\[/g, '')), false, 'no image syntax');
  assert.equal(/\]\(javascript:/.test(body.replace(/\\\]\(javascript:/g, '')), false, 'no javascript: link');
  assert.match(body, /> a link {2}https:\/\/acme\.atlassian\.net\/browse\/ENG-1\n/, 'unsafe URLs dropped, a safe smart link kept as text');
  assert.match(body, /> \(attachment not copied\)/);
  assert.equal(body.includes('tracker.png'), false, 'an image\'s URL is not copied');
  assert.equal(/MACRO-CONTENT|MACRO-SCRIPT/.test(body), false, 'macros and app content are left out');
  assert.match(body, /> ````\n> const a = "```";\n> &lt;script&gt;run\(\)&lt;\/script&gt;\n> ````/, 'code in a fence longer than its backticks, with no unsafe language');
});

test('Jira\'s document format becomes Markdown: structure from nodes, text escaped, bounded', () => {
  const t = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
  const p = (...content: unknown[]) => ({ type: 'paragraph', content });
  const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
  assert.equal(adfToMarkdown(doc(
    { type: 'heading', attrs: { level: 2 }, content: [t('Steps')] },
    { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [p(t('open')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('nested'))] }] }] }, { type: 'listItem', content: [p(t('close'))] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [t('done')] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [t('todo')] }] },
    { type: 'blockquote', content: [p(t('quoted'))] },
    { type: 'rule' },
    { type: 'table', content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('a'))] }, { type: 'tableHeader', content: [p(t('b|c'))] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('1'))] }] },
    ] },
    p(t('x', [{ type: 'em' }]), t(' '), t('y', [{ type: 'strike' }]), t(' '), t('a`b', [{ type: 'code' }]), { type: 'hardBreak' }, { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } }, t(' '), { type: 'date', attrs: { timestamp: '1763337600000' } }, t(' '), { type: 'status', attrs: { text: 'BLOCKED' } }),
    { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('in a panel'))] },
    { type: 'expand', attrs: { title: 'More' }, content: [p(t('hidden'))] },
  )), [
    '## Steps', '',
    '3. open', '', '   - nested', '4. close', '',
    '- [x] done', '- [ ] todo', '',
    '> quoted', '', '---', '',
    '| a | b\\|c |', '| --- | --- |', '| 1 |  |', '',
    '_x_ ~~y~~ ``a`b``', '😄 2025-11-17 BLOCKED', '',
    'in a panel', '', '**More**', '', 'hidden',
  ].join('\n'));
  assert.equal(adfToMarkdown('plain *text* [x](y)'), 'plain \\*text\\* \\[x\\](y)', 'an older API\'s plain text is escaped too');
  assert.equal(adfToMarkdown(null), '');
  assert.equal(adfToMarkdown({ type: 'paragraph' }), '', 'not a document');
  // Deep nesting and huge documents are cut, not followed.
  let deep: Record<string, unknown> = p(t('bottom'));
  for (let i = 0; i < 100; i += 1) deep = { type: 'blockquote', content: [deep] };
  assert.equal(adfToMarkdown(doc(deep)).includes('bottom'), false);
  const huge = adfToMarkdown(doc(...Array.from({ length: 30_000 }, (_v, i) => p(t(`line ${i}`)))));
  assert.ok(huge.length <= 60_001 && !huge.includes('line 29999'));
  // ProPR's own comment, as Jira takes it.
  assert.deepEqual(adfComment('Done.', { label: 'acme/api#5', url: 'https://github.com/acme/api/pull/5' }), {
    type: 'doc', version: 1, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Done.' }, { type: 'text', text: ' ' }, { type: 'text', text: 'acme/api#5', marks: [{ type: 'link', attrs: { href: 'https://github.com/acme/api/pull/5' } }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Posted by ProPR.', marks: [{ type: 'em' }] }] },
    ],
  });
});

test('each sync-back event posts its comment and transition when switched on, once, and nothing when off', async () => {
  const k = await handedOver();
  const id = HOOKS.ids.tickets.mapped;
  const expected: [PluginEventInput, string, string | null][] = [
    [task('started'), 'ProPR started working on this ticket. [acme/api#101](https://github.com/acme/api/issues/101)', null],
    [task('completed', { status: 'completed', pullRequest: 'opened' }, 101, 55), 'ProPR opened a pull request for this ticket. [acme/api#55](https://github.com/acme/api/pull/55)', '21'],
    [pull('review_scored', { score: 91.6, goal: 85, goalReached: true, source: 'review' }), 'The review of the pull request for this ticket reached its goal: score 92 (goal 85). [acme/api#55](https://github.com/acme/api/pull/55)', null],
    [pull('merged'), 'The pull request for this ticket was merged. [acme/api#55](https://github.com/acme/api/pull/55)', '31'],
    [pull('closed'), 'The pull request for this ticket was closed without merging. [acme/api#55](https://github.com/acme/api/pull/55)', null],
    [task('failed', { status: 'failed', failureCategory: 'timed_out' }), 'ProPR\'s task for this ticket failed (timed_out). ProPR shows the details. [acme/api#101](https://github.com/acme/api/issues/101)', null],
  ];
  for (const [input, sentence, transition] of expected) {
    const before = [k.comments().length, k.moves().length];
    await k.syncBack(input, k.ctx);
    assert.deepEqual(k.comments().slice(before[0]).map(c => [c.path, commentText(c.json)]), [[`issue/${id}/comment`, `${sentence}\nPosted by ProPR.`]], sentence);
    assert.deepEqual(k.moves().slice(before[1]).map(c => [c.path, c.json]), transition ? [[`issue/${id}/transitions`, { transition: { id: transition } }]] : [], sentence);
    const again = [k.comments().length, k.moves().length];
    assert.deepEqual((await k.syncBack({ ...input, attempt: 2 }, k.ctx) as { skipped: string }).skipped, 'done');
    assert.deepEqual([k.comments().length, k.moves().length], again, 'redelivered: nothing again');
  }
  for (const input of [pull('review_scored', { score: 60, goal: 85, goalReached: false }), task('started', { kind: 'follow-up' }), { ...task('started'), event: { ...task('started').event, repository: 'acme/web' } }]) {
    await k.syncBack(input, k.ctx);
  }
  assert.equal(k.comments().length, expected.length);

  // Switched off: no comments; without status names: no transitions.
  const off = await handedOver({ ...BASE_SETTINGS, syncEvents: [], openedState: null as unknown as string, mergedState: null as unknown as string });
  for (const [input] of expected) assert.equal((await off.syncBack({ ...input, deliveryId: `${input.deliveryId}-off` }, off.ctx) as { skipped: string }).skipped, 'switched_off');
  assert.deepEqual([off.comments().length, off.moves().length], [0, 0]);
  const one = await handedOver({ ...BASE_SETTINGS, syncEvents: ['pull_request.merged'], openedState: null as unknown as string });
  for (const [input] of expected) await one.syncBack(input, one.ctx);
  assert.deepEqual(one.comments().map(c => commentText(c.json).split('.')[0]), ['The pull request for this ticket was merged']);
  assert.deepEqual(one.moves().map(c => c.json), [{ transition: { id: '31' } }]);
});

test('tracked tickets are bound to their Jira site: after the site URL changes, the old site\'s tickets are not updated on the new one, and the new one\'s ticket with the same id is not a duplicate', async () => {
  const OTHER = 'https://other.atlassian.net';
  const id = HOOKS.ids.tickets.mapped;
  const onSite = (site: string): PluginWebhookInput => ({ ...webhook('labelAdded', 1, `whk-issues:${site}`), body: HOOKS.requests.labelAdded.body.replaceAll(SITE, site) });
  const a = await handedOver();
  assert.deepEqual([...a.state.values()].flatMap(v => (Array.isArray(v) ? v : [])).map(r => (r as { t: string }).t), [`acme.atlassian.net/${id}`], 'recorded under the site and the id');

  // The site URL changes: ENG-123 of acme (acme/api#101) is not commented on or moved on the other site, and nothing is marked done.
  const b = await kit({ ...BASE_SETTINGS, siteUrl: OTHER }, { state: a.state, firstIssue: 201 });
  for (const input of [task('started'), task('completed', { status: 'completed', pullRequest: 'opened' }, 101, 55), pull('merged')]) {
    assert.deepEqual(await b.syncBack(input, b.ctx), { event: input.event.domain === 'task' ? `task.${input.event.type}` : `pull_request.${input.event.type}`, ticket: 'ENG-123', skipped: 'other_site', commented: false, moved: null, problems: [] });
  }
  assert.deepEqual(b.requests, [], 'no site was called');
  assert.ok(b.logs.some(line => line.level === 'warn' && line.message === 'ENG-123 was handed over from another Jira site than the configured one, so it was not updated. Set the Jira site URL back to update it'));
  // A webhook still coming from acme is not read on the other site by its id.
  assert.deepEqual(await b.onJiraWebhook(webhook('labelAdded'), b.ctx), { outcome: 'ignored', reason: 'other_site', ticket: null, repository: null, issue: null });
  assert.deepEqual(b.requests, []);
  // The other site's own ticket with the same id is handed over, not taken for acme's, and syncs back to the other site.
  assert.deepEqual(await b.onJiraWebhook(onSite(OTHER), b.ctx), { outcome: 'created', reason: null, ticket: 'ENG-123', repository: 'acme/api', issue: 201 });
  assert.match(String((b.issues()[0].args[1] as { body: string }).body), /\(https:\/\/other\.atlassian\.net\/browse\/ENG-123\)/);
  await b.syncBack(task('started', {}, 201), b.ctx);
  assert.deepEqual(b.comments().map(c => c.path), [`issue/${id}/comment`]);
  assert.ok(b.requests.every(r => r.url.startsWith(`${OTHER}/rest/api/3/`)), 'only the other site is called');

  // Set back: acme's ticket syncs again (nothing was marked done meanwhile), the other site's is left alone, and acme's ticket is still a duplicate.
  const back = await kit(BASE_SETTINGS, { state: b.state, firstIssue: 301 });
  assert.equal((await back.syncBack(task('started'), back.ctx) as { commented: boolean }).commented, true);
  assert.equal((await back.syncBack(task('failed', { status: 'failed', failureCategory: 'timed_out' }, 201), back.ctx) as { skipped: string }).skipped, 'other_site');
  assert.equal((await back.onJiraWebhook(onSite(SITE), back.ctx) as { outcome: string; issue: number }).issue, 101);
  assert.deepEqual([back.comments().map(c => commentText(c.json).split('.')[0]), back.issues().length], [['ProPR started working on this ticket'], 0]);
  assert.ok(back.requests.every(r => r.url.startsWith(API)));
});

test('a status no transition reaches is reported in Activity and does not block the comment or later events; a ticket already there is not moved', async () => {
  const k = await handedOver({ ...BASE_SETTINGS, openedState: 'Code Review' });
  const result = await k.syncBack(task('completed', { status: 'completed', pullRequest: 'opened' }, 101, 55), k.ctx) as { commented: boolean; moved: string | null; problems: string[] };
  assert.deepEqual([result.commented, result.moved], [true, null]);
  assert.deepEqual(result.problems, ['Jira offers no transition to a status named "Code Review" from its current status "To Do" for ENG-123, so it was not moved. Choose a status the project\'s workflow reaches in the plugin\'s settings']);
  assert.ok(k.logs.some(line => line.level === 'warn' && line.message.includes('no transition to a status named "Code Review"')));
  await k.syncBack(pull('merged'), k.ctx);
  assert.deepEqual(k.moves().map(c => c.json), [{ transition: { id: '31' } }], 'the merged move still happens');
  assert.equal(k.comments().length, 2);

  const there = await handedOver(BASE_SETTINGS, { status: 'in review' });
  const opened = await there.syncBack(task('completed', { status: 'completed', pullRequest: 'opened' }, 101, 55), there.ctx) as { moved: string | null; problems: string[] };
  assert.deepEqual([opened.moved, opened.problems, there.moves().length], [null, [], 0]);
  assert.ok(there.logs.some(line => line.message === 'ENG-123 is already in in review'));
});

test('a failed comment is retried with the delivery while a done transition is not repeated; Jira\'s refusals are readable and never quote Jira', async () => {
  let failing = true;
  const k = await handedOver(BASE_SETTINGS, { rest: c => (c.path.endsWith('/comment') && failing ? REST.rateLimited : undefined) });
  const input = task('completed', { status: 'completed', pullRequest: 'opened' }, 101, 55);
  await assert.rejects(k.syncBack(input, k.ctx), (error: unknown) => error instanceof PluginDeliveryError && !error.permanent && error.retryAfterMs === 30_000);
  assert.equal(k.moves().length, 1, 'the transition went ahead');
  failing = false;
  await k.syncBack({ ...input, attempt: 2 }, k.ctx);
  assert.deepEqual([k.comments().length, k.moves().length], [2, 1]);

  const unauthorized = await handedOver(BASE_SETTINGS, { rest: c => (c.path.endsWith('/comment') ? REST.unauthorized : undefined) });
  await assert.rejects(unauthorized.syncBack(task('started'), unauthorized.ctx), (error: unknown) => error instanceof PluginDeliveryError && error.permanent
    && error.message === 'Jira refused the comment on ENG-123 with UNAUTHORIZED; it is not retried. Check the account email and API token under Connections');
  const unreadable = await kit(BASE_SETTINGS, { rest: c => (c.method === 'GET' ? { status: 503, body: 'down' } : undefined) });
  await assert.rejects(unreadable.onJiraWebhook(webhook('labelAdded'), unreadable.ctx), (error: unknown) => error instanceof PluginDeliveryError && !error.permanent && /Jira answered HTTP_503 for reading the ticket/.test(error.message));
  assert.equal(unreadable.issues().length, 0);
});

test('the configure form\'s choices: projects (paged) and the mapped projects\' workflow statuses from Jira, and clear errors before Jira is connected', async () => {
  const k = await kit();
  const input = (setting: string): PluginSettingOptionsInput => ({ kind: 'setting_options', setting });
  assert.deepEqual(await k.options('projectOptions')(input('repositoryProjects'), k.ctx), { options: [
    { value: 'DES', label: 'Design (DES)' }, { value: 'ENG', label: 'Engineering (ENG)' }, { value: 'OPS', label: 'Operations (OPS)' },
  ] });
  assert.deepEqual(await k.options('stateOptions')(input('openedState'), k.ctx), { options: [
    { value: 'Done', label: 'Done (10001, ENG)' }, { value: 'In Review', label: 'In Review (ENG)' }, { value: 'To Do', label: 'To Do (10001, ENG)' },
  ] }, 'a project mapped by id is read by id');
  const statuses = k.jira().filter(c => c.path.endsWith('/statuses')).map(c => c.path);
  assert.deepEqual([...new Set(statuses)], ['project/ENG/statuses', `project/${HOOKS.ids.projects.DES}/statuses`]);

  const byKey = await kit({ ...BASE_SETTINGS, repositoryProjects: { 'acme/api': 'ENG', 'acme/onboarding': 'DES' } });
  assert.deepEqual(await byKey.options('stateOptions')(input('mergedState'), byKey.ctx), { options: [
    { value: 'Done', label: 'Done (DES, ENG)' }, { value: 'In Review', label: 'In Review (ENG)' }, { value: 'To Do', label: 'To Do (DES, ENG)' },
  ] });
  const unmapped = await kit({ siteUrl: SITE });
  await assert.rejects(unmapped.options('stateOptions')(input('openedState'), unmapped.ctx), /Map a repository to a Jira project under Repository projects and save first/);
  const unset = await kit(BASE_SETTINGS, { connections: ['webhook-secret'] });
  await assert.rejects(unset.options('projectOptions')(input('repositoryProjects'), unset.ctx), (error: unknown) => error instanceof PluginDeliveryError
    && error.message === 'Jira is not connected yet. Set the Jira site URL, save, set the account email and API token under Connections, then choose Reload choices.');
  const refused = await kit(BASE_SETTINGS, { rest: () => REST.unauthorized });
  await assert.rejects(refused.options('projectOptions')(input('repositoryProjects'), refused.ctx), /Jira refused the list for repositoryProjects with UNAUTHORIZED/);
});

test('no ticket text is sent anywhere but into the GitHub issue, and nothing from code, logs or the task reaches Jira (sentinel)', async () => {
  const k = await kit();
  await k.onJiraWebhook(webhook('injection'), k.ctx);
  const sentinel = 'SENTINEL-TASK-OUTPUT';
  const inputs = [
    task('started', { prompt: sentinel, log: sentinel }, 101), task('completed', { status: 'completed', pullRequest: 'opened', terminalReason: sentinel }, 101, 55),
    pull('review_scored', { score: 95, goal: 90, goalReached: true, reviewerModel: sentinel, summary: sentinel }), pull('merged', { title: sentinel }),
    task('failed', { status: 'failed', failureCategory: `${sentinel} with spaces`, terminalReason: sentinel }, 101),
  ];
  for (const input of inputs) await k.syncBack(input, k.ctx);
  assert.equal(k.comments().length, inputs.length);
  const outbound = JSON.stringify(k.requests.map(r => [r.url, r.init]));
  for (const marker of ['SENTINEL-TICKET-TEXT', 'Add dark mode', sentinel]) assert.equal(outbound.includes(marker), false, `${marker} sent to Jira`);
  const logs = JSON.stringify(k.logs);
  for (const marker of ['SENTINEL-TICKET-TEXT', 'Add dark mode', sentinel]) assert.equal(logs.includes(marker), false, `${marker} logged`);
  assert.match(String((k.issues()[0].args[1] as { body: string }).body), /SENTINEL-TICKET-TEXT/);
  assert.ok(k.requests.every(r => r.url.startsWith(`${SITE}/rest/api/3/`)), 'only the configured site is called');
});
