import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up as createJournal, down as dropJournal } from '../src/db/migrations/20261112160000_create_repository_events.js';

/** Plan issue status writers journal `status_changed` where they persist the status. */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
const activity: Array<Record<string, unknown>> = [];
await mock.module('../src/db/connection.js', { namedExports: { db: database, closeConnection: async () => {} } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/utils/eventPublisher.js', { namedExports: {
  getEventPublisher: () => ({ publishActivity: async (event: Record<string, unknown>) => { activity.push(event); return true; } }),
} });
await mock.module('../src/services/taskPlanningService.js', { namedExports: { checkAndUpdateDraftStatus: async () => {} } });
await mock.module('../src/services/taskPlanning/epicExecutionQueue.js', { namedExports: { onPlanIssueStatusChanged: async () => {} } });
const { updatePlanIssue, updatePlanIssueStatus, updatePlanIssueByPR, PlanIssueStatus: S } = await import('../src/config/planIssueManager.js');
const { listRepositoryEvents } = await import('../src/services/repositoryEventJournal.js');

await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.string('repository'); table.integer('issue_number'); table.integer('pr_number');
  table.string('status'); table.string('task_id'); table.string('agent_alias'); table.string('model_name'); table.integer('followup_count');
  table.boolean('run_ultrafix'); table.integer('ultrafix_goal'); table.integer('ultrafix_max_cycles');
  table.timestamp('created_at').defaultTo(database.fn.now()); table.timestamp('updated_at').defaultTo(database.fn.now());
});
await createJournal(database);
after(async () => database.destroy());
let issueId = 0;
beforeEach(async () => {
  for (const table of ['plan_issues', 'repository_events']) await database(table).delete();
  [issueId] = await database('plan_issues').insert({ draft_id: 'draft', repository: 'acme/repo', issue_number: 12, pr_number: 70,
    status: 'pending', updated_at: '2026-11-12 09:00:00' });
  activity.length = 0;
});

const journal = async () => (await listRepositoryEvents(database, { repository: 'acme/repo', domains: ['plan_issue'] }))
  .map(event => ({ entityId: event.entityId, planId: event.planId, issueNumber: event.issueNumber, payload: event.payload }));
const transitions = async () => (await journal()).map(event => [event.entityId, event.payload.from, event.payload.to]);

test('each status writer journals the change from the persisted status', async () => {
  assert.equal(await updatePlanIssueStatus('acme/repo', 12, S.PROCESSING), true);
  await updatePlanIssueByPR('acme/repo', 70, { status: S.UNDER_REVIEW });
  await updatePlanIssue('draft', 12, { status: S.MERGED });
  assert.deepEqual(await journal(), [
    { entityId: String(issueId), planId: 'draft', issueNumber: 12, payload: { from: 'pending', to: 'processing' } },
    { entityId: String(issueId), planId: 'draft', issueNumber: 12, payload: { from: 'processing', to: 'under_review' } },
    { entityId: String(issueId), planId: 'draft', issueNumber: 12, payload: { from: 'under_review', to: 'merged' } },
  ]);
  // The writers' own plan activity event still announces the change; the journal adds no second one.
  assert.equal(activity.length, 3);
});

test('a redelivered status write appends nothing', async () => {
  await updatePlanIssueStatus('acme/repo', 12, S.PROCESSING);
  await updatePlanIssueStatus('acme/repo', 12, S.PROCESSING);
  await updatePlanIssueByPR('acme/repo', 70, { status: S.PROCESSING });
  await updatePlanIssue('draft', 12, { status: S.PROCESSING });
  assert.equal((await journal()).length, 1);
});

test('a transition repeated within one clock second is journaled each time', async () => {
  // Every write stamps the same second-precision CURRENT_TIMESTAMP, so the prior
  // `updated_at` cannot tell the two processing → under_review transitions apart.
  await database('plan_issues').update({ status: 'processing' });
  await updatePlanIssueStatus('acme/repo', 12, S.UNDER_REVIEW);
  await updatePlanIssueByPR('acme/repo', 70, { status: S.PROCESSING });
  await updatePlanIssue('draft', 12, { status: S.UNDER_REVIEW });
  await updatePlanIssueStatus('acme/repo', 12, S.PROCESSING);
  await updatePlanIssueStatus('acme/repo', 12, S.UNDER_REVIEW);
  const id = String(issueId);
  assert.deepEqual(await transitions(), [
    [id, 'processing', 'under_review'], [id, 'under_review', 'processing'], [id, 'processing', 'under_review'],
    [id, 'under_review', 'processing'], [id, 'processing', 'under_review'],
  ]);
});

test('the event names the status the write itself replaced, whatever another writer did after an earlier read', async () => {
  await database('plan_issues').update({ status: 'processing' });
  // stillApplies runs after the writer's lookup and before its update; writer A's
  // change lands in that window, so writer B's earlier read is stale by its update.
  const persisted = await updatePlanIssueStatus('acme/repo', 12, S.PROCESSING, {
    stillApplies: async () => { await updatePlanIssueStatus('acme/repo', 12, S.UNDER_REVIEW); return true; },
  });
  assert.equal(persisted, true);
  assert.equal((await database('plan_issues').first('status')).status, 'processing');
  const id = String(issueId);
  assert.deepEqual(await transitions(), [[id, 'processing', 'under_review'], [id, 'under_review', 'processing']]);
});

test('only the rows a guarded write changed are journaled', async () => {
  // The newest row for the issue is held by its linked review; an older draft's row is eligible.
  const [newerId] = await database('plan_issues').insert({ draft_id: 'newer', repository: 'acme/repo', issue_number: 12,
    pr_number: 71, status: 'under_review' });
  let linked = 0;
  assert.equal(await updatePlanIssueStatus('acme/repo', 12, S.PROCESSING, { onLinkedReview: () => { linked++; } }), true);
  assert.equal(linked, 0);
  assert.deepEqual(await transitions(), [[String(issueId), 'pending', 'processing']]);
  assert.equal((await database('plan_issues').where({ id: newerId }).first('status')).status, 'under_review');

  // When the guard keeps every row, nothing is journaled.
  await database('repository_events').delete();
  await database('plan_issues').where({ id: issueId }).update({ status: 'under_review' });
  assert.equal(await updatePlanIssueStatus('acme/repo', 12, S.PROCESSING, { onLinkedReview: () => { linked++; } }), false);
  assert.equal(linked, 1);
  assert.deepEqual(await transitions(), []);
});

test('a write matching several rows journals each changed row from its own status', async () => {
  const [otherId] = await database('plan_issues').insert({ draft_id: 'older', repository: 'acme/repo', issue_number: 9,
    pr_number: 70, status: 'processing' });
  const [doneId] = await database('plan_issues').insert({ draft_id: 'oldest', repository: 'acme/repo', issue_number: 8,
    pr_number: 70, status: 'under_review' });
  await updatePlanIssueByPR('acme/repo', 70, { status: S.UNDER_REVIEW });
  assert.deepEqual(await transitions(), [[String(issueId), 'pending', 'under_review'], [String(otherId), 'processing', 'under_review']]);
  assert.equal((await database('plan_issues').where({ id: doneId }).first('status')).status, 'under_review');
});

test('a failed append does not fail the status write', async () => {
  await dropJournal(database);
  try {
    assert.equal(await updatePlanIssueStatus('acme/repo', 12, S.PROCESSING), true);
    assert.equal((await database('plan_issues').first('status')).status, 'processing');
    await updatePlanIssue('draft', 12, { status: S.MERGED });
    assert.equal((await database('plan_issues').first('status')).status, 'merged');
  } finally {
    await createJournal(database);
  }
});
