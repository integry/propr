import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import { up as createPullRequestState } from '../../core/src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { up as createReviewScores } from '../../core/src/db/migrations/20261006000000_create_review_scores.js';
import { loadAutonomy, loadDeliveryMetrics, loadRelatedTasks } from '../routes/analyticsDelivery.js';
import { NOW, clearDashboardTestDatabase, createDashboardTestDatabase, daysAgo, seedTask } from './dashboardTestHarness.js';

let database: Knex;
const WEEK = { timeframe: '7d' as const, from: new Date(NOW.getTime() - 7 * 24 * 60 * 60_000), to: NOW };
const REPOSITORY = 'integry/propr';

before(async () => {
  database = await createDashboardTestDatabase();
  await createPullRequestState(database);
  await createReviewScores(database);
});
after(async () => database.destroy());
beforeEach(async () => {
  await clearDashboardTestDatabase(database);
  await database('notification_pull_request_state').del();
  await database('review_scores').del();
});

/** A task acting on PR `pr`, as the comment handler records it. */
async function seedFollowUp(taskId: string, pr: number, jobData: Record<string, unknown>): Promise<void> {
  await database('tasks').insert({
    task_id: taskId, repository: REPOSITORY, issue_number: pr, pr_number: null, task_type: 'pr-comment',
    model_name: 'claude-opus-5', created_at: daysAgo(2), initial_job_data: JSON.stringify(jobData), final_result: null,
  });
}

/** PR `pr` opened for issue `issue` by one implementation task with `runs` runs, then merged. */
async function seedMergedPullRequest(pr: number, issue: number, runs = 1): Promise<void> {
  await seedTask(database, { taskId: `impl-${pr}`, issueNumber: issue, prNumber: pr, states: [{ state: 'completed', timestamp: daysAgo(3) }] });
  await database('llm_executions').insert(Array.from({ length: runs }, () => ({ task_id: `impl-${pr}`, start_time: daysAgo(3) })));
  await database('notification_pull_request_state').insert({
    repository: REPOSITORY, pr_number: pr, merged_at: daysAgo(1), outcome: 'merged', closed_at: daysAgo(1),
  });
}

test('autonomy counts a failure even when a retry later completed the task', async () => {
  await seedTask(database, { taskId: 'clean', states: [{ state: 'processing', timestamp: daysAgo(2) }, { state: 'completed', timestamp: daysAgo(1.9) }] });
  await seedTask(database, {
    taskId: 'recovered', issueNumber: 2,
    states: [
      { state: 'failed', timestamp: daysAgo(2), reason: 'nope' },
      { state: 'processing', timestamp: daysAgo(1.8) },
      { state: 'completed', timestamp: daysAgo(1.5) },
    ],
  });
  assert.deepEqual(await loadAutonomy(database, WEEK), { rate: 0.5, autonomous: 1, operator: 1, n: 2 });

  // A population made only of the recovered task is not 100% autonomous.
  await database('tasks').where({ task_id: 'clean' }).del();
  assert.deepEqual(await loadAutonomy(database, WEEK), { rate: 0, autonomous: 0, operator: 1, n: 1 });
});

test('a task matched by two batches is related to its PR once', async () => {
  // Issue 1000 opens the first batch of 500 numbers and PR 1 the second.
  await seedTask(database, { taskId: 'impl', issueNumber: 1000, prNumber: 1, states: [{ state: 'completed', timestamp: daysAgo(2) }] });
  const numbers = [1000, ...Array.from({ length: 499 }, (_, index) => 2000 + index), 1];
  const related = await loadRelatedTasks(database, [REPOSITORY], numbers, ['task_id']);
  assert.deepEqual(related.map(task => task.task_id), ['impl']);
});

test('a merged PR spanning two batches keeps one run and passes first time', async () => {
  // An unmerged PR for issue 1 names number 1 first; 599 more PRs fill the first batch of 500 numbers.
  await seedTask(database, { taskId: 'issue-1', issueNumber: 1, prNumber: 9999, states: [{ state: 'completed', timestamp: daysAgo(4) }] });
  for (let pr = 2; pr <= 600; pr += 1) {
    await seedTask(database, { taskId: `filler-${pr}`, issueNumber: null, prNumber: pr, states: [{ state: 'completed', timestamp: daysAgo(3) }] });
  }
  // PR 1 is matched in the first batch by its PR number and in the second by its issue, 5000.
  await seedMergedPullRequest(1, 5000);
  const delivery = await loadDeliveryMetrics(database, WEEK);
  assert.equal(delivery.prs_merged, 1);
  assert.deepEqual(delivery.runs_per_merged_pr, { mean: 1, n: 1 });
  assert.deepEqual(delivery.first_time_pass, { rate: 1, passed: 1, n: 1 });
});

test('an Ultrafix fix whose next review was never scored still fails first-time pass', async () => {
  await seedMergedPullRequest(10, 110);
  // The first Ultrafix review asked for a fix; the fix ran, and its follow-up review recorded no score.
  await database('review_scores').insert({
    repository_id: REPOSITORY, pr_number: 10, task_id: 'ultrafix-review-1', implementer_model: 'claude-opus-5',
    reviewer_agent: 'codex', reviewer_model: 'gpt-5.6', score: 5, blocker_count: 1, suggestion_count: 0,
    cycle_number: 1, goal: 8, goal_reached: false, source: 'ultrafix', head_sha: 'sha-1', created_at: daysAgo(2),
  });
  await seedFollowUp('ultrafix-review-1', 10, { commandMode: 'review', ultrafixMeta: { workEpoch: 1, goal: 8 } });
  await seedFollowUp('ultrafix-fix-1', 10, { commandMode: 'fix', ultrafixMeta: { workEpoch: 1, goal: 8 } });
  await database('llm_executions').insert({ task_id: 'ultrafix-fix-1', start_time: daysAgo(2) });
  // A second PR whose Ultrafix loop only reviewed, and passed, is still a first-time pass.
  await seedMergedPullRequest(11, 111);
  await seedFollowUp('ultrafix-review-11', 11, { commandMode: 'review', ultrafixMeta: { workEpoch: 1, goal: 8 } });

  const delivery = await loadDeliveryMetrics(database, WEEK);
  assert.deepEqual(delivery.first_time_pass, { rate: 0.5, passed: 1, n: 2 });
});

test('extra runs on the one implementation task do not fail first-time pass', async () => {
  // An auxiliary call or a usage-limit requeue records a second run on the same task.
  await seedMergedPullRequest(20, 120, 2);
  // A second implementation task for the same issue is a real re-attempt.
  await seedMergedPullRequest(21, 121);
  await seedTask(database, { taskId: 'impl-21-retry', issueNumber: 121, states: [{ state: 'completed', timestamp: daysAgo(2.5) }] });

  const delivery = await loadDeliveryMetrics(database, WEEK);
  assert.deepEqual(delivery.first_time_pass, { rate: 0.5, passed: 1, n: 2 });
  // The runs still count toward runs per merged PR.
  assert.deepEqual(delivery.runs_per_merged_pr, { mean: 1.5, n: 2 });
});
