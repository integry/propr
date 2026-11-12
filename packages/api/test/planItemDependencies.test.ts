import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { createToolCatalog, type ToolDeps } from '../mcp/tools.js';
import { McpError } from '../mcp/config.js';
import { createPlannerRoutes } from '../routes/plannerRoutes.js';
import { createFinalizeHandler } from '../routes/plannerActionHandlers.js';
import { listPlanRevisions, restorePlanRevision } from '../routes/plannerHelpers/planRevisions.js';
import { runBackgroundRefinement } from '../routes/plannerHelpers/refineBackground.js';
import type { McpPolicy, McpPrincipal } from '../mcp/policy.js';

after(async () => closeConnection());

const repository = 'acme/repo';
const userId = '123';
const draftId = '30000000-0000-4000-8000-000000000001';
type Item = { id?: string; title: string; body: string; implementation: string; dependsOn?: string[] };
const task = (title: string, extra: Partial<Item> = {}): Item => ({ title, body: `${title} body`, implementation: `${title} steps`, ...extra });
const storedPlan = async (db: Knex): Promise<Item[]> => JSON.parse((await db('task_drafts').where({ draft_id: draftId }).first()).plan_json);
const relation = (plan: Item[]) => plan.map(item => [item.id, item.dependsOn ?? []]);

const invalidPlans: Array<[string, Item[], RegExp]> = [
  ['an unknown id', [task('Schema', { id: 'schema' }), task('API', { id: 'api', dependsOn: ['missing'] })],
    /Task 2 "API" \(id "api"\) depends on "missing", which matches no item in this plan/],
  ['a self-reference', [task('Schema', { id: 'schema', dependsOn: ['schema'] })], /Task 1 "Schema" \(id "schema"\) depends on itself/],
  ['a cycle', [task('A', { id: 'a', dependsOn: ['c'] }), task('B', { id: 'b', dependsOn: ['a'] }), task('C', { id: 'c', dependsOn: ['b'] })],
    /Task 1 "A" \(id "a"\) is part of a dependency cycle: "a" → "c" → "b" → "a"/],
  ['a duplicate id', [task('A', { id: 'same' }), task('B', { id: 'same' })], /Task 2 "B" \(id "same"\) reuses the id "same" of task 1/],
];

async function setup(t: { after: (fn: () => Promise<void>) => void }, plan: unknown[] | null = [task('Initial', { id: 'initial' })]): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  await db('task_drafts').insert({ draft_id: draftId, user_id: userId, repository, status: 'review', plan_json: plan ? JSON.stringify(plan) : null });
  return db;
}

function mcp(db: Knex, request: McpPrincipal['github']['request'] = (async () => { throw new Error('unexpected GitHub call'); }) as never) {
  const principal = { user: { id: userId }, grant: { id: 'grant-1' }, github: { request } } as unknown as McpPrincipal;
  const deps: ToolDeps = { db, policy: { repository: async () => {} } as unknown as McpPolicy,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  const catalog = createToolCatalog(deps);
  const call = (name: string, args: Record<string, unknown>, operationId = `op-${name}`) => {
    const tool = catalog.find(candidate => candidate.name === name)!;
    return tool.run({ principal, operationId, args: tool.schema.parse({ repository, ...args }) } as never);
  };
  return { call };
}

async function restUpdate(db: Knex, body: Record<string, unknown>): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = { statusCode: 200, body: {} as Record<string, unknown> };
  const res = { status(code: number) { response.statusCode = code; return res; }, json(value: Record<string, unknown>) { response.body = value; return res; } };
  await createPlannerRoutes({ db }).updateDraft({ params: { id: draftId }, user: { id: userId }, body } as never, res as never);
  return response;
}

for (const [label, plan, message] of invalidPlans) {
  test(`MCP create_plan, update_plan and the REST draft update all reject ${label}`, async t => {
    const db = await setup(t);
    const { call } = mcp(db);
    const rejectsWith = (error: unknown) => error instanceof McpError && error.code === 'PLAN_INVALID' && message.test(error.message);
    await assert.rejects(call('create_plan', { idempotencyKey: 'create-invalid', name: 'Plan', prompt: 'Prompt', plan }), rejectsWith);
    const { mcp_revision: revision } = await db('task_drafts').where({ draft_id: draftId }).first();
    await assert.rejects(call('update_plan', { idempotencyKey: 'update-invalid', planId: draftId, expectedRevision: revision, plan }), rejectsWith);

    const response = await restUpdate(db, { plan_json: plan });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.code, 'PLAN_INVALID');
    assert.match(String(response.body.error), message);
    assert.deepEqual(relation(await storedPlan(db)), [['initial', []]], 'a rejected plan is not stored');
  });
}

test('stored plans get ids for items without one and keep every existing id and dependsOn', async t => {
  const db = await setup(t);
  const { call } = mcp(db);
  const created = await call('create_plan', { idempotencyKey: 'create-plan', name: 'Plan', prompt: 'Prompt',
    plan: [task('Schema', { id: 'schema' }), task('Unnamed'), task('API', { id: 'api', dependsOn: ['schema'] })] });
  const createdId = (created.data as { planId: string }).planId;
  const createdPlan: Item[] = JSON.parse((await db('task_drafts').where({ draft_id: createdId }).first()).plan_json);
  assert.equal(createdPlan[0].id, 'schema');
  assert.match(createdPlan[1].id!, /^item-[0-9a-f]{12}$/);
  assert.deepEqual(createdPlan[2], task('API', { id: 'api', dependsOn: ['schema'] }));

  const { mcp_revision: revision } = await db('task_drafts').where({ draft_id: draftId }).first();
  await call('update_plan', { idempotencyKey: 'update-plan', planId: draftId, expectedRevision: revision,
    plan: [task('Initial', { id: 'initial' }), task('Next', { dependsOn: ['initial'] })] });
  const updated = await storedPlan(db);
  assert.equal(updated[0].id, 'initial');
  assert.deepEqual(updated[1].dependsOn, ['initial']);
  assert.match(updated[1].id!, /^item-/);

  // REST reorders keep ids and edges; a new item gets an id once.
  const reordered = [updated[1], updated[0], task('Added', { dependsOn: [updated[1].id!] })];
  assert.equal((await restUpdate(db, { plan_json: reordered })).statusCode, 200);
  const rest = await storedPlan(db);
  assert.deepEqual(relation(rest).slice(0, 2), [[updated[1].id, ['initial']], ['initial', []]]);
  assert.match(rest[2].id!, /^item-/);
  assert.deepEqual(rest[2].dependsOn, [updated[1].id]);
  assert.equal((await restUpdate(db, { plan_json: 'not a plan' })).statusCode, 400);
});

test('plan revisions and restore keep item ids and dependsOn', async t => {
  const original = [task('Schema', { id: 'schema' }), task('API', { id: 'api', dependsOn: ['schema'] })];
  const db = await setup(t, original);
  await db('task_drafts').where({ draft_id: draftId }).update({ plan_cause: 'generation' });
  assert.equal((await restUpdate(db, { plan_json: [task('Replacement', { id: 'replacement' })] })).statusCode, 200);

  const revisions = await listPlanRevisions(db, draftId);
  const snapshot = revisions.find(revision => revision.titles.join() === 'Schema,API')!;
  const restored = await restorePlanRevision(db, draftId, snapshot.revision_id);
  assert.equal(restored.restored, true);
  assert.deepEqual(await storedPlan(db), original);
  assert.deepEqual(restored.restored && restored.plan, original);
});

test('a refinement keeps item ids and drops dependsOn entries for removed tasks', async t => {
  t.mock.method(console, 'log', () => undefined);
  const currentPlan = [task('Schema', { id: 'schema' }), task('API', { id: 'api', dependsOn: ['schema'] }), task('UI', { id: 'ui', dependsOn: ['api'] })];
  const db = await setup(t, currentPlan);
  const runId = 'refinement-ids';
  await db('task_drafts').where({ draft_id: draftId }).update({ status: 'refining', refinement_result: JSON.stringify({ status: 'in_progress', runId }) });
  // The model rewrote the plan in full: it removed the API task, dropped the
  // UI task's id and added a task without one.
  const refined = [task('Schema', { id: 'schema' }), task('UI', { dependsOn: ['api', 'schema'] }), task('Docs', { dependsOn: ['ui'] })];
  await runBackgroundRefinement({ db, draftId, currentPlan, instruction: 'Drop the API task and add docs', generationModel: 'test-model',
    correlationId: runId, accessToken: 'token', runId }, {
    checkAborted: async () => false,
    getRepoContext: async () => ({ worktreePath: '/tmp/worktree', repository, authToken: 'token' }),
    refine: async () => ({ action: 'modified', summary: 'Removed the API task.', model: 'test-model', plan: refined }) as never,
  });

  const stored = await storedPlan(db);
  assert.deepEqual(relation(stored).slice(0, 2), [['schema', []], ['ui', ['schema']]]);
  assert.match(stored[2].id!, /^item-/);
  assert.deepEqual(stored[2].dependsOn, ['ui']);
});

function issueServer() {
  let posts = 0;
  let failAt: number | undefined;
  const remote: Array<{ number: number; html_url: string; title: string; body: string }> = [];
  const request = (async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues') return { data: [...remote].reverse().slice((Number(args.page) - 1) * 100, Number(args.page) * 100) };
    posts += 1;
    const issue = { number: 100 + posts, html_url: `https://github.com/acme/repo/issues/${100 + posts}`, title: String(args.title), body: String(args.body) };
    remote.push(issue);
    if (posts === failAt) throw Object.assign(new Error('socket closed after upload'), { code: 'ECONNRESET' });
    return { data: issue };
  }) as McpPrincipal['github']['request'];
  return { request, failOn: (post: number) => { failAt = post; } };
}

const publishedPlan = [task('UI', { id: 'ui', dependsOn: ['api'] }), task('Schema', { id: 'schema' }), task('API', { id: 'api', dependsOn: ['schema'] })];
const expectedRows = [
  { issue_number: 101, plan_item_id: 'ui', depends_on_issues: [103] },
  { issue_number: 102, plan_item_id: 'schema', depends_on_issues: [] },
  { issue_number: 103, plan_item_id: 'api', depends_on_issues: [102] },
];

async function publishedRows(db: Knex, call: ReturnType<typeof mcp>['call']) {
  const plan = (await call('get_plan', { planId: draftId })).data as { issues: Array<Record<string, unknown>> };
  return plan.issues.map(({ issue_number, plan_item_id, depends_on_issues }) => ({ issue_number, plan_item_id, depends_on_issues }))
    .sort((left, right) => Number(left.issue_number) - Number(right.issue_number));
}

test('MCP publish_plan records each issue item id and prerequisite issue numbers, also for forward references', async t => {
  const db = await setup(t, publishedPlan);
  const server = issueServer();
  const { call } = mcp(db, server.request);
  const { mcp_revision: revision } = await db('task_drafts').where({ draft_id: draftId }).first();
  await call('publish_plan', { idempotencyKey: 'publish-plan', planId: draftId, expectedRevision: revision });

  assert.deepEqual(await publishedRows(db, call), expectedRows);
  assert.deepEqual(relation(await storedPlan(db)), relation(publishedPlan));
});

test('a resumed MCP publication records the same rows as an uninterrupted one', async t => {
  const db = await setup(t, publishedPlan);
  const server = issueServer();
  server.failOn(2);
  const { call } = mcp(db, server.request);
  const { mcp_revision: revision } = await db('task_drafts').where({ draft_id: draftId }).first();
  await assert.rejects(call('publish_plan', { idempotencyKey: 'publish-first', planId: draftId, expectedRevision: revision }, 'first-attempt'),
    (error: unknown) => error instanceof McpError && error.code === 'PUBLISH_PARTIAL');

  const partial = await db('task_drafts').where({ draft_id: draftId }).first();
  await call('publish_plan', { idempotencyKey: 'publish-resume', planId: draftId, expectedRevision: partial.mcp_revision, resume: true }, 'resume-attempt');
  assert.deepEqual(await publishedRows(db, call), expectedRows);
});

test('REST finalize refuses a stored plan with invalid dependencies before claiming it', async t => {
  const db = await setup(t, [task('A', { id: 'a', dependsOn: ['ghost'] })]);
  const response = { statusCode: 200, body: {} as Record<string, unknown> };
  const res = { status(code: number) { response.statusCode = code; return res; }, json(value: Record<string, unknown>) { response.body = value; return res; } };
  await createFinalizeHandler(db)({ body: { draftId }, user: { id: userId } } as never, res as never);
  assert.equal(response.statusCode, 400);
  assert.match(String(response.body.error), /Task 1 "A" \(id "a"\) depends on "ghost"/);
  assert.equal((await db('task_drafts').where({ draft_id: draftId }).first()).status, 'review');
});

test('plan issues published before dependencies existed read as having no prerequisites', async t => {
  const db = await setup(t);
  await db('plan_issues').insert({ draft_id: draftId, repository, issue_number: 7 });
  const { call } = mcp(db);
  assert.deepEqual(await publishedRows(db, call), [{ issue_number: 7, plan_item_id: null, depends_on_issues: [] }]);
});
