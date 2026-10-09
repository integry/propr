import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Octokit } from '@octokit/core';

const originalNodeEnv = process.env.NODE_ENV;
const originalDbFilename = process.env.DB_FILENAME;
const originalDataDir = process.env.DATA_DIR;
const isolatedDir = await mkdtemp(path.join(tmpdir(), 'propr-task-assignment-routes-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = isolatedDir;
process.env.DB_FILENAME = path.join(isolatedDir, 'propr.sqlite');

const { db, runMigrations, closeConnection, resetUnresolvedGitHubUserIds } = await import('@propr/core');
type TaskAssignmentClient = import('@propr/core').TaskAssignmentClient;
const { createTaskAssignmentRoutes, parseAssigneesBody, ASSIGNABLE_USERS_CACHE_TTL_MS, MAX_ASSIGNABLE_USERS } = await import('../routes/taskAssignmentRoutes.js');
const { GitHubRepositoryWriteAccessError, verifyGitHubRepositoryWriteAccess } = await import('../githubMetadataAuth.js');
const { createOperationalRouteEntries } = await import('../routeRegistry.js');

after(async () => {
  await closeConnection();
  await rm(isolatedDir, { recursive: true, force: true });
  for (const [key, value] of [['NODE_ENV', originalNodeEnv], ['DB_FILENAME', originalDbFilename], ['DATA_DIR', originalDataDir]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const USERS: Record<string, string> = { '1': 'octocat', '2': 'hubot', '3': 'outsider', '4': 'human' };

/**
 * A stub of GitHub's assignment API. `assigned` holds live assignee ids per
 * issue number; users in `noAccess` are silently ignored on assign, as GitHub
 * does for users without repository access.
 */
function fakeGitHub(assigned: Record<number, string[]>, options: { failWrites?: number; noAccess?: string[]; assignable?: number } = {}) {
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const idOf = (login: unknown) => Object.keys(USERS).find(id => USERS[id].toLowerCase() === String(login).toLowerCase());
  const issue = (number: number) => ({ number, assignees: (assigned[number] ?? []).map(id => ({ id: Number(id), login: USERS[id], avatar_url: `https://avatars.example/u/${id}` })) });
  const client: TaskAssignmentClient = {
    async request(route, parameters) {
      calls.push({ route, parameters });
      if (route === 'GET /users/{username}') {
        const id = idOf(parameters.username);
        if (!id) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: { id: Number(id), login: USERS[id], name: null, avatar_url: `https://avatars.example/u/${id}` } };
      }
      if (route === 'GET /repos/{owner}/{repo}/assignees') {
        const total = options.assignable ?? 3;
        const page = Number(parameters.page);
        const perPage = Number(parameters.per_page);
        const ids = Array.from({ length: total }, (_, index) => index + 1).slice((page - 1) * perPage, page * perPage);
        return { data: ids.map(id => ({ id, login: USERS[String(id)] ?? `user-${id}`, avatar_url: null })) };
      }
      const number = Number(parameters.issue_number);
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') return { data: issue(number) };
      if (options.failWrites) throw Object.assign(new Error('Validation Failed'), { status: options.failWrites });
      const ids = (parameters.assignees as string[]).map(idOf).filter((id): id is string => Boolean(id));
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/assignees') {
        const current = new Set(assigned[number] ?? []);
        for (const id of ids) if (!options.noAccess?.includes(id)) current.add(id);
        assigned[number] = [...current];
        return { data: issue(number) };
      }
      if (route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees') {
        assigned[number] = (assigned[number] ?? []).filter(id => !ids.includes(id));
        return { data: issue(number) };
      }
      throw new Error(`Unexpected route ${route}`);
    },
  };
  const writes = () => calls.filter(call => !call.route.startsWith('GET '));
  return { client, calls, assigned, writes };
}

interface Captured { status: number; body: Record<string, unknown> }

function mockResponse() {
  const captured: Captured = { status: 200, body: {} };
  const res = {
    status(code: number) { captured.status = code; return res; },
    json(body: Record<string, unknown>) { captured.body = body; return res; },
  };
  return { res: res as never, captured };
}

function request(taskId: string, options: { body?: unknown; query?: Record<string, string> } = {}) {
  return { params: { taskId }, query: options.query ?? {}, body: options.body, user: { id: 7, accessToken: 'user-token' } } as never;
}

function setup(github: ReturnType<typeof fakeGitHub>, options: { canWrite?: boolean | Error } = {}) {
  let clock = Date.parse('2026-10-09T10:00:00.000Z');
  const accessChecks: string[] = [];
  const routes = createTaskAssignmentRoutes({
    db,
    github: async () => github.client,
    resolveMetadataToken: async () => 'user-token',
    verifyRepositoryWriteAccess: async repository => {
      accessChecks.push(repository);
      if (options.canWrite instanceof Error) throw options.canWrite;
      if (options.canWrite === false) throw new GitHubRepositoryWriteAccessError(repository);
    },
    now: () => clock,
  });
  const call = async (handler: keyof typeof routes, taskId: string, init: { body?: unknown; query?: Record<string, string> } = {}) => {
    const { res, captured } = mockResponse();
    await routes[handler](request(taskId, init), res);
    return captured;
  };
  return { call, accessChecks, advance: (ms: number) => { clock += ms; } };
}

const logins = (users: unknown) => (users as Array<{ login: string }>).map(user => user.login);

describe('parseAssigneesBody', () => {
  test('accepts logins with a default replace mode', () => {
    assert.deepEqual(parseAssigneesBody({ logins: ['octocat', '@hubot'] }), { ok: true, logins: ['octocat', 'hubot'], mode: 'replace' });
    assert.deepEqual(parseAssigneesBody({ logins: [], mode: 'add' }), { ok: true, logins: [], mode: 'add' });
  });

  test('rejects malformed bodies', () => {
    for (const body of [
      undefined,
      [],
      { logins: 'octocat' },
      { logins: ['octocat', 42] },
      { logins: ['not a login'] },
      { logins: [''] },
      { logins: Array.from({ length: 11 }, (_, index) => `user-${index}`) },
      { logins: ['octocat'], mode: 'remove' },
    ]) {
      assert.equal(parseAssigneesBody(body).ok, false, JSON.stringify(body));
    }
  });
});

describe('task assignment routes', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    await db('task_assignees').delete();
    await db('github_user_profiles').delete();
    await db('tasks').whereIn('task_id', ['issue-7', 'pr-comment-8', 'goal-1']).delete();
    resetUnresolvedGitHubUserIds();
    await db('tasks').insert([
      { task_id: 'issue-7', repository: 'acme/widgets', task_type: 'issue', issue_number: 7 },
      { task_id: 'pr-comment-8', repository: 'acme/widgets', task_type: 'pr-comment', issue_number: 8 },
      { task_id: 'goal-1', repository: 'acme/widgets', task_type: 'goal', issue_number: null },
    ]);
  });

  describe('GET /api/task/:taskId/assignees', () => {
    test('reads the live assignment from GitHub and stores it', async () => {
      const github = fakeGitHub({ 7: ['1', '2'] });
      const { call } = setup(github);
      const response = await call('getAssignees', 'issue-7');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.subject, { owner: 'acme', repo: 'widgets', number: 7, kind: 'issue' });
      assert.deepEqual(logins(response.body.assignees), ['hubot', 'octocat']);
      assert.equal(response.body.synced, true);
      assert.equal(github.calls.length, 1);
    });

    test('with refresh=false serves the stored set without calling GitHub', async () => {
      const github = fakeGitHub({ 7: ['1'] });
      const { call } = setup(github);
      await call('getAssignees', 'issue-7');
      github.assigned[7] = ['1', '2'];
      github.calls.length = 0;
      const response = await call('getAssignees', 'issue-7', { query: { refresh: 'false' } });
      assert.equal(response.status, 200);
      assert.deepEqual(logins(response.body.assignees), ['octocat']);
      assert.equal(response.body.synced, false);
      assert.deepEqual(response.body.subject, { owner: 'acme', repo: 'widgets', number: 7, kind: 'issue' });
      assert.equal(github.calls.length, 0);
    });

    test('resolves a PR task to its pull request', async () => {
      const response = await setup(fakeGitHub({ 8: ['2'] })).call('getAssignees', 'pr-comment-8');
      assert.deepEqual(response.body.subject, { owner: 'acme', repo: 'widgets', number: 8, kind: 'pull_request' });
      assert.deepEqual(logins(response.body.assignees), ['hubot']);
    });

    test('answers 400 for an invalid id, 404 for an unknown task and 409 for a task with nothing to assign', async () => {
      const github = fakeGitHub({});
      const { call } = setup(github);
      assert.equal((await call('getAssignees', 'bad id!')).status, 400);
      assert.equal((await call('getAssignees', 'missing-task')).status, 404);
      const goal = await call('getAssignees', 'goal-1');
      assert.equal(goal.status, 409);
      assert.equal(goal.body.code, 'NO_GITHUB_SUBJECT');
      assert.match(String(goal.body.error), /nothing to assign/);
      assert.equal(github.calls.length, 0);
    });
  });

  describe('PUT /api/task/:taskId/assignees', () => {
    test('assigns on GitHub and returns the confirmed set', async () => {
      const github = fakeGitHub({ 7: [] });
      const { call, accessChecks } = setup(github);
      const response = await call('putAssignees', 'issue-7', { body: { logins: ['octocat'] } });
      assert.equal(response.status, 200);
      assert.deepEqual(logins(response.body.assignees), ['octocat']);
      assert.deepEqual(response.body.rejected, []);
      assert.deepEqual(github.assigned[7], ['1']);
      assert.deepEqual(accessChecks, ['acme/widgets']);
      assert.deepEqual((await db('task_assignees').where({ task_id: 'issue-7' })).map(row => row.github_user_id), ['1']);
    });

    test('an empty list in the default mode clears the assignment', async () => {
      const github = fakeGitHub({ 7: ['1', '2'] });
      const response = await setup(github).call('putAssignees', 'issue-7', { body: { logins: [] } });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.assignees, []);
      assert.deepEqual(github.assigned[7], []);
    });

    test('replace removes assignees not requested', async () => {
      const github = fakeGitHub({ 7: ['1', '4'] });
      const response = await setup(github).call('putAssignees', 'issue-7', { body: { logins: ['hubot'] } });
      assert.deepEqual(logins(response.body.assignees), ['hubot']);
    });

    test('add mode keeps pre-existing assignees', async () => {
      const github = fakeGitHub({ 7: ['4'] });
      const response = await setup(github).call('putAssignees', 'issue-7', { body: { logins: ['octocat'], mode: 'add' } });
      assert.equal(response.status, 200);
      assert.deepEqual(logins(response.body.assignees), ['human', 'octocat']);
      assert.equal(github.writes().filter(call => call.route.startsWith('DELETE')).length, 0);
    });

    test('without write access answers 403 and changes nothing on GitHub', async () => {
      const github = fakeGitHub({ 7: ['1'] });
      const response = await setup(github, { canWrite: false }).call('putAssignees', 'issue-7', { body: { logins: [] } });
      assert.equal(response.status, 403);
      assert.equal(response.body.code, 'REPOSITORY_WRITE_ACCESS_REQUIRED');
      assert.equal(github.calls.length, 0);
      assert.deepEqual(github.assigned[7], ['1']);
    });

    test('a repository the user cannot read answers 404 and changes nothing', async () => {
      const github = fakeGitHub({ 7: ['1'] });
      const notFound = Object.assign(new Error('Not Found'), { status: 404 });
      const response = await setup(github, { canWrite: notFound }).call('putAssignees', 'issue-7', { body: { logins: [] } });
      assert.equal(response.status, 404);
      assert.equal(response.body.code, 'REPOSITORY_NOT_ACCESSIBLE');
      assert.equal(github.calls.length, 0);
    });

    test('an unknown login answers 400 before anything is written', async () => {
      const github = fakeGitHub({ 7: ['1'] });
      const response = await setup(github).call('putAssignees', 'issue-7', { body: { logins: ['nobody-here'] } });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'UNKNOWN_LOGIN');
      assert.deepEqual(response.body.logins, ['nobody-here']);
      assert.equal(github.writes().length, 0);
      assert.deepEqual(github.assigned[7], ['1']);
    });

    test('a GitHub rejection answers 422', async () => {
      const failed = await setup(fakeGitHub({ 7: [] }, { failWrites: 422 })).call('putAssignees', 'issue-7', { body: { logins: ['octocat'] } });
      assert.equal(failed.status, 422);
      assert.equal(failed.body.code, 'GITHUB_REJECTED');

      // GitHub silently ignores users without repository access.
      const ignored = await setup(fakeGitHub({ 7: [] }, { noAccess: ['3'] })).call('putAssignees', 'issue-7', { body: { logins: ['octocat', 'outsider'] } });
      assert.equal(ignored.status, 422);
      assert.equal(ignored.body.code, 'GITHUB_REJECTED');
      assert.deepEqual(logins(ignored.body.assignees), ['octocat']);
      assert.deepEqual(logins(ignored.body.rejected), ['outsider']);
    });

    test('a GitHub outage answers 502', async () => {
      const response = await setup(fakeGitHub({ 7: [] }, { failWrites: 503 })).call('putAssignees', 'issue-7', { body: { logins: ['octocat'] } });
      assert.equal(response.status, 502);
    });

    test('a GitHub outage during the write-access check answers 502 and changes nothing', async () => {
      for (const status of [500, 502, 503]) {
        const github = fakeGitHub({ 7: ['1'] });
        const unavailable = Object.assign(new Error('Service Unavailable'), { status });
        const response = await setup(github, { canWrite: unavailable }).call('putAssignees', 'issue-7', { body: { logins: ['octocat'] } });
        assert.equal(response.status, 502, String(status));
        assert.equal(response.body.code, 'GITHUB_UNAVAILABLE');
        assert.equal(github.calls.length, 0);
        assert.deepEqual(github.assigned[7], ['1']);
      }
    });

    test('a non-GitHub failure during the write-access check still answers 500', async () => {
      const github = fakeGitHub({ 7: ['1'] });
      const response = await setup(github, { canWrite: new Error('boom') }).call('putAssignees', 'issue-7', { body: { logins: [] } });
      assert.equal(response.status, 500);
      assert.equal(github.calls.length, 0);
    });

    test('a task with no subject answers 409, an unknown task 404', async () => {
      const github = fakeGitHub({});
      const { call, accessChecks } = setup(github);
      const goal = await call('putAssignees', 'goal-1', { body: { logins: ['octocat'] } });
      assert.equal(goal.status, 409);
      assert.equal(goal.body.code, 'NO_GITHUB_SUBJECT');
      assert.equal((await call('putAssignees', 'missing-task', { body: { logins: [] } })).status, 404);
      assert.deepEqual(accessChecks, []);
      assert.equal(github.calls.length, 0);
    });

    test('a malformed body answers 400 without touching GitHub', async () => {
      const github = fakeGitHub({ 7: ['1'] });
      const { call, accessChecks } = setup(github);
      for (const body of [
        { logins: 'octocat' },
        { logins: ['octocat', 'not a login'] },
        { logins: Array.from({ length: 11 }, (_, index) => `user-${index}`) },
        { logins: ['octocat'], mode: 'merge' },
      ]) {
        const response = await call('putAssignees', 'issue-7', { body });
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.equal(response.body.code, 'INVALID_ASSIGNEES');
      }
      assert.deepEqual(accessChecks, []);
      assert.equal(github.calls.length, 0);
    });
  });

  describe('GET /api/task/:taskId/assignable-users', () => {
    test('lists the repository\'s assignable users and caches them for the window', async () => {
      const github = fakeGitHub({}, { assignable: 3 });
      const { call, advance } = setup(github);
      const first = await call('getAssignableUsers', 'issue-7');
      assert.equal(first.status, 200);
      assert.deepEqual(logins(first.body.users), ['hubot', 'octocat', 'outsider']);
      assert.equal(first.body.truncated, false);
      assert.equal(github.calls.length, 1);
      assert.deepEqual(github.calls[0].parameters, { owner: 'acme', repo: 'widgets', per_page: 100, page: 1 });
      assert.equal(await db('github_user_profiles').count({ count: '*' }).first().then(row => Number(row?.count)), 3);

      // Another task of the same repository shares the cache entry.
      const second = await call('getAssignableUsers', 'pr-comment-8');
      assert.deepEqual(second.body, first.body);
      assert.equal(github.calls.length, 1);

      advance(ASSIGNABLE_USERS_CACHE_TTL_MS + 1);
      await call('getAssignableUsers', 'issue-7');
      assert.equal(github.calls.length, 2);
    });

    test('pages through GitHub and bounds the list', async () => {
      const github = fakeGitHub({}, { assignable: MAX_ASSIGNABLE_USERS + 50 });
      const response = await setup(github).call('getAssignableUsers', 'issue-7');
      assert.equal(response.status, 200);
      assert.equal((response.body.users as unknown[]).length, MAX_ASSIGNABLE_USERS);
      assert.equal(response.body.truncated, true);
      // One page past the cap establishes that more users exist.
      assert.equal(github.calls.length, MAX_ASSIGNABLE_USERS / 100 + 1);
    });

    test('reports truncation only when the repository has more users than the cap', async () => {
      for (const [assignable, listed, truncated] of [
        [MAX_ASSIGNABLE_USERS - 1, MAX_ASSIGNABLE_USERS - 1, false],
        [MAX_ASSIGNABLE_USERS, MAX_ASSIGNABLE_USERS, false],
        [MAX_ASSIGNABLE_USERS + 1, MAX_ASSIGNABLE_USERS, true],
      ] as const) {
        const response = await setup(fakeGitHub({}, { assignable })).call('getAssignableUsers', 'issue-7');
        assert.equal(response.status, 200, String(assignable));
        assert.equal((response.body.users as unknown[]).length, listed, String(assignable));
        assert.equal(response.body.truncated, truncated, String(assignable));
      }
    });

    test('does not cache a failed read', async () => {
      let fail = true;
      const github = fakeGitHub({});
      const inner = github.client.request.bind(github.client);
      github.client.request = async (route, parameters) => {
        if (fail) throw new Error('GitHub is down');
        return await inner(route, parameters);
      };
      const { call } = setup(github);
      assert.equal((await call('getAssignableUsers', 'issue-7')).status, 502);
      fail = false;
      assert.equal((await call('getAssignableUsers', 'issue-7')).status, 200);
    });

    test('answers 404 for an unknown task and 409 for a task with nothing to assign', async () => {
      const { call } = setup(fakeGitHub({}));
      assert.equal((await call('getAssignableUsers', 'missing-task')).status, 404);
      assert.equal((await call('getAssignableUsers', 'goal-1')).status, 409);
    });
  });
});

describe('verifyGitHubRepositoryWriteAccess', () => {
  const octokit = (data: unknown) => () => ({ request: async () => ({ data }) }) as unknown as Octokit;

  test('accepts push, maintain or admin permission', async () => {
    for (const permissions of [{ push: true }, { maintain: true }, { admin: true }]) {
      await verifyGitHubRepositoryWriteAccess('acme/widgets', 'token', octokit({ permissions }));
    }
  });

  test('rejects read-only access', async () => {
    await assert.rejects(
      verifyGitHubRepositoryWriteAccess('acme/widgets', 'token', octokit({ permissions: { pull: true, push: false } })),
      GitHubRepositoryWriteAccessError,
    );
    await assert.rejects(verifyGitHubRepositoryWriteAccess('acme/widgets', 'token', octokit({})), GitHubRepositoryWriteAccessError);
  });
});

test('the three routes are registered beside the other task routes', () => {
  const handlers = new Proxy({}, { get: (_target, name) => name });
  const deps = new Proxy({}, { get: () => handlers }) as never;
  const entries = createOperationalRouteEntries(deps).map(([method, route, ...rest]) => [method, route, ...rest]);
  assert.deepEqual(entries.filter(([, route]) => /assignee|assignable/.test(String(route))), [
    ['get', '/api/task/:taskId/assignees', 'getAssignees'],
    ['put', '/api/task/:taskId/assignees', 'putAssignees'],
    ['get', '/api/task/:taskId/assignable-users', 'getAssignableUsers'],
  ]);
});
