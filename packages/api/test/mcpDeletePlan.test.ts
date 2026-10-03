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
