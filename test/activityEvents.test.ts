import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTIVITY_CHANGES,
  ACTIVITY_UPDATE,
  GOAL_UPDATE,
  NOTIFICATION_UPDATE,
  USAGE_UPDATE,
  isActivityUpdatePayload,
  isGoalUpdatePayload,
  isNotificationUpdatePayload,
  isTerminalActivityChange,
  isUsageUpdatePayload,
  type ActivityUpdatePayload,
  type GoalUpdatePayload,
  type NotificationUpdatePayload,
  type UsageUpdatePayload,
} from '../packages/shared/src/activityEvents.js';

const validPayload: ActivityUpdatePayload = {
  eventType: ACTIVITY_UPDATE,
  domain: 'task',
  change: 'completed',
  entityId: 'task-1',
  repository: 'integry/propr',
  terminal: true,
  occurredAt: '2026-09-26T10:00:00.000Z',
};

test('only completed, failed, cancelled and dismissed end a unit of work', () => {
  const terminal = ACTIVITY_CHANGES.filter(isTerminalActivityChange);
  assert.deepEqual(terminal, ['completed', 'failed', 'cancelled', 'dismissed']);
});

test('activity payloads are validated at the Redis trust boundary', () => {
  assert.equal(isActivityUpdatePayload(validPayload), true);
  assert.equal(isActivityUpdatePayload({ ...validPayload, occurredAt: 'yesterday' }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, domain: 'invented' }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, change: 'invented' }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, entityId: 7 }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, eventType: 'task:update' }), false);
  assert.equal(isActivityUpdatePayload(null), false);
  assert.equal(isActivityUpdatePayload('activity:update'), false);
});

const validGoal: GoalUpdatePayload = {
  eventType: GOAL_UPDATE,
  goalId: 'goal-1',
  repository: 'integry/propr',
  state: 'running',
  currentTaskId: 'task-1',
  occurredAt: '2026-09-26T10:00:00.000Z',
};

const validNotification: NotificationUpdatePayload = {
  eventType: NOTIFICATION_UPDATE,
  change: 'created',
  eventId: 'event-1',
  recipientIds: ['user-a'],
  repository: 'integry/propr',
  occurredAt: '2026-09-26T10:00:00.000Z',
};

const validUsage: UsageUpdatePayload = {
  eventType: USAGE_UPDATE,
  source: 'agent-tank',
  occurredAt: '2026-09-26T10:00:00.000Z',
};

test('an activity envelope must carry every field a consumer reads', () => {
  // A repository a consumer cannot filter on, and a terminal flag that
  // disagrees with its own change, are the two ways a structurally plausible
  // envelope still misleads the dashboard.
  assert.equal(isActivityUpdatePayload({ ...validPayload, repository: null }), true);
  assert.equal(isActivityUpdatePayload({ ...validPayload, repository: 42 }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, repository: undefined }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, repository: '' }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, terminal: false }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, terminal: 'yes' }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, terminal: undefined }), false);
  assert.equal(
    isActivityUpdatePayload({ ...validPayload, change: 'progressed', terminal: false }),
    true,
  );
  assert.equal(isActivityUpdatePayload({ ...validPayload, entityId: '' }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, revision: 0 }), true);
  assert.equal(isActivityUpdatePayload({ ...validPayload, revision: '3' }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, revision: 1.5 }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, revision: -1 }), false);
});

test('a goal frame is validated whole before it is forwarded', () => {
  assert.equal(isGoalUpdatePayload(validGoal), true);
  assert.equal(isGoalUpdatePayload({ ...validGoal, currentTaskId: null }), true);
  assert.equal(isGoalUpdatePayload({ ...validGoal, currentTaskId: undefined }), true);
  assert.equal(isGoalUpdatePayload({ ...validGoal, goalId: undefined }), false);
  assert.equal(isGoalUpdatePayload({ ...validGoal, goalId: '' }), false);
  // A goal is always repository-scoped; 42 is the shape the Goals console would
  // compare against its selected repository and silently never match.
  assert.equal(isGoalUpdatePayload({ ...validGoal, repository: 42 }), false);
  assert.equal(isGoalUpdatePayload({ ...validGoal, repository: null }), false);
  assert.equal(isGoalUpdatePayload({ ...validGoal, state: 'finished' }), false);
  assert.equal(isGoalUpdatePayload({ ...validGoal, currentTaskId: 7 }), false);
  assert.equal(isGoalUpdatePayload({ ...validGoal, revision: 'next' }), false);
  assert.equal(isGoalUpdatePayload({ ...validGoal, occurredAt: 'yesterday' }), false);
  assert.equal(isGoalUpdatePayload({ ...validGoal, eventType: ACTIVITY_UPDATE }), false);
  assert.equal(isGoalUpdatePayload(null), false);
});

test('a notification frame names its subject unless it is the bulk clear', () => {
  assert.equal(isNotificationUpdatePayload(validNotification), true);
  assert.equal(isNotificationUpdatePayload({
    ...validNotification,
    change: 'dismissed_all',
    eventId: null,
    repository: null,
  }), true);
  // Only the bulk clear has no subject: every other change is keyed by event id.
  assert.equal(isNotificationUpdatePayload({ ...validNotification, eventId: null }), false);
  assert.equal(isNotificationUpdatePayload({
    ...validNotification,
    change: 'dismissed_all',
    eventId: 'event-1',
  }), false);
  assert.equal(isNotificationUpdatePayload({ ...validNotification, change: 'archived' }), false);
  assert.equal(isNotificationUpdatePayload({ ...validNotification, recipientIds: 'user-a' }), false);
  assert.equal(isNotificationUpdatePayload({ ...validNotification, recipientIds: undefined }), false);
  assert.equal(isNotificationUpdatePayload({ ...validNotification, repository: 42 }), false);
  assert.equal(isNotificationUpdatePayload({ ...validNotification, occurredAt: '' }), false);
  assert.equal(isNotificationUpdatePayload(null), false);
});

test('a usage trigger is validated down to its source', () => {
  assert.equal(isUsageUpdatePayload(validUsage), true);
  assert.equal(isUsageUpdatePayload({ ...validUsage, source: 'guesswork' }), false);
  assert.equal(isUsageUpdatePayload({ ...validUsage, source: undefined }), false);
  assert.equal(isUsageUpdatePayload({ ...validUsage, occurredAt: 'soon' }), false);
  assert.equal(isUsageUpdatePayload(null), false);
});
