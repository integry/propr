import { after, afterEach, describe, mock, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs-extra';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { Server as SocketIOServer } from 'socket.io';
import { db } from '@propr/core';
import { TaskWatcherManager, withStableLiveEventIds } from '../services/taskWatcher.js';

after(async () => {
  await db.destroy();
});

function createIo(): SocketIOServer {
  return {
    to: () => ({ emit: () => undefined }),
    sockets: { adapter: { rooms: new Map() } },
  } as unknown as SocketIOServer;
}

function createRedis(get: (key: string) => Promise<string | null>): RedisClientType {
  return { get } as unknown as RedisClientType;
}

function taskState(sessionId = 'unknown'): string {
  return JSON.stringify({
    history: [{ state: 'claude_execution', timestamp: new Date().toISOString(), metadata: { sessionId } }],
  });
}

describe('TaskWatcherManager', () => {
  test('assigns stable sequence IDs independently of regenerated timestamps', () => {
    const first = withStableLiveEventIds({
      taskId: 'task-1',
      source: 'redis',
      events: [
        { type: 'thought', content: 'same', timestamp: '2026-08-04T00:00:00Z' },
        { type: 'thought', content: 'same', timestamp: '2026-08-04T00:00:01Z' },
      ],
      totalEventCount: 12,
      executionNamespace: 'execution-7',
    });
    const reparsed = withStableLiveEventIds({
      taskId: 'task-1',
      source: 'redis',
      events: [
        { type: 'thought', content: 'same', timestamp: '2026-08-04T01:00:00Z' },
        { type: 'thought', content: 'same', timestamp: '2026-08-04T01:00:01Z' },
      ],
      totalEventCount: 12,
      executionNamespace: 'execution-7',
    });

    assert.deepEqual(first.map(event => event.id), [
      'live:task-1:redis:execution-7:thought:sequence:10',
      'live:task-1:redis:execution-7:thought:sequence:11',
    ]);
    assert.deepEqual(reparsed.map(event => event.id), first.map(event => event.id));
  });

  test('namespaces parser IDs by task, source, execution, and event type', () => {
    const firstExecution = withStableLiveEventIds({
      taskId: 'task-1', source: 'redis', events: [{ id: 'tool-1', type: 'tool_use' }],
      totalEventCount: 1, executionNamespace: 'execution-1',
    });
    const secondExecution = withStableLiveEventIds({
      taskId: 'task-1', source: 'redis', events: [{ id: 'tool-1', type: 'tool_use' }],
      totalEventCount: 1, executionNamespace: 'execution-2',
    });
    const matchingResult = withStableLiveEventIds({
      taskId: 'task-1', source: 'redis', events: [{ id: 'tool-1', type: 'tool_result' }],
      totalEventCount: 1, executionNamespace: 'execution-1',
    });

    assert.notEqual(firstExecution[0].id, secondExecution[0].id);
    assert.notEqual(firstExecution[0].id, matchingResult[0].id);
    assert.match(firstExecution[0].id, /:tool_use:external:tool-1$/);
  });

  afterEach(() => mock.restoreAll());

  test('uses Redis output before trying to prepare a Claude log directory', async () => {
    const ensureDir = mock.method(fs, 'ensureDir', async () => undefined);
    const manager = new TaskWatcherManager(createIo());
    manager.setDeps({
      redisClient: createRedis(async key => key.startsWith('worker:state:')
        ? taskState()
        : '{"type":"thread.started","thread_id":"test"}'),
      db: {} as Knex,
    });

    await manager.startTaskWatcher('task-with-redis-output');

    assert.strictEqual(ensureDir.mock.callCount(), 0);
    await manager.closeAll();
  });

  test('falls back to Redis when the Claude log directory is read-only', async () => {
    mock.method(fs, 'pathExists', async () => false);
    const ensureDir = mock.method(fs, 'ensureDir', async () => {
      throw Object.assign(new Error('read-only mount'), { code: 'ENOENT' });
    });
    const manager = new TaskWatcherManager(createIo());
    manager.setDeps({
      redisClient: createRedis(async key => key.startsWith('worker:state:') ? taskState() : null),
      db: {} as Knex,
    });

    await assert.doesNotReject(manager.startTaskWatcher('task-with-missing-log-directory'));

    assert.strictEqual(ensureDir.mock.callCount(), 1);
    await manager.closeAll();
  });
});
