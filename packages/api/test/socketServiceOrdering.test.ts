import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import {
  loadDurableTaskRevision,
  readCachedTaskRevision,
  shouldBroadcastTaskUpdate,
} from '../services/socketService.js';

after(async () => { await closeConnection(); });

describe('SocketService task update ordering', () => {
  test('accepts legacy events only before a versioned stream is established', () => {
    assert.equal(shouldBroadcastTaskUpdate(undefined, undefined), true);
    assert.equal(shouldBroadcastTaskUpdate(undefined, 1), true);
    assert.equal(shouldBroadcastTaskUpdate(5, undefined), false);
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

  test('seeds ordering from the greatest durable revision after restart or cache eviction', async () => {
    const values = new Map([
      ['revision:worker:state:task-1', '21'],
      ['worker:state:task-1', JSON.stringify({ version: 20 })],
    ]);

    const revision = await loadDurableTaskRevision(async key => values.get(key) ?? null, 'task-1');

    assert.equal(revision, 21);
    assert.equal(shouldBroadcastTaskUpdate(revision, 19), false);
    assert.equal(shouldBroadcastTaskUpdate(revision, 21, true), true);
    assert.equal(shouldBroadcastTaskUpdate(revision, 21), false);
    assert.equal(shouldBroadcastTaskUpdate(revision, 22), true);
  });

  test('uses the configured worker-state key namespaces', async () => {
    const requestedKeys: string[] = [];
    const revision = await loadDurableTaskRevision(async key => {
      requestedKeys.push(key);
      return key.startsWith('durable:') ? '9' : JSON.stringify({ version: 8 });
    }, 'task-custom', {
      keyPrefix: 'custom:state:',
      revisionKeyPrefix: 'durable:',
    });

    assert.deepEqual(requestedKeys, [
      'durable:task-custom',
      'custom:state:task-custom',
    ]);
    assert.equal(revision, 9);
  });

  test('ignores negative, fractional, and unsafe durable revisions', async () => {
    for (const malformed of ['-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1)]) {
      const revision = await loadDurableTaskRevision(async key => (
        key.startsWith('revision:') ? malformed : JSON.stringify({ version: Number(malformed) })
      ), 'task-malformed');
      assert.equal(revision, undefined);
    }
  });
});
