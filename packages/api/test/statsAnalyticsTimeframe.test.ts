import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import { createStatsRoutes } from '../routes/statsRoutes.js';
import { analyticsDayKeys } from '../routes/analyticsWindow.js';
import {
  NOW,
  call,
  clearDashboardTestDatabase,
  createDashboardTestDatabase,
  daysAgo,
  minutesAgo,
  seedTask,
} from './dashboardTestHarness.js';

let database: Knex;

before(async () => {
  database = await createDashboardTestDatabase();
  // The overview also reads model names, per-event token counts and indexed repositories.
  await database.schema.alterTable('llm_executions', table => { table.string('model_name'); });
  await database.schema.createTable('llm_execution_details', table => {
    table.increments('detail_id').primary();
    table.integer('execution_id');
    table.integer('token_count_input');
    table.integer('token_count_output');
  });
  await database.schema.createTable('repositories', table => {
    table.string('repository').primary();
    table.timestamp('last_indexed_at');
  });
});
after(async () => database.destroy());
beforeEach(async () => {
  await clearDashboardTestDatabase(database);
  await database('llm_execution_details').del();
  await database('repositories').del();
});

const PERIOD_ERROR = 'period must be one of: 24h, 7d, 30d, 90d, 1y, all';

/** One task created 30 minutes ago and one created two days ago, each with a run. */
async function seedRecentAndOlder(): Promise<void> {
  await seedTask(database, {
    taskId: 'recent', repository: 'acme/recent', issueNumber: 1,
    states: [{ state: 'processing', timestamp: minutesAgo(30) }, { state: 'completed', timestamp: minutesAgo(10) }],
  });
  await seedTask(database, {
    taskId: 'older', repository: 'acme/older', issueNumber: 2,
    createdAt: daysAgo(2),
    states: [{ state: 'processing', timestamp: daysAgo(2) }, { state: 'failed', timestamp: daysAgo(1.9), reason: 'nope' }],
  });
  await database('llm_executions').insert([
    { execution_id: 1, task_id: 'recent', start_time: minutesAgo(29), cost_usd: 1.5, model_name: 'claude-opus-5-5' },
    { execution_id: 2, task_id: 'older', start_time: daysAgo(2), cost_usd: 0.5, model_name: 'gpt-5.6' },
  ]);
  await database('llm_execution_details').insert([
    { execution_id: 1, token_count_input: 100, token_count_output: 20 },
    { execution_id: 2, token_count_input: 1000, token_count_output: 200 },
  ]);
  await database('repositories').insert({ repository: 'acme/older', last_indexed_at: daysAgo(40) });
}

test('an unknown period is rejected with 400 by every analytics endpoint', async () => {
  const stats = createStatsRoutes({ db: database, now: () => NOW });
  for (const handler of [stats.getTaskStats, stats.getRepositoryStats, stats.getOverview]) {
    const response = await call(handler, { period: 'nope' });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: PERIOD_ERROR });
  }
});

test('without a period the endpoints keep their historical scope', async () => {
  await seedRecentAndOlder();
  await seedTask(database, {
    taskId: 'ancient', repository: 'acme/older', issueNumber: 3, states: [{ state: 'completed', timestamp: daysAgo(400) }],
  });
  const stats = createStatsRoutes({ db: database, now: () => NOW });

  const tasks = await call(stats.getTaskStats);
  assert.equal(tasks.status, 200);
  // Totals are all-time; the daily series lists only the days with tasks in the last 30.
  assert.deepEqual(tasks.body.summary, { total: 3, completed: 2, failed: 1 });
  assert.deepEqual((tasks.body.dailyCounts as Array<{ date: string }>).map(day => day.date), [
    daysAgo(2).slice(0, 10),
    minutesAgo(30).slice(0, 10),
  ]);

  const repositories = await call(stats.getRepositoryStats);
  const totals = Object.fromEntries((repositories.body.repositories as Array<{ repository: string; total: number }>)
    .map(row => [row.repository, row.total]));
  assert.deepEqual(totals, { 'acme/older': 2, 'acme/recent': 1 });

  const overview = await call(stats.getOverview);
  assert.equal((overview.body.tasks as { completed: number }).completed, 2);
  assert.deepEqual(overview.body.usage, {
    total_tokens: 1320,
    input_tokens: 1100,
    output_tokens: 220,
    total_cost_usd: 2,
    models: { 'claude-opus-5-5': 1, 'gpt-5.6': 1 },
    // This schema records no cache breakdown, so there is no hit rate to report.
    cache: null,
  });
  assert.deepEqual(overview.body.model_usage, [
    { model: 'gpt-5.6', runs: 1, tasks: 1, tokens: 1200, cost_usd: 0.5 },
    { model: 'claude-opus-5-5', runs: 1, tasks: 1, tokens: 120, cost_usd: 1.5 },
  ]);
  // Two runs across the three tasks the totals band counts.
  assert.deepEqual(overview.body.runs, { total: 2, tasks: 3, per_task: 0.67 });
});

test('a period bounds task counts to tasks created inside the window', async () => {
  await seedRecentAndOlder();
  const stats = createStatsRoutes({ db: database, now: () => NOW });

  const lastDay = await call(stats.getTaskStats, { period: '24h' });
  assert.deepEqual(lastDay.body.summary, { total: 1, completed: 1, failed: 0 });
  assert.deepEqual(lastDay.body.statusDistribution, [{ status: 'completed', count: 1 }]);

  for (const period of ['7d', 'all']) {
    const response = await call(stats.getTaskStats, { period });
    assert.deepEqual(response.body.summary, { total: 2, completed: 1, failed: 1 }, period);
  }

  const repositories = await call(stats.getRepositoryStats, { period: '24h' });
  assert.deepEqual((repositories.body.repositories as Array<{ repository: string }>).map(row => row.repository), ['acme/recent']);
});

test('a day period zero-fills one daily count per UTC day, today and the days before it', async () => {
  await seedRecentAndOlder();
  const stats = createStatsRoutes({ db: database, now: () => NOW });

  const week = await call(stats.getTaskStats, { period: '7d' });
  const days = week.body.dailyCounts as Array<{ date: string; count: number }>;
  // "Last 7 days" draws seven bars: today and the six days before it.
  assert.equal(days.length, 7);
  assert.deepEqual(days.map(day => day.date), [...days.map(day => day.date)].sort());
  assert.equal(days[0].date, daysAgo(6).slice(0, 10));
  assert.equal(days[days.length - 1].date, NOW.toISOString().slice(0, 10));
  assert.equal(days.find(day => day.date === daysAgo(2).slice(0, 10))?.count, 1);
  assert.equal(days.find(day => day.date === NOW.toISOString().slice(0, 10))?.count, 1);
  assert.equal(days.reduce((total, day) => total + day.count, 0), 2);
  // Each day carries the runs started on it, and they sum to the delivery band's runs.
  const weekOverview = await call(stats.getOverview, { period: '7d' });
  const dailyRuns = (days as Array<{ runs: number }>).reduce((total, day) => total + day.runs, 0);
  assert.equal(dailyRuns, (weekOverview.body.runs as { total: number }).total);
  assert.ok(dailyRuns > 0);

  // All time starts at the earliest matching task.
  const allTime = await call(stats.getTaskStats, { period: 'all' });
  const allDays = allTime.body.dailyCounts as Array<{ date: string }>;
  assert.equal(allDays[0].date, daysAgo(2).slice(0, 10));
  assert.equal(allDays.length, 3);

  await clearDashboardTestDatabase(database);
  const empty = await call(stats.getTaskStats, { period: 'all' });
  assert.deepEqual(empty.body.dailyCounts, []);
});

test('a period bounds overview usage by execution start but never the indexed repository count', async () => {
  await seedRecentAndOlder();
  const stats = createStatsRoutes({ db: database, now: () => NOW });

  const lastDay = await call(stats.getOverview, { period: '24h' });
  assert.deepEqual(lastDay.body.usage, {
    total_tokens: 120, input_tokens: 100, output_tokens: 20, total_cost_usd: 1.5, models: { 'claude-opus-5-5': 1 }, cache: null,
  });
  assert.equal((lastDay.body.tasks as { completed: number }).completed, 1);
  assert.deepEqual(lastDay.body.system, { repos_indexed: 1 });
  assert.deepEqual(lastDay.body.model_usage, [{ model: 'claude-opus-5-5', runs: 1, tasks: 1, tokens: 120, cost_usd: 1.5 }]);

  const week = await call(stats.getOverview, { period: '7d' });
  assert.equal((week.body.usage as { total_tokens: number }).total_tokens, 1320);
});

test('the dashboard widget and the Analytics page report the same figures for the same period', async () => {
  await seedTask(database, { taskId: 'today', issueNumber: 1, states: [{ state: 'completed', timestamp: daysAgo(0.1) }] });
  await seedTask(database, { taskId: 'midweek', issueNumber: 2, states: [{ state: 'failed', timestamp: daysAgo(3), reason: 'nope' }] });
  // Just after midnight six days ago: the first of the window's seven days.
  await seedTask(database, { taskId: 'edge', issueNumber: 3, states: [{ state: 'completed', timestamp: daysAgo(6.4) }] });
  // Within 7 × 24 hours of now, but on an eighth calendar day, so outside "7 days".
  await seedTask(database, { taskId: 'eighth-day', issueNumber: 5, states: [{ state: 'completed', timestamp: daysAgo(6.9) }] });
  await seedTask(database, { taskId: 'outside', issueNumber: 4, states: [{ state: 'completed', timestamp: daysAgo(8) }] });
  await database('llm_executions').insert([
    { task_id: 'today', start_time: daysAgo(0.1), cost_usd: 2 },
    { task_id: 'edge', start_time: daysAgo(6.4), cost_usd: 0.75 },
    { task_id: 'eighth-day', start_time: daysAgo(6.9), cost_usd: 4 },
    { task_id: 'outside', start_time: daysAgo(8), cost_usd: 9 },
  ]);

  const stats = createStatsRoutes({ db: database, now: () => NOW });
  for (const period of ['7d', '30d']) {
    const widget = await call(stats.getDashboardStats, { repository: 'all', period });
    const tasks = await call(stats.getTaskStats, { period });
    const overview = await call(stats.getOverview, { period });
    const summary = tasks.body.summary as { total: number; completed: number; failed: number };
    assert.equal(widget.body.tasks, summary.total, period);
    assert.equal(widget.body.completed, summary.completed, period);
    assert.equal(widget.body.failed, summary.failed, period);
    assert.equal(widget.body.recordedSpend, (overview.body.usage as { total_cost_usd: number }).total_cost_usd, period);
    // The page also layers each day's runs behind its tasks; the widget draws tasks only.
    const pageDays = (tasks.body.dailyCounts as Array<{ date: string; count: number }>).map(({ date, count }) => ({ date, count }));
    assert.deepEqual(widget.body.dailyTasks, pageDays, period);
  }
  const week = await call(stats.getDashboardStats, { repository: 'all', period: '7d' });
  assert.equal(week.body.tasks, 3);
  assert.equal(week.body.recordedSpend, 2.75);
});

test('analytics day keys cover every UTC day from start to end inclusive', () => {
  assert.deepEqual(
    analyticsDayKeys(new Date('2026-09-29T23:30:00.000Z'), new Date('2026-10-01T00:10:00.000Z')),
    ['2026-09-29', '2026-09-30', '2026-10-01'],
  );
});
