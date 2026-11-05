import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { createToolCatalog, type ToolDeps } from '../mcp/tools.js';
import { createPlannerRoutes } from '../routes/plannerRoutes.js';
import { getCurrentPlanCause, listPlanRevisions, restorePlanRevision } from '../routes/plannerHelpers/planRevisions.js';
import { runBackgroundRefinement } from '../routes/plannerHelpers/refineBackground.js';
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

async function refineInBackground(db: Knex, currentPlan: string, result: { action: string; plan: unknown }): Promise<void> {
  const runId = `refinement-${result.action}`;
  await setDraft(db, { status: 'refining', refinement_result: JSON.stringify({ status: 'in_progress', runId }) });
  await runBackgroundRefinement({ db, draftId, currentPlan: JSON.parse(currentPlan), instruction: 'How does this work?',
    generationModel: 'test-model', correlationId: runId, accessToken: 'token', runId }, {
    checkAborted: async () => false,
    getRepoContext: async () => ({ worktreePath: '/tmp/worktree', repository: 'acme/repo', authToken: 'token' }),
    refine: async () => ({ summary: 'Refinement finished.', model: 'test-model', ...result }) as never,
  });
  const refined = await draft(db);
  assert.equal(refined.status, 'review');
  assert.equal(JSON.parse(refined.refinement_result).action, result.action);
}

for (const action of ['answered', 'clarify'] as const) {
  test(`a refinement that only ${action === 'answered' ? 'answers' : 'asks for clarification'} keeps generation provenance in the history`, async t => {
    t.mock.method(console, 'log', () => undefined);
    const db = await setup(t);
    const generated = plan('A1', 'A2', 'A3', 'A4');
    await setDraft(db, { plan_cause: 'generation' });

    await refineInBackground(db, generated, { action, plan: JSON.parse(plan('Unrequested')) });
    assert.equal((await draft(db)).plan_json, generated);
    assert.equal((await draft(db)).plan_cause, 'generation');
    assert.equal(await getCurrentPlanCause(db, draftId), 'generation');
    assert.deepEqual(await listPlanRevisions(db, draftId), [], 'the preserved plan does not create a snapshot');

    await setDraft(db, { plan_json: plan('Edited later'), plan_cause: 'manual_edit' });
    const [snapshot] = await listPlanRevisions(db, draftId);
    assert.deepEqual(snapshot.titles, ['A1', 'A2', 'A3', 'A4']);
    assert.equal(snapshot.cause, 'generation', 'the generated plan is not recorded as a refined version');
  });
}

test('a refinement that replaces the plan records refinement provenance for the new plan only', async t => {
  t.mock.method(console, 'log', () => undefined);
  const db = await setup(t);
  await setDraft(db, { plan_cause: 'generation' });

  await refineInBackground(db, plan('A1', 'A2', 'A3', 'A4'), { action: 'modified', plan: JSON.parse(plan('B1', 'B2')) });
  assert.equal((await draft(db)).plan_json, plan('B1', 'B2'));
  assert.equal((await draft(db)).plan_cause, 'refinement');
  const [snapshot] = await listPlanRevisions(db, draftId);
  assert.deepEqual(snapshot.titles, ['A1', 'A2', 'A3', 'A4']);
  assert.equal(snapshot.cause, 'generation');
  assert.equal(snapshot.currentCause, 'refinement');
});
