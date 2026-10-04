import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { ACTIVITY_UPDATE, GOAL_UPDATE, NOTIFICATION_UPDATE, TASK_UPDATE, type TaskUpdatePayload } from '@propr/shared';
import { ACTIVITY_ROOM, activityUserRoom } from '../services/socketSubscriptions.js';
import { SocketService } from '../services/socketService.js';
import {
  loadDurableTaskRevision,
  readCachedTaskRevision,
  shouldBroadcastTaskUpdate,
} from '../services/taskRevisionOrdering.js';

after(async () => { await closeConnection(); });

describe('SocketService task update ordering', () => {
  test('accepts legacy events only before a versioned stream is established', () => {
    assert.equal(shouldBroadcastTaskUpdate(undefined, undefined), true);
    assert.equal(shouldBroadcastTaskUpdate(undefined, 1), true);
    assert.equal(shouldBroadcastTaskUpdate(5, undefined), false);
  });

  test('accepts a legacy event without seeding from durable versioned state', async () => {
    let durableReads = 0;
    const broadcasts: Array<{ rooms: string[]; event: string; payload: Record<string, unknown> }> = [];
    const service = Object.create(SocketService.prototype) as SocketService;
    const internals = service as unknown as {
      io: {
        to: (room: string) => {
          to: (additionalRoom: string) => unknown;
          emit: (event: string, payload: Record<string, unknown>) => void;
        };
      };
      queueDeps: {
        redisClient: { get: (key: string) => Promise<string | null> };
      };
      taskRevisions: Map<string, { version: number; expiresAt: number }>;
      handleTaskUpdate: (payload: TaskUpdatePayload) => Promise<void>;
    };
    internals.io = {
      to: room => {
        const rooms = [room];
        const operator = {
          to: (additionalRoom: string) => {
            rooms.push(additionalRoom);
            return operator;
          },
          emit: (event: string, emittedPayload: Record<string, unknown>) => {
            broadcasts.push({ rooms, event, payload: emittedPayload });
          },
        };
        return operator;
      },
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
    assert.deepEqual(broadcasts.map(broadcast => ({ rooms: broadcast.rooms, event: broadcast.event })), [
      { rooms: ['instance:operational', 'task:legacy-task'], event: TASK_UPDATE },
      // The same transition also reaches interest-based consumers as the
      // derived envelope, without a second producer having to publish it.
      { rooms: [ACTIVITY_ROOM], event: ACTIVITY_UPDATE },
    ]);
    assert.deepEqual(broadcasts[0].payload, payload);
    assert.partialDeepStrictEqual(broadcasts[1].payload, {
      domain: 'task',
      change: 'started',
      subjectId: 'legacy-task',
      terminal: false,
    });
  });

  test('publishes attention entry and departure but suppresses task heartbeats', async () => {
    /*
      The dashboard summary, its attention pane and the header's attention count
      all declare an interest in `blocked`. Nothing else in the envelope says a
      run stopped for a person rather than moving along, so if this transition
      is published as `progressed` those surfaces stay stale until some
      unrelated terminal event or a reconnect - the very transition they exist
      to surface.
    */
    const broadcasts: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const service = Object.create(SocketService.prototype) as SocketService;
    const internals = service as unknown as {
      io: {
        to: (room: string) => {
          to: (additionalRoom: string) => unknown;
          emit: (event: string, payload: Record<string, unknown>) => void;
        };
      };
      taskRevisions: Map<string, { version: number; expiresAt: number }>;
      handleTaskUpdate: (payload: TaskUpdatePayload) => Promise<void>;
    };
    internals.io = {
      to: () => {
        const operator = {
          to: () => operator,
          emit: (event: string, payload: Record<string, unknown>) => {
            broadcasts.push({ event, payload });
          },
        };
        return operator;
      },
    };
    internals.taskRevisions = new Map();

    // Every spelling the workers emit, as the dashboard projection lists them.
    for (const state of ['action_required', 'action-required', 'needs_attention', 'needs-attention']) {
      broadcasts.length = 0;
      internals.taskRevisions.clear();

      await internals.handleTaskUpdate({
        eventType: TASK_UPDATE,
        taskId: `attention-${state}`,
        state,
        previousState: 'claude_execution',
        repository: 'integry/propr',
        timestamp: new Date(0).toISOString(),
      });

      const activity = broadcasts.find(broadcast => broadcast.event === ACTIVITY_UPDATE);
      assert.ok(activity, `expected ${state} to reach the activity room`);
      assert.partialDeepStrictEqual(activity.payload, {
        domain: 'task',
        change: 'blocked',
        subjectId: `attention-${state}`,
        terminal: false,
      });

      broadcasts.length = 0;
      const resumed: TaskUpdatePayload = {
        eventType: TASK_UPDATE,
        taskId: `attention-${state}`,
        state: 'processing',
        previousState: state,
        repository: 'integry/propr',
        timestamp: new Date(1).toISOString(),
      };
      await internals.handleTaskUpdate(resumed);
      assert.partialDeepStrictEqual(broadcasts.find(frame => frame.event === ACTIVITY_UPDATE)?.payload, {
        domain: 'task',
        change: 'progressed',
        subjectId: resumed.taskId,
        terminal: false,
      });

      broadcasts.length = 0;
      await internals.handleTaskUpdate({ ...resumed, previousState: 'processing' });
      assert.deepEqual(broadcasts.map(frame => frame.event), [TASK_UPDATE]);
    }
  });

  test('goal task heartbeats skip goal reads while transitions and terminal frames reconcile', async () => {
    const broadcasts: Array<{ room: string; event: string }> = [];
    const goalQueries: unknown[] = [];
    const service = Object.create(SocketService.prototype);
    Object.assign(service, {
      taskRevisions: new Map(),
      io: {
        to: (room: string) => {
          const operator = {
            to: () => operator,
            emit: (event: string) => broadcasts.push({ room, event }),
          };
          return operator;
        },
      },
      queueDeps: {
        redisClient: { get: async () => null },
        db: (table: string) => {
          assert.equal(table, 'goals');
          return { where: (filter: unknown) => {
            goalQueries.push(filter);
            return { first: async () => ({
              goal_id: 'private-goal', owner_id: 'owner', repository: 'integry/propr',
              desired_state: 'running', result_state: null, current_task_id: 'goal-task',
            }) };
          } };
        },
      },
    });
    const payload: TaskUpdatePayload = {
      eventType: TASK_UPDATE, taskId: 'goal-task', state: 'processing', previousState: 'queued',
      timestamp: new Date(0).toISOString(), version: 1,
    };
    await service.handleTaskUpdate(payload);
    assert.equal(goalQueries.length, 2);
    assert.deepEqual(broadcasts.filter(frame => frame.event !== TASK_UPDATE), [
      { room: activityUserRoom('owner'), event: GOAL_UPDATE },
      { room: activityUserRoom('owner'), event: ACTIVITY_UPDATE },
    ]);
    broadcasts.length = 0;
    goalQueries.length = 0;
    for (const version of [2, 3]) {
      await service.handleTaskUpdate({ ...payload, previousState: 'processing', version });
    }
    assert.deepEqual(goalQueries, []);
    assert.deepEqual(broadcasts.map(frame => frame.event), [TASK_UPDATE, TASK_UPDATE]);
    await service.handleTaskUpdate({ ...payload, version: 2 });
    assert.equal(goalQueries.length, 0, 'a stale transition cannot bypass revision ordering');

    for (const [index, state] of ['completed', 'failed', 'cancelled'].entries()) {
      broadcasts.length = 0;
      goalQueries.length = 0;
      const terminal = { ...payload, state, previousState: state, version: index + 4 };
      await service.handleTaskUpdate(terminal);
      assert.equal(goalQueries.length, 2, `${state} reconciles even with the same previous state`);
      assert.equal(broadcasts.filter(frame => frame.event === GOAL_UPDATE).length, 1);
      await service.handleTaskUpdate(terminal);
      assert.equal(goalQueries.length, 2, 'an exact terminal replay is rejected');
    }
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


test('relays both notification publisher formats only to their recipients', () => {
  const broadcasts: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
  const service = Object.create(SocketService.prototype) as SocketService;
  const internals = service as unknown as {
    io: { to: (room: string) => { emit: (event: string, payload: Record<string, unknown>) => void } };
    handleEvent: (channel: string, payload: Record<string, unknown>) => void;
  };
  internals.io = {
    to: room => ({ emit: (event, payload) => { broadcasts.push({ room, event, payload }); } }),
  };
  const common = { eventType: NOTIFICATION_UPDATE, change: 'read', eventId: 'notification-1',
    occurredAt: new Date(0).toISOString() };
  internals.handleEvent('', { ...common, recipientId: 'alice' });
  internals.handleEvent('', { ...common, recipientIds: ['bob', 'bob', 'carol'], repository: null });
  assert.deepEqual(broadcasts.map(({ room, event }) => ({ room, event })), [
    { room: activityUserRoom('alice'), event: NOTIFICATION_UPDATE },
    { room: activityUserRoom('bob'), event: NOTIFICATION_UPDATE },
    { room: activityUserRoom('bob'), event: ACTIVITY_UPDATE },
    { room: activityUserRoom('carol'), event: NOTIFICATION_UPDATE },
    { room: activityUserRoom('carol'), event: ACTIVITY_UPDATE },
  ]);
  const notifications = broadcasts.filter(broadcast => broadcast.event === NOTIFICATION_UPDATE);
  for (const broadcast of notifications) {
    assert.equal('recipientId' in broadcast.payload, false);
    assert.equal(broadcast.payload.eventId, common.eventId);
  }
  assert.equal('recipientIds' in notifications[0].payload, false);
  assert.deepEqual(notifications[1].payload.recipientIds, ['bob']);
  assert.deepEqual(notifications[2].payload.recipientIds, ['carol']);
});
