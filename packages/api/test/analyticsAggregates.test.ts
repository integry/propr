import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import { loadCacheUsage, loadRunVolume, loadTaskSummary } from '../routes/analyticsAggregates.js';
import { loadAutonomy } from '../routes/analyticsDelivery.js';
import {
  NOW,
  clearDashboardTestDatabase,
  createDashboardTestDatabase,
  daysAgo,
  seedTask,
} from './dashboardTestHarness.js';

let database: Knex;
const WEEK = { timeframe: '7d' as const, from: new Date(NOW.getTime() - 7 * 24 * 60 * 60_000), to: NOW };

before(async () => {
  database = await createDashboardTestDatabase();
  await database.schema.alterTable('llm_executions', table => {
    table.string('model_name');
    table.integer('input_tokens');
    table.integer('cache_read_input_tokens');
    table.integer('cache_creation_input_tokens');
    table.boolean('cache_usage_reported');
  });
});
after(async () => database.destroy());
beforeEach(async () => clearDashboardTestDatabase(database));

test('runs per task divides total runs by total tasks, so the two figures beside it multiply out', async () => {
  for (const [index, [taskId, days]] of ([['a', 1], ['b', 2], ['queued', 3], ['c', 30]] as const).entries()) {
    await seedTask(database, { taskId, issueNumber: index + 1, states: [{ state: 'queued', timestamp: daysAgo(days) }] });
  }
  await database('llm_executions').insert([
    { task_id: 'a', start_time: daysAgo(1) },
    { task_id: 'a', start_time: daysAgo(1) },
    { task_id: 'a', start_time: daysAgo(1) },
    { task_id: 'b', start_time: daysAgo(2) },
    // A planning run belongs to no task, but it is still a run in the Models table.
    { task_id: null, start_time: daysAgo(2) },
    { task_id: 'c', start_time: daysAgo(30) },
  ]);
  // 'queued' never ran, yet it is one of the week's tasks: 5 runs over 3 tasks, not over the 2 that ran.
  assert.deepEqual(await loadRunVolume(database, WEEK), { total: 5, tasks: 3, per_task: 1.67 });
  assert.deepEqual(await loadRunVolume(database, null), { total: 6, tasks: 4, per_task: 1.5 });

  await database('llm_executions').del();
  assert.deepEqual(await loadRunVolume(database, WEEK), { total: 0, tasks: 3, per_task: 0 });
  await database('tasks').del();
  assert.deepEqual(await loadRunVolume(database, WEEK), { total: 0, tasks: 0, per_task: null });
});

test('a task is a pull request with every run on it, as the task list groups them', async () => {
  const run = (taskId: string, days: number, seed: { repository?: string; issueNumber?: number | null; prNumber?: number | null; taskType?: string; job?: Record<string, unknown> }) =>
    seedTask(database, { taskId, ...seed, states: [{ state: 'completed', timestamp: daysAgo(days) }] }).then(async () => {
      if (seed.job) await database('tasks').where({ task_id: taskId }).update({ initial_job_data: JSON.stringify(seed.job) });
      await database('llm_executions').insert({ task_id: taskId, start_time: daysAgo(days) });
    });
  // Issue 7: a failed first attempt, then the implementation that opened PR 70.
  await run('attempt-1', 3, { issueNumber: 7 });
  await run('implement', 2.9, { issueNumber: 7, prNumber: 70, job: { issueNumber: 7 } });
  // Runs on PR 70 itself: a review, a follow-up fix and a merge-conflict resolution.
  await run('review', 2.5, { issueNumber: 70, taskType: 'pr-comment', job: { pullRequestNumber: 70, commandMode: 'review' } });
  await run('fix', 2, { issueNumber: 70, taskType: 'pr-comment', job: { pullRequestNumber: 70, commandMode: 'fix' } });
  await run('conflict', 1, { issueNumber: 70, prNumber: 70, taskType: 'merge_conflict' });
  // A different PR in another repository, and an issue that has not opened one yet.
  await run('other-repo', 1, { repository: 'integry/other', issueNumber: 7, prNumber: 70 });
  await run('issue-only', 1, { issueNumber: 9 });

  assert.deepEqual(await loadRunVolume(database, WEEK), { total: 7, tasks: 3, per_task: 2.33 });
  const summary = await loadTaskSummary(database, WEEK);
  assert.equal(summary.total, 3);
  // Outcomes count tasks too: three completed tasks, not seven completed runs.
  assert.deepEqual({ completed: summary.completed, failed: summary.failed }, { completed: 3, failed: 0 });
  // Each task counts once, on the day of its first run.
  assert.equal(summary.dailyCounts.reduce((sum, day) => sum + day.count, 0), 3);
  assert.equal(summary.dailyCounts.find(day => day.count > 0)?.date, daysAgo(3).slice(0, 10));
});

for (const source of ['column', 'job', 'result'] as const) {
  test(`task links from before the period survive when the PR comes from ${source}`, async () => {
    await seedTask(database, { taskId: 'old-link', issueNumber: 7, prNumber: source === 'column' ? 70 : null,
      states: [{ state: 'failed', timestamp: daysAgo(10) }] });
    await database('tasks').where({ task_id: 'old-link' }).update({
      initial_job_data: JSON.stringify({ issueNumber: 7, ...(source === 'job' ? { pullRequestNumber: 70 } : {}) }),
      final_result: source === 'result' ? JSON.stringify({ postProcessing: { pr: { number: 70 } } }) : null,
    });
    await seedTask(database, { taskId: 'attempt', issueNumber: 7, states: [{ state: 'queued', timestamp: daysAgo(7) }] });
    await seedTask(database, { taskId: 'review', issueNumber: 70, taskType: 'pr-comment',
      states: [{ state: 'completed', timestamp: daysAgo(1) }] });
    await database('tasks').where({ task_id: 'review' }).update({ initial_job_data: JSON.stringify({ pullRequestNumber: 70 }) });
    await seedTask(database, { taskId: 'other-repo', repository: 'integry/other', issueNumber: 7,
      states: [{ state: 'queued', timestamp: daysAgo(2) }] });
    await database('llm_executions').insert([
      { task_id: 'old-link', start_time: daysAgo(10) },
      { task_id: 'attempt', start_time: daysAgo(7) },
      { task_id: 'review', start_time: daysAgo(1) },
    ]);

    assert.deepEqual(await loadRunVolume(database, WEEK), { total: 2, tasks: 2, per_task: 1 });
    const summary = await loadTaskSummary(database, WEEK, 'integry/propr');
    assert.deepEqual({ total: summary.total, completed: summary.completed, failed: summary.failed },
      { total: 1, completed: 1, failed: 0 });
    assert.deepEqual(summary.dailyCounts.filter(day => day.count), [{ date: daysAgo(7).slice(0, 10), count: 1 }]);
    assert.equal((await loadTaskSummary(database, WEEK)).total, 2);
    assert.equal((await loadTaskSummary(database, WEEK, 'integry/other')).total, 1);
    assert.equal((await loadTaskSummary(database, WEEK, 'integry/propr', { dailySince: new Date(daysAgo(2)) })).dailyCounts.reduce((sum, day) => sum + day.count, 0), 0);

    // With only issue runs in the window, earlier linkage still supplies identity,
    // but the old failure must never become this period's outcome.
    const beforeReview = { ...WEEK, to: new Date(daysAgo(1)), toExclusive: true };
    const earlier = await loadTaskSummary(database, beforeReview, 'integry/propr');
    assert.deepEqual({ total: earlier.total, completed: earlier.completed, failed: earlier.failed },
      { total: 1, completed: 0, failed: 0 });
    assert.deepEqual(await loadRunVolume(database, beforeReview), { total: 1, tasks: 2, per_task: 0.5 });
    await database('tasks').where({ task_id: 'other-repo' }).del();
    assert.deepEqual(await loadRunVolume(database, WEEK), { total: 2, tasks: 1, per_task: 2 });
  });
}

test('historical links preserve a shared PR identity even without a PR run in the period', async () => {
  for (const issueNumber of [7, 8]) {
    await seedTask(database, { taskId: `link-${issueNumber}`, issueNumber, prNumber: 70,
      states: [{ state: 'completed', timestamp: daysAgo(10) }] });
    await database('tasks').where({ task_id: `link-${issueNumber}` }).update({ initial_job_data: JSON.stringify({ issueNumber }) });
    await seedTask(database, { taskId: `attempt-${issueNumber}`, issueNumber,
      states: [{ state: 'failed', timestamp: daysAgo(issueNumber === 7 ? 3 : 1) }] });
  }
  const summary = await loadTaskSummary(database, WEEK);
  assert.deepEqual({ total: summary.total, completed: summary.completed, failed: summary.failed }, { total: 1, completed: 0, failed: 1 });
  assert.deepEqual(summary.dailyCounts.filter(day => day.count), [{ date: daysAgo(3).slice(0, 10), count: 1 }]);
  assert.deepEqual(await loadRunVolume(database, WEEK), { total: 0, tasks: 1, per_task: 0 });
});

test('historical linkage excludes goals and does not cross the upper period boundary', async () => {
  for (const [taskId, days, taskType] of [['old-goal', 10, 'goal'], ['future-link', 0, 'issue']] as const) {
    await seedTask(database, { taskId, issueNumber: 7, prNumber: 70, taskType,
      states: [{ state: 'failed', timestamp: daysAgo(days) }] });
    await database('tasks').where({ task_id: taskId }).update({ initial_job_data: JSON.stringify({ issueNumber: 7 }) });
  }
  await seedTask(database, { taskId: 'attempt', issueNumber: 7, states: [{ state: 'queued', timestamp: daysAgo(3) }] });
  await seedTask(database, { taskId: 'review', issueNumber: 70, prNumber: 70, states: [{ state: 'completed', timestamp: daysAgo(1) }] });
  const window = { ...WEEK, toExclusive: true };
  const summary = await loadTaskSummary(database, window);
  assert.deepEqual({ total: summary.total, completed: summary.completed, failed: summary.failed }, { total: 2, completed: 1, failed: 0 });
  assert.deepEqual(await loadRunVolume(database, window), { total: 0, tasks: 2, per_task: 0 });
  assert.deepEqual(summary.dailyCounts.filter(day => day.count), [
    { date: daysAgo(3).slice(0, 10), count: 1 }, { date: daysAgo(1).slice(0, 10), count: 1 },
  ]);
});

test('cache usage reports the hit rate over the whole prompt and what cached reads saved at known prices', async () => {
  // Rows as `recordLLMMetrics` persists them: `input_tokens` is the whole
  // prompt, cache writes and reads included, beside the separate cache counts.
  await database('llm_executions').insert([
    // A Claude run: 2k uncached, 8k written to the cache, 150k read back from it.
    { task_id: 'a', start_time: daysAgo(1), model_name: 'priced', input_tokens: 160_000, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 150_000 },
    // A Codex run: its inclusive count split into 30k uncached and 70k cached, then stored whole again; it reports no cache writes.
    { task_id: 'b', start_time: daysAgo(1), model_name: 'unpriced', input_tokens: 100_000, cache_creation_input_tokens: null, cache_read_input_tokens: 70_000 },
    // An execution that never reported a breakdown stays out of the denominator.
    { task_id: 'c', start_time: daysAgo(1), model_name: 'priced', input_tokens: 5_000_000, cache_read_input_tokens: null },
  ]);
  const prices = (model: string) => (model === 'priced' ? { prompt: 4 / 1_000_000, cacheRead: 0.2 / 1_000_000 } : null);
  const usage = await loadCacheUsage(database, WEEK, prices);
  assert.deepEqual(usage, {
    // 160k from the Claude run and 100k from the Codex run, each counted once.
    input_tokens: 260_000,
    cache_read_tokens: 220_000,
    hit_rate: 0.8462,
    // 150k reads at $3.80/M below the full prompt price; the unpriced model adds nothing.
    saved_usd: 0.57,
  });
  // Cache reads far above uncached input still make a share, never above 1.
  assert.ok(usage!.hit_rate <= 1 && usage!.cache_read_tokens <= usage!.input_tokens);
  const unpriced = await loadCacheUsage(database, WEEK, () => null);
  assert.equal(unpriced?.saved_usd, null);

  await database('llm_executions').del();
  assert.equal(await loadCacheUsage(database, WEEK, prices), null);
});

test('only executions with a known cache breakdown enter the hit rate', async () => {
  await database('llm_executions').insert([
    // Reported a breakdown and read everything back from the cache.
    { task_id: 'a', start_time: daysAgo(1), model_name: 'm', input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, cache_usage_reported: true },
    // Reported a breakdown and found nothing cached: a measured 0% that does count.
    { task_id: 'b', start_time: daysAgo(1), model_name: 'm', input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_usage_reported: true },
    // Reported input and output only; the producer now stores no cache counts for it.
    { task_id: 'c', start_time: daysAgo(1), model_name: 'm', input_tokens: 9_000, cache_creation_input_tokens: null, cache_read_input_tokens: null, cache_usage_reported: false },
    // Written before the flag existed: zeros that may be missing telemetry rather than a cold cache.
    { task_id: 'd', start_time: daysAgo(1), model_name: 'm', input_tokens: 9_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_usage_reported: null },
    // Written before the flag existed, but with cache writes: the breakdown was evidently reported.
    { task_id: 'e', start_time: daysAgo(1), model_name: 'm', input_tokens: 200, cache_creation_input_tokens: 200, cache_read_input_tokens: 0, cache_usage_reported: null },
  ]);
  // 100 of 400, not 100 of 18,400: unknown telemetry neither dilutes nor inflates the rate.
  assert.deepEqual(await loadCacheUsage(database, WEEK, () => null), { input_tokens: 400, cache_read_tokens: 100, hit_rate: 0.25, saved_usd: null });
});

test('a prompt holds at least its cached reads, so a malformed row cannot report a hit rate above 100%', async () => {
  // A row written by a producer that stored only the uncached portion.
  await database('llm_executions').insert({
    task_id: 'a', start_time: daysAgo(1), model_name: 'm', input_tokens: 2_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 8_000,
  });
  const usage = await loadCacheUsage(database, WEEK, () => null);
  assert.equal(usage?.input_tokens, 8_000);
  assert.equal(usage?.hit_rate, 1);
});

test('autonomy counts finished tasks that never failed or asked for an operator', async () => {
  await seedTask(database, { taskId: 'clean', states: [{ state: 'processing', timestamp: daysAgo(2) }, { state: 'completed', timestamp: daysAgo(1.9) }] });
  await seedTask(database, {
    taskId: 'asked', issueNumber: 2,
    states: [{ state: 'needs_attention', timestamp: daysAgo(2) }, { state: 'completed', timestamp: daysAgo(1.5) }],
  });
  await seedTask(database, { taskId: 'broke', issueNumber: 3, states: [{ state: 'failed', timestamp: daysAgo(1), reason: 'nope' }] });
  // Still running and cancelled work has no autonomy verdict yet.
  await seedTask(database, { taskId: 'running', issueNumber: 4, states: [{ state: 'processing', timestamp: daysAgo(1) }] });
  await seedTask(database, { taskId: 'stopped', issueNumber: 5, states: [{ state: 'cancelled', timestamp: daysAgo(1) }] });

  assert.deepEqual(await loadAutonomy(database, WEEK), { rate: 0.3333, autonomous: 1, operator: 2, n: 3 });
  await clearDashboardTestDatabase(database);
  assert.deepEqual(await loadAutonomy(database, WEEK), { rate: null, autonomous: 0, operator: 0, n: 0 });
});
