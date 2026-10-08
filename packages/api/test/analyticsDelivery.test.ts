import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import { up as createPullRequestState } from '../../core/src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { up as createReviewScores } from '../../core/src/db/migrations/20261006000000_create_review_scores.js';
import { loadAutonomy, loadDeliveryMetrics, loadRelatedTasks } from '../routes/analyticsDelivery.js';
import { loadTaskSummary } from '../routes/analyticsAggregates.js';
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
async function seedFollowUp(taskId: string, pr: number, jobData: Record<string, unknown>, createdAt = daysAgo(2)): Promise<void> {
  await database('tasks').insert({
    task_id: taskId, repository: REPOSITORY, issue_number: pr, pr_number: null, task_type: 'pr-comment',
    model_name: 'claude-opus-5', created_at: createdAt, initial_job_data: JSON.stringify(jobData), final_result: null,
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

test('finished goal tasks are not part of the autonomy population', async () => {
  // The only deliverable task failed.
  await seedTask(database, { taskId: 'failed', states: [{ state: 'failed', timestamp: daysAgo(2), reason: 'nope' }] });
  // A goal that finished cleanly, and one that failed, orchestrated it; neither delivered anything.
  await seedTask(database, { taskId: 'goal-done', issueNumber: 2, taskType: 'goal', states: [{ state: 'processing', timestamp: daysAgo(3) }, { state: 'completed', timestamp: daysAgo(1) }] });
  await seedTask(database, { taskId: 'goal-failed', issueNumber: 3, taskType: 'goal', states: [{ state: 'failed', timestamp: daysAgo(1), reason: 'nope' }] });

  const autonomy = await loadAutonomy(database, WEEK);
  assert.deepEqual(autonomy, { rate: 0, autonomous: 0, operator: 1, n: 1 });
  // The same population the page's Total tasks counts.
  assert.equal(autonomy.n, (await loadTaskSummary(database, WEEK)).total);
});

test('a task matched by two batches is related to its PR once', async () => {
  // Issue 1000 opens the first batch of numbers and PR 1 a later one.
  await seedTask(database, { taskId: 'impl', issueNumber: 1000, prNumber: 1, states: [{ state: 'completed', timestamp: daysAgo(2) }] });
  const numbers = [1000, ...Array.from({ length: 499 }, (_, index) => 2000 + index), 1];
  const related = await loadRelatedTasks(database, [REPOSITORY], numbers, ['task_id']);
  assert.deepEqual(related.map(task => task.task_id), ['impl']);
});

test('a merged PR spanning two batches is one implementation attempt and passes first time', async () => {
  // Only merged PRs' numbers are read. A merged PR for issue 1 names number 1
  // first; 599 more merged PRs fill the first batches of numbers.
  await seedTask(database, { taskId: 'issue-1', issueNumber: 1, prNumber: 9999, states: [{ state: 'completed', timestamp: daysAgo(4) }] });
  for (let pr = 2; pr <= 600; pr += 1) {
    await seedTask(database, { taskId: `filler-${pr}`, issueNumber: null, prNumber: pr, states: [{ state: 'completed', timestamp: daysAgo(3) }] });
  }
  await database.batchInsert('notification_pull_request_state', [9999, ...Array.from({ length: 599 }, (_, index) => index + 2)].map(pr => ({
    repository: REPOSITORY, pr_number: pr, merged_at: daysAgo(1), outcome: 'merged', closed_at: daysAgo(1),
  })), 100);
  // PR 1 is matched in the first batch by its PR number and in a later one by its issue, 5000.
  await seedMergedPullRequest(1, 5000);
  const delivery = await loadDeliveryMetrics(database, WEEK);
  assert.equal(delivery.prs_merged, 601);
  // Matched twice, PR 1 would read as two implementation attempts and fail.
  assert.deepEqual(delivery.first_time_pass, { rate: 1, passed: 601, n: 601 });
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

test('a merge-conflict resolution is not a fix, so a merged PR that only needed one still passes first time', async () => {
  /** The task the merge-conflict handler records against PR `pr`, with one run. */
  const seedConflictResolution = async (pr: number) => {
    await database('tasks').insert({
      task_id: `merge-conflict-${pr}`, repository: REPOSITORY, issue_number: pr, pr_number: null, task_type: 'merge_conflict',
      model_name: 'claude-opus-5', created_at: daysAgo(2), initial_job_data: JSON.stringify({}), final_result: null,
    });
    await database('llm_executions').insert({ task_id: `merge-conflict-${pr}`, start_time: daysAgo(2) });
  };
  // The base moved under the PR; the same change was replayed onto it and merged.
  await seedMergedPullRequest(40, 140);
  await seedConflictResolution(40);
  // A PR that needed a real fix after its rebase still fails.
  await seedMergedPullRequest(41, 141);
  await seedConflictResolution(41);
  await seedFollowUp('fix-41', 41, { commandMode: 'fix' });

  const delivery = await loadDeliveryMetrics(database, WEEK);
  assert.deepEqual(delivery.first_time_pass, { rate: 0.5, passed: 1, n: 2 });
  // The resolution's run still counts toward runs per merged PR.
  assert.deepEqual(delivery.runs_per_merged_pr, { mean: 2, n: 2 });
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

test('work recorded after the merge never changes the merged PR\'s verdict or its runs', async () => {
  // PR 30 merged a day ago after one implementation run.
  await seedMergedPullRequest(30, 130);
  // Since then: a review task on the merged PR with its own run, a fresh
  // implementation task on the same issue, and a fix requested on the PR.
  await seedFollowUp('late-review-30', 30, { commandMode: 'review' }, daysAgo(0.5));
  await database('llm_executions').insert({ task_id: 'late-review-30', start_time: daysAgo(0.5) });
  await seedTask(database, { taskId: 'late-impl-130', issueNumber: 130, states: [{ state: 'completed', timestamp: daysAgo(0.5) }] });
  await database('llm_executions').insert({ task_id: 'late-impl-130', start_time: daysAgo(0.5) });
  await seedFollowUp('late-fix-30', 30, { commandMode: 'fix' }, daysAgo(0.4));
  // A run the implementation task recorded after the merge is not a run to merge either.
  await database('llm_executions').insert({ task_id: 'impl-30', start_time: daysAgo(0.3) });

  const delivery = await loadDeliveryMetrics(database, WEEK);
  assert.deepEqual(delivery.first_time_pass, { rate: 1, passed: 1, n: 1 });
  assert.deepEqual(delivery.runs_per_merged_pr, { mean: 1, n: 1 });
  // Two days from the implementation task to the merge, as before the later work.
  assert.deepEqual(delivery.time_to_merge_minutes, { mean: 2880, median: 2880, n: 1 });
});

test('an Ultrafix cycle scored after the merge does not fail first-time pass', async () => {
  await seedMergedPullRequest(31, 131);
  await database('review_scores').insert({
    repository_id: REPOSITORY, pr_number: 31, task_id: 'ultrafix-review-2', implementer_model: 'claude-opus-5',
    reviewer_agent: 'codex', reviewer_model: 'gpt-5.6', score: 9, blocker_count: 0, suggestion_count: 0,
    cycle_number: 2, goal: 8, goal_reached: true, source: 'ultrafix', head_sha: 'sha-2', created_at: daysAgo(0.5),
  });
  assert.deepEqual((await loadDeliveryMetrics(database, WEEK)).first_time_pass, { rate: 1, passed: 1, n: 1 });

  // The same cycle scored before the merge is a fix.
  await database('review_scores').where({ pr_number: 31 }).update({ created_at: daysAgo(2) });
  assert.deepEqual((await loadDeliveryMetrics(database, WEEK)).first_time_pass, { rate: 0, passed: 0, n: 1 });
});

test('a goal task naming the PR\'s issue is not an implementation attempt', async () => {
  await seedMergedPullRequest(32, 132);
  // The goal that set the work in motion, created well before the implementation.
  await seedTask(database, { taskId: 'goal-132', issueNumber: 132, taskType: 'goal', states: [{ state: 'processing', timestamp: daysAgo(6) }] });
  await database('llm_executions').insert({ task_id: 'goal-132', start_time: daysAgo(6) });

  const delivery = await loadDeliveryMetrics(database, WEEK);
  assert.deepEqual(delivery.first_time_pass, { rate: 1, passed: 1, n: 1 });
  // Time to merge still starts at the implementation task, and the goal's runs are not the PR's.
  assert.deepEqual(delivery.time_to_merge_minutes, { mean: 2880, median: 2880, n: 1 });
  assert.deepEqual(delivery.runs_per_merged_pr, { mean: 1, n: 1 });
});
