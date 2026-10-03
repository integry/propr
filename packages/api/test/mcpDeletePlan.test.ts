import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { randomBytes } from 'node:crypto';
import { closeConnection } from '@propr/core';
import { createToolCatalog, executeTool, type ToolDeps } from '../mcp/tools.js';
import { McpError } from '../mcp/config.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { presentResultText } from '../mcp/presentation.js';

const repository = 'acme/repo';
const userId = '123';

after(async () => closeConnection());

async function setup(t: { after: (fn: () => Promise<void>) => void }): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  return db;
}

async function insertPlan(db: Knex, id: string, status: string, revision = 0): Promise<void> {
  await db('task_drafts').insert({ draft_id: id, user_id: userId, repository, status, mcp_revision: revision, plan_json: '[]' });
}

/**
 * Let delete_plan's first plan read resolve, then apply a concurrent change
 * before the tool continues, so its conditional delete races that change.
 */
function raceAfterFirstRead(db: Knex, race: () => Promise<unknown>): Knex {
  let pending = true;
  return new Proxy(db, { apply(target, thisArg, args) {
    const builder = Reflect.apply(target, thisArg, args) as Knex.QueryBuilder;
    if (!pending || args[0] !== 'task_drafts') return builder;
    pending = false;
    const then = builder.then.bind(builder);
    builder.then = ((resolve, reject) => then(async (row: unknown) => { await race(); return row; }).then(resolve, reject)) as typeof builder.then;
    return builder;
  } });
}

function deletePlan(db: Knex) {
  const principal = { user: { id: userId }, grant: { id: 'grant-1' } } as unknown as McpPrincipal;
  const deps: ToolDeps = { db, policy: { repository: async () => {} } as unknown as McpPolicy,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  const tool = createToolCatalog(deps).find(candidate => candidate.name === 'delete_plan')!;
  return (planId: string, expectedRevision?: number) => tool.run({ principal, operationId: `delete-${planId}`,
    args: tool.schema.parse({ repository, planId, idempotencyKey: `delete-${planId}`, ...(expectedRevision === undefined ? {} : { expectedRevision }) }) } as never);
}

const exists = async (db: Knex, id: string) => !!(await db('task_drafts').where({ draft_id: id }).first());

test('delete_plan deletes a failed plan at its current revision', async t => {
  const db = await setup(t);
  const id = '00000000-0000-4000-8000-000000000001';
  await insertPlan(db, id, 'failed', 3);
  const result = await deletePlan(db)(id, 3);
  assert.deepEqual(result.data, { planId: id, deleted: true });
  assert.equal(await exists(db, id), false);
});

test('delete_plan deletes the current revision when expectedRevision is omitted', async t => {
  const db = await setup(t);
  const draft = '00000000-0000-4000-8000-000000000002';
  const merged = '00000000-0000-4000-8000-000000000003';
  await insertPlan(db, draft, 'review', 7);
  await insertPlan(db, merged, 'merged', 2);
  await deletePlan(db)(draft);
  await deletePlan(db)(merged);
  assert.equal(await exists(db, draft), false);
  assert.equal(await exists(db, merged), false);
});

test('delete_plan rejects a stale expectedRevision with STALE_REVISION', async t => {
  const db = await setup(t);
  const id = '00000000-0000-4000-8000-000000000004';
  await insertPlan(db, id, 'draft', 2);
  await assert.rejects(deletePlan(db)(id, 1), (error: McpError) => {
    assert.equal(error.code, 'STALE_REVISION');
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { currentRevision: 2 });
    return true;
  });
  assert.equal(await exists(db, id), true);
});

test('delete_plan rejects a busy plan with PLAN_NOT_DELETABLE, not STALE_REVISION', async t => {
  const db = await setup(t);
  for (const [index, status] of ['generating', 'refining', 'executing', 'executed', 'pr_created'].entries()) {
    const id = `00000000-0000-4000-8000-00000000010${index}`;
    await insertPlan(db, id, status, 4);
    for (const expectedRevision of [4, undefined]) {
      await assert.rejects(deletePlan(db)(id, expectedRevision), (error: McpError) => {
        assert.equal(error.code, 'PLAN_NOT_DELETABLE');
        assert.equal(error.status, 409);
        assert.equal(error.stage, 'precondition');
        assert.equal(error.details?.status, status);
        assert.equal(error.details?.currentRevision, 4);
        assert.match(error.message, new RegExp(status));
        return true;
      });
    }
    assert.equal(await exists(db, id), true);
  }
});

test('delete_plan reports STALE_REVISION when the revision changes before its conditional delete', async t => {
  const db = await setup(t);
  const id = '00000000-0000-4000-8000-000000000201';
  await insertPlan(db, id, 'review', 5);
  const raced = raceAfterFirstRead(db, () => db('task_drafts').where({ draft_id: id }).update({ mcp_revision: 6 }));
  await assert.rejects(deletePlan(raced)(id), (error: McpError) => {
    assert.equal(error.code, 'STALE_REVISION');
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { currentRevision: 6 });
    return true;
  });
  assert.equal(await exists(db, id), true);
});

test('delete_plan reports PLAN_NOT_DELETABLE when the plan becomes busy before its conditional delete', async t => {
  const db = await setup(t);
  const id = '00000000-0000-4000-8000-000000000202';
  await insertPlan(db, id, 'review', 5);
  // The revision trigger bumps the revision too; the busy status takes precedence over staleness.
  const raced = raceAfterFirstRead(db, () => db('task_drafts').where({ draft_id: id }).update({ status: 'generating' }));
  await assert.rejects(deletePlan(raced)(id, 5), (error: McpError) => {
    assert.equal(error.code, 'PLAN_NOT_DELETABLE');
    assert.equal(error.status, 409);
    assert.equal(error.details?.status, 'generating');
    assert.equal(error.details?.currentRevision, 6);
    return true;
  });
  assert.equal((await db('task_drafts').where({ draft_id: id }).first('status')).status, 'generating');
});

test('delete_plan succeeds when the plan is deleted concurrently before its conditional delete', async t => {
  const db = await setup(t);
  const id = '00000000-0000-4000-8000-000000000203';
  await insertPlan(db, id, 'failed', 1);
  const raced = raceAfterFirstRead(db, () => db('task_drafts').where({ draft_id: id }).delete());
  const result = await deletePlan(raced)(id, 1);
  assert.deepEqual(result.data, { planId: id, deleted: true });
  assert.equal(await exists(db, id), false);
});

function dispatcher(db: Knex) {
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test-instance', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  policy.repository = async () => { /* repository authorization is covered elsewhere */ };
  const deps: ToolDeps = { db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  const principal = {
    user: { id: userId, login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'fixture' },
    authorization: { role: 'member', permissions: [], source: 'local' },
    grant: { id: 'grant-1', ownerId: userId, clientId: 'client-1', clientName: 'Claude', instanceId: 'test-instance',
      resource: config.resource, scopes: ['read', 'plan'], repositories: [repository],
      createdAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' },
    scopes: ['read', 'plan'],
    github: {} as never,
  } as McpPrincipal;
  const tool = createToolCatalog(deps).find(candidate => candidate.name === 'delete_plan')!;
  return (args: Record<string, unknown>) => executeTool(tool, { repository, ...args }, principal, deps);
}

test('PLAN_NOT_DELETABLE and its details survive the durable receipt through the dispatcher', async t => {
  const db = await setup(t);
  const id = '00000000-0000-4000-8000-000000000301';
  await insertPlan(db, id, 'executing', 4);
  const call = dispatcher(db);
  const args = { planId: id, idempotencyKey: 'delete-busy-plan', expectedRevision: 4 };
  const failed = await call(args);
  assert.equal(failed.data.state, 'failed');
  const error = (failed.data.result as { error: Record<string, unknown> }).error;
  assert.equal(error.code, 'PLAN_NOT_DELETABLE');
  assert.equal(error.status, 409);
  assert.equal(error.stage, 'precondition');
  assert.deepEqual(error.details, { status: 'executing', currentRevision: 4, deletableStatuses: ['draft', 'review', 'approved', 'merged', 'failed'] });
  assert.match(presentResultText(failed), /PLAN_NOT_DELETABLE/);
  const access = await db('mcp_access_log').where({ name: 'delete_plan' }).first('error_code');
  assert.equal(access.error_code, 'PLAN_NOT_DELETABLE');
  // A retry with the same key replays the stored failure rather than re-running.
  const replayed = await call(args);
  assert.equal(replayed.data.operationId, failed.data.operationId);
  assert.deepEqual((replayed.data.result as { error: unknown }).error, error);
  assert.equal(await exists(db, id), true);
});

test('delete_plan without expectedRevision replays its completed receipt after the plan is gone', async t => {
  const db = await setup(t);
  const id = '00000000-0000-4000-8000-000000000302';
  await insertPlan(db, id, 'failed', 9);
  const call = dispatcher(db);
  const args = { planId: id, idempotencyKey: 'delete-failed-plan' };
  const deleted = await call(args);
  assert.equal(deleted.data.state, 'completed');
  assert.deepEqual(deleted.data.result, { planId: id, deleted: true });
  assert.equal(await exists(db, id), false);
  const replayed = await call(args);
  assert.equal(replayed.data.operationId, deleted.data.operationId);
  assert.equal(replayed.data.state, 'completed');
  assert.deepEqual(replayed.data.result, { planId: id, deleted: true });
});
