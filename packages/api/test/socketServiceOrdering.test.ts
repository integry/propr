import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import {
  loadDurableTaskRevision,
  shouldBroadcastTaskUpdate,
} from '../services/socketService.js';

after(async () => { await closeConnection(); });

describe('SocketService task update ordering', () => {
  test('accepts legacy events only before a versioned stream is established', () => {
    assert.equal(shouldBroadcastTaskUpdate(undefined, undefined), true);
    assert.equal(shouldBroadcastTaskUpdate(undefined, 1), true);
    assert.equal(shouldBroadcastTaskUpdate(5, undefined), false);
  });

  test('drops older revisions and permits the current or a newer revision', () => {
    assert.equal(shouldBroadcastTaskUpdate(5, 4), false);
    assert.equal(shouldBroadcastTaskUpdate(5, 5), true);
    assert.equal(shouldBroadcastTaskUpdate(5, 6), true);
  });

  test('seeds ordering from the greatest durable revision after restart or cache eviction', async () => {
    const values = new Map([
      ['revision:worker:state:task-1', '21'],
      ['worker:state:task-1', JSON.stringify({ version: 20 })],
    ]);

    const revision = await loadDurableTaskRevision(async key => values.get(key) ?? null, 'task-1');

    assert.equal(revision, 21);
    assert.equal(shouldBroadcastTaskUpdate(revision, 19), false);
    assert.equal(shouldBroadcastTaskUpdate(revision, 22), true);
  });
});
