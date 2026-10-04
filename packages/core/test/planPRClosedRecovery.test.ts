import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

/**
 * A plan issue closed by its unmerged PR recovers when that PR is reopened or
 * merged; a manually closed source issue stays closed.
 */
type StoredIssue = { draft_id: string; issue_number: number; pr_number: number; status: string };
let stored: StoredIssue;
let livePR: { state: string; merged_at: string | null; merge_commit_sha?: string };
let liveIssue: { state: string; closed_at: string | null };
let issueEvents: Array<{ event: string; commit_id: string | null; created_at: string }>;
let afterEvents: (() => void) | undefined;
let eventsFailure = false;
const writes: Array<{ prNumber: number; status: string }> = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };

await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/config/planIssueManager.js', { namedExports: {
  PlanIssueStatus: { PENDING: 'pending', PROCESSING: 'processing', UNDER_REVIEW: 'under_review',
    IN_REFINEMENT: 'in_refinement', REFINEMENT_PROCESSING: 'refinement_processing', MERGED: 'merged', CLOSED: 'closed' },
  findPlanIssueByRepoAndNumber: async () => stored,
  findPlanIssueByRepoAndPR: async (_repository: string, prNumber: number) => stored.pr_number === prNumber ? stored : null,
  updatePlanIssueStatus: async () => undefined,
  linkPRToPlanIssue: async () => undefined,
  updatePlanIssueByPR: async (_repository: string, prNumber: number, updates: { status: string }) => {
    writes.push({ prNumber, status: updates.status });
    stored = { ...stored, status: updates.status };
  },
} });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({
  request: async (route: string, input: { page?: number }) => {
    if (route.endsWith('/events')) {
      if (eventsFailure) throw new Error('Events unavailable');
      const data = issueEvents.slice(((input.page ?? 1) - 1) * 100, (input.page ?? 1) * 100);
      afterEvents?.();
      return { data };
    }
    return { data: route.includes('/pulls/') ? livePR : liveIssue };
  },
}) } });
await mock.module('../src/config/configManager.js', { namedExports: { loadPrLabel: async () => 'propr' } });
await mock.module('../src/webhook/planIssueTrackingHelpers.js', { namedExports: { checkAndMigrateRepositoryFromWebhook: async () => undefined } });
await mock.module('../src/services/notificationService.js', { namedExports: { notificationService: {
  markPullRequestMergedAndDismissNotifications: async () => undefined,
  dismissNotificationsForPullRequest: async () => undefined,
} } });
const { handlePlanPRUpdate } = await import('../src/webhook/planIssueTracking.js');

const MERGED_AT = '2026-10-02T12:00:00Z';
beforeEach(() => {
  stored = { draft_id: 'draft', issue_number: 10, pr_number: 100, status: 'closed' };
  livePR = { state: 'open', merged_at: null };
  liveIssue = { state: 'open', closed_at: null };
  writes.length = 0; issueEvents = []; afterEvents = undefined; eventsFailure = false;
});

function event(action: string, merged = false, prNumber = 100) {
  return handlePlanPRUpdate({ action, repository: { full_name: 'acme/repo' },
    pull_request: { number: prNumber, title: 'Fix', body: 'Closes #10', merged, merged_at: merged ? MERGED_AT : null } } as never, 'test');
}

test('reopening a PR-closed head returns it to review and its merge records merged', async () => {
  await event('reopened');
  assert.deepEqual(writes, [{ prNumber: 100, status: 'under_review' }]);
  livePR = { state: 'closed', merged_at: MERGED_AT, merge_commit_sha: 'merge-sha' };
  // The merge's closing keyword closes the source issue at the same time.
  liveIssue = { state: 'closed', closed_at: MERGED_AT };
  await event('closed', true);
  assert.deepEqual(writes.at(-1), { prNumber: 100, status: 'merged' });
});

test('a merge observed while still closed recovers when the source issue was closed by that merge', async () => {
  livePR = { state: 'closed', merged_at: MERGED_AT, merge_commit_sha: 'merge-sha' };
  liveIssue = { state: 'closed', closed_at: '2026-10-02T12:00:01Z' };
  issueEvents = [{ event: 'closed', commit_id: 'merge-sha', created_at: liveIssue.closed_at! }];
  await event('closed', true);
  assert.deepEqual(writes, [{ prNumber: 100, status: 'merged' }]);
});

test('a manually closed source issue stays closed through PR reopen and merge', async () => {
  liveIssue = { state: 'closed', closed_at: '2026-10-02T11:00:00Z' };
  await event('reopened');
  livePR = { state: 'closed', merged_at: MERGED_AT, merge_commit_sha: 'merge-sha' };
  await event('closed', true);
  assert.deepEqual(writes, []);
  assert.equal(stored.status, 'closed');
});

test('a delayed reopened event cannot revive a PR that GitHub reports closed again', async () => {
  livePR = { state: 'closed', merged_at: null };
  await event('reopened');
  assert.deepEqual(writes, []);
});

test('only the linked PR can recover a closed issue, and merged issues never change', async () => {
  stored = { ...stored, pr_number: 101 };
  await event('reopened');
  stored = { ...stored, pr_number: 100, status: 'merged' };
  await event('reopened');
  assert.deepEqual(writes, []);
});

for (const commitId of [null, 'unrelated-sha']) {
  test(`manual closure after merge stays closed with closing commit ${commitId}`, async () => {
    livePR = { state: 'closed', merged_at: MERGED_AT, merge_commit_sha: 'merge-sha' };
    liveIssue = { state: 'closed', closed_at: '2026-10-02T13:00:00Z' };
    issueEvents = [{ event: 'closed', commit_id: commitId, created_at: liveIssue.closed_at! }];
    await event('closed', true);
    assert.deepEqual(writes, []);
    assert.equal(stored.status, 'closed');
  });
}

test('a later manual reclosure overrides earlier merge closure even across event pages', async () => {
  livePR = { state: 'closed', merged_at: MERGED_AT, merge_commit_sha: 'merge-sha' };
  liveIssue = { state: 'closed', closed_at: '2026-10-02T13:00:00Z' };
  issueEvents = [
    { event: 'closed', commit_id: 'merge-sha', created_at: MERGED_AT },
    ...Array.from({ length: 99 }, () => ({ event: 'labeled', commit_id: null, created_at: MERGED_AT })),
    { event: 'reopened', commit_id: null, created_at: '2026-10-02T12:30:00Z' },
    { event: 'closed', commit_id: null, created_at: liveIssue.closed_at! },
  ];
  await event('closed', true);
  assert.deepEqual(writes, []);
});

test('a closure changed during event lookup cannot use stale merge evidence', async () => {
  livePR = { state: 'closed', merged_at: MERGED_AT, merge_commit_sha: 'merge-sha' };
  liveIssue = { state: 'closed', closed_at: MERGED_AT };
  issueEvents = [{ event: 'closed', commit_id: 'merge-sha', created_at: MERGED_AT }];
  afterEvents = () => { liveIssue = { state: 'closed', closed_at: '2026-10-02T13:00:00Z' }; };
  await event('closed', true);
  assert.deepEqual(writes, []);
});

test('missing closure evidence or a failed event lookup preserves closed status', async () => {
  livePR = { state: 'closed', merged_at: MERGED_AT, merge_commit_sha: 'merge-sha' };
  liveIssue = { state: 'closed', closed_at: MERGED_AT };
  await event('closed', true);
  eventsFailure = true;
  await event('closed', true);
  assert.deepEqual(writes, []);
});
