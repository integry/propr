/* eslint-disable max-lines -- publication recovery and failure-stage regressions share one database fixture */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PUBLICATION_LEASE_MS, PUBLICATION_TAKEOVER_GRACE_MS, publicationLeaseLapsed, publicationOwner, publicationOwnerStopped } from '../mcp/planPublication.js';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { createToolCatalog, type ToolDeps } from '../mcp/tools.js';
import { McpError } from '../mcp/config.js';
import { McpOperations } from '../mcp/operations.js';
import type { McpPolicy, McpPrincipal } from '../mcp/policy.js';

const repository = 'acme/repo';
const userId = '123';
const tasks = ['First', 'Second', 'Third'].map(title => ({ title, body: `${title} body`, implementation: `${title} implementation` }));

after(async () => closeConnection());

async function setup(t: { after: (fn: () => Promise<void>) => void }, id: string, plan: unknown = tasks, filename = ':memory:'): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  await db('task_drafts').insert({ draft_id: id, user_id: userId, repository, status: 'review', plan_json: JSON.stringify(plan) });
  return db;
}

function tools(db: Knex, request: McpPrincipal['github']['request'], authorize: () => Promise<void> = async () => {}) {
  const principal = { user: { id: userId }, grant: { id: 'grant-1' }, github: { request } } as unknown as McpPrincipal;
  const deps: ToolDeps = { db, policy: { repository: authorize } as unknown as McpPolicy,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  const catalog = createToolCatalog(deps);
  const publish = catalog.find(tool => tool.name === 'publish_plan')!;
  const get = catalog.find(tool => tool.name === 'get_plan')!;
  const callPublish = (id: string, expectedRevision: number, operationId: string, resume = false) => publish.run({ principal, operationId,
    args: publish.schema.parse({ repository, planId: id, expectedRevision, resume, idempotencyKey: `publish-${operationId}` }) } as never);
  const callTrackedPublish = (id: string, expectedRevision: number, idempotencyKey: string, resume = false) => {
    const args = publish.schema.parse({ repository, planId: id, expectedRevision, resume, idempotencyKey });
    return new McpOperations(db).run(principal, { tool: publish.name, args, repository }, operationId =>
      publish.run({ principal, operationId, args } as never));
  };
  const callGet = (id: string) => get.run({ principal, args: get.schema.parse({ repository, planId: id }) } as never);
  return { callPublish, callTrackedPublish, callGet };
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

function rejectQueriesInOrder(db: Knex, predicates: Array<(query: { sql?: string; bindings?: unknown[] }) => boolean>): void {
  const query = db.client.query.bind(db.client);
  let next = 0;
  db.client.query = (connection: unknown, statement: { sql?: string; bindings?: unknown[] }) => {
    if (predicates[next]?.(statement)) {
      next += 1;
      return Promise.reject(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
    }
    return query(connection, statement);
  };
}

async function recordAttempt(db: Knex, values: {
  id: string; state: string; lifecycle: string; claimedAt: string; result?: string | null;
}): Promise<void> {
  const claimedAt = Date.parse(values.claimedAt);
  await db('mcp_operations').insert({ id: values.id, owner_id: userId, grant_id: 'grant-1',
    idempotency_key: `attempt-${values.id}`, tool: 'publish_plan', repository, payload_hash: 'x'.repeat(64),
    state: values.state, lifecycle: values.lifecycle, result: values.result ?? null, artifacts: '{}',
    accepted_at: claimedAt - 1, created_at: claimedAt - 1, updated_at: claimedAt + 1,
    finished_at: ['completed', 'failed', 'cancelled'].includes(values.lifecycle) ? claimedAt + 1 : null });
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

  let currentRevision: number | undefined;
  await assert.rejects(callPublish(id, before.mcp_revision, 'first-attempt'), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PUBLISH_FAILED');
    assert.equal(error.stage, 'github');
    assert.equal(error.retryable, false);
    assert.equal(error.details?.failedIndex, 0);
    assert.equal((error.details?.cause as { code: string }).code, 'GITHUB_REJECTED');
    assert.deepEqual(error.details?.createdIssues, []);
    currentRevision = error.details?.currentRevision as number;
    return true;
  });
  let draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'review');
  assert.equal(await db('plan_issues').where({ draft_id: id }).first(), undefined);
  // The claim advanced the revision; the failure reports the one a retry needs
  // so the caller does not have to re-read the plan or hit STALE_REVISION.
  assert.notEqual(currentRevision, before.mcp_revision);
  assert.equal(currentRevision, draft.mcp_revision);

  reject = false;
  await assert.rejects(callPublish(id, before.mcp_revision, 'stale-retry'), (error: McpError) => error.code === 'STALE_REVISION');
  const result = await callPublish(id, currentRevision!, 'second-attempt');
  assert.equal((result.data as { resumed: boolean }).resumed, false);
  draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'executed');
});

test('a partial publication reports a plan issue insert failure as database work', async t => {
  const id = '10000000-0000-4000-8000-000000000009';
  const db = await setup(t, id, tasks.slice(0, 1));
  const request = (async (_route: string, args: Record<string, unknown>) => ({
    data: { number: 81, html_url: 'https://github.com/acme/repo/issues/81', title: args.title },
  })) as McpPrincipal['github']['request'];
  const { callPublish } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();
  rejectQueryOnce(db, query => /^insert into `plan_issues`/i.test(query.sql || ''));

  await assert.rejects(callPublish(id, before.mcp_revision, 'record-stage'), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PUBLISH_PARTIAL');
    assert.equal(error.stage, 'database');
    assert.equal(error.details?.step, 'record_issue');
    assert.equal((error.details?.cause as { code: string }).code, 'DATABASE_BUSY');
    return true;
  });
});

test('a partial publication reports a later repository denial as authorization work', async t => {
  const id = '10000000-0000-4000-8000-000000000010';
  const db = await setup(t, id, tasks.slice(0, 2));
  let authorizationCount = 0;
  const authorize = async () => {
    authorizationCount += 1;
    if (authorizationCount === 2) throw new McpError('REPOSITORY_FORBIDDEN', 'Repository access was denied.', 403);
  };
  let postCount = 0;
  const request = (async (_route: string, args: Record<string, unknown>) => {
    postCount += 1;
    return { data: { number: 81 + postCount, html_url: `https://github.com/acme/repo/issues/${81 + postCount}`,
      title: args.title } };
  }) as McpPrincipal['github']['request'];
  const { callPublish } = tools(db, request, authorize);
  const before = await db('task_drafts').where({ draft_id: id }).first();

  await assert.rejects(callPublish(id, before.mcp_revision, 'authorization-stage'), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PUBLISH_PARTIAL');
    assert.equal(error.stage, 'authorization');
    assert.equal(error.details?.step, 'authorize');
    assert.equal((error.details?.createdIssues as unknown[]).length, 1);
    return true;
  });
  assert.equal(postCount, 1);
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

test('a resume reclaims a durably stopped active attempt and adopts its unrecorded issue', async t => {
  const id = '10000000-0000-4000-8000-000000000011';
  const db = await setup(t, id, tasks.slice(0, 2));
  const claimedAt = new Date(Date.now() - 3 * 60_000).toISOString();
  await db('task_drafts').where({ draft_id: id }).update({ status: 'executing', context_config: JSON.stringify({
    publication: { state: 'active', operationId: 'interrupted-original', attemptId: 'interrupted-attempt',
      created: [{ index: 0, number: 91, url: 'https://github.com/acme/repo/issues/91' }], claimedAt },
  }) });
  await db('plan_issues').insert({ draft_id: id, repository, issue_number: 91 });
  await recordAttempt(db, { id: 'interrupted-attempt', state: 'unknown', lifecycle: 'unknown', claimedAt,
    result: JSON.stringify({ error: { code: 'OUTCOME_UNKNOWN', message: 'response lost' } }) });
  const remote = [{ number: 92, html_url: 'https://github.com/acme/repo/issues/92', title: 'Second',
    body: '<!-- propr-mcp:interrupted-original:1 -->' }];
  let postCount = 0;
  const request = (async (route: string) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') return { data: remote };
    postCount += 1;
    throw new Error('the interrupted issue must be adopted');
  }) as McpPrincipal['github']['request'];
  const { callPublish } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();

  const result = (await callPublish(id, before.mcp_revision, 'after-interruption', true)).data as
    { adopted: number[]; issues: Array<{ number: number }> };
  assert.deepEqual(result.adopted, [1]);
  assert.deepEqual(result.issues.map(issue => issue.number), [91, 92]);
  assert.equal(postCount, 0);
  assert.deepEqual(await db('mcp_operations').where({ id: 'interrupted-attempt' }).first('state', 'lifecycle'),
    { state: 'unknown', lifecycle: 'unknown' });
  assert.equal((await db('task_drafts').where({ draft_id: id }).first()).status, 'executed');
});

test('a resume remains recoverable when recording partial state also fails', async t => {
  const id = '10000000-0000-4000-8000-000000000012';
  const db = await setup(t, id, tasks.slice(0, 2));
  await db('task_drafts').where({ draft_id: id }).update({ status: 'executing', context_config: JSON.stringify({
    publication: { state: 'partial', operationId: 'persistence-original',
      created: [{ index: 0, number: 101, url: 'https://github.com/acme/repo/issues/101' }], failedIndex: 1,
      failedAt: new Date().toISOString(), cause: { code: 'UPSTREAM_UNREACHABLE', message: 'lost' } },
  }) });
  await db('plan_issues').insert({ draft_id: id, repository, issue_number: 101 });
  const remote: Array<{ number: number; html_url: string; title: string; body: string }> = [];
  let postCount = 0;
  const request = (async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') return { data: remote };
    postCount += 1;
    const issue = { number: 102, html_url: 'https://github.com/acme/repo/issues/102',
      title: String(args.title), body: String(args.body) };
    remote.push(issue);
    return { data: issue };
  }) as McpPrincipal['github']['request'];
  const { callPublish, callTrackedPublish } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();
  rejectQueriesInOrder(db, [
    query => /^insert into `plan_issues`/i.test(query.sql || '') && query.bindings?.includes(102) === true,
    query => /^update `task_drafts`/i.test(query.sql || ''),
  ]);

  const interrupted = await callTrackedPublish(id, before.mcp_revision, 'persistence-failure', true);
  assert.equal(interrupted.state, 'unknown');
  let draft = await db('task_drafts').where({ draft_id: id }).first();
  const active = JSON.parse(draft.context_config).publication;
  assert.equal(active.state, 'active');
  assert.equal(active.operationId, 'persistence-original');
  assert.equal(active.attemptId, interrupted.operationId);

  const recovered = (await callPublish(id, draft.mcp_revision, 'after-persistence-failure', true)).data as
    { adopted: number[]; issues: Array<{ number: number }> };
  assert.deepEqual(recovered.adopted, [1]);
  assert.deepEqual(recovered.issues.map(issue => issue.number), [101, 102]);
  assert.equal(postCount, 1, 'the issue created before both database failures is adopted');
  draft = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(draft.status, 'executed');
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
  await recordAttempt(db, { id: 'resume-a', state: 'accepted', lifecycle: 'accepted', claimedAt: new Date().toISOString() });
  const firstResume = callPublish(id, before.mcp_revision, 'resume-a', true);
  await started;

  const active = await db('task_drafts').where({ draft_id: id }).first();
  assert.deepEqual((await callGet(id)).data.publication, { state: 'active', created: 1 });
  await assert.rejects(callPublish(id, active.mcp_revision, 'resume-b', true), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PRECONDITION_FAILED');
    assert.match(error.message, /not recoverable/i);
    return true;
  });
  assert.equal(postCount, 1, 'the competing resume cannot reach a POST');

  releasePost();
  const result = (await firstResume).data as { issues: Array<{ number: number }> };
  assert.deepEqual(result.issues.map(issue => issue.number), [51, 52, 53]);
  assert.equal(postCount, 2, 'only the owner creates the two remaining issues');
});

test('a timeout cannot reclaim an active publication while its GitHub POST is awaiting', async t => {
  const id = '10000000-0000-4000-8000-000000000013';
  const db = await setup(t, id);
  await db('task_drafts').where({ draft_id: id }).update({ status: 'executing', context_config: JSON.stringify({
    publication: { state: 'partial', operationId: 'timeout-original',
      created: [{ index: 0, number: 61, url: 'https://github.com/acme/repo/issues/61' }], failedIndex: 1,
      failedAt: new Date().toISOString(), cause: { code: 'UPSTREAM_UNREACHABLE', message: 'lost' } },
  }) });
  await db('plan_issues').insert({ draft_id: id, repository, issue_number: 61 });
  let releasePost!: () => void;
  let postStarted!: () => void;
  const started = new Promise<void>(resolve => { postStarted = resolve; });
  const gate = new Promise<void>(resolve => { releasePost = resolve; });
  let postCount = 0;
  const request = (async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') return { data: [] };
    postCount += 1;
    if (postCount === 1) { postStarted(); await gate; }
    return { data: { number: 61 + postCount, html_url: `https://github.com/acme/repo/issues/${61 + postCount}`,
      title: args.title } };
  }) as McpPrincipal['github']['request'];
  const { callPublish, callTrackedPublish } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();
  const firstResume = callTrackedPublish(id, before.mcp_revision, 'timeout-resume-a', true);
  await started;

  const active = await db('task_drafts').where({ draft_id: id }).first();
  const activePublication = JSON.parse(active.context_config).publication as { attemptId: string };
  await db('mcp_operations').where({ id: activePublication.attemptId })
    .update({ accepted_at: Date.now() - 3 * 60_000 });
  await assert.rejects(callPublish(id, active.mcp_revision, 'timeout-resume-b', true), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PRECONDITION_FAILED');
    assert.match(error.message, /not recoverable/i);
    return true;
  });
  assert.equal(postCount, 1, 'the timed-out receipt cannot authorize a competing POST');
  assert.deepEqual(await db('mcp_operations').where({ id: activePublication.attemptId }).first('state', 'lifecycle', 'result'),
    { state: 'unknown', lifecycle: 'unknown', result: null });

  await db('mcp_operations').where({ id: activePublication.attemptId }).update({ lifecycle: 'cancelled' });
  await assert.rejects(callPublish(id, active.mcp_revision, 'timeout-resume-c', true), /not recoverable/);
  assert.equal(postCount, 1, 'a lifecycle cancellation is not proof that the callback has stopped');
  await db('mcp_operations').where({ id: activePublication.attemptId }).update({ lifecycle: 'unknown' });

  releasePost();
  const result = await firstResume;
  assert.equal(result.state, 'completed');
  assert.deepEqual(((result.result as { issues: Array<{ number: number }> }).issues).map(issue => issue.number), [61, 62, 63]);
  assert.equal(postCount, 2, 'only the original owner creates the two remaining issues');
  assert.equal((await db('task_drafts').where({ draft_id: id }).first()).status, 'executed');
});

const takeoverAfterMs = PUBLICATION_LEASE_MS + PUBLICATION_TAKEOVER_GRACE_MS;

/** An active claim left behind by a runtime whose PID namespace no longer exists. */
function restartedRuntimeClaim(operationId: string, attemptId: string, times: { claimedAt: string; renewedAt?: string }) {
  return { publication: { state: 'active', operationId, attemptId,
    created: [{ index: 0, number: 71, url: 'https://github.com/acme/repo/issues/71' }], ...times,
    owner: { ...publicationOwner()!, pidNamespace: 'pid:[4026539999]' } } };
}

test('a resume takes over a lapsed claim left by a restarted runtime and adopts its marked issue', async t => {
  const id = '10000000-0000-4000-8000-000000000014';
  const db = await setup(t, id);
  const claimedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  // The owner renewed recently: it may still have an issue POST in flight.
  const renewing = restartedRuntimeClaim('restart-original', 'restart-attempt',
    { claimedAt, renewedAt: new Date(Date.now() - takeoverAfterMs + 30_000).toISOString() });
  await db('task_drafts').where({ draft_id: id }).update({ status: 'executing', context_config: JSON.stringify(renewing) });
  await db('plan_issues').insert({ draft_id: id, repository, issue_number: 71 });
  // The container died mid-POST, so its receipt never stored a result.
  await recordAttempt(db, { id: 'restart-attempt', state: 'unknown', lifecycle: 'unknown', claimedAt });
  assert.equal(publicationOwnerStopped(renewing.publication.owner), false, 'the old PID namespace cannot be inspected');
  const remote = [{ number: 72, html_url: 'https://github.com/acme/repo/issues/72', title: 'Second',
    body: '<!-- propr-mcp:restart-original:1 -->' }];
  let getCount = 0;
  let postCount = 0;
  const request = (async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') { getCount += 1; return { data: remote }; }
    postCount += 1;
    return { data: { number: 73, html_url: 'https://github.com/acme/repo/issues/73', title: args.title } };
  }) as McpPrincipal['github']['request'];
  const { callPublish } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();

  await assert.rejects(callPublish(id, before.mcp_revision, 'restart-too-early', true), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PRECONDITION_FAILED');
    assert.equal(error.stage, 'precondition');
    assert.match(error.message, /not recoverable yet/i);
    assert.equal(Date.parse(String(error.details?.claimLapsesAt)),
      Date.parse(renewing.publication.renewedAt!) + takeoverAfterMs);
    return true;
  });
  assert.equal(getCount + postCount, 0, 'a claim inside its lease is never contacted or replaced');
  assert.deepEqual(await db('task_drafts').where({ draft_id: id }).first(), before);

  for (const [attempt, times] of [
    { claimedAt, renewedAt: new Date(Date.now() - takeoverAfterMs - 1_000).toISOString() },
    // A claim that died before its first renewal lapses from its claim time.
    { claimedAt },
  ].entries()) {
    postCount = 0;
    await db('plan_issues').where({ draft_id: id }).whereNot({ issue_number: 71 }).delete();
    await db('task_drafts').where({ draft_id: id }).update({ status: 'executing', plan_json: JSON.stringify(tasks),
      context_config: JSON.stringify(restartedRuntimeClaim('restart-original', 'restart-attempt', times)) });
    const lapsed = await db('task_drafts').where({ draft_id: id }).first();
    const result = (await callPublish(id, lapsed.mcp_revision, `restart-takeover-${attempt}`, true)).data as
      { adopted: number[]; issues: Array<{ number: number }> };
    assert.deepEqual(result.adopted, [1], 'the issue created before the restart is adopted, not duplicated');
    assert.deepEqual(result.issues.map(issue => issue.number), [71, 72, 73]);
    assert.equal(postCount, 1, 'only the task without a marked issue is created');
    assert.equal((await db('task_drafts').where({ draft_id: id }).first()).status, 'executed');
    assert.deepEqual(await db('mcp_operations').where({ id: 'restart-attempt' }).first('state', 'lifecycle', 'result'),
      { state: 'unknown', lifecycle: 'unknown', result: null });
  }
});

test('a takeover fails its claim when the owner renews after the lapsed lease was read', async t => {
  const id = '10000000-0000-4000-8000-000000000015';
  const db = await setup(t, id);
  const claimedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  await db('task_drafts').where({ draft_id: id }).update({ status: 'executing',
    context_config: JSON.stringify(restartedRuntimeClaim('renewed-original', 'renewed-attempt', { claimedAt })) });
  await db('plan_issues').insert({ draft_id: id, repository, issue_number: 71 });
  await recordAttempt(db, { id: 'renewed-attempt', state: 'unknown', lifecycle: 'unknown', claimedAt });
  let contacts = 0;
  const { callPublish } = tools(db, (async () => { contacts += 1; throw new Error('unreachable'); }) as McpPrincipal['github']['request'],
    async () => { contacts += 1; });
  const before = await db('task_drafts').where({ draft_id: id }).first();
  const renewed = JSON.stringify(restartedRuntimeClaim('renewed-original', 'renewed-attempt',
    { claimedAt, renewedAt: new Date().toISOString() }));
  // The owner, slow but alive in another runtime, renews while the resume is
  // still gathering evidence from the receipt table.
  const query = db.client.query.bind(db.client);
  let renewedByOwner = false;
  db.client.query = async (connection: unknown, statement: { sql?: string }) => {
    if (!renewedByOwner && /^select .* from `mcp_operations`/i.test(statement.sql || '')) {
      renewedByOwner = true;
      // The single in-memory connection is already held by the intercepted query.
      await query(connection, { method: 'update', sql: 'update `task_drafts` set `context_config` = ? where `draft_id` = ?',
        bindings: [renewed, id] });
    }
    return query(connection, statement);
  };

  await assert.rejects(callPublish(id, before.mcp_revision, 'raced-takeover', true), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PRECONDITION_FAILED');
    assert.match(error.message, /no longer available to resume/i);
    return true;
  });
  assert.equal(renewedByOwner, true);
  assert.equal(contacts, 0, 'the stale takeover never reaches GitHub');
  assert.deepEqual(await db('task_drafts').where({ draft_id: id }).first('status', 'mcp_revision', 'context_config'),
    { status: 'executing', mcp_revision: before.mcp_revision + 1, context_config: renewed });
});

test('the owner renews its claim before each issue and aborts a request at the lease deadline', async t => {
  const id = '10000000-0000-4000-8000-000000000016';
  const db = await setup(t, id, tasks.slice(0, 2));
  // Lease deadlines use Date.now(), so advance the wall clock with the timers.
  // Freezing it during renewal and scheduling prevents real elapsed time from
  // shortening the lease and moving the abort deadline before the tick below.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const renewals: string[] = [];
  const remote: Array<{ number: number; html_url: string; title: string; body: string }> = [];
  let hang = true;
  let hung!: () => void;
  const hanging = new Promise<void>(resolve => { hung = resolve; });
  const request = (async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') return { data: remote };
    const publication = JSON.parse((await db('task_drafts').where({ draft_id: id }).first()).context_config).publication;
    renewals.push(publication.renewedAt);
    const signal = (args.request as { signal: AbortSignal }).signal;
    assert.equal(signal.aborted, false, 'a request starts inside its lease');
    if (renewals.length === 2 && hang) {
      // GitHub never answers: only the lease deadline can end this request.
      hung();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    const issue = { number: 80 + renewals.length, html_url: `https://github.com/acme/repo/issues/${80 + renewals.length}`,
      title: String(args.title), body: String(args.body) };
    remote.push(issue);
    return { data: issue };
  }) as McpPrincipal['github']['request'];
  const { callPublish } = tools(db, request);
  const before = await db('task_drafts').where({ draft_id: id }).first();

  const publishing = callPublish(id, before.mcp_revision, 'leased-attempt');
  const outcome = assert.rejects(publishing, error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'PUBLISH_PARTIAL');
    assert.equal(error.details?.step, 'create_issue');
    assert.equal(error.details?.failedIndex, 1);
    assert.equal((error.details?.cause as { code: string }).code, 'UPSTREAM_TIMEOUT');
    return true;
  });
  await hanging;
  assert.equal(renewals.length, 2);
  assert.ok(renewals.every(renewedAt => Number.isFinite(Date.parse(renewedAt))), 'each issue request follows a stored renewal');
  t.mock.timers.tick(PUBLICATION_LEASE_MS - 1);
  assert.equal((await db('task_drafts').where({ draft_id: id }).first()).status, 'executing');
  assert.equal(JSON.parse((await db('task_drafts').where({ draft_id: id }).first()).context_config).publication.state, 'active');
  t.mock.timers.tick(1);
  await outcome;

  // The aborted owner released its claim as a partial publication, so recovery
  // does not have to wait for the takeover grace.
  const partial = await db('task_drafts').where({ draft_id: id }).first();
  assert.equal(JSON.parse(partial.context_config).publication.state, 'partial');
  hang = false;
  const recovered = (await callPublish(id, partial.mcp_revision, 'leased-recovery', true)).data as
    { adopted: number[]; issues: Array<{ number: number }> };
  assert.deepEqual(recovered.adopted, []);
  assert.deepEqual(recovered.issues.map(issue => issue.number), [81, 83]);
  assert.equal((await db('task_drafts').where({ draft_id: id }).first()).status, 'executed');
});

test('a claim lapses only after its lease and the takeover grace have both passed', () => {
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  const at = (ageMs: number) => new Date(now - ageMs).toISOString();
  assert.equal(publicationLeaseLapsed({ claimedAt: at(takeoverAfterMs) }, now), false);
  assert.equal(publicationLeaseLapsed({ claimedAt: at(takeoverAfterMs + 1) }, now), true);
  assert.equal(publicationLeaseLapsed({ claimedAt: at(PUBLICATION_LEASE_MS + 1) }, now), false,
    'the lease deadline alone leaves an aborted request unsettled');
  assert.equal(publicationLeaseLapsed({ claimedAt: at(10 * takeoverAfterMs), renewedAt: at(takeoverAfterMs) }, now), false,
    'a renewal restarts the lease of an old claim');
  assert.equal(publicationLeaseLapsed({ claimedAt: at(10 * takeoverAfterMs), renewedAt: at(takeoverAfterMs + 1) }, now), true);
  assert.equal(publicationLeaseLapsed({ claimedAt: at(-60_000) }, now), false, 'a claim from the future is still held');
  assert.equal(publicationLeaseLapsed({ claimedAt: at(takeoverAfterMs + 1), renewedAt: 'not a time' }, now), true,
    'an unreadable renewal cannot strand the draft');
  assert.equal(publicationLeaseLapsed({ claimedAt: 'not a time' }, now), false);
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
    assert.match(error.message, /not recoverable/i);
    return true;
  });
  assert.equal((await db('task_drafts').where({ draft_id: id }).first()).status, 'review');
  assert.equal(contacts, 0);
});


for (const resume of [false, true]) {
  // The owner child cold-compiles the MCP tool graph through tsx: ~8s idle, well over 30s on a loaded CI shard.
  test(`process death during ${resume ? 'resumed' : 'initial'} publication permits marker recovery`, { timeout: 120_000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'publication-owner-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const filename = path.join(root, 'db.sqlite');
    const id = '10000000-0000-4000-8000-000000000020';
    const db = await setup(t, id, tasks.slice(0, 2), filename);
    if (resume) {
      await db('task_drafts').where({ draft_id: id }).update({ status: 'executing', context_config: JSON.stringify({
        publication: { state: 'partial', operationId: 'dead-original',
          created: [{ index: 0, number: 301, url: 'https://github.com/acme/repo/issues/301' }], failedIndex: 1,
          failedAt: new Date().toISOString(), cause: { code: 'UPSTREAM_UNREACHABLE', message: 'lost' } },
      }) });
      await db('plan_issues').insert({ draft_id: id, repository, issue_number: 301 });
    }
    // Run the owner from a file: an --input-type flag would be inherited by pino's
    // transport worker, which Node then refuses to start, killing the child.
    const script = path.join(root, 'owner.mjs');
    await writeFile(script, `
      import knex from ${JSON.stringify(import.meta.resolve('knex'))};
      import { createToolCatalog } from ${JSON.stringify(new URL('../mcp/tools.ts', import.meta.url).href)};
      import { McpOperations } from ${JSON.stringify(new URL('../mcp/operations.ts', import.meta.url).href)};
      const db = knex({ client: 'better-sqlite3', connection: { filename: process.env.PUBLICATION_DB }, useNullAsDefault: true });
      const draft = await db('task_drafts').first();
      const principal = { user: { id: '123' }, grant: { id: 'grant-1' }, github: { request: async (route, args) => {
        if (route.startsWith('GET')) return { data: [] };
        // GitHub accepted this issue, but the process dies before storing the response.
        process.send({ number: 302, html_url: 'https://github.com/acme/repo/issues/302', title: args.title, body: args.body });
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      } } };
      const tool = createToolCatalog({ db, policy: { repository: async () => {} }, taskQueue: {}, redisClient: {}, runtimeBuildQueue: {} })
        .find(tool => tool.name === 'publish_plan');
      const args = tool.schema.parse({ repository: 'acme/repo', planId: draft.draft_id, expectedRevision: draft.mcp_revision,
        resume: process.env.PUBLICATION_RESUME === 'true', idempotencyKey: 'dead-process-attempt' });
      await new McpOperations(db).run(principal, { tool: tool.name, args, repository: 'acme/repo' },
        operationId => tool.run({ principal, operationId, args }));
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, PUBLICATION_DB: filename, PUBLICATION_RESUME: String(resume) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    t.after(() => { child.kill('SIGKILL'); });
    const remote = await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('exit', (code, signal) => reject(new Error(`publication owner exited early (code ${code}, signal ${signal})`)));
    });
    const active = await db('task_drafts').where({ draft_id: id }).first();
    const marker = JSON.parse(active.context_config).publication;
    assert.equal(marker.owner.pid, child.pid);
    assert.equal(publicationOwnerStopped(marker.owner), false);
    await db('mcp_operations').where({ id: marker.attemptId }).update({ accepted_at: Date.now() - 180000 });
    let posts = 0;
    const { callPublish } = tools(db, (async (route: string, args: Record<string, unknown>) => {
      if (route.startsWith('GET')) return { data: [remote] };
      posts += 1;
      return { data: { number: 303, html_url: 'https://github.com/acme/repo/issues/303', title: args.title } };
    }) as McpPrincipal['github']['request']);
    await assert.rejects(callPublish(id, active.mcp_revision, 'still-alive', true), /not recoverable/);
    assert.deepEqual(await db('mcp_operations').where({ id: marker.attemptId }).first('state', 'result'), { state: 'unknown', result: null });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    assert.equal(publicationOwnerStopped(marker.owner), true);
    const recovered = (await callPublish(id, active.mcp_revision, 'after-process-death', true)).data as { adopted: number[] };
    assert.deepEqual(recovered.adopted, [resume ? 1 : 0]);
    assert.equal(posts, resume ? 0 : 1);
    assert.equal((await db('task_drafts').where({ draft_id: id }).first()).status, 'executed');
    assert.equal((await db('plan_issues').where({ draft_id: id })).length, 2);
  });
}

test('unverifiable process ownership never authorizes publication takeover', () => {
  const owner = publicationOwner()!;
  assert.ok(owner);
  assert.equal(publicationOwnerStopped(owner), false);
  assert.equal(publicationOwnerStopped(undefined), false);
  assert.equal(publicationOwnerStopped({ ...owner, bootId: 'another-boot' }), false);
  assert.equal(publicationOwnerStopped({ ...owner, pidNamespace: 'another-namespace' }), false);
  // A reused PID no longer identifies the process that claimed the draft.
  assert.equal(publicationOwnerStopped({ ...owner, started: '0' }), true);
});

test('losing the draft claim during issue creation prevents the old publisher from recording or releasing it', async t => {
  const id = '10000000-0000-4000-8000-000000000021';
  const db = await setup(t, id, tasks.slice(0, 1));
  let replacement: unknown;
  const { callPublish } = tools(db, (async () => {
    await db('task_drafts').where({ draft_id: id }).update({ context_config: JSON.stringify({ publication: { state: 'replacement' } }) });
    replacement = await db('task_drafts').where({ draft_id: id }).first();
    return { data: { number: 401, html_url: 'https://github.com/acme/repo/issues/401', title: 'First' } };
  }) as McpPrincipal['github']['request']);
  const before = await db('task_drafts').where({ draft_id: id }).first();
  await assert.rejects(callPublish(id, before.mcp_revision, 'lost-claim'), (error: unknown) =>
    error instanceof McpError && error.code === 'PUBLICATION_CLAIM_LOST');
  assert.deepEqual(await db('task_drafts').where({ draft_id: id }).first(), replacement);
  assert.deepEqual(await db('plan_issues').where({ draft_id: id }), []);
});
