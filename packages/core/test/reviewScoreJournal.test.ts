import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up as createNotificationSchema } from '../src/db/migrations/20260802000000_create_notification_schema.js';
import { up as createPullRequestState } from '../src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { up as createReviewScores } from '../src/db/migrations/20261006000000_create_review_scores.js';
import { up as addReasoningLevels } from '../src/db/migrations/20261111000000_add_reasoning_level_columns.js';
import { up as createJournal, down as dropJournal } from '../src/db/migrations/20261112160000_create_repository_events.js';

/**
 * Review scores and pull request outcomes are journaled in the transaction
 * that persists them: `recordReviewScores`, `recordPullRequestOutcome` and the
 * Inbox merge marker (`markPullRequestMergedAndDismissNotifications`).
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/db/connection.js', { namedExports: { db: database, closeConnection: async () => {} } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/utils/eventPublisher.js', { namedExports: {
  getEventPublisher: () => ({ publishActivity: async () => true, publishNotificationUpdate: async () => true }),
} });
const { recordReviewScores, recordPullRequestOutcome } = await import('../src/services/reviewScoreStore.js');
const { NotificationService } = await import('../src/services/notificationService.js');
const { listRepositoryEvents } = await import('../src/services/repositoryEventJournal.js');

await database.schema.createTable('tasks', table => {
  table.string('task_id').primary(); table.string('repository'); table.integer('pr_number'); table.string('task_type');
  table.string('model_name'); table.text('initial_job_data'); table.string('created_at');
});
await database.schema.createTable('llm_executions', table => {
  table.increments('id'); table.string('task_id'); table.string('model_name'); table.string('start_time');
});
for (const migration of [createNotificationSchema, createPullRequestState, createReviewScores, addReasoningLevels, createJournal]) await migration(database);
after(async () => database.destroy());
beforeEach(async () => {
  for (const table of ['review_scores', 'notification_pull_request_state', 'repository_events']) await database(table).delete();
});

const score = (overrides: Record<string, unknown> = {}) => ({
  repository: 'acme/repo', prNumber: 70, taskId: 'review-1', reviewerAgent: 'codex', reviewerModel: 'gpt-5.6',
  score: 8, blockerCount: 0, suggestionCount: 2, source: 'ultrafix' as const, cycleNumber: 2, goal: 8, goalReached: true,
  headSha: 'head1', createdAt: new Date('2026-11-12T10:00:00.000Z'), ...overrides,
});
const journal = async () => (await listRepositoryEvents(database, { repository: 'acme/repo' }))
  .map(event => ({ type: event.type, prNumber: event.prNumber, headSha: event.headSha, payload: event.payload, occurredAt: event.occurredAt }));

test('each recorded review score is journaled with its small scalars', async () => {
  assert.equal(await recordReviewScores(database, [score(), score({ reviewerModel: 'claude-opus-5-5', score: 6, goalReached: true })]), 2);
  assert.deepEqual(await journal(), [
    { type: 'review_scored', prNumber: 70, headSha: 'head1', occurredAt: '2026-11-12T10:00:00.000Z',
      payload: { score: 8, goal: 8, goalReached: true, source: 'ultrafix', cycle: 2, reviewerModel: 'gpt-5.6' } },
    { type: 'review_scored', prNumber: 70, headSha: 'head1', occurredAt: '2026-11-12T10:00:00.000Z',
      payload: { score: 6, goal: 8, goalReached: true, source: 'ultrafix', cycle: 2, reviewerModel: 'claude-opus-5-5' } },
  ]);
  const keys = (await database('repository_events').select('dedupe_key')).map(row => row.dedupe_key);
  const ids = (await database('review_scores').orderBy('id').select('id')).map(row => row.id);
  assert.deepEqual(keys, ids.map(id => `pr:70:review_scored:${id}`));
});

test('a failed append does not fail the review score write', async () => {
  await dropJournal(database);
  try {
    assert.equal(await recordReviewScores(database, [score()]), 1);
    assert.equal((await database('review_scores')).length, 1);
  } finally {
    await createJournal(database);
  }
});

test('a merge is journaled once whichever writer sees it first', async () => {
  const service = new NotificationService({ database, publishNotificationUpdate: () => {} });
  await service.markPullRequestMergedAndDismissNotifications('acme/repo', 70, '2026-11-12T12:00:00.000Z');
  const merged = { repository: 'acme/repo', prNumber: 70, action: 'closed' as const, merged: true,
    mergedAt: '2026-11-12T12:00:00.000Z', closedAt: '2026-11-12T12:00:00.000Z' };
  await recordPullRequestOutcome(database, merged);
  await recordPullRequestOutcome(database, merged);
  assert.deepEqual((await journal()).map(event => [event.type, event.occurredAt]), [['merged', '2026-11-12T12:00:00.000Z']]);
});

test('a failed append does not fail the merge handling', async () => {
  await dropJournal(database);
  try {
    const service = new NotificationService({ database, publishNotificationUpdate: () => {} });
    await service.markPullRequestMergedAndDismissNotifications('acme/repo', 70, '2026-11-12T12:00:00.000Z');
    await recordPullRequestOutcome(database, { repository: 'acme/repo', prNumber: 70, action: 'closed', merged: true,
      mergedAt: '2026-11-12T12:00:00.000Z' });
    const state = await database('notification_pull_request_state').first('merged_at', 'outcome');
    assert.equal(state.outcome, 'merged');
    assert.equal(state.merged_at, '2026-11-12T12:00:00.000Z');
  } finally {
    await createJournal(database);
  }
});
