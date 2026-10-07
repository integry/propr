import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import { loadCacheUsage, loadRunVolume } from '../routes/analyticsAggregates.js';
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
  });
});
after(async () => database.destroy());
beforeEach(async () => clearDashboardTestDatabase(database));

test('runs per task divides total runs by total tasks, so the two figures beside it multiply out', async () => {
  for (const [taskId, days] of [['a', 1], ['b', 2], ['queued', 3], ['c', 30]] as const) {
    await seedTask(database, { taskId, states: [{ state: 'queued', timestamp: daysAgo(days) }] });
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

test('cache usage reports the hit rate over the whole prompt and what cached reads saved at known prices', async () => {
  // Rows as executions persist them: `input_tokens` is only the uncached part of
  // the prompt, beside separate cache-write and cache-read counts.
  await database('llm_executions').insert([
    // A Claude run: almost all of its prompt is read back from the cache.
    { task_id: 'a', start_time: daysAgo(1), model_name: 'priced', input_tokens: 2_000, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 150_000 },
    // A Codex run, its inclusive input already split into uncached and cached parts; it reports no cache writes.
    { task_id: 'b', start_time: daysAgo(1), model_name: 'unpriced', input_tokens: 30_000, cache_creation_input_tokens: null, cache_read_input_tokens: 70_000 },
    // An execution that never reported a breakdown stays out of the denominator.
    { task_id: 'c', start_time: daysAgo(1), model_name: 'priced', input_tokens: 5_000_000, cache_read_input_tokens: null },
  ]);
  const prices = (model: string) => (model === 'priced' ? { prompt: 4 / 1_000_000, cacheRead: 0.2 / 1_000_000 } : null);
  const usage = await loadCacheUsage(database, WEEK, prices);
  assert.deepEqual(usage, {
    // 160k from the Claude run and 100k from the Codex run.
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
