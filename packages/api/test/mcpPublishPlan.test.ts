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

function rejectQueryOnce(db: Knex, predicate: (query: { sql?: string; bindings?: unknown[] }) => boolean): void {
  const query = db.client.query.bind(db.client);
  let rejected = false;
  db.client.query = (connection: unknown, statement: { sql?: string; bindings?: unknown[] }) => {
    if (!rejected && predicate(statement)) {
      rejected = true;
      return Promise.reject(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
    }
    return query(connection, statement);
  };
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

test('an uncertain first issue remains recoverable under its original marker', async t => {
  const id = '10000000-0000-4000-8000-000000000004';
  const db = await setup(t, id, tasks.slice(0, 1));
  const remote: Array<{ number: number; html_url: string; title: string; body: string }> = [];
  let postCount = 0;
  const request = (async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') return { data: remote };
    postCount += 1;
    const issue = { number: 41, html_url: 'https://github.com/acme/repo/issues/41',
      title: String(args.title), body: String(args.body) };
    remote.push(issue);
    if (postCount === 1) throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
    return { data: issue };
  }) as McpPrincipal['github']['request'];
  const { callPublish, callGet } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();

  await assert.rejects(callPublish(id, before.mcp_revision, 'uncertain-first'), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PUBLISH_PARTIAL');
    assert.deepEqual(error.details?.createdIssues, []);
    return true;
  });
  let draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'executing');
  assert.deepEqual((await callGet(id)).data.publication, { state: 'partial', created: 0, failedIndex: 0,
    cause: { code: 'UPSTREAM_UNREACHABLE', message: 'The upstream service could not be reached.' } });
  assert.equal(JSON.parse(draft.context_config).publication.operationId, 'uncertain-first');

  const result = (await callPublish(id, draft.mcp_revision, 'recovery-attempt', true)).data as
    { issues: Array<{ number: number }>; adopted: number[] };
  assert.deepEqual(result.issues.map(issue => issue.number), [41]);
  assert.deepEqual(result.adopted, [0]);
  assert.equal(postCount, 1, 'recovery adopts the uncertain first issue instead of posting again');
  draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'executed');
});

test('a partial publication is visible and resume adopts the uncertain issue without duplication', async t => {
  const id = '10000000-0000-4000-8000-000000000002';
  const db = await setup(t, id);
  const remote: Array<{ number: number; html_url: string; title: string; body: string }> = [];
  let postCount = 0;
  const request = (async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') {
      assert.equal(args.labels, undefined, 'marker recovery must not depend on a mutable label');
      const page = Number(args.page);
      return { data: [...remote].reverse().slice((page - 1) * 100, page * 100) };
    }
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

  for (let offset = 0; offset < 100; offset++) remote.push({ number: 1000 + offset,
    html_url: `https://github.com/acme/repo/issues/${1000 + offset}`, title: `Newer ${offset}`, body: 'No publication marker' });

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

test('a resumed publication preserves its prior issues when the post-claim row lookup fails', async t => {
  const id = '10000000-0000-4000-8000-000000000007';
  const db = await setup(t, id, tasks.slice(0, 1));
  await db('task_drafts').where({ draft_id: id }).update({ status: 'executing', context_config: JSON.stringify({
    publication: { state: 'partial', operationId: 'lookup-original',
      created: [{ index: 0, number: 61, url: 'https://github.com/acme/repo/issues/61' }], failedIndex: 0,
      failedAt: new Date().toISOString(), cause: { code: 'DATABASE_BUSY', message: 'busy' } },
  }) });
  await db('plan_issues').insert({ draft_id: id, repository, issue_number: 61 });
  let contacts = 0;
  const { callPublish } = tools(db, (async () => { contacts += 1; throw new Error('GitHub must not be called'); }) as McpPrincipal['github']['request']);
  const before = await db('task_drafts').where({ draft_id: id }).first();
  rejectQueryOnce(db, query => /^select .* from `plan_issues`/i.test(query.sql || ''));

  await assert.rejects(callPublish(id, before.mcp_revision, 'lookup-resume', true), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PUBLISH_PARTIAL');
    assert.equal(error.stage, 'database');
    assert.equal(error.details?.step, 'load_issues');
    assert.equal((error.details?.cause as { code: string }).code, 'DATABASE_BUSY');
    assert.deepEqual(error.details?.createdIssues, [
      { index: 0, number: 61, url: 'https://github.com/acme/repo/issues/61' },
    ]);
    return true;
  });
  let draft = await db('task_drafts').where({ draft_id: id }).first();
  const recovered = JSON.parse(draft.context_config).publication;
  assert.equal(draft.status, 'executing');
  assert.equal(recovered.state, 'partial');
  assert.equal(recovered.operationId, 'lookup-original');
  assert.deepEqual(recovered.created, [{ index: 0, number: 61, url: 'https://github.com/acme/repo/issues/61' }]);

  await callPublish(id, draft.mcp_revision, 'lookup-retry', true);
  draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'executed');
  assert.equal(contacts, 0, 'the known issue is not posted again');
});

test('a resumed publication preserves every issue when the final draft update fails', async t => {
  const id = '10000000-0000-4000-8000-000000000008';
  const db = await setup(t, id, tasks.slice(0, 2));
  await db('task_drafts').where({ draft_id: id }).update({ status: 'executing', context_config: JSON.stringify({
    publication: { state: 'partial', operationId: 'completion-original',
      created: [{ index: 0, number: 71, url: 'https://github.com/acme/repo/issues/71' }], failedIndex: 1,
      failedAt: new Date().toISOString(), cause: { code: 'UPSTREAM_UNREACHABLE', message: 'lost' } },
  }) });
  await db('plan_issues').insert({ draft_id: id, repository, issue_number: 71 });
  let postCount = 0;
  let getCount = 0;
  const request = (async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') { getCount += 1; return { data: [] }; }
    postCount += 1;
    assert.match(String(args.body), /propr-mcp:completion-original:1/);
    return { data: { number: 72, html_url: 'https://github.com/acme/repo/issues/72', title: args.title } };
  }) as McpPrincipal['github']['request'];
  const { callPublish } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();
  rejectQueryOnce(db, query => /^update `task_drafts`/i.test(query.sql || '') && query.bindings?.includes('executed') === true);

  await assert.rejects(callPublish(id, before.mcp_revision, 'completion-resume', true), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PUBLISH_PARTIAL');
    assert.equal(error.stage, 'database');
    assert.equal(error.details?.step, 'complete');
    assert.equal((error.details?.cause as { code: string }).code, 'DATABASE_BUSY');
    assert.deepEqual((error.details?.createdIssues as Array<{ number: number }>).map(issue => issue.number), [71, 72]);
    return true;
  });
  let draft = await db('task_drafts').where({ draft_id: id }).first();
  const recovered = JSON.parse(draft.context_config).publication;
  assert.equal(draft.status, 'executing');
  assert.equal(recovered.state, 'partial');
  assert.equal(recovered.operationId, 'completion-original');
  assert.deepEqual(recovered.created.map((issue: { number: number }) => issue.number), [71, 72]);

  await callPublish(id, draft.mcp_revision, 'completion-retry', true);
  draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'executed');
  assert.equal(postCount, 1, 'the issue recorded before the failed completion is not posted again');
  assert.equal(getCount, 1, 'the completed retry does not search GitHub for already known issues');
  assert.deepEqual((await db('plan_issues').where({ draft_id: id }).orderBy('issue_number')).map(row => row.issue_number), [71, 72]);
});

test('an active resume is exclusively owned while its GitHub POST is awaiting', async t => {
  const id = '10000000-0000-4000-8000-000000000005';
  const db = await setup(t, id);
  await db('task_drafts').where({ draft_id: id }).update({ status: 'executing', context_config: JSON.stringify({
    publication: { state: 'partial', operationId: 'original',
      created: [{ index: 0, number: 51, url: 'https://github.com/acme/repo/issues/51' }], failedIndex: 1,
      failedAt: new Date().toISOString(), cause: { code: 'UPSTREAM_UNREACHABLE', message: 'lost' } },
  }) });
  await db('plan_issues').insert({ draft_id: id, repository, issue_number: 51 });
  let releasePost!: () => void;
  let postStarted!: () => void;
  const started = new Promise<void>(resolve => { postStarted = resolve; });
  const gate = new Promise<void>(resolve => { releasePost = resolve; });
  let postCount = 0;
  const request = (async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') return { data: [] };
    postCount += 1;
    if (postCount === 1) { postStarted(); await gate; }
    return { data: { number: 51 + postCount, html_url: `https://github.com/acme/repo/issues/${51 + postCount}`,
      title: args.title } };
  }) as McpPrincipal['github']['request'];
  const { callPublish, callGet } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();
  const firstResume = callPublish(id, before.mcp_revision, 'resume-a', true);
  await started;

  const active = await db('task_drafts').where({ draft_id: id }).first();
  assert.deepEqual((await callGet(id)).data.publication, { state: 'active', created: 1 });
  await assert.rejects(callPublish(id, active.mcp_revision, 'resume-b', true), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PRECONDITION_FAILED');
    assert.match(error.message, /not partially published/i);
    return true;
  });
  assert.equal(postCount, 1, 'the competing resume cannot reach a POST');

  releasePost();
  const result = (await firstResume).data as { issues: Array<{ number: number }> };
  assert.deepEqual(result.issues.map(issue => issue.number), [51, 52, 53]);
  assert.equal(postCount, 2, 'only the owner creates the two remaining issues');
});

test('an incomplete marker window preserves recovery state and refuses a POST', async t => {
  const id = '10000000-0000-4000-8000-000000000006';
  const db = await setup(t, id, tasks.slice(0, 1));
  await db('task_drafts').where({ draft_id: id }).update({ status: 'executing', context_config: JSON.stringify({
    publication: { state: 'partial', operationId: 'old-operation', created: [], failedIndex: 0,
      failedAt: new Date().toISOString(), cause: { code: 'UPSTREAM_UNREACHABLE', message: 'lost' } },
  }) });
  const remote = Array.from({ length: 1000 }, (_, offset) => ({ number: 2000 - offset,
    html_url: `https://github.com/acme/repo/issues/${2000 - offset}`, title: `Issue ${offset}`, body: 'No marker' }));
  let postCount = 0;
  let getCount = 0;
  const request = (async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') {
      getCount += 1;
      const page = Number(args.page);
      return { data: remote.slice((page - 1) * 100, page * 100) };
    }
    postCount += 1;
    throw new Error('POST must not be called');
  }) as McpPrincipal['github']['request'];
  const { callPublish } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();

  await assert.rejects(callPublish(id, before.mcp_revision, 'bounded-recovery', true), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PUBLISH_PARTIAL');
    assert.equal((error.details?.cause as { code: string }).code, 'MARKER_LOOKUP_INCOMPLETE');
    return true;
  });
  assert.equal(getCount, 10);
  assert.equal(postCount, 0);
  const draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'executing');
  assert.equal(JSON.parse(draft.context_config).publication.state, 'partial');
  assert.equal(JSON.parse(draft.context_config).publication.operationId, 'old-operation');
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
