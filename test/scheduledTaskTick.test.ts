import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { runScheduledTaskTick, SCHEDULE_TICK_LEASE_KEY } from '../src/daemon/scheduledTaskTick.js';

after(closeConnection);

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string, _mode: string, _ttl: number, condition: string) {
      if (condition === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async eval(_script: string, _keys: number, key: string, token: string) {
      if (store.get(key) !== token) return 0;
      store.delete(key);
      return 1;
    },
  };
}

const database = {} as never;

test('only the lease holder runs a scheduler tick, and it releases the lease afterwards', async () => {
  const redis = fakeRedis();
  let ticks = 0;
  const dependencies = { dispatch: async () => { throw new Error('unused'); }, admissionSettings: async () => ({ maxConcurrent: 1, window: '', windowError: null }) };
  // Another daemon holds the lease: this one does nothing.
  redis.store.set(SCHEDULE_TICK_LEASE_KEY, 'other-daemon');
  const skipped = await runScheduledTaskTick({ redis: redis as never, database, dependencies,
    tick: async () => { ticks++; return { dispatched: 0, skipped: 0, missed: 0, failed: 0, reconciled: 0 }; } });
  assert.equal(skipped, null);
  assert.equal(ticks, 0);
  assert.equal(redis.store.get(SCHEDULE_TICK_LEASE_KEY), 'other-daemon', 'a foreign lease is never released');

  redis.store.clear();
  const result = await runScheduledTaskTick({ redis: redis as never, database, dependencies,
    tick: async () => { ticks++; return { dispatched: 1, skipped: 0, missed: 0, failed: 0, reconciled: 0 }; } });
  assert.equal(result?.dispatched, 1);
  assert.equal(ticks, 1);
  assert.equal(redis.store.has(SCHEDULE_TICK_LEASE_KEY), false);

  await assert.rejects(runScheduledTaskTick({ redis: redis as never, database, dependencies, tick: async () => { throw new Error('boom'); } }), /boom/);
  assert.equal(redis.store.has(SCHEDULE_TICK_LEASE_KEY), false, 'the lease is released when a tick fails');
});
