import test from 'node:test';
import assert from 'node:assert/strict';
import { PLUGIN_PROPR_OPERATIONS, PLUGIN_PERMISSIONS, type PluginJsonValue } from '@propr/shared';
import { runPluginHandler } from '../src/plugins/pluginHandlerRunner.js';
import { githubPluginProprBackend } from '../src/plugins/pluginProprBackend.js';
import { pluginAttributionMarker, scopedProprClient, type PluginProprCallRecord } from '../src/plugins/pluginProprClient.js';
import type { IssueJobData } from '../src/queue/taskQueue.types.js';
import { taskIntentIssueRef } from '../src/services/taskIntentIssueRef.js';
import { FIXTURE_ID, pluginHandlerFixture } from './helpers/pluginHandlerFixture.js';

type CallResult = { ok: boolean; value?: PluginJsonValue; code?: string; message?: string };

async function proprFixture(t: Parameters<typeof pluginHandlerFixture>[0]) {
  const f = await pluginHandlerFixture(t);
  const call = async (operation: string, ...args: PluginJsonValue[]) => {
    const run = await runPluginHandler(FIXTURE_ID, 'callPropr', { kind: 'invoke', payload: { operation, args } }, f.options);
    assert.equal(run.outcome, 'succeeded', run.error ?? '');
    return { ...(run.result as CallResult), logs: run.logs };
  };
  const audit = async () => (await f.database('plugin_audit').whereIn('action', ['handler_call', 'handler_refused']).orderBy('id').select('action', 'actor', 'detail'))
    .map(row => ({ action: row.action as string, actor: row.actor as string, ...JSON.parse(row.detail) as Record<string, unknown> }));
  return { ...f, call, audit };
}

test('every ctx.propr operation names a permission of the closed set', () => {
  for (const permission of Object.values(PLUGIN_PROPR_OPERATIONS)) assert.ok((PLUGIN_PERMISSIONS as readonly string[]).includes(permission), permission);
});

test('ctx.propr refuses operations outside the granted permissions, and logs and records the refusal', async t => {
  const f = await proprFixture(t);
  // The fixture does not ask for pull_requests.read or pull_requests.comment.
  for (const [operation, args, permission] of [['getPullRequest', ['owner/allowed', 7], 'pull_requests.read'], ['commentOnPullRequest', ['owner/allowed', 7, 'hello'], 'pull_requests.comment']] as const) {
    const result = await f.call(operation, ...args);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'permission_denied');
    assert.match(result.message ?? '', new RegExp(permission.replace('.', '\\.')));
    assert.deepEqual(result.logs.map(l => [l.level, l.message]), [['warn', `ctx.propr.${operation} refused: permission_denied`]]);
  }
  assert.deepEqual(f.calls, [], 'a refused call never reaches the backend');

  // A permission granted at install that the current manifest dropped is not usable either.
  await f.database('plugin_installations').where({ plugin_id: FIXTURE_ID }).update({ granted_permissions: JSON.stringify(['tasks.read', 'pull_requests.read']) });
  assert.equal((await f.call('getPullRequest', 'owner/allowed', 7)).code, 'permission_denied');
  assert.equal((await f.call('listEvents', { repository: 'owner/allowed' })).code, 'permission_denied', 'a requested but ungranted permission is refused');
  assert.equal((await f.call('getTask', 'task-1')).ok, true);

  const audit = await f.audit();
  assert.deepEqual(audit.map(a => [a.action, a.actor, a.operation, a.reason ?? null]), [
    ['handler_refused', `plugin:${FIXTURE_ID}`, 'getPullRequest', 'permission_denied'],
    ['handler_refused', `plugin:${FIXTURE_ID}`, 'commentOnPullRequest', 'permission_denied'],
    ['handler_refused', `plugin:${FIXTURE_ID}`, 'getPullRequest', 'permission_denied'],
    ['handler_refused', `plugin:${FIXTURE_ID}`, 'listEvents', 'permission_denied'],
    ['handler_call', `plugin:${FIXTURE_ID}`, 'getTask', null],
  ]);
  assert.equal(audit[0].handler, 'callPropr');
});

test('ctx.propr refuses repositories outside the installation limit, tasks of other repositories included', async t => {
  const f = await proprFixture(t);
  for (const [operation, args] of [
    ['getIssue', ['other/repo', 3]], ['createIssue', ['other/repo', { title: 'x' }]], ['createTask', ['Other/Repo', 3]],
    ['commentOnIssue', ['other/repo', 3, 'hi']], ['addLabel', ['other/repo', 3, 'bug']], ['removeLabel', ['other/repo', 3, 'bug']],
    ['listEvents', [{ repository: 'other/repo' }]],
  ] as const) {
    const result = await f.call(operation, ...(args as unknown as PluginJsonValue[]));
    assert.equal(result.code, 'repository_not_allowed', `${operation}: ${result.message}`);
  }
  assert.deepEqual(f.calls, [], 'no call outside the limit reaches the backend');
  // A task is read before its repository is known: one outside the limit is not returned.
  const elsewhere = await f.call('getTask', 'elsewhere');
  assert.equal(elsewhere.code, 'repository_not_allowed');
  assert.equal(elsewhere.value, undefined);
  assert.equal((await f.call('getTask', 'missing')).code, 'not_found');
  // The limit is case-insensitive, like GitHub names.
  assert.equal((await f.call('getIssue', 'Owner/Allowed', 3)).ok, true);
  // Invalid input is refused before the backend too.
  assert.equal((await f.call('getIssue', 'not-a-repo', 3)).code, 'invalid_input');
  assert.equal((await f.call('getIssue', 'owner/allowed', -1)).code, 'invalid_input');
  assert.equal((await f.call('createIssue', 'owner/allowed', { title: '' })).code, 'invalid_input');
  assert.equal((await f.call('listEvents', { repository: 'owner/allowed', afterSeq: -1 })).code, 'invalid_input');
  assert.equal((await f.call('listEvents', { repository: 'owner/allowed', domains: ['secrets'] })).code, 'invalid_input');
});

test('allowed ctx.propr operations reach the backend attributed to the plugin', async t => {
  const f = await proprFixture(t);
  assert.equal((await f.call('getIssue', 'owner/allowed', 3)).ok, true);
  assert.equal((await f.call('listEvents', { repository: 'owner/allowed', limit: 5000, afterSeq: 4, domains: ['task'] })).ok, true);
  const created = await f.call('createIssue', 'owner/allowed', { title: 'Follow up', body: 'From the chat', labels: ['triage'] });
  assert.deepEqual(created.value, { repository: 'owner/allowed', number: 11, url: 'https://github.com/owner/allowed/issues/11' });
  assert.deepEqual((await f.call('createTask', 'owner/allowed', 11)).value, { repository: 'owner/allowed', issueNumber: 11, jobId: 'issue-owner-allowed-11' });
  assert.equal((await f.call('commentOnIssue', 'owner/allowed', 3, 'Linked thread')).ok, true);
  assert.equal((await f.call('addLabel', 'owner/allowed', 3, 'synced')).ok, true);
  assert.equal((await f.call('removeLabel', 'owner/allowed', 3, 'synced')).ok, true);

  const marker = pluginAttributionMarker(FIXTURE_ID);
  assert.deepEqual(f.calls.map(c => c.operation), ['getIssue', 'listEvents', 'createIssue', 'createTask', 'comment', 'addLabel', 'removeLabel']);
  assert.deepEqual(f.calls[1].args[0], { repository: 'owner/allowed', afterSeq: 4, domains: ['task'], limit: 100 }, 'event lists are bounded');
  assert.deepEqual(f.calls[2].args, ['owner/allowed', { title: 'Follow up', body: `From the chat\n\n${marker}`, labels: ['triage'] }]);
  assert.deepEqual(f.calls[3].args, ['owner/allowed', 11, { requestedBy: `plugin:${FIXTURE_ID}` }]);
  assert.equal(f.calls[4].args[2], `Linked thread\n\n${marker}`);

  const audit = await f.audit();
  assert.ok(audit.every(a => a.action === 'handler_call' && a.actor === `plugin:${FIXTURE_ID}` && a.handler === 'callPropr'));
  assert.deepEqual(audit.map(a => [a.operation, a.permission, a.repository, a.number ?? null]), [
    ['getIssue', 'issues.read', 'owner/allowed', 3],
    ['listEvents', 'events.read', 'owner/allowed', null],
    ['createIssue', 'issues.create', 'owner/allowed', null],
    ['createTask', 'tasks.create', 'owner/allowed', 11],
    ['commentOnIssue', 'issues.comment', 'owner/allowed', 3],
    ['addLabel', 'labels.write', 'owner/allowed', 3],
    ['removeLabel', 'labels.write', 'owner/allowed', 3],
  ]);
  // The audit trail an administrator reads shows them with the plugin as the actor.
  const detail = await f.store.get('1', FIXTURE_ID);
  assert.equal(detail.audit[0].action, 'handler_call');
  assert.equal(detail.audit[0].actor, `plugin:${FIXTURE_ID}`);
  assert.equal(detail.audit[0].detail.operation, 'removeLabel');
});

test('the GitHub backend queues the task with the plugin as requester, which the task keeps in its first event', async t => {
  const f = await pluginHandlerFixture(t);
  const jobs: { data: IssueJobData; jobId: string }[] = [];
  const requests: { route: string; parameters: Record<string, unknown> }[] = [];
  const backend = githubPluginProprBackend({
    database: f.database,
    enqueueIssueTask: async (data, jobId) => { jobs.push({ data, jobId }); },
    github: async () => ({ request: async (route, parameters) => {
      requests.push({ route, parameters });
      return { data: { number: 5, id: 77, html_url: 'https://github.com/owner/allowed/issues/5', title: 't', state: 'open', labels: [{ name: 'bug' }], user: { login: 'octo' }, created_at: 'c', updated_at: 'u' } };
    } }),
  });
  const run = await runPluginHandler(FIXTURE_ID, 'callPropr', { kind: 'invoke', payload: { operation: 'createTask', args: ['owner/allowed', 5] } }, { ...f.options, backend });
  assert.equal((run.result as CallResult).ok, true, JSON.stringify(run));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, 'issue-owner-allowed-5');
  assert.equal(jobs[0].data.requestedBy, `plugin:${FIXTURE_ID}`);
  assert.deepEqual([jobs[0].data.repoOwner, jobs[0].data.repoName, jobs[0].data.number], ['owner', 'allowed', 5]);
  // The issue job builds the task's state from its data: `requestedBy` survives into the task record.
  assert.equal(taskIntentIssueRef(jobs[0].data, { kind: 'issue', number: 5, repoOwner: 'owner', repoName: 'allowed' }).requestedBy, `plugin:${FIXTURE_ID}`);

  const issue = await runPluginHandler(FIXTURE_ID, 'callPropr', { kind: 'invoke', payload: { operation: 'getIssue', args: ['owner/allowed', 5] } }, { ...f.options, backend });
  assert.deepEqual((issue.result as CallResult).value, { repository: 'owner/allowed', number: 5, title: 't', state: 'open', url: 'https://github.com/owner/allowed/issues/5', labels: ['bug'], author: 'octo', createdAt: 'c', updatedAt: 'u' });
  await runPluginHandler(FIXTURE_ID, 'callPropr', { kind: 'invoke', payload: { operation: 'commentOnIssue', args: ['owner/allowed', 5, 'hi'] } }, { ...f.options, backend });
  // getIssue reads the number; commentOnIssue reads it again to confirm it is an issue before posting.
  assert.deepEqual(requests.map(r => r.route), ['GET /repos/{owner}/{repo}/issues/{issue_number}', 'GET /repos/{owner}/{repo}/issues/{issue_number}', 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments']);
  assert.equal(requests[2].parameters.body, `hi\n\n${pluginAttributionMarker(FIXTURE_ID)}`);

  // A backend failure reaches the handler without its details.
  const failing = githubPluginProprBackend({ database: f.database, github: async () => ({ request: async () => { throw new Error('HttpError: Bad credentials ghs_secretvalue'); } }) });
  const failed = await runPluginHandler(FIXTURE_ID, 'callPropr', { kind: 'invoke', payload: { operation: 'getIssue', args: ['owner/allowed', 5] } }, { ...f.options, backend: failing });
  assert.deepEqual((failed.result as CallResult), { ok: false, code: 'unavailable', message: 'ProPR could not complete getIssue' });
});

/** A GitHub where #5 is an issue and #7 is a pull request (the issue routes serve both), recording every request. */
function issueOrPullGitHub() {
  const requests: { route: string; parameters: Record<string, unknown> }[] = [];
  const item = (number: number) => ({
    number, id: 100 + number, html_url: `https://github.com/owner/allowed/${number === 7 ? 'pull' : 'issues'}/${number}`, title: 't', state: 'open', labels: [], user: { login: 'octo' }, created_at: 'c', updated_at: 'u',
    ...(number === 7 ? { pull_request: { url: 'https://api.github.com/repos/owner/allowed/pulls/7' } } : {}),
  });
  const github = async () => ({ request: async (route: string, parameters: Record<string, unknown>) => {
    requests.push({ route, parameters });
    return { data: item(Number(parameters.issue_number)) };
  } });
  return { requests, github };
}

test('a comment permission covers only its own target kind: issues.comment cannot reach a pull request, nor the reverse', async t => {
  const f = await pluginHandlerFixture(t);
  const posts = (requests: { route: string; parameters: Record<string, unknown> }[]) => requests.filter(r => r.route.startsWith('POST'));
  const client = (permissions: PluginProprCallRecord['permission'][]) => {
    const gh = issueOrPullGitHub();
    const records: PluginProprCallRecord[] = [];
    const propr = scopedProprClient({ pluginId: FIXTURE_ID, grantedPermissions: permissions, repositories: ['owner/allowed'], backend: githubPluginProprBackend({ database: f.database, github: gh.github }), record: async call => { records.push(call); } });
    return { propr, records, requests: gh.requests };
  };

  // issues.comment only: commentOnIssue with a pull request's number is refused and posts nothing.
  const issueOnly = client(['issues.comment', 'issues.read']);
  await assert.rejects(issueOnly.propr.commentOnIssue('owner/allowed', 7, 'sneaky'), { code: 'not_found' });
  assert.deepEqual(posts(issueOnly.requests), []);
  assert.deepEqual(issueOnly.records.map(r => [r.operation, r.allowed, r.reason]), [['commentOnIssue', false, 'not_found']]);
  // getIssue (issues.read) cannot read a pull request through the issue route either.
  await assert.rejects(issueOnly.propr.getIssue('owner/allowed', 7), { code: 'not_found' });
  // The issue itself is still allowed.
  assert.equal((await issueOnly.propr.commentOnIssue('owner/allowed', 5, 'ok')).id, 105);
  assert.deepEqual(posts(issueOnly.requests).map(r => r.parameters.issue_number), [5]);

  // pull_requests.comment only: commentOnPullRequest with an issue's number is refused and posts nothing.
  const pullOnly = client(['pull_requests.comment']);
  await assert.rejects(pullOnly.propr.commentOnPullRequest('owner/allowed', 5, 'sneaky'), { code: 'not_found' });
  assert.deepEqual(posts(pullOnly.requests), []);
  assert.equal((await pullOnly.propr.commentOnPullRequest('owner/allowed', 7, 'ok')).id, 107);
  // Without the permission the method is refused before GitHub is asked anything.
  await assert.rejects(pullOnly.propr.commentOnIssue('owner/allowed', 5, 'x'), { code: 'permission_denied' });

  // Through a handler: the fixture has issues.comment but not pull_requests.comment.
  const gh = issueOrPullGitHub();
  const run = await runPluginHandler(FIXTURE_ID, 'callPropr', { kind: 'invoke', payload: { operation: 'commentOnIssue', args: ['owner/allowed', 7, 'sneaky'] } }, { ...f.options, backend: githubPluginProprBackend({ database: f.database, github: gh.github }) });
  assert.equal((run.result as CallResult).code, 'not_found');
  assert.deepEqual(posts(gh.requests), []);
});

test('the GitHub backend sends nothing once the handler run has ended, even when the App token arrives later', async () => {
  const controller = new AbortController();
  const requests: string[] = [];
  let release!: () => void;
  const token = new Promise<void>(resolve => { release = resolve; });
  const backend = githubPluginProprBackend({
    database: {} as never, signal: controller.signal,
    enqueueIssueTask: async () => { requests.push('enqueue'); },
    github: async () => { await token; return { request: async (route: string) => { requests.push(route); return { data: {} }; } }; },
  });
  const pending = backend.comment('owner/allowed', 5, 'late', 'issue');
  controller.abort();
  release();
  await assert.rejects(pending, { code: 'unavailable' });
  await assert.rejects(backend.createTask('owner/allowed', 5, { requestedBy: 'plugin:x' }), { code: 'unavailable' });
  assert.deepEqual(requests, []);
});

test('the default enqueue adds no job when the run ends while the issue queue is initialized', async () => {
  const controller = new AbortController();
  const added: string[] = [];
  let release!: () => void;
  const initialized = new Promise<void>(resolve => { release = resolve; });
  let initializing!: () => void;
  const started = new Promise<void>(resolve => { initializing = resolve; });
  const backend = githubPluginProprBackend({
    database: {} as never, signal: controller.signal,
    issueQueue: async () => { initializing(); await initialized; return { add: async (_name: string, _data: IssueJobData, options: Record<string, unknown>) => { added.push(String(options.jobId)); } }; },
  });
  const pending = backend.createTask('owner/allowed', 5, { requestedBy: 'plugin:x' });
  await started;
  controller.abort();
  release();
  await assert.rejects(pending, { code: 'unavailable' });
  assert.deepEqual(added, []);

  // A live run's task is added to the same queue.
  const live = githubPluginProprBackend({ database: {} as never, signal: new AbortController().signal, issueQueue: async () => ({ add: async (_n: string, _d: IssueJobData, options: Record<string, unknown>) => { added.push(String(options.jobId)); } }) });
  assert.equal((await live.createTask('owner/allowed', 5, { requestedBy: 'plugin:x' })).jobId, 'issue-owner-allowed-5');
  assert.deepEqual(added, ['issue-owner-allowed-5']);
});
