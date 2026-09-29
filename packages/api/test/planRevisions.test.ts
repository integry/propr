import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { down as removePlanRevisionCauses } from '../../core/src/db/migrations/20261002000000_add_plan_revision_causes.js';
import { getPlanRevision, listPlanRevisions, restorePlanRevision } from '../routes/plannerHelpers/planRevisions.js';
import { createToolCatalog, type ToolDeps } from '../mcp/tools.js';
import { createListPlanRevisionsHandler, createRestorePlanRevisionHandler } from '../routes/plannerHelpers/handlers/revisionHandlers.js';
import { verifyDraftOwnership } from '../routes/plannerHelpers/auth.js';
import type { McpPolicy, McpPrincipal } from '../mcp/policy.js';

after(async () => closeConnection());

const draftId = '11111111-1111-4111-8111-111111111111';
const plan = (...titles: string[]) => JSON.stringify(titles.map(title => ({ title, body: `${title} body`, implementation: `${title} steps` })));

async function setup(t: { after: (fn: () => Promise<void>) => void }): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  await db('task_drafts').insert({ draft_id: draftId, user_id: '123', repository: 'acme/repo', status: 'review', plan_json: plan('A1', 'A2', 'A3', 'A4') });
  return db;
}

const setDraft = (db: Knex, update: Record<string, unknown>) => db('task_drafts').where({ draft_id: draftId }).update(update);
const draft = (db: Knex) => db('task_drafts').where({ draft_id: draftId }).first();
// Moves every snapshot outside the edit coalescing window.
const age = (db: Knex) => db('task_draft_plan_revisions').update({ replaced_at: db.raw("datetime('now', '-1 hour')") });

test('every status-changing plan write keeps the replaced plan with the revision it had', async t => {
  const db = await setup(t);
  const initialRevision = (await draft(db)).mcp_revision;

  await setDraft(db, { status: 'refining' });
  assert.equal((await listPlanRevisions(db, draftId)).length, 0, 'a write that keeps plan_json records nothing');

  await setDraft(db, { status: 'review', plan_json: plan('B1') });
  const revisions = await listPlanRevisions(db, draftId);
  assert.equal(revisions.length, 1);
  assert.deepEqual(revisions[0].titles, ['A1', 'A2', 'A3', 'A4']);
  assert.equal(revisions[0].issue_count, 4);
  assert.equal(revisions[0].status_before, 'refining');
  assert.equal(revisions[0].status_after, 'review');
  // The mcp_revision trigger bumped once for the refining claim; the snapshot keeps that revision.
  assert.equal(revisions[0].draft_revision, initialRevision + 1);
  assert.equal((await draft(db)).mcp_revision, initialRevision + 2);

  await setDraft(db, { plan_json: null });
  await setDraft(db, { plan_json: plan('C1') });
  assert.deepEqual((await listPlanRevisions(db, draftId)).map(revision => revision.titles), [['B1'], ['A1', 'A2', 'A3', 'A4']],
    'clearing the plan records it once and a plan written into an empty draft records nothing');
});

test('records plan provenance, rename details and restore provenance in order', async t => {
  const db = await setup(t);
  await setDraft(db, { plan_cause: 'generation' });

  await setDraft(db, { status: 'refining' });
  await setDraft(db, { status: 'review', plan_json: plan('Refined'), plan_cause: 'refinement' });
  await setDraft(db, { plan_json: plan('Edited'), plan_cause: 'manual_edit' });
  await setDraft(db, { name: 'Renamed plan' });

  const beforeRestore = await listPlanRevisions(db, draftId);
  assert.deepEqual(beforeRestore.map(revision => revision.cause), ['rename', 'refinement', 'generation']);
  assert.equal(beforeRestore[0].nameBefore, 'Untitled Plan');
  assert.equal(beforeRestore[0].nameAfter, 'Renamed plan');
  assert.equal(beforeRestore[0].currentCause, 'manual_edit');
  assert.equal(beforeRestore.filter(revision => revision.cause === 'rename').length, 1,
    'a name-only update creates exactly one rename row');

  const original = beforeRestore.find(revision => revision.cause === 'generation')!;
  assert.equal((await restorePlanRevision(db, draftId, original.revision_id)).restored, true);
  const afterRestore = await listPlanRevisions(db, draftId);
  assert.deepEqual(afterRestore.map(revision => revision.cause), ['manual_edit', 'rename', 'refinement', 'generation']);
  assert.equal(afterRestore[0].currentCause, 'restore');
  assert.equal((await getPlanRevision(db, draftId, afterRestore[0].revision_id))!.currentCause, 'restore');

  await setDraft(db, { plan_json: plan('Edited after restore'), plan_cause: 'manual_edit' });
  assert.equal((await listPlanRevisions(db, draftId))[0].cause, 'restore',
    'replacing a restored plan snapshots it with restore provenance');
});

test('reports unknown for legacy rows and live plans without provenance', async t => {
  const db = await setup(t);
  await setDraft(db, { plan_json: plan('Legacy replacement') });
  const [revision] = await listPlanRevisions(db, draftId);
  assert.equal(revision.cause, 'unknown');
  assert.equal(revision.currentCause, 'unknown');
  assert.equal((await getPlanRevision(db, draftId, revision.revision_id))!.cause, 'unknown');
});

test('migration down removes cause metadata and restores the original plan trigger', async t => {
  const db = await setup(t);
  await removePlanRevisionCauses(db);

  assert.equal(await db.schema.hasColumn('task_drafts', 'plan_cause'), false);
  assert.equal(await db.schema.hasColumn('task_draft_plan_revisions', 'cause'), false);
  const trigger = await db('sqlite_master').where({ type: 'trigger', name: 'task_drafts_plan_history' }).first('sql');
  assert.ok(trigger?.sql.includes('INSERT INTO task_draft_plan_revisions (draft_id, plan_json, draft_revision, status_before, status_after, replaced_at)'));

  await setDraft(db, { plan_json: plan('After rollback') });
  const row = await db('task_draft_plan_revisions').where({ draft_id: draftId }).first();
  assert.equal(row.plan_json, plan('A1', 'A2', 'A3', 'A4'));
});

test('autosaved edits are coalesced until the edit window passes, but never hide an operation result', async t => {
  const db = await setup(t);
  await setDraft(db, { status: 'refining' });
  await setDraft(db, { status: 'review', plan_json: plan('Refined') });
  await setDraft(db, { plan_json: plan('Refined edit 1') });
  await setDraft(db, { plan_json: plan('Refined edit 2') });
  await setDraft(db, { plan_json: plan('Refined edit 3') });
  assert.deepEqual((await listPlanRevisions(db, draftId)).map(revision => revision.titles[0]), ['Refined', 'A1'],
    'the refinement output is kept before the first edit; later edits in the burst are not');

  await age(db);
  await setDraft(db, { plan_json: plan('Refined edit 4') });
  assert.deepEqual((await listPlanRevisions(db, draftId)).map(revision => revision.titles[0]), ['Refined edit 3', 'Refined', 'A1']);

  await setDraft(db, { status: 'refining' });
  await setDraft(db, { status: 'review', plan_json: plan('Refined again') });
  assert.equal((await listPlanRevisions(db, draftId))[0].titles[0], 'Refined edit 4', 'a refinement inside the edit window still records');
});

for (const status of ['refining', 'generating']) {
  test(`${status} preserves its result when the outgoing plan duplicates a recent edit snapshot`, async t => {
    const db = await setup(t);
    const originalPlan = (await draft(db)).plan_json;
    await setDraft(db, { plan_json: plan('B') });
    await setDraft(db, { plan_json: originalPlan });
    const [original] = await listPlanRevisions(db, draftId);
    assert.equal(original.status_before, 'review');
    assert.equal(original.status_after, 'review');

    await setDraft(db, { status });
    const beforeOperation = await draft(db);
    await setDraft(db, { status: 'review', plan_json: plan('C') });
    const boundary = await listPlanRevisions(db, draftId);
    assert.equal(boundary.length, 1, 'the duplicate outgoing plan is still stored only once');
    assert.equal(boundary[0].revision_id, original.revision_id);
    assert.equal(boundary[0].status_before, status);
    assert.equal(boundary[0].status_after, 'review');
    assert.equal(boundary[0].draft_revision, beforeOperation.mcp_revision);

    await setDraft(db, { plan_json: plan('D') });
    const revisions = await listPlanRevisions(db, draftId);
    assert.deepEqual(revisions.map(revision => revision.titles[0]), ['C', 'A1'],
      'the first edit preserves the operation result within the coalescing window');
    assert.deepEqual((await getPlanRevision(db, draftId, revisions[0].revision_id))!.plan, JSON.parse(plan('C')));
    await setDraft(db, { plan_json: plan('E') });
    assert.deepEqual(await listPlanRevisions(db, draftId), revisions, 'subsequent edits still coalesce');
    assert.equal((await restorePlanRevision(db, draftId, revisions[0].revision_id)).restored, true);
    assert.equal((await draft(db)).plan_json, plan('C'), 'the complete operation result can be recovered');
  });
}

test('history is capped per draft and removed with the draft', async t => {
  const db = await setup(t);
  for (let index = 0; index < 55; index += 1) {
    await setDraft(db, { status: index % 2 ? 'review' : 'approved', plan_json: plan(`P${index}`) });
  }
  const revisions = await listPlanRevisions(db, draftId);
  assert.equal(revisions.length, 50);
  assert.equal(revisions[0].titles[0], 'P53');
  assert.equal(revisions[49].titles[0], 'P4');

  await db('task_drafts').where({ draft_id: draftId }).delete();
  assert.equal((await db('task_draft_plan_revisions').count('* as count').first())!.count, 0);
});

test('restoring brings back the plan, keeps the replaced one and is refused for busy, published or stale drafts', async t => {
  const db = await setup(t);
  await setDraft(db, { status: 'refining' });
  await setDraft(db, { status: 'review', plan_json: plan('Lossy') });
  // A recent edit makes the trigger coalesce, so restore must record the current plan itself.
  await setDraft(db, { plan_json: plan('Lossy edited') });
  const [editSnapshot, original] = await listPlanRevisions(db, draftId);
  assert.equal(original.titles[0], 'A1');
  assert.equal(editSnapshot.titles[0], 'Lossy');

  const full = await getPlanRevision(db, draftId, original.revision_id);
  assert.equal((full!.plan[0] as { body: string }).body, 'A1 body');
  assert.equal(await getPlanRevision(db, '22222222-2222-4222-8222-222222222222', original.revision_id), null, 'revisions are scoped to their draft');

  const current = await draft(db);
  assert.deepEqual(await restorePlanRevision(db, draftId, original.revision_id, { expectedRevision: current.mcp_revision - 1 }), { restored: false, reason: 'conflict' });
  assert.deepEqual(await restorePlanRevision(db, draftId, 999_999), { restored: false, reason: 'not_found' });

  const restored = await restorePlanRevision(db, draftId, original.revision_id, { expectedRevision: current.mcp_revision });
  assert.equal(restored.restored, true);
  const after = await draft(db);
  assert.equal(after.plan_json, plan('A1', 'A2', 'A3', 'A4'));
  assert.equal(after.status, 'review');
  assert.equal(restored.restored && restored.revision, after.mcp_revision);
  assert.deepEqual((await listPlanRevisions(db, draftId)).map(revision => revision.titles[0]), ['Lossy edited', 'Lossy', 'A1'],
    'the replaced plan is recorded exactly once, so the restore can be undone');

  for (const status of ['generating', 'refining', 'executing', 'executed']) {
    await setDraft(db, { status });
    assert.deepEqual(await restorePlanRevision(db, draftId, original.revision_id), { restored: false, reason: 'conflict' }, status);
  }
  assert.equal((await draft(db)).plan_json, plan('A1', 'A2', 'A3', 'A4'));
});

test('restoring the oldest version at capacity preserves it through the next edit', async t => {
  const db = await setup(t);
  for (let index = 0; index < 50; index += 1) {
    await setDraft(db, { status: index % 2 ? 'review' : 'approved', plan_json: plan(`P${index}`) });
  }
  const original = (await listPlanRevisions(db, draftId))[49];
  const restoredPlan = plan('A1', 'A2', 'A3', 'A4');
  assert.equal((await draft(db)).status, 'review');
  assert.equal((await restorePlanRevision(db, draftId, original.revision_id)).restored, true);
  assert.equal(await getPlanRevision(db, draftId, original.revision_id), null, 'retention evicts the original snapshot');
  assert.equal((await draft(db)).plan_json, restoredPlan);
  assert.equal((await listPlanRevisions(db, draftId))[0].titles[0], 'P49', 'restore itself can be undone');

  await setDraft(db, { plan_json: plan('Bad edit') });
  const revisions = await listPlanRevisions(db, draftId);
  assert.equal(revisions.length, 50);
  assert.deepEqual((await getPlanRevision(db, draftId, revisions[0].revision_id))!.plan, JSON.parse(restoredPlan));
  await setDraft(db, { plan_json: plan('Another edit') });
  assert.deepEqual(await listPlanRevisions(db, draftId), revisions, 'later edits still coalesce');
  assert.equal((await restorePlanRevision(db, draftId, revisions[0].revision_id)).restored, true);
  assert.equal((await draft(db)).plan_json, restoredPlan);
});

test('a restore breaks coalescing when the outgoing plan is already the newest snapshot', async t => {
  const db = await setup(t);
  await setDraft(db, { status: 'refining' });
  await setDraft(db, { status: 'review', plan_json: plan('Refined') });
  await setDraft(db, { plan_json: plan('Edited') });
  await setDraft(db, { plan_json: plan('Refined') });
  const [latest, original] = await listPlanRevisions(db, draftId);
  assert.equal(latest.titles[0], 'Refined');
  await restorePlanRevision(db, draftId, original.revision_id);
  assert.equal((await listPlanRevisions(db, draftId)).length, 2, 'no duplicate outgoing snapshot');
  await setDraft(db, { plan_json: plan('Bad edit') });
  assert.deepEqual((await listPlanRevisions(db, draftId)).map(revision => revision.titles[0]), ['A1', 'Refined', 'A1']);
});

test('MCP publication after recent edits preserves the complete pre-publication plan', async t => {
  const db = await setup(t);
  await setDraft(db, { plan_json: plan('First edit', 'Second task') });
  await setDraft(db, { plan_json: plan('Ready to publish', 'Second task') });
  const before = await draft(db);
  assert.equal((await listPlanRevisions(db, draftId)).length, 1);
  let issueNumber = 0;
  const principal = { user: { id: '123' }, github: { request: async (_route: string, args: { title: string }) => {
    issueNumber += 1;
    return { data: { number: issueNumber, html_url: `https://github.com/acme/repo/issues/${issueNumber}`, title: args.title } };
  } } } as unknown as McpPrincipal;
  const deps: ToolDeps = { db, policy: { repository: async () => {} } as unknown as McpPolicy,
    taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  const tool = createToolCatalog(deps).find(candidate => candidate.name === 'publish_plan')!;
  await tool.run({ principal, operationId: 'publish-history', args: tool.schema.parse({
    repository: 'acme/repo', planId: draftId, expectedRevision: before.mcp_revision, idempotencyKey: 'publish-history',
  }) } as never);
  assert.equal((await draft(db)).status, 'executed');
  assert.equal(issueNumber, 2);
  const revisions = await listPlanRevisions(db, draftId);
  assert.equal(revisions.length, 2, 'issue-link writes coalesce only within the publishing status');
  assert.deepEqual((await getPlanRevision(db, draftId, revisions[0].revision_id))!.plan, JSON.parse(before.plan_json));
});

test('MCP tools list, read and restore plan revisions at an exact revision', async t => {
  const db = await setup(t);
  await setDraft(db, { status: 'refining' });
  await setDraft(db, { status: 'review', plan_json: plan('Lossy') });

  const deps: ToolDeps = { db, policy: {} as McpPolicy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  const catalog = createToolCatalog(deps);
  const principal = { user: { id: '123' } } as McpPrincipal;
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = catalog.find(candidate => candidate.name === name)!;
    return tool.run({ principal, args: tool.schema.parse({ repository: 'acme/repo', planId: draftId, ...args }) } as never);
  };

  const listed = await run('list_plan_revisions', {});
  assert.equal((listed.data as { currentCause: string }).currentCause, 'unknown');
  const [revision] = (listed.data as { revisions: Array<{ revision_id: number; titles: string[] }> }).revisions;
  assert.deepEqual(revision.titles, ['A1', 'A2', 'A3', 'A4']);
  const read = await run('get_plan_revision', { revisionId: revision.revision_id });
  assert.equal((read.data as { plan: unknown[] }).plan.length, 4);
  await assert.rejects(run('get_plan_revision', { revisionId: 999_999 }), /Plan revision not found/);

  const { mcp_revision: revisionNow } = await draft(db);
  await assert.rejects(run('restore_plan_revision', { revisionId: revision.revision_id, expectedRevision: revisionNow + 1, idempotencyKey: 'restore-stale' }), /Read it again/);
  const restored = await run('restore_plan_revision', { revisionId: revision.revision_id, expectedRevision: revisionNow, idempotencyKey: 'restore-current' });
  assert.equal(restored.status, 200);
  assert.equal((restored.data as { revision: number }).revision, (await draft(db)).mcp_revision);
  assert.equal((await draft(db)).plan_json, plan('A1', 'A2', 'A3', 'A4'));
});

test('get_plan exposes compact revision history and the live plan cause', async t => {
  const db = await setup(t);
  await setDraft(db, { plan_cause: 'generation', status: 'refining' });
  await setDraft(db, { plan_json: plan('Refined'), plan_cause: 'refinement', status: 'review' });

  const deps: ToolDeps = { db, policy: {} as McpPolicy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  const tool = createToolCatalog(deps).find(candidate => candidate.name === 'get_plan')!;
  const result = await tool.run({
    principal: { user: { id: '123' } } as McpPrincipal,
    args: tool.schema.parse({ repository: 'acme/repo', planId: draftId }),
  } as never);
  const history = (result.data as { revisionHistory: {
    count: number; currentCause: string; latest: Array<Record<string, unknown>>; tools: string[];
  } }).revisionHistory;

  assert.equal(history.count, 1);
  assert.equal(history.currentCause, 'refinement');
  assert.deepEqual(history.latest, [{
    revisionId: (await listPlanRevisions(db, draftId))[0].revision_id,
    cause: 'generation',
    replacedAt: (await listPlanRevisions(db, draftId))[0].replaced_at,
    issueCount: 4,
    titles: ['A1', 'A2', 'A3', 'A4'],
  }]);
  assert.deepEqual(history.tools, ['list_plan_revisions', 'get_plan_revision', 'restore_plan_revision']);
});

test('HTTP handlers check ownership and input and refuse restoring a busy plan', async t => {
  const db = await setup(t);
  await setDraft(db, { status: 'refining' });
  await setDraft(db, { status: 'review', plan_json: plan('Lossy') });
  const deps = { db, verifyOwnership: (id: string, userId: string, fields?: string[]) => verifyDraftOwnership(db, id, userId, fields) };
  const call = async (handler: (req: never, res: never) => Promise<void>, params: Record<string, string>, userId = '123', body: unknown = {}) => {
    const response = { status: 200, body: undefined as unknown };
    const res = { status(code: number) { response.status = code; return res; }, json(value: unknown) { response.body = value; return res; } };
    await handler({ params: { id: draftId, ...params }, user: { id: userId }, body } as never, res as never);
    return response;
  };
  const list = createListPlanRevisionsHandler(deps);
  const restore = createRestorePlanRevisionHandler(deps);

  assert.equal((await call(list, {}, '999')).status, 403);
  assert.equal((await call(list, { id: 'not-a-uuid' })).status, 400);
  const listed = await call(list, {});
  const [{ revision_id: revisionId }] = (listed.body as { revisions: Array<{ revision_id: number }> }).revisions;

  assert.equal((await call(restore, { revisionId: 'abc' })).status, 400);
  assert.equal((await call(restore, { revisionId: String(revisionId) }, '123', { expectedRevision: -1 })).status, 400);
  assert.equal((await call(restore, { revisionId: String(revisionId) }, '999')).status, 403);
  await setDraft(db, { status: 'refining' });
  assert.equal((await call(restore, { revisionId: String(revisionId) })).status, 409);
  await setDraft(db, { status: 'review' });
  const restored = await call(restore, { revisionId: String(revisionId) });
  assert.equal(restored.status, 200);
  assert.equal((restored.body as { plan_json: unknown[] }).plan_json.length, 4);
});
