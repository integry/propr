import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import { createStatsRoutes } from '../routes/statsRoutes.js';
import {
  NOW,
  call,
  clearDashboardTestDatabase,
  createDashboardTestDatabase,
  daysAgo,
  seedTask as seedTaskInto,
  type TaskSeed,
} from './dashboardTestHarness.js';

let database: Knex;

before(async () => { database = await createDashboardTestDatabase(); });
after(async () => database.destroy());
beforeEach(async () => clearDashboardTestDatabase(database));

const seedTask = (seed: TaskSeed): Promise<void> => seedTaskInto(database, seed);

test('success rate excludes queued, running and cancelled work and is null when nothing finished', async () => {
  await seedTask({ taskId: 'run-a', repository: 'acme/only-running', issueNumber: 1, states: [{ state: 'claude_execution', timestamp: daysAgo(1) }] });
  await seedTask({ taskId: 'run-b', repository: 'acme/only-running', issueNumber: 2, states: [{ state: 'pending', timestamp: daysAgo(1) }] });
  await seedTask({ taskId: 'run-c', repository: 'acme/only-running', issueNumber: 3, states: [{ state: 'cancelled', timestamp: daysAgo(1) }] });

  const stats = createStatsRoutes({ db: database, now: () => NOW });
  const onlyRunning = await call(stats.getDashboardStats, { repository: 'acme/only-running' });
  assert.equal(onlyRunning.body.successRate, null);
  assert.notEqual(onlyRunning.body.successRate, 0);
  assert.equal(onlyRunning.body.completed, 0);
  assert.equal(onlyRunning.body.recordedSpend, null);

  await seedTask({ taskId: 'mix-1', repository: 'acme/mixed', issueNumber: 1, states: [{ state: 'completed', timestamp: daysAgo(1) }] });
  await seedTask({ taskId: 'mix-2', repository: 'acme/mixed', issueNumber: 2, states: [{ state: 'completed', timestamp: daysAgo(2) }] });
  await seedTask({ taskId: 'mix-3', repository: 'acme/mixed', issueNumber: 3, states: [{ state: 'completed', timestamp: daysAgo(2) }] });
  await seedTask({ taskId: 'mix-4', repository: 'acme/mixed', issueNumber: 4, states: [{ state: 'failed', timestamp: daysAgo(3), reason: 'nope' }] });
  await seedTask({ taskId: 'mix-5', repository: 'acme/mixed', issueNumber: 5, states: [{ state: 'cancelled', timestamp: daysAgo(3) }] });
  await seedTask({ taskId: 'mix-6', repository: 'acme/mixed', issueNumber: 6, states: [{ state: 'processing', timestamp: daysAgo(3) }] });

  const mixed = await call(stats.getDashboardStats, { repository: 'acme/mixed', period: '7d' });
  // Three completed and one failed: cancelled, queued and running never reach the denominator.
  assert.equal(mixed.body.completed, 3);
  assert.equal(mixed.body.successRate, 75);
  assert.equal((mixed.body.dailyCompleted as unknown[]).length, 7);
  assert.equal((mixed.body.dailyCompleted as Array<{ date: string; count: number }>)
    .reduce((total, day) => total + day.count, 0), 3);
});

test('dashboard stats compare against the previous period and report recorded spend only when recorded', async () => {
  await seedTask({ taskId: 'now-1', repository: 'acme/spend', issueNumber: 1, states: [{ state: 'completed', timestamp: daysAgo(2) }] });
  await seedTask({ taskId: 'then-1', repository: 'acme/spend', issueNumber: 2, states: [{ state: 'completed', timestamp: daysAgo(9) }] });
  await seedTask({ taskId: 'then-2', repository: 'acme/spend', issueNumber: 3, states: [{ state: 'failed', timestamp: daysAgo(10), reason: 'nope' }] });
  await database('llm_executions').insert([
    { task_id: 'now-1', start_time: daysAgo(2), cost_usd: 1.25 },
    // A run with no recorded cost must not be read as $0 spend.
    { task_id: 'now-1', start_time: daysAgo(2), cost_usd: null },
    { task_id: 'then-1', start_time: daysAgo(9), cost_usd: 0.5 },
  ]);

  const stats = createStatsRoutes({ db: database, now: () => NOW });
  const current = await call(stats.getDashboardStats, { repository: 'acme/spend', period: '7d' });
  assert.equal(current.body.completed, 1);
  assert.equal(current.body.successRate, 100);
  assert.equal(current.body.recordedSpend, 1.25);
  assert.deepEqual(current.body.previous, { completed: 1, successRate: 50, recordedSpend: 0.5 });

  const empty = await call(stats.getDashboardStats, { repository: 'acme/never-used', period: '30d' });
  assert.equal(empty.body.successRate, null);
  assert.equal(empty.body.recordedSpend, null);
  assert.equal((empty.body.dailyCompleted as unknown[]).length, 30);
});

test('historical stats keep a recorded failure once its retry starts', async () => {
  await seedTask({
    taskId: 'retried', repository: 'acme/history', issueNumber: 1,
    states: [
      { state: 'failed', timestamp: daysAgo(3), reason: 'nope' },
      // The retry is under way: the run's current state is no longer terminal.
      { state: 'pending', timestamp: daysAgo(1) },
    ],
  });
  await seedTask({ taskId: 'clean', repository: 'acme/history', issueNumber: 2, states: [{ state: 'completed', timestamp: daysAgo(2) }] });

  const stats = createStatsRoutes({ db: database, now: () => NOW });
  const current = await call(stats.getDashboardStats, { repository: 'acme/history', period: '7d' });
  // One run finished well and one finished badly. Starting a retry does not
  // turn the instance's history into a perfect record.
  assert.equal(current.body.completed, 1);
  assert.equal(current.body.successRate, 50);

  // Repeated entries for the same outcome stay one finished run.
  await database('task_history').insert([
    { task_id: 'clean', state: 'completed', timestamp: daysAgo(2), metadata: '{}' },
  ]);
  const deduplicated = await call(stats.getDashboardStats, { repository: 'acme/history', period: '7d' });
  assert.equal(deduplicated.body.completed, 1);
  assert.equal(deduplicated.body.successRate, 50);
});

test('dashboard stats reject an unsupported period', async () => {
  const stats = createStatsRoutes({ db: database, now: () => NOW });
  const rejected = await call(stats.getDashboardStats, { repository: 'all', period: '90d' });
  assert.equal(rejected.status, 400);
});
