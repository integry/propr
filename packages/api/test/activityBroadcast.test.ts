import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import {
  ACTIVITY_UPDATE,
  GOAL_UPDATE,
  NOTIFICATION_UPDATE,
  TASK_UPDATE,
  USAGE_UPDATE,
  isActivityUpdatePayload,
  type ActivityUpdatePayload,
  type DraftUpdatePayload,
  type GoalUpdatePayload,
  type NotificationUpdatePayload,
  type TaskUpdatePayload,
  type UsageUpdatePayload,
} from '@propr/shared';
import {
  ACTIVITY_ROOM,
  ActivityBroadcaster,
  activityFromTask,
} from '../services/activityBroadcast.js';
import { SocketService } from '../services/socketService.js';

after(async () => { await closeConnection(); });

interface Frame {
  room: string;
  event: string;
  payload: unknown;
}

/** A fake Socket.IO server that records every room a frame was emitted to. */
function recorder() {
  const frames: Frame[] = [];
  const warnings: string[] = [];
  const io = {
    to: (room: string) => {
      const rooms = [room];
      const operator = {
        to: (additionalRoom: string) => {
          rooms.push(additionalRoom);
          return operator;
        },
        emit: (event: string, payload: unknown) => {
          for (const target of rooms) frames.push({ room: target, event, payload });
        },
      };
      return operator;
    },
  };
  return { frames, warnings, io, log: { warn: (message: string) => warnings.push(message) } };
}

function activityFrames(frames: Frame[]): ActivityUpdatePayload[] {
  return frames
    .filter(frame => frame.event === ACTIVITY_UPDATE)
    .map(frame => frame.payload as ActivityUpdatePayload);
}

const goalPayload: GoalUpdatePayload = {
  eventType: GOAL_UPDATE,
  goalId: 'goal-1',
  repository: 'integry/propr',
  state: 'completed',
  currentTaskId: 'goal-task-1',
  occurredAt: '2026-09-26T10:00:00.000Z',
};

const notificationPayload: NotificationUpdatePayload = {
  eventType: NOTIFICATION_UPDATE,
  change: 'created',
  eventId: 'event-1',
  recipientIds: ['user-a', 'user-b'],
  repository: 'integry/propr',
  occurredAt: '2026-09-26T10:01:00.000Z',
};

const usagePayload: UsageUpdatePayload = {
  eventType: USAGE_UPDATE,
  source: 'agent-tank',
  occurredAt: '2026-09-26T10:02:00.000Z',
};

describe('activity broadcast derivation', () => {
  test('a goal transition emits its own event plus exactly one activity envelope', () => {
    const { frames, io } = recorder();
    new ActivityBroadcaster(io).goalUpdated(goalPayload);

    assert.deepEqual(frames.map(frame => [frame.room, frame.event]), [
      [ACTIVITY_ROOM, GOAL_UPDATE],
      [ACTIVITY_ROOM, ACTIVITY_UPDATE],
    ]);
    assert.deepEqual(activityFrames(frames), [{
      eventType: ACTIVITY_UPDATE,
      terminal: true,
      domain: 'goal',
      change: 'completed',
      entityId: 'goal-1',
      repository: 'integry/propr',
      occurredAt: goalPayload.occurredAt,
    }]);
  });

  test('a paused goal is progress, not the end of the work', () => {
    const { frames, io } = recorder();
    new ActivityBroadcaster(io).goalUpdated({ ...goalPayload, state: 'paused' });
    assert.deepEqual(
      activityFrames(frames).map(payload => [payload.change, payload.terminal]),
      [['progressed', false]],
    );
  });

  test('a notification reaches each recipient naming only that recipient', () => {
    const { frames, io } = recorder();
    new ActivityBroadcaster(io).notificationUpdated(notificationPayload);

    const delivered = frames.filter(frame => frame.event === NOTIFICATION_UPDATE);
    assert.deepEqual(delivered.map(frame => frame.room), ['user:user-a', 'user:user-b']);
    assert.deepEqual(delivered.map(frame => frame.payload), [
      { ...notificationPayload, recipientIds: ['user-a'] },
      { ...notificationPayload, recipientIds: ['user-b'] },
    ]);
  });

  test('a socket in one user room never sees another user addressed', () => {
    const { frames, io } = recorder();
    new ActivityBroadcaster(io).notificationUpdated(notificationPayload);

    for (const frame of frames) {
      const addressed = (frame.payload as { recipientIds?: string[] }).recipientIds ?? [];
      const foreign = addressed.filter(userId => frame.room !== `user:${userId}`);
      assert.deepEqual(foreign, [], `frame to ${frame.room} leaked ${foreign.join(',')}`);
    }
    // Each recipient gets their own envelope, and it names nobody.
    assert.deepEqual(activityFrames(frames).map(payload => payload.entityId), [
      'event-1',
      'event-1',
    ]);
    for (const envelope of activityFrames(frames)) {
      assert.equal('recipientIds' in envelope, false);
    }
  });

  test('an activity subscriber outside the recipient rooms receives neither frame', () => {
    const { frames, io } = recorder();
    const broadcaster = new ActivityBroadcaster(io);
    broadcaster.notificationUpdated(notificationPayload);
    broadcaster.notificationUpdated({
      ...notificationPayload,
      change: 'read',
      recipientIds: ['user-a'],
    });
    broadcaster.notificationUpdated({
      ...notificationPayload,
      change: 'dismissed',
      recipientIds: ['user-a'],
    });

    // A notification's arrival, and the timing of its owner reading or
    // dismissing it, are visible only inside that owner's room: the activity
    // room any authenticated socket may join must carry no trace of them.
    assert.deepEqual(
      frames.filter(frame => frame.room === ACTIVITY_ROOM),
      [],
    );
    assert.deepEqual(new Set(frames.map(frame => frame.room)), new Set([
      'user:user-a',
      'user:user-b',
    ]));
    assert.deepEqual(
      frames.filter(frame => frame.room === 'user:user-b').map(frame => frame.event),
      [NOTIFICATION_UPDATE, ACTIVITY_UPDATE],
    );
  });

  test('a bulk clear has no single subject but stays with the user who cleared', () => {
    const { frames, io } = recorder();
    new ActivityBroadcaster(io).notificationUpdated({
      ...notificationPayload,
      change: 'dismissed_all',
      eventId: null,
      recipientIds: ['user-a'],
      repository: null,
    });

    assert.deepEqual(frames.map(frame => [frame.room, frame.event]), [
      ['user:user-a', NOTIFICATION_UPDATE],
      ['user:user-a', ACTIVITY_UPDATE],
    ]);
    assert.deepEqual(activityFrames(frames), [{
      eventType: ACTIVITY_UPDATE,
      terminal: true,
      domain: 'notification',
      change: 'dismissed',
      entityId: 'all',
      repository: null,
      occurredAt: notificationPayload.occurredAt,
    }]);
  });

  test('a usage change is a bare trigger with no activity envelope', () => {
    const { frames, io } = recorder();
    new ActivityBroadcaster(io).usageUpdated(usagePayload);
    assert.deepEqual(frames, [{
      room: ACTIVITY_ROOM,
      event: USAGE_UPDATE,
      payload: usagePayload,
    }]);
  });

  test('a planner draft stays scoped to its owner', () => {
    const { frames, io } = recorder();
    const draft: DraftUpdatePayload = {
      eventType: 'draft:update',
      draftId: 'draft-1',
      step: 'llm',
      status: 'completed',
      draftStatus: 'review',
      timestamp: '2026-09-26T10:03:00.000Z',
    };
    new ActivityBroadcaster(io).draftUpdated(draft, 'user-a');
    assert.deepEqual(frames, [{
      room: 'user:user-a',
      event: ACTIVITY_UPDATE,
      payload: {
        eventType: ACTIVITY_UPDATE,
        terminal: true,
        domain: 'plan',
        change: 'completed',
        entityId: 'draft-1',
        repository: null,
        occurredAt: draft.timestamp,
      },
    }]);
  });

  test('an unmapped task state is dropped rather than guessed', () => {
    const payload: TaskUpdatePayload = {
      eventType: TASK_UPDATE,
      taskId: 'task-1',
      state: 'awaiting_something_new',
      timestamp: '2026-09-26T10:04:00.000Z',
    };
    assert.equal(activityFromTask(payload), null);

    const { frames, io } = recorder();
    new ActivityBroadcaster(io).taskUpdated(payload);
    assert.deepEqual(frames, []);
  });

  test('task states map onto the activity vocabulary with their revision', () => {
    const states: Array<[string, string, boolean]> = [
      ['pending', 'created', false],
      ['queued', 'created', false],
      ['processing', 'started', false],
      ['claude_execution', 'progressed', false],
      ['post_processing', 'progressed', false],
      ['completed', 'completed', true],
      ['failed', 'failed', true],
      ['cancelled', 'cancelled', true],
    ];
    for (const [state, change, terminal] of states) {
      const derived = activityFromTask({
        eventType: TASK_UPDATE,
        taskId: 'task-1',
        state,
        repository: 'integry/propr',
        version: 12,
        timestamp: '2026-09-26T10:05:00.000Z',
      });
      assert.ok(derived, `${state} should derive an activity envelope`);
      assert.equal(derived.change, change);
      assert.equal(derived.terminal, terminal);
      assert.equal(derived.revision, 12);
    }
  });

  test('a frame without a parseable timestamp is dropped and reported', () => {
    const { frames, warnings, io, log } = recorder();
    const broadcaster = new ActivityBroadcaster(io, log);
    broadcaster.goalUpdated({ ...goalPayload, occurredAt: 'yesterday' });
    broadcaster.notificationUpdated({ ...notificationPayload, occurredAt: '' });
    broadcaster.usageUpdated({ ...usagePayload, occurredAt: undefined as unknown as string });

    assert.deepEqual(frames, []);
    assert.equal(warnings.length, 3);
    for (const warning of warnings) assert.match(warning, /occurredAt/);
  });

  test('a malformed recipient list delivers to nobody rather than crashing', () => {
    const { frames, io, log } = recorder();
    new ActivityBroadcaster(io, log).notificationUpdated({
      ...notificationPayload,
      recipientIds: ['user-a', '', 7] as unknown as string[],
    });

    const delivered = frames.filter(frame => frame.event === NOTIFICATION_UPDATE);
    assert.deepEqual(delivered.map(frame => frame.room), ['user:user-a']);
  });

  test('every emitted envelope carries a parseable ISO-8601 occurredAt', () => {
    const { frames, io } = recorder();
    const broadcaster = new ActivityBroadcaster(io);
    broadcaster.goalUpdated(goalPayload);
    broadcaster.notificationUpdated(notificationPayload);
    broadcaster.taskUpdated({
      eventType: TASK_UPDATE,
      taskId: 'task-1',
      state: 'completed',
      timestamp: '2026-09-26T10:06:00.000Z',
    });

    // One per producer event, except the notification, which is repeated once
    // per recipient room because that is the only place it may be seen.
    const envelopes = activityFrames(frames);
    assert.equal(envelopes.length, 4);
    for (const envelope of envelopes) {
      assert.equal(isActivityUpdatePayload(envelope), true);
      assert.equal(new Date(envelope.occurredAt).toISOString(), envelope.occurredAt);
    }
  });
});

describe('socket service activity dispatch', () => {
  /** A SocketService with only the collaborators the dispatch path touches. */
  function dispatcher() {
    const { frames, io } = recorder();
    const service = Object.create(SocketService.prototype) as SocketService;
    const internals = service as unknown as {
      io: typeof io;
      taskRevisions: Map<string, { version: number; expiresAt: number }>;
      handleEvent: (channel: string, payload: unknown) => void;
      handleTaskUpdate: (payload: TaskUpdatePayload) => Promise<void>;
    };
    internals.io = io;
    internals.taskRevisions = new Map();
    return { frames, internals };
  }

  test('each producer event produces exactly one activity envelope per audience', () => {
    const { frames, internals } = dispatcher();
    internals.handleEvent('propr:events:goals', goalPayload);
    internals.handleEvent('propr:events:notifications', {
      ...notificationPayload,
      recipientIds: ['user-a'],
    });
    internals.handleEvent('propr:events:usage', usagePayload);

    assert.deepEqual(activityFrames(frames).map(payload => payload.domain), [
      'goal',
      'notification',
    ]);
    assert.deepEqual(
      frames.filter(frame => frame.event === ACTIVITY_UPDATE).map(frame => frame.room),
      [ACTIVITY_ROOM, 'user:user-a'],
    );
  });

  test('a task update broadcasts the task once and its activity once', async () => {
    const { frames, internals } = dispatcher();
    await internals.handleTaskUpdate({
      eventType: TASK_UPDATE,
      taskId: 'task-1',
      state: 'completed',
      repository: 'integry/propr',
      timestamp: '2026-09-26T10:07:00.000Z',
    });

    assert.equal(frames.filter(frame => frame.event === TASK_UPDATE).length, 2);
    assert.deepEqual(activityFrames(frames).map(payload => [payload.domain, payload.change]), [
      ['task', 'completed'],
    ]);
  });
});
