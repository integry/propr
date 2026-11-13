import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up as createJournal, down as dropJournal } from '../src/db/migrations/20261112160000_create_repository_events.js';

/** `recordAutoMergeDecisionEvent` journals each decision beside the task timeline event. */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/db/connection.js', { namedExports: { db: database, closeConnection: async () => {} } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({ publishActivity: async () => true }) } });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => { throw new Error('no GitHub'); } } });
await mock.module('../src/config/planIssueManager.js', { namedExports: { findPlanIssueByRepoAndPR: async () => null } });
const { recordAutoMergeDecisionEvent } = await import('../src/services/autoMergeGate.js');
const { listRepositoryEvents } = await import('../src/services/repositoryEventJournal.js');

await database.schema.createTable('tasks', table => {
  table.string('task_id').primary(); table.string('repository'); table.integer('issue_number'); table.string('created_at');
});
await database.schema.createTable('task_history', table => {
  table.increments('history_id'); table.string('task_id'); table.string('state'); table.string('timestamp'); table.text('reason'); table.text('metadata');
});
await createJournal(database);
after(async () => database.destroy());
beforeEach(async () => {
  for (const table of ['tasks', 'task_history', 'repository_events']) await database(table).delete();
});

const decision = {
  repository: 'acme/repo', prNumber: 70, taskId: 'task-1', opportunity: 'initial_pr' as const, headSha: 'head1', baseRef: 'main',
  decision: { arm: false, reason: 'skipped_protected_path' as const, opportunity: 'initial_pr' as const, matchedPaths: ['migrations/001.sql'] },
};
const deps = { database, now: () => Date.parse('2026-11-12T10:00:00.000Z') };
const journal = () => listRepositoryEvents(database, { repository: 'acme/repo' });

test('a decision is journaled with the timeline metadata, once per head', async () => {
  assert.equal(await recordAutoMergeDecisionEvent(decision, deps, log), true);
  assert.equal(await recordAutoMergeDecisionEvent(decision, deps, log), true);
  const events = await journal();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'auto_merge_decision');
  assert.equal(events[0].prNumber, 70);
  assert.equal(events[0].headSha, 'head1');
  const timeline = await database('task_history').where({ task_id: 'task-1' }).select('metadata');
  assert.equal(timeline.length, 2, 'the timeline keeps recording each evaluation');
  assert.deepEqual(events[0].payload, JSON.parse(timeline[0].metadata).autoMergeDecision);
  assert.deepEqual(events[0].payload, {
    reason: 'skipped_protected_path', arm: false, opportunity: 'initial_pr', prNumber: 70,
    matchedPaths: ['migrations/001.sql'], headSha: 'head1', baseRef: 'main', policyPath: '.propr/workflow.yml',
  });

  // A new head is a new decision.
  await recordAutoMergeDecisionEvent({ ...decision, headSha: 'head2' }, deps, log);
  assert.equal((await journal()).length, 2);
});

test('a decision without a task timeline is still journaled', async () => {
  assert.equal(await recordAutoMergeDecisionEvent({ ...decision, taskId: undefined }, deps, log), false);
  assert.deepEqual((await journal()).map(event => event.type), ['auto_merge_decision']);
});

test('a failed append does not fail the timeline event', async () => {
  await dropJournal(database);
  try {
    assert.equal(await recordAutoMergeDecisionEvent(decision, deps, log), true);
    assert.equal((await database('task_history').where({ task_id: 'task-1' })).length, 1);
  } finally {
    await createJournal(database);
  }
});
