import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Knex } from 'knex';
import { closeConnection, shutdownQueue } from '@propr/core';
import { loadCacheUsage } from '../routes/analyticsAggregates.js';
import { officialCachePrice } from '../routes/analyticsPricing.js';
import { NOW, createDashboardTestDatabase, daysAgo } from './dashboardTestHarness.js';

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
after(async () => {
  await database.destroy();
  await closeConnection();
  await shutdownQueue();
});

test('the overview\'s official price lookup is per token, so savings come out in dollars', async () => {
  // 1M tokens read from the cache on Claude Opus 5.5: $4/M at the full prompt price, $0.20/M cached.
  await database('llm_executions').insert({
    task_id: 'a', start_time: daysAgo(1), model_name: 'claude-opus-5-5',
    input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000,
  });
  const price = officialCachePrice('claude-opus-5-5');
  assert.ok(price && price.prompt < 0.001, 'a per-million price would read as dollars per token');
  const usage = await loadCacheUsage(database, WEEK, officialCachePrice);
  assert.equal(usage?.saved_usd, 3.8);
  // A model with no official price saves an unknown amount, not $0.
  assert.equal(officialCachePrice('not-a-model'), null);
});
