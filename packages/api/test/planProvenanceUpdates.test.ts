import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { createToolCatalog, type ToolDeps } from '../mcp/tools.js';
import { createPlannerRoutes } from '../routes/plannerRoutes.js';
import { listPlanRevisions, restorePlanRevision } from '../routes/plannerHelpers/planRevisions.js';
import type { McpPolicy, McpPrincipal } from '../mcp/policy.js';

after(async () => closeConnection());

const draftId = '11111111-1111-4111-8111-111111111111';
const plan = (...titles: string[]) => JSON.stringify(titles.map(title => (
  { title, body: `${title} body`, implementation: `${title} steps` }
)));
const setDraft = (db: Knex, update: Record<string, unknown>) => db('task_drafts').where({ draft_id: draftId }).update(update);
const draft = (db: Knex) => db('task_drafts').where({ draft_id: draftId }).first();
type PreservedCause = 'generation' | 'refinement' | 'restore';

async function setup(t: { after: (fn: () => Promise<void>) => void }): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  await db('task_drafts').insert({ draft_id: draftId, user_id: '123', repository: 'acme/repo', status: 'review',
    plan_json: plan('A1', 'A2', 'A3', 'A4') });
  return db;
}

async function prepareCurrentCause(db: Knex, cause: PreservedCause): Promise<void> {
  if (cause !== 'restore') {
    await setDraft(db, { plan_cause: cause });
    return;
  }
  await setDraft(db, { plan_cause: 'generation' });
  await setDraft(db, { plan_json: plan('Temporary replacement'), plan_cause: 'manual_edit' });
  const original = (await listPlanRevisions(db, draftId)).find(revision => revision.cause === 'generation')!;
  assert.equal((await restorePlanRevision(db, draftId, original.revision_id)).restored, true);
}

for (const cause of ['generation', 'refinement', 'restore'] as const) {
  test(`HTTP unchanged plan submissions preserve ${cause} provenance`, async t => {
    const db = await setup(t);
    await prepareCurrentCause(db, cause);
    const historyBefore = await listPlanRevisions(db, draftId);
    const routes = createPlannerRoutes({ db });
    const call = async (body: Record<string, unknown>) => {
      const response = { statusCode: 200 };
      const res = { status(code: number) { response.statusCode = code; return res; }, json() { return res; } };
      await routes.updateDraft({ params: { id: draftId }, user: { id: '123' }, body } as never, res as never);
      assert.equal(response.statusCode, 200);
    };

    await call({ plan_json: JSON.parse(plan('A1', 'A2', 'A3', 'A4')), initial_prompt: `Updated after ${cause}` });
    assert.equal((await draft(db)).plan_cause, cause);
    assert.deepEqual((await listPlanRevisions(db, draftId)).map(revision => revision.revision_id),
      historyBefore.map(revision => revision.revision_id), 'the unchanged plan does not create a snapshot');

    await call({ plan_json: JSON.parse(plan(`HTTP replacement after ${cause}`)) });
    const [snapshot] = await listPlanRevisions(db, draftId);
    assert.equal(snapshot.cause, cause, 'the later replacement retains the outgoing plan provenance');
    assert.deepEqual(snapshot.titles, ['A1', 'A2', 'A3', 'A4']);
    assert.equal((await draft(db)).plan_cause, 'manual_edit');
  });
}

for (const cause of ['generation', 'refinement', 'restore'] as const) {
  test(`MCP unchanged plan submissions preserve ${cause} provenance`, async t => {
    const db = await setup(t);
    await prepareCurrentCause(db, cause);
    const historyBefore = await listPlanRevisions(db, draftId);
    const deps: ToolDeps = { db, policy: {} as McpPolicy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
    const tool = createToolCatalog(deps).find(candidate => candidate.name === 'update_plan')!;
    const principal = { user: { id: '123' } } as McpPrincipal;
    const update = async (expectedRevision: number, nextPlan: string, idempotencyKey: string) => tool.run({ principal,
      args: tool.schema.parse({ repository: 'acme/repo', planId: draftId, expectedRevision, idempotencyKey,
        prompt: `Updated after ${cause}`, plan: JSON.parse(nextPlan) }) } as never);

    const before = await draft(db);
    const unchanged = await update(before.mcp_revision, before.plan_json, `unchanged-${cause}`);
    assert.equal(unchanged.status, 200);
    assert.equal((await draft(db)).plan_cause, cause);
    assert.deepEqual((await listPlanRevisions(db, draftId)).map(revision => revision.revision_id),
      historyBefore.map(revision => revision.revision_id), 'the unchanged plan does not create a snapshot');

    const afterUnchanged = await draft(db);
    await update(afterUnchanged.mcp_revision, plan(`MCP replacement after ${cause}`), `replacement-${cause}`);
    const [snapshot] = await listPlanRevisions(db, draftId);
    assert.equal(snapshot.cause, cause, 'the later replacement retains the outgoing plan provenance');
    assert.deepEqual(snapshot.titles, ['A1', 'A2', 'A3', 'A4']);
    assert.equal((await draft(db)).plan_cause, 'manual_edit');
  });
}
