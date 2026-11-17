import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import { createStatsRoutes } from '../routes/statsRoutes.js';
import {
  NOW,
  call,
  clearDashboardTestDatabase,
  createDashboardTestDatabase,
  minutesAgo,
  seedTask,
} from './dashboardTestHarness.js';

let database: Knex;

before(async () => { database = await createDashboardTestDatabase(); });
after(async () => database.destroy());
beforeEach(async () => clearDashboardTestDatabase(database));

const repository = 'acme/widgets';
const started = (minutes: number) => ({ state: 'processing', timestamp: minutesAgo(minutes) });

/** One task in each lifecycle the table distinguishes. */
async function seedLifecycles(): Promise<void> {
  const seeds: Array<[string, Array<{ state: string; timestamp: string }>]> = [
    ['done', [started(60), { state: 'completed', timestamp: minutesAgo(50) }]],
    ['broken', [started(60), { state: 'failed', timestamp: minutesAgo(50) }]],
    ['running', [started(40), { state: 'claude_execution', timestamp: minutesAgo(30) }]],
    ['waiting', [{ state: 'pending', timestamp: minutesAgo(20) }]],
    ['stopped', [started(60), { state: 'cancelled', timestamp: minutesAgo(55) }]],
    ['superseded', [{ state: 'pending', timestamp: minutesAgo(70) }, { state: 'skipped', timestamp: minutesAgo(65) }]],
  ];
  for (const [index, [taskId, states]] of seeds.entries()) {
    await seedTask(database, { taskId, repository, issueNumber: index + 1, states });
  }
}

test('in progress counts only queued and running tasks; cancelled and other terminal states are counted apart', async () => {
  await seedLifecycles();
  const stats = createStatsRoutes({ db: database, now: () => NOW });

  const response = await call(stats.getRepositoryStats, { period: '7d' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.repositories, [{
    repository, total: 6, completed: 1, failed: 1, inProgress: 2, other: 2, successRate: 50,
  }]);
});

test('the per-repository success rate is the header success rate for that repository', async () => {
  await seedLifecycles();
  // A second repository, and a pull request whose failed run was retried to completion.
  await seedTask(database, { taskId: 'other-done', repository: 'acme/other', issueNumber: 1, states: [started(30), { state: 'completed', timestamp: minutesAgo(20) }] });
  await seedTask(database, { taskId: 'pr-fail', repository, issueNumber: null, prNumber: 9, states: [started(30), { state: 'failed', timestamp: minutesAgo(25) }] });
  await seedTask(database, { taskId: 'pr-fix', repository, issueNumber: null, prNumber: 9, states: [started(20), { state: 'completed', timestamp: minutesAgo(10) }] });
  const stats = createStatsRoutes({ db: database, now: () => NOW });

  const repositories = (await call(stats.getRepositoryStats, { period: '7d' })).body.repositories as Array<Record<string, unknown>>;
  const widgets = repositories.find(row => row.repository === repository);
  // The PR's two runs are one task, counted completed and failed, as the header counts it.
  assert.deepEqual(widgets, { repository, total: 7, completed: 2, failed: 2, inProgress: 2, other: 2, successRate: 50 });

  const tasks = await call(stats.getTaskStats, { period: '7d' });
  const summary = tasks.body.summary as { total: number; completed: number; failed: number };
  const totals = repositories.reduce<{ total: number; completed: number; failed: number }>((sum, row) => ({
    total: sum.total + Number(row.total), completed: sum.completed + Number(row.completed), failed: sum.failed + Number(row.failed),
  }), { total: 0, completed: 0, failed: 0 });
  assert.deepEqual(totals, summary);
});

test('a repository with nothing finished has no success rate rather than 0%', async () => {
  await seedTask(database, { taskId: 'queued', repository, states: [{ state: 'queued', timestamp: minutesAgo(5) }] });
  const stats = createStatsRoutes({ db: database, now: () => NOW });

  const response = await call(stats.getRepositoryStats, { period: '24h' });
  assert.deepEqual(response.body.repositories, [{
    repository, total: 1, completed: 0, failed: 0, inProgress: 1, other: 0, successRate: null,
  }]);
});

test('goal tasks are left out, as the header leaves them out', async () => {
  await seedTask(database, { taskId: 'goal', repository, taskType: 'goal', states: [started(5)] });
  const stats = createStatsRoutes({ db: database, now: () => NOW });

  const response = await call(stats.getRepositoryStats, { period: '24h' });
  assert.deepEqual(response.body.repositories, []);
});
