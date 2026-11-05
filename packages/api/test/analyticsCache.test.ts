import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnalyticsCache } from '../routes/analyticsCache.js';
import type { AnalyticsWindow } from '../routes/analyticsWindow.js';

const NOW = Date.UTC(2026, 8, 23, 12);
const ALL: AnalyticsWindow = { timeframe: 'all', from: null, to: new Date(NOW) };
const WEEK: AnalyticsWindow = { timeframe: '7d', from: new Date(NOW - 6 * 24 * 60 * 60_000), to: new Date(NOW) };

/** A loader that counts its calls and answers with the count. */
const counter = () => {
  let calls = 0;
  return { load: async () => ++calls, get calls() { return calls; } };
};

test('a bounded window is remembered for its own, shorter time; all time for longer', async () => {
  let clock = NOW;
  const cache = createAnalyticsCache({ ttlMs: 1_000, boundedTtlMs: 100, now: () => clock });
  const week = counter();
  const all = counter();

  assert.equal(await cache.remember('delivery', WEEK, week.load), 1);
  assert.equal(await cache.remember('delivery', WEEK, week.load), 1);
  assert.equal(await cache.remember('delivery', ALL, all.load), 1);
  assert.equal(await cache.remember('delivery', ALL, all.load), 1);
  // A request with no period is all time too, remembered as its own entry.
  assert.equal(await cache.remember('delivery', null, all.load), 2);
  assert.equal(await cache.remember('delivery', null, all.load), 2);
  clock += 100;
  // The bounded entry has expired; the all-time ones have not.
  assert.equal(await cache.remember('delivery', WEEK, week.load), 2);
  assert.equal(await cache.remember('delivery', ALL, all.load), 1);
  assert.equal(await cache.remember('delivery', null, all.load), 2);
  clock += 900;
  assert.equal(await cache.remember('delivery', ALL, all.load), 3);
  assert.equal(await cache.remember('delivery', null, all.load), 4);
  // Names are separate entries too, and the bounded delivery entry has long expired.
  assert.equal(await cache.remember('autonomy', WEEK, week.load), 3);
  assert.equal(await cache.remember('delivery', WEEK, week.load), 4);
  assert.equal(await cache.remember('delivery', WEEK, week.load), 4);
});

test('a zero bounded TTL reads bounded windows afresh and still remembers all time', async () => {
  const cache = createAnalyticsCache({ ttlMs: 1_000, boundedTtlMs: 0, now: () => NOW });
  const week = counter();
  const all = counter();
  assert.equal(await cache.remember('delivery', WEEK, week.load), 1);
  assert.equal(await cache.remember('delivery', WEEK, week.load), 2);
  assert.equal(await cache.remember('delivery', ALL, all.load), 1);
  assert.equal(await cache.remember('delivery', ALL, all.load), 1);
  assert.equal(cache.size, 1);
});

test('expired entries are dropped the next time the memo is consulted, whichever key is asked for', async () => {
  let clock = NOW;
  const cache = createAnalyticsCache({ ttlMs: 1_000, boundedTtlMs: 100, now: () => clock });
  // Repository-specific summaries that are never asked for again.
  await cache.remember('review-scores|acme/one', WEEK, async () => 1);
  await cache.remember('review-scores|acme/two', ALL, async () => 2);
  assert.equal(cache.size, 2);
  clock += 100;
  await cache.remember('delivery', ALL, async () => 3);
  // The bounded summary expired and went; the all-time one is still fresh.
  assert.equal(cache.size, 2);
  clock += 900;
  await cache.remember('delivery', WEEK, async () => 4);
  // Now the all-time summary has gone too; only the two delivery entries remain.
  assert.equal(cache.size, 2);
  clock += 100;
  // The all-time delivery entry reaches its minute; the bounded one is renewed.
  await cache.remember('delivery', WEEK, async () => 5);
  assert.equal(cache.size, 1);
  clock += 1_000;
  await cache.remember('autonomy', WEEK, async () => 6);
  assert.equal(cache.size, 1);
});

test('a failed load is not remembered', async () => {
  const cache = createAnalyticsCache({ ttlMs: 1_000, boundedTtlMs: 100, now: () => NOW });
  let attempts = 0;
  const load = async () => { attempts += 1; if (attempts === 1) throw new Error('nope'); return attempts; };
  await assert.rejects(cache.remember('delivery', WEEK, load), /nope/);
  assert.equal(await cache.remember('delivery', WEEK, load), 2);
  assert.equal(await cache.remember('delivery', WEEK, load), 2);
});
