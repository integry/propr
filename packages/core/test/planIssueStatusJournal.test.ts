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
  // Distinct prior timestamps, as consecutive real writes would leave.
  [issueId] = await database('plan_issues').insert({ draft_id: 'draft', repository: 'acme/repo', issue_number: 12, pr_number: 70,
    status: 'pending', updated_at: '2026-11-12 09:00:00' });
  activity.length = 0;
});

const journal = async () => (await listRepositoryEvents(database, { repository: 'acme/repo', domains: ['plan_issue'] }))
  .map(event => ({ entityId: event.entityId, planId: event.planId, issueNumber: event.issueNumber, payload: event.payload }));

test('each status writer journals the change from the persisted status', async () => {
  assert.equal(await updatePlanIssueStatus('acme/repo', 12, S.PROCESSING), true);
  await database('plan_issues').update({ updated_at: '2026-11-12 09:01:00' });
  await updatePlanIssueByPR('acme/repo', 70, { status: S.UNDER_REVIEW });
  await database('plan_issues').update({ updated_at: '2026-11-12 09:02:00' });
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
  assert.equal((await journal()).length, 1);
});

test('a failed append does not fail the status write', async () => {
  await dropJournal(database);
  try {
    assert.equal(await updatePlanIssueStatus('acme/repo', 12, S.PROCESSING), true);
    assert.equal((await database('plan_issues').first('status')).status, 'processing');
  } finally {
    await createJournal(database);
  }
});
