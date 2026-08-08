import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { TASK_UPDATE, type TaskUpdatePayload } from '@propr/shared';
import {
  loadDurableTaskRevision,
  readCachedTaskRevision,
  shouldBroadcastTaskUpdate,
  SocketService,
} from '../services/socketService.js';

after(async () => { await closeConnection(); });

describe('SocketService task update ordering', () => {
  test('accepts legacy events only before a versioned stream is established', () => {
    assert.equal(shouldBroadcastTaskUpdate(undefined, undefined), true);
    assert.equal(shouldBroadcastTaskUpdate(undefined, 1), true);
    assert.equal(shouldBroadcastTaskUpdate(5, undefined), false);
  });

  test('accepts a legacy event without seeding from durable versioned state', async () => {
    let durableReads = 0;
    const broadcasts: Array<{ room?: string; payload: TaskUpdatePayload }> = [];
    const service = Object.create(SocketService.prototype) as SocketService;
    const internals = service as unknown as {
      io: {
        to: (room: string) => {
          emit: (event: string, payload: TaskUpdatePayload) => void;
        };
        emit: (event: string, payload: TaskUpdatePayload) => void;
      };
      queueDeps: {
        redisClient: { get: (key: string) => Promise<string | null> };
      };
      taskRevisions: Map<string, { version: number; expiresAt: number }>;
      handleTaskUpdate: (payload: TaskUpdatePayload) => Promise<void>;
    };
    internals.io = {
      to: room => ({
        emit: (_event, payload) => { broadcasts.push({ room, payload }); },
      }),
      emit: (_event, payload) => { broadcasts.push({ payload }); },
    };
    internals.queueDeps = {
      redisClient: {
        get: async () => {
          durableReads += 1;
          return JSON.stringify({ version: 20 });
        },
      },
    };
    internals.taskRevisions = new Map();
    const payload: TaskUpdatePayload = {
      eventType: TASK_UPDATE,
      taskId: 'legacy-task',
      state: 'processing',
      timestamp: new Date(0).toISOString(),
    };

    await internals.handleTaskUpdate(payload);

    assert.equal(durableReads, 0);
    assert.deepEqual(broadcasts, [
      { room: 'task:legacy-task', payload },
      { payload },
    ]);
  });

  test('rejects malformed incoming revisions before they can poison the cache', () => {
    assert.equal(shouldBroadcastTaskUpdate(undefined, -1), false);
    assert.equal(shouldBroadcastTaskUpdate(undefined, 1.5), false);
    assert.equal(shouldBroadcastTaskUpdate(undefined, Number.MAX_SAFE_INTEGER + 1), false);
  });

  test('permits equality only for the first event after a durable seed', () => {
    assert.equal(shouldBroadcastTaskUpdate(5, 4), false);
    assert.equal(shouldBroadcastTaskUpdate(5, 5), false);
    assert.equal(shouldBroadcastTaskUpdate(5, 5, true), true);
    assert.equal(shouldBroadcastTaskUpdate(5, 6), true);
  });

  test('expires socket revision cache entries so recreated task IDs can reseed', () => {
    const entry = { version: 42, expiresAt: 30_000 };

    assert.equal(readCachedTaskRevision(entry, 29_999), 42);
    assert.equal(readCachedTaskRevision(entry, 30_000), undefined);
  });

  test('seeds ordering from durable task state after restart or cache eviction', async () => {
    const values = new Map([
      ['worker:state:task-1', JSON.stringify({ version: 20 })],
    ]);

    const revision = await loadDurableTaskRevision(async key => values.get(key) ?? null, 'task-1');

    assert.equal(revision, 20);
    assert.equal(shouldBroadcastTaskUpdate(revision, 19), false);
    assert.equal(shouldBroadcastTaskUpdate(revision, 20, true), true);
    assert.equal(shouldBroadcastTaskUpdate(revision, 20), false);
    assert.equal(shouldBroadcastTaskUpdate(revision, 21), true);
  });

  test('uses the configured worker-state key namespaces', async () => {
    const requestedKeys: string[] = [];
    const revision = await loadDurableTaskRevision(async key => {
      requestedKeys.push(key);
      return JSON.stringify({ version: 8 });
    }, 'task-custom', {
      keyPrefix: 'custom:state:',
    });

    assert.deepEqual(requestedKeys, ['custom:state:task-custom']);
    assert.equal(revision, 8);
  });

  test('ignores negative, fractional, and unsafe durable revisions', async () => {
    for (const malformed of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const revision = await loadDurableTaskRevision(
        async () => JSON.stringify({ version: malformed }),
        'task-malformed',
      );
      assert.equal(revision, undefined);
    }
  });
});
