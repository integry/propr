import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { createToolCatalog, type ToolDeps } from '../mcp/tools.js';
import { McpError } from '../mcp/config.js';
import type { McpPolicy, McpPrincipal } from '../mcp/policy.js';

const repository = 'acme/repo';
const userId = '123';
const tasks = ['First', 'Second', 'Third'].map(title => ({ title, body: `${title} body`, implementation: `${title} implementation` }));

after(async () => closeConnection());

async function setup(t: { after: (fn: () => Promise<void>) => void }, id: string, plan: unknown = tasks): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  await db('task_drafts').insert({ draft_id: id, user_id: userId, repository, status: 'review', plan_json: JSON.stringify(plan) });
  return db;
}

function tools(db: Knex, request: McpPrincipal['github']['request'], authorize: () => Promise<void> = async () => {}) {
  const principal = { user: { id: userId }, github: { request } } as unknown as McpPrincipal;
  const deps: ToolDeps = { db, policy: { repository: authorize } as unknown as McpPolicy,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  const catalog = createToolCatalog(deps);
  const publish = catalog.find(tool => tool.name === 'publish_plan')!;
  const get = catalog.find(tool => tool.name === 'get_plan')!;
  const callPublish = (id: string, expectedRevision: number, operationId: string, resume = false) => publish.run({ principal, operationId,
    args: publish.schema.parse({ repository, planId: id, expectedRevision, resume, idempotencyKey: `publish-${operationId}` }) } as never);
  const callGet = (id: string) => get.run({ principal, args: get.schema.parse({ repository, planId: id }) } as never);
  return { callPublish, callGet };
}

test('a first-issue GitHub rejection releases the claimed review plan and permits a later publication', async t => {
  const id = '10000000-0000-4000-8000-000000000001';
  const db = await setup(t, id, tasks.slice(0, 1));
  let reject = true;
  const request = (async (route: string, args: Record<string, unknown>) => {
    assert.equal(route, 'POST /repos/{owner}/{repo}/issues');
    if (reject) throw Object.assign(new Error('Validation Failed'), { name: 'HttpError', status: 422,
      response: { status: 422, headers: {}, data: { message: 'Validation Failed', errors: [{ message: 'Bad label' }] } } });
    return { data: { number: 11, html_url: 'https://github.com/acme/repo/issues/11', title: args.title } };
  }) as McpPrincipal['github']['request'];
  const { callPublish } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();

  await assert.rejects(callPublish(id, before.mcp_revision, 'first-attempt'), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PUBLISH_FAILED');
    assert.equal(error.stage, 'github');
    assert.equal(error.retryable, false);
    assert.equal(error.details?.failedIndex, 0);
    assert.equal((error.details?.cause as { code: string }).code, 'GITHUB_REJECTED');
    assert.deepEqual(error.details?.createdIssues, []);
    return true;
  });
  let draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'review');
  assert.equal(await db('plan_issues').where({ draft_id: id }).first(), undefined);

  reject = false;
  const result = await callPublish(id, draft.mcp_revision, 'second-attempt');
  assert.equal((result.data as { resumed: boolean }).resumed, false);
  draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'executed');
});

test('a partial publication is visible and resume adopts the uncertain issue without duplication', async t => {
  const id = '10000000-0000-4000-8000-000000000002';
  const db = await setup(t, id);
  const remote: Array<{ number: number; html_url: string; title: string; body: string }> = [];
  let postCount = 0;
  const request = (async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') return { data: [...remote].reverse() };
    assert.equal(route, 'POST /repos/{owner}/{repo}/issues');
    postCount += 1;
    const issue = { number: 100 + postCount, html_url: `https://github.com/acme/repo/issues/${100 + postCount}`,
      title: String(args.title), body: String(args.body) };
    remote.push(issue);
    if (postCount === 2) throw Object.assign(new Error('socket closed after upload'), { code: 'ECONNRESET' });
    return { data: issue };
  }) as McpPrincipal['github']['request'];
  const { callPublish, callGet } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();

  await assert.rejects(callPublish(id, before.mcp_revision, 'original-operation'), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PUBLISH_PARTIAL');
    assert.equal(error.stage, 'github');
    assert.equal(error.retryable, false);
    assert.equal(error.details?.failedIndex, 1);
    assert.equal((error.details?.createdIssues as unknown[]).length, 1);
    return true;
  });
  let draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'executing');
  const partial = (await callGet(id)).data as { publication: { state: string; created: number; failedIndex: number } };
  assert.deepEqual(partial.publication, { state: 'partial', created: 1, failedIndex: 1,
    cause: { code: 'UPSTREAM_UNREACHABLE', message: 'The upstream service could not be reached.' } });

  const resumed = await callPublish(id, draft.mcp_revision, 'resume-operation', true);
  const result = resumed.data as { resumed: boolean; adopted: number[]; issues: Array<{ number: number }> };
  assert.equal(result.resumed, true);
  assert.deepEqual(result.adopted, [1]);
  assert.deepEqual(result.issues.map(issue => issue.number), [101, 102, 103]);
  assert.equal(postCount, 3, 'resume creates only the third issue');
  assert.equal((await db('plan_issues').where({ draft_id: id })).length, 3);
  assert.equal(new Set((await db('plan_issues').where({ draft_id: id })).map(row => row.issue_number)).size, 3);
  draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'executed');
  assert.equal(JSON.parse(draft.context_config || '{}').publication, undefined);
  assert.equal(((await callGet(id)).data as { publication: unknown }).publication, null);
});

test('invalid plans and non-partial resume requests fail before claiming or contacting GitHub', async t => {
  const id = '10000000-0000-4000-8000-000000000003';
  const db = await setup(t, id, [{ title: 'Incomplete', implementation: 'Steps' }]);
  let contacts = 0;
  const { callPublish } = tools(db, (async () => { contacts += 1; throw new Error('unreachable'); }) as McpPrincipal['github']['request'],
    async () => { contacts += 1; });
  const before = await db('task_drafts').where({ draft_id: id }).first();

  await assert.rejects(callPublish(id, before.mcp_revision, 'invalid-plan'), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PLAN_INVALID');
    assert.equal(error.stage, 'validation');
    assert.deepEqual(error.details?.incomplete, [{ index: 0, title: 'Incomplete', missing: ['body'] }]);
    return true;
  });
  assert.equal(contacts, 0);
  assert.deepEqual(await db('task_drafts').where({ draft_id: id }).first('status', 'mcp_revision'),
    { status: 'review', mcp_revision: before.mcp_revision });

  await db('task_drafts').where({ draft_id: id }).update({ plan_json: JSON.stringify(tasks.slice(0, 1)) });
  const valid = await db('task_drafts').where({ draft_id: id }).first();
  await assert.rejects(callPublish(id, valid.mcp_revision, 'not-partial', true), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PRECONDITION_FAILED');
    assert.match(error.message, /not partially published/i);
    return true;
  });
  assert.equal((await db('task_drafts').where({ draft_id: id }).first()).status, 'review');
  assert.equal(contacts, 0);
});
