import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import type { PullRequestEvent } from '@octokit/webhooks-types';
import { up as createPullRequestState } from '../src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { up as createReviewScores } from '../src/db/migrations/20261006000000_create_review_scores.js';
import { up as createJournal, down as dropJournal } from '../src/db/migrations/20261112160000_create_repository_events.js';

/**
 * The pull_request webhook journals `opened`, `head_changed`, `merged` and
 * `closed` through `handlePlanPRUpdate`, the handler every pull_request
 * delivery reaches; redelivery appends nothing.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
const planLookups: number[] = [];
const merges: number[] = [];
await mock.module('../src/db/connection.js', { namedExports: { db: database, closeConnection: async () => {} } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({ publishActivity: async () => true }) } });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => { throw new Error('no GitHub'); } } });
await mock.module('../src/config/configManager.js', { namedExports: { loadPrLabel: async () => null } });
await mock.module('../src/webhook/planIssueTrackingHelpers.js', { namedExports: { checkAndMigrateRepositoryFromWebhook: async () => {} } });
await mock.module('../src/config/planIssueManager.js', { namedExports: {
  findPlanIssueByRepoAndNumber: async () => null,
  findPlanIssueByRepoAndPR: async (_repository: string, prNumber: number) => { planLookups.push(prNumber); return null; },
  updatePlanIssueStatus: async () => true, linkPRToPlanIssue: async () => {}, updatePlanIssueByPR: async () => {},
  PlanIssueStatus: { PENDING: 'pending', PROCESSING: 'processing', UNDER_REVIEW: 'under_review',
    IN_REFINEMENT: 'in_refinement', REFINEMENT_PROCESSING: 'refinement_processing', MERGED: 'merged', CLOSED: 'closed' },
} });
const { recordPullRequestOutcome } = await import('../src/services/reviewScoreStore.js');
await mock.module('../src/services/notificationService.js', { namedExports: { notificationService: {
  markPullRequestMergedAndDismissNotifications: async (_repository: string, prNumber: number) => { merges.push(prNumber); return 0; },
  dismissNotificationsForPullRequest: async () => 0,
  // The real outcome writer, against the test database.
  recordPullRequestOutcome: (event: Parameters<typeof recordPullRequestOutcome>[1]) => recordPullRequestOutcome(database, event),
} } });
const { handlePlanPRUpdate } = await import('../src/webhook/planIssueTracking.js');
const { listRepositoryEvents } = await import('../src/services/repositoryEventJournal.js');

await createPullRequestState(database);
await createReviewScores(database);
await createJournal(database);
after(async () => database.destroy());
beforeEach(async () => {
  for (const table of ['notification_pull_request_state', 'repository_events']) await database(table).delete();
  planLookups.length = 0; merges.length = 0;
});

function delivery(action: string, pullRequest: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): PullRequestEvent {
  return {
    action, repository: { full_name: 'acme/repo' }, ...extra,
    pull_request: { number: 70, title: 'Add widget', body: '', merged: false, draft: false, created_at: '2026-11-12T09:00:00Z',
      head: { sha: 'head1', ref: 'feature' }, base: { ref: 'main' }, merged_at: null, closed_at: null, ...pullRequest },
  } as unknown as PullRequestEvent;
}
const journal = async () => (await listRepositoryEvents(database, { repository: 'acme/repo' }))
  .map(event => ({ type: event.type, entityId: event.entityId, headSha: event.headSha, payload: event.payload }));

test('opened and each new head are journaled once, however often GitHub redelivers', async () => {
  await handlePlanPRUpdate(delivery('opened'), 'c1');
  await handlePlanPRUpdate(delivery('opened'), 'c1-redelivery');
  await handlePlanPRUpdate(delivery('synchronize', { head: { sha: 'head2' } }, { before: 'head1', after: 'head2' }), 'c2');
  await handlePlanPRUpdate(delivery('synchronize', { head: { sha: 'head2' } }, { before: 'head1', after: 'head2' }), 'c2-redelivery');
  await handlePlanPRUpdate(delivery('edited'), 'c3');
  assert.deepEqual(await journal(), [
    { type: 'opened', entityId: '70', headSha: 'head1', payload: { baseRef: 'main', draft: false } },
    { type: 'head_changed', entityId: '70', headSha: 'head2', payload: { previousHeadSha: 'head1' } },
  ]);
});

test('a merge and a close are journaled from the outcome writer', async () => {
  await handlePlanPRUpdate(delivery('closed', { closed_at: '2026-11-12T10:00:00Z' }), 'close');
  await handlePlanPRUpdate(delivery('closed', { closed_at: '2026-11-12T10:00:00Z' }), 'close-redelivery');
  await handlePlanPRUpdate(delivery('reopened'), 'reopen');
  await handlePlanPRUpdate(delivery('closed', { closed_at: '2026-11-12T11:00:00Z' }), 'close-again');
  await handlePlanPRUpdate(delivery('reopened'), 'reopen-again');
  const merged = { merged: true, merged_at: '2026-11-12T12:00:00Z', closed_at: '2026-11-12T12:00:00Z' };
  await handlePlanPRUpdate(delivery('closed', merged), 'merge');
  await handlePlanPRUpdate(delivery('closed', merged), 'merge-redelivery');
  // Each close is its own event (a pull request can be reopened); a merge happens once.
  assert.deepEqual((await journal()).map(event => event.type), ['closed', 'closed', 'merged']);
  assert.deepEqual(merges, [70, 70]);
});

test('a failed append never stops the webhook handling', async () => {
  await dropJournal(database);
  try {
    await handlePlanPRUpdate(delivery('opened'), 'c1');
    await handlePlanPRUpdate(delivery('closed', { merged: true, merged_at: '2026-11-12T12:00:00Z' }), 'merge');
    assert.deepEqual(planLookups, [70, 70], 'plan issue tracking still ran');
    assert.equal((await database('notification_pull_request_state').first('outcome')).outcome, 'merged');
  } finally {
    await createJournal(database);
  }
});
