import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up as createPullRequestState } from '../../core/src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { up as createReviewScores } from '../../core/src/db/migrations/20261006000000_create_review_scores.js';
import { loadPlanIssuePullRequestActivity, withPullRequestActivity } from '../routes/planIssuePullRequestActivity.js';

let database: Knex;

const task = (taskId: string, fields: { pr?: number; type?: string; commandMode?: string; replacedBy?: string; repository?: string } = {}) => ({
  task_id: taskId, repository: fields.repository ?? 'acme/repo', issue_number: fields.pr ?? 40, task_type: fields.type ?? 'pr-comment',
  initial_job_data: JSON.stringify(fields.commandMode ? { commandMode: fields.commandMode } : {}),
  replaced_by_task_id: fields.replacedBy ?? null, created_at: '2026-10-09T00:00:00.000Z',
});

const score = (taskId: string, value: number, at: string, pr = 40) => ({
  repository_id: 'acme/repo', pr_number: pr, task_id: taskId, score: value, source: 'ultrafix', created_at: at,
});

before(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('tasks', table => {
    table.string('task_id').primary();
    table.string('repository');
    table.integer('issue_number');
    table.integer('pr_number');
    table.string('task_type');
    table.text('initial_job_data');
    table.string('replaced_by_task_id');
    table.text('created_at');
  });
  await createPullRequestState(database);
  await createReviewScores(database);
  await database('tasks').insert([
    // The implementation that opened PR #40 is not a follow-up.
    { ...task('issue-12', { pr: 12, type: 'issue' }), pr_number: 40 },
    // Three Ultrafix review → fix cycles; only the fixes are follow-ups.
    task('pr-comments-batch-acme-repo-40-ultrafix-review-1', { commandMode: 'review' }),
    task('pr-comments-batch-acme-repo-40-ultrafix-fix-1', { commandMode: 'fix' }),
    task('pr-comments-batch-acme-repo-40-ultrafix-review-2', { commandMode: 'review' }),
    task('pr-comments-batch-acme-repo-40-ultrafix-fix-2', { commandMode: 'fix' }),
    task('pr-comments-batch-acme-repo-40-ultrafix-review-3', { commandMode: 'review' }),
    // A human follow-up comment, and a retried attempt of it that does not count twice.
    task('pr-comments-batch-acme-repo-40-1', {}),
    task('pr-comments-batch-acme-repo-40-0', { replacedBy: 'pr-comments-batch-acme-repo-40-1' }),
    // Neither the /ultrafix kick-off nor a merge-conflict run is a follow-up.
    task('pr-comments-batch-acme-repo-40-ultrafix', { commandMode: 'ultrafix' }),
    task('merge-conflict-40', { type: 'merge_conflict' }),
    // Another repository's PR with the same number.
    task('pr-comments-batch-other-repo-40', { repository: 'other/repo' }),
  ]);
  await database('review_scores').insert([
    score('pr-comments-batch-acme-repo-40-ultrafix-review-1', 6, '2026-10-09T01:00:00.000Z'),
    score('pr-comments-batch-acme-repo-40-ultrafix-review-2', 6, '2026-10-09T02:00:00.000Z'),
    // Two reviewers on the last cycle: the newest one is the cycle's score.
    score('pr-comments-batch-acme-repo-40-ultrafix-review-3', 8, '2026-10-09T03:00:00.000Z'),
    score('pr-comments-batch-acme-repo-40-ultrafix-review-3', 9, '2026-10-09T03:01:00.000Z'),
    score('review-41', 7, '2026-10-09T01:00:00.000Z', 41),
  ]);
});

after(async () => {
  await database.destroy();
});

test('counts every follow-up run on the PR and traces its review scores in order', async () => {
  const activity = await loadPlanIssuePullRequestActivity(database, [
    { repository: 'acme/repo', pr_number: 40 },
    { repository: 'acme/repo', pr_number: 41 },
    { repository: 'acme/repo', pr_number: null },
  ]);

  assert.deepEqual(activity.get('acme/repo#40'), { followupCount: 3, reviewScores: [6, 6, 9] });
  assert.deepEqual(activity.get('acme/repo#41'), { followupCount: 0, reviewScores: [7] });
  assert.equal(activity.has('other/repo#40'), false);
});

test('never shows fewer follow-ups than the webhook counted', async () => {
  const activity = await loadPlanIssuePullRequestActivity(database, [{ repository: 'acme/repo', pr_number: 40 }]);
  const base = { repository: 'acme/repo', pr_number: 40 };

  assert.deepEqual(withPullRequestActivity({ ...base, followup_count: 1 }, activity), { ...base, followup_count: 3, review_scores: [6, 6, 9] });
  assert.equal(withPullRequestActivity({ ...base, followup_count: 5 }, activity).followup_count, 5);
  assert.deepEqual(withPullRequestActivity({ ...base, pr_number: null, followup_count: 0 }, activity).review_scores, []);
});

test('reads nothing when no issue has a PR', async () => {
  const activity = await loadPlanIssuePullRequestActivity(database, [{ repository: 'acme/repo', pr_number: null }]);
  assert.equal(activity.size, 0);
});
