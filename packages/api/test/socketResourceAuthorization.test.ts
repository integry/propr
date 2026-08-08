import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { Knex } from 'knex';
import type { Socket } from 'socket.io';
import type { Queue } from 'bullmq';
import type { RedisClientType } from 'redis';
import { closeConnection } from '@propr/core';
import { DRAFT_UPDATE, type DraftUpdatePayload } from '@propr/shared';
import type { SocketPrincipal } from '../auth.js';
import { SocketService, type QueueDependencies } from '../services/socketService.js';
import {
  normalizeRepositorySubscription,
  normalizeSocketResourceId,
  SocketSubscriptionManager,
} from '../services/socketSubscriptions.js';
import type { TaskWatcherManager } from '../services/taskWatcher.js';

type Row = Record<string, unknown>;

after(async () => { await closeConnection(); });

function fakeDb(rows: Record<string, Row[]>): Knex {
  return ((table: string) => {
    let filters: Row = {};
    const query = {
      select: () => query,
      where: (nextFilters: Row) => {
        filters = nextFilters;
        return query;
      },
      first: async () => rows[table]?.find(row => (
        Object.entries(filters).every(([key, value]) => row[key] === value)
      )),
    };
    return query;
  }) as unknown as Knex;
}

function principal(userId: string): SocketPrincipal {
  return {
    user: {
      id: userId,
      login: `user-${userId}`,
      username: `user-${userId}`,
      displayName: `User ${userId}`,
      email: null,
      avatarUrl: null,
    },
    authorization: { role: 'member', permissions: [], source: 'durable' },
  };
}

function subscriptionManager(queueDependencies: QueueDependencies): SocketSubscriptionManager {
  return new SocketSubscriptionManager({
    getQueueDependencies: () => queueDependencies,
    getQueueBroadcaster: () => null,
    taskWatcherManager: {
      startTaskWatcher: async () => undefined,
      sendTaskLiveUpdate: async () => undefined,
      stopTaskWatcherIfEmpty: async () => undefined,
    } as unknown as TaskWatcherManager,
  });
}

describe('Socket.IO resource authorization', () => {
  test('bounds and validates room resource identifiers', () => {
    assert.equal(normalizeSocketResourceId(' task-1 '), 'task-1');
    assert.equal(normalizeSocketResourceId(''), null);
    assert.equal(normalizeSocketResourceId('task\nroom'), null);
    assert.equal(normalizeSocketResourceId('x'.repeat(513)), null);
    assert.equal(normalizeSocketResourceId({}), null);

    assert.equal(normalizeRepositorySubscription('integry/propr'), 'integry/propr');
    assert.equal(normalizeRepositorySubscription('integry'), null);
    assert.equal(normalizeRepositorySubscription('integry/propr/extra'), null);
    assert.equal(normalizeRepositorySubscription('integry /propr'), null);
  });

  test('authorizes task rooms only for durable or active tasks', async () => {
    const manager = subscriptionManager({
      taskQueue: {} as Queue,
      redisClient: { get: async (key: string) => key === 'custom:active-task' ? '{}' : null } as RedisClientType,
      db: fakeDb({ tasks: [{ task_id: 'durable-task' }] }),
      workerStateOptions: { keyPrefix: 'custom:' },
    });

    assert.equal(await manager.taskExists('active-task'), true);
    assert.equal(await manager.taskExists('durable-task'), true);
    assert.equal(await manager.taskExists('invented-task'), false);
  });

  test('authorizes draft rooms only for their owning GitHub user id', async () => {
    const manager = subscriptionManager({
      taskQueue: {} as Queue,
      redisClient: {} as RedisClientType,
      db: fakeDb({ task_drafts: [{ draft_id: 'draft-1', user_id: 'owner' }] }),
    });
    const ownerSocket = { data: { principal: principal('owner') } } as unknown as Socket;
    const otherSocket = { data: { principal: principal('other') } } as unknown as Socket;

    assert.equal(await manager.ownsDraft(ownerSocket, 'draft-1'), true);
    assert.equal(await manager.ownsDraft(otherSocket, 'draft-1'), false);
    assert.equal(await manager.ownsDraft(ownerSocket, 'missing'), false);
  });

  test('caps resource rooms without rejecting an idempotent re-subscription', () => {
    const manager = subscriptionManager({
      taskQueue: {} as Queue,
      redisClient: {} as RedisClientType,
      db: fakeDb({}),
    });
    const canJoin = (manager as unknown as {
      canJoin: (socket: Socket, room: string) => boolean;
    }).canJoin.bind(manager);
    const rooms = new Set(['socket-id', ...Array.from({ length: 100 }, (_, index) => `task:task-${index}`)]);
    const socket = { rooms } as unknown as Socket;

    assert.equal(canJoin(socket, 'task:new-task'), false);
    assert.equal(canJoin(socket, 'task:task-5'), true);
  });

  test('does not let an unsubscribe be undone while task authorization is pending', async () => {
    let resolveTaskLookup!: (value: string | null) => void;
    const pendingTaskLookup = new Promise<string | null>(resolve => {
      resolveTaskLookup = resolve;
    });
    let markTaskLookupStarted!: () => void;
    const taskLookupStarted = new Promise<void>(resolve => {
      markTaskLookupStarted = resolve;
    });
    const watcherCalls: string[] = [];
    const manager = new SocketSubscriptionManager({
      getQueueDependencies: () => ({
        taskQueue: {} as Queue,
        redisClient: {
          get: () => {
            markTaskLookupStarted();
            return pendingTaskLookup;
          },
        } as unknown as RedisClientType,
        db: fakeDb({}),
      }),
      getQueueBroadcaster: () => null,
      taskWatcherManager: {
        startTaskWatcher: async () => { watcherCalls.push('start'); },
        sendTaskLiveUpdate: async () => { watcherCalls.push('update'); },
        stopTaskWatcherIfEmpty: async () => { watcherCalls.push('stop'); },
      } as unknown as TaskWatcherManager,
    });
    const handlers = new Map<string, (value?: unknown) => unknown>();
    const rooms = new Set(['socket-id']);
    const socket = {
      id: 'socket-id',
      data: {
        principal: principal('owner'),
        revalidateAuthentication: async () => true,
      },
      connected: true,
      rooms,
      emit: () => true,
      join: async (room: string) => { rooms.add(room); },
      leave: async (room: string) => { rooms.delete(room); },
      on: (event: string, handler: (value?: unknown) => unknown) => {
        handlers.set(event, handler);
        return socket;
      },
    } as unknown as Socket;
    manager.setup(socket);
    const subscribe = handlers.get('subscribe:task:live');
    const unsubscribe = handlers.get('unsubscribe:task:live');
    assert(subscribe);
    assert(unsubscribe);

    const pendingSubscribe = Promise.resolve(subscribe('task-1'));
    await taskLookupStarted;
    await Promise.resolve(unsubscribe('task-1'));
    resolveTaskLookup('{}');
    await pendingSubscribe;

    assert.equal(rooms.has('task:live:task-1'), false);
    assert.deepEqual(watcherCalls, ['stop']);
  });

  test('broadcasts drafts only to the authorized draft and owner rooms', async () => {
    const emitted: Array<{ rooms: string[]; event: string; payload: DraftUpdatePayload }> = [];
    const service = Object.create(SocketService.prototype) as SocketService;
    const internals = service as unknown as {
      queueDeps: { db: Knex };
      io: { to: (room: string) => unknown };
      handleDraftUpdate: (payload: DraftUpdatePayload) => Promise<void>;
    };
    internals.queueDeps = {
      db: fakeDb({ task_drafts: [{ draft_id: 'draft-1', user_id: 'owner' }] }),
    };
    internals.io = {
      to: (room: string) => {
        const rooms = [room];
        const operator = {
          to: (additionalRoom: string) => {
            rooms.push(additionalRoom);
            return operator;
          },
          emit: (event: string, payload: DraftUpdatePayload) => {
            emitted.push({ rooms, event, payload });
          },
        };
        return operator;
      },
    };
    const payload: DraftUpdatePayload = {
      eventType: DRAFT_UPDATE,
      draftId: 'draft-1',
      step: 'planning',
      timestamp: new Date(0).toISOString(),
    };

    await internals.handleDraftUpdate(payload);

    assert.deepEqual(emitted, [{
      rooms: ['draft:draft-1', 'user:owner'],
      event: DRAFT_UPDATE,
      payload,
    }]);
  });
});
