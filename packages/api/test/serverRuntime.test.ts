import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { RedisClientType } from 'redis';
import { closeConnection } from '../../core/src/db/connection.js';
import { createNotificationProjectionLease } from '../serverRuntime.js';

after(async () => closeConnection());

test('notification projection lease validates its Redis TTL', () => {
  const redisClient = { eval: async () => 1 } as unknown as RedisClientType;

  assert.throws(
    () => createNotificationProjectionLease(redisClient, 'invalid-ttl', 0),
    /lease TTL/
  );
  assert.throws(
    () => createNotificationProjectionLease(redisClient, 'oversized-ttl', 2_147_483_648),
    /lease TTL/
  );
});

test('notification projection lease acquisition fails closed when Redis rejects', async () => {
  const redisClient = {
    eval: async () => { throw new Error('Redis unavailable'); },
  } as unknown as RedisClientType;

  const acquire = createNotificationProjectionLease(redisClient, 'failed-acquisition', 30_000, 20);

  assert.equal(await acquire(), false);
});

test('a late Redis acquisition is released after the caller deadline', async () => {
  let resolveAcquisition!: (value: number) => void;
  let markReleased!: () => void;
  const acquisition = new Promise<number>(resolve => { resolveAcquisition = resolve; });
  const released = new Promise<void>(resolve => { markReleased = resolve; });
  let commands = 0;
  const redisClient = {
    eval: async () => {
      commands++;
      if (commands === 1) return acquisition;
      markReleased();
      return 1;
    },
  } as unknown as RedisClientType;
  const acquire = createNotificationProjectionLease(redisClient, 'late-acquisition', 30_000, 10);

  assert.equal(await acquire(), false);
  resolveAcquisition(1);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      released,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(
          new Error('late lease acquisition was not released')
        ), 1_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  assert.equal(commands, 2);
});
