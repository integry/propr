import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { createToolCatalog, type ToolDeps } from '../mcp/tools.js';
import { McpError } from '../mcp/config.js';
import type { McpPolicy, McpPrincipal } from '../mcp/policy.js';

// MCP publish_plan links each published issue on GitHub as "blocked by" its
// prerequisites in a second pass, once every issue exists.
const repository = 'acme/repo';
const userId = '123';
const LIST = 'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by';
const ADD = 'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by';
const LOOKUP = 'GET /repos/{owner}/{repo}/issues/{issue_number}';

after(async () => closeConnection());

const task = (id: string, dependsOn?: string[]) => ({ id, title: `Task ${id}`, body: `${id} body`, implementation: `${id} steps`,
  ...(dependsOn ? { dependsOn } : {}) });

async function setup(t: { after: (fn: () => Promise<void>) => void }, id: string, plan: unknown[]): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  await db('task_drafts').insert({ draft_id: id, user_id: userId, repository, status: 'review', plan_json: JSON.stringify(plan) });
  return db;
}

interface FakeOptions {
  /** Issue creation returns the REST id unless this is false; ids are number * 1000. */
  returnIds?: boolean;
  links?: Record<number, number[]>;
  fail?: (route: string, args: Record<string, unknown>) => Error | undefined;
}

/** GitHub with issues, the issue dependency routes and the marker search used by resume. */
function fakeGitHub(options: FakeOptions = {}) {
  const remote: Array<{ id: number; number: number; html_url: string; title: string; body: string }> = [];
  const links = new Map<number, number[]>(Object.entries(options.links ?? {}).map(([issue, blockers]) => [Number(issue), [...blockers]]));
  const calls: string[] = [];
  let nextNumber = 200;
  const request = (async (route: string, args: Record<string, unknown>) => {
    calls.push(route);
    const failure = options.fail?.(route, args);
    if (failure) throw failure;
    const number = Number(args.issue_number);
    if (route === 'POST /repos/{owner}/{repo}/issues') {
      nextNumber += 1;
      const issue = { id: nextNumber * 1000, number: nextNumber, html_url: `https://github.com/acme/repo/issues/${nextNumber}`,
        title: String(args.title), body: String(args.body) };
      remote.push(issue);
      const { id, ...withoutId } = issue;
      return { data: options.returnIds === false ? withoutId : { ...withoutId, id } };
    }
    if (route === 'GET /repos/{owner}/{repo}/issues') return { data: [...remote].reverse() };
    if (route === LOOKUP) return { data: remote.find(issue => issue.number === number) };
    if (route === LIST) return { data: (links.get(number) ?? []).map(blocker => ({ id: blocker * 1000, number: blocker })) };
    if (route === ADD) {
      links.set(number, [...links.get(number) ?? [], Number(args.issue_id) / 1000]);
      return { data: {} };
    }
    throw new Error(`unexpected route ${route}`);
  }) as unknown as McpPrincipal['github']['request'];
  return { request, calls, links, remote };
}

function tools(db: Knex, request: McpPrincipal['github']['request']) {
  const principal = { user: { id: userId }, grant: { id: 'grant-1' }, github: { request } } as unknown as McpPrincipal;
  const deps: ToolDeps = { db, policy: { repository: async () => {} } as unknown as McpPolicy,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  const catalog = createToolCatalog(deps);
  const publish = catalog.find(tool => tool.name === 'publish_plan')!;
  const get = catalog.find(tool => tool.name === 'get_plan')!;
  const callPublish = (id: string, expectedRevision: number, operationId: string, resume = false) => publish.run({ principal, operationId,
    args: publish.schema.parse({ repository, planId: id, expectedRevision, resume, idempotencyKey: `publish-${operationId}` }) } as never);
  const callGet = async (id: string) => (await get.run({ principal, args: get.schema.parse({ repository, planId: id }) } as never)).data as {
    dependencyLinks: { created: number; existing: number; failed: Array<{ issue: number; blockedBy: number; error: string | null }> } | null };
  return { callPublish, callGet };
}

type PublishResult = { issues: Array<{ number: number }>; dependencyLinks?: { links: Array<{ issue: number; blockedBy: number; status: string }> } };
const revision = async (db: Knex, id: string) => (await db('task_drafts').where({ draft_id: id }).first()).mcp_revision as number;

test('publication links a small graph on GitHub, including a prerequisite published after its dependant', async t => {
  const id = '30000000-0000-4000-8000-000000000001';
  // ui (first) depends on api (second), which depends on schema (third).
  const db = await setup(t, id, [task('ui', ['api']), task('api', ['schema']), task('schema')]);
  const github = fakeGitHub();
  const { callPublish, callGet } = tools(db, github.request);

  const result = (await callPublish(id, await revision(db, id), 'graph')).data as PublishResult;

  const [ui, api, schema] = result.issues.map(issue => issue.number);
  assert.deepEqual(Object.fromEntries(github.links), { [ui]: [api], [api]: [schema] });
  assert.deepEqual(result.dependencyLinks?.links, [
    { issue: ui, blockedBy: api, status: 'created' },
    { issue: api, blockedBy: schema, status: 'created' },
  ]);
  assert.equal(github.calls.includes(LOOKUP), false, 'ids come from the issue creation responses');
  // Links are added only after every issue exists.
  assert.ok(github.calls.indexOf(ADD) > github.calls.lastIndexOf('POST /repos/{owner}/{repo}/issues'));
  assert.equal((await db('task_drafts').where({ draft_id: id }).first()).status, 'executed');
  const { syncedAt } = JSON.parse((await db('task_drafts').where({ draft_id: id }).first()).context_config).dependencyLinks;
  assert.deepEqual((await callGet(id)).dependencyLinks, { syncedAt, created: 2, existing: 0, failed: [] });
});

test('resume after a partial publication links every issue once, looking up ids it did not see', async t => {
  const id = '30000000-0000-4000-8000-000000000002';
  const db = await setup(t, id, [task('a'), task('b', ['a']), task('c', ['a', 'b'])]);
  let posts = 0;
  const github = fakeGitHub({ returnIds: false, fail: route => {
    if (route !== 'POST /repos/{owner}/{repo}/issues') return undefined;
    posts += 1;
    return posts === 2 ? Object.assign(new Error('Validation Failed'), { status: 422,
      response: { status: 422, headers: {}, data: { message: 'Validation Failed' } } }) : undefined;
  } });
  const { callPublish, callGet } = tools(db, github.request);

  await assert.rejects(callPublish(id, await revision(db, id), 'partial'), error =>
    error instanceof McpError && error.code === 'PUBLISH_PARTIAL');
  assert.equal(github.calls.some(route => route.includes('/dependencies/')), false, 'no links before every issue exists');
  const [a] = github.remote.map(issue => issue.number);

  const resumed = (await callPublish(id, await revision(db, id), 'resume', true)).data as PublishResult;
  const [, b, c] = resumed.issues.map(issue => issue.number);
  assert.equal(resumed.issues[0].number, a);
  assert.deepEqual(Object.fromEntries(github.links), { [b]: [a], [c]: [a, b] });
  assert.deepEqual(resumed.dependencyLinks?.links.map(link => link.status), ['created', 'created', 'created']);
  assert.deepEqual(github.calls.filter(route => route === LOOKUP).length, 2, 'ids of the prerequisites a and b are looked up');
  assert.equal((await callGet(id)).dependencyLinks?.created, 3);
});

test('a resume that finds links already on GitHub does not add them again', async t => {
  const id = '30000000-0000-4000-8000-000000000003';
  const db = await setup(t, id, [task('a'), task('b', ['a'])]);
  // Issue numbers are predictable: a = 201, b = 202. The link exists from an earlier pass.
  let posts = 0;
  const github = fakeGitHub({ links: { 202: [201] }, fail: route => {
    if (route !== 'POST /repos/{owner}/{repo}/issues') return undefined;
    posts += 1;
    return posts === 2 ? Object.assign(new Error('socket closed after upload'), { code: 'ECONNRESET' }) : undefined;
  } });
  const { callPublish } = tools(db, github.request);
  await assert.rejects(callPublish(id, await revision(db, id), 'first'), error => error instanceof McpError && error.code === 'PUBLISH_PARTIAL');

  const resumed = (await callPublish(id, await revision(db, id), 'second', true)).data as PublishResult;
  assert.deepEqual(resumed.issues.map(issue => issue.number), [201, 202]);
  assert.deepEqual(resumed.dependencyLinks?.links, [{ issue: 202, blockedBy: 201, status: 'existing' }]);
  assert.equal(github.calls.includes(ADD), false);
  assert.deepEqual(github.links.get(202), [201]);
});

test('a GitHub dependency API failure leaves the publication successful and get_plan shows the missing links', async t => {
  const id = '30000000-0000-4000-8000-000000000004';
  const db = await setup(t, id, [task('a'), task('b', ['a']), task('c', ['b'])]);
  const github = fakeGitHub({ fail: (route, args) => route === ADD && Number(args.issue_number) === 203
    ? Object.assign(new Error('Resource not accessible by integration'), { status: 403 }) : undefined });
  const { callPublish, callGet } = tools(db, github.request);

  const result = (await callPublish(id, await revision(db, id), 'forbidden')).data as PublishResult;
  assert.deepEqual(result.issues.map(issue => issue.number), [201, 202, 203]);
  const draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'executed');
  assert.equal(JSON.parse(draft.context_config).publication, undefined, 'no partial publication state is left');
  const summary = (await callGet(id)).dependencyLinks;
  assert.equal(summary?.created, 1);
  assert.deepEqual(summary?.failed, [{ issue: 203, blockedBy: 202, error: '403: Resource not accessible by integration' }]);
  assert.equal((await db('plan_issues').where({ draft_id: id })).length, 3);
});

test('a plan without dependencies makes no additional GitHub calls', async t => {
  const id = '30000000-0000-4000-8000-000000000005';
  const db = await setup(t, id, [task('a'), task('b')]);
  const github = fakeGitHub();
  const { callPublish, callGet } = tools(db, github.request);

  const result = (await callPublish(id, await revision(db, id), 'independent')).data as PublishResult;
  assert.equal(result.dependencyLinks, undefined);
  assert.deepEqual(github.calls, ['POST /repos/{owner}/{repo}/issues', 'POST /repos/{owner}/{repo}/issues']);
  assert.equal((await callGet(id)).dependencyLinks, null);
});
