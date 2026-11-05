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
import {
  SHELL_ACTIVITY_CHANGES,
  isShellActivityUpdatePayload,
  isShellNotificationUpdatePayload,
  isShellUsageUpdatePayload,
  isTerminalShellActivityChange,
  type ActivityUpdatePayload as ShellActivityUpdatePayload,
  type NotificationUpdatePayload as ShellNotificationUpdatePayload,
} from '../packages/shared/src/events.js';

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

// The shell-shaped wire formats are relayed from the same Redis channels and
// re-emitted to the same browsers, so supporting them cannot mean trusting
// them. These guards are what the relay checks a second accepted format with.
const validShellActivity: ShellActivityUpdatePayload = {
  eventType: ACTIVITY_UPDATE,
  domain: 'task',
  change: 'completed',
  subjectId: 'task-1',
  repository: 'integry/propr',
  terminal: true,
  occurredAt: '2026-09-26T10:00:00.000Z',
};

test('a shell activity frame is validated whole, subject and scope included', () => {
  assert.equal(isShellActivityUpdatePayload(validShellActivity), true);
  // A queue or health frame has no subject and no repository of its own.
  assert.equal(isShellActivityUpdatePayload({
    eventType: ACTIVITY_UPDATE, domain: 'queue', change: 'updated', terminal: false,
    occurredAt: validShellActivity.occurredAt,
  }), true);
  assert.equal(isShellActivityUpdatePayload({ ...validShellActivity, terminal: undefined }), true);
  assert.equal(isShellActivityUpdatePayload({ ...validShellActivity, occurredAt: 'yesterday' }), false);
  assert.equal(isShellActivityUpdatePayload({ ...validShellActivity, domain: 'invented' }), false);
  assert.equal(isShellActivityUpdatePayload({ ...validShellActivity, change: 'progressed' }), false);
  assert.equal(isShellActivityUpdatePayload({ ...validShellActivity, subjectId: '' }), false);
  assert.equal(isShellActivityUpdatePayload({ ...validShellActivity, repository: 42 }), false);
  // A flag that contradicts its own change would have producer and consumer
  // reading the same event differently.
  assert.equal(isShellActivityUpdatePayload({ ...validShellActivity, terminal: false }), false);
  assert.equal(isShellActivityUpdatePayload({ ...validShellActivity, change: 'started' }), false);
  assert.equal(isShellActivityUpdatePayload({
    ...validShellActivity, change: 'started', terminal: false,
  }), true);
  assert.equal(isShellActivityUpdatePayload({ ...validShellActivity, eventType: USAGE_UPDATE }), false);
  assert.equal(isShellActivityUpdatePayload(null), false);
});

test('only the shell terminal changes end a subject', () => {
  assert.deepEqual(SHELL_ACTIVITY_CHANGES.filter(isTerminalShellActivityChange),
    ['failed', 'completed', 'cancelled']);
});

test('a per-recipient notification frame is validated down to its badge count', () => {
  const validShellNotification: ShellNotificationUpdatePayload = {
    eventType: NOTIFICATION_UPDATE, change: 'read', eventId: 'event-1',
    recipientId: 'user-a', unreadCount: 2, occurredAt: validShellActivity.occurredAt,
  };
  assert.equal(isShellNotificationUpdatePayload(validShellNotification), true);
  // A bulk clear and a multi-event dismissal both mean 'reconcile the list',
  // so neither names a single subject.
  assert.equal(isShellNotificationUpdatePayload({
    ...validShellNotification, change: 'dismissed_all', eventId: undefined,
  }), true);
  assert.equal(isShellNotificationUpdatePayload({ ...validShellNotification, change: 'archived' }), false);
  assert.equal(isShellNotificationUpdatePayload({ ...validShellNotification, eventId: 7 }), false);
  assert.equal(isShellNotificationUpdatePayload({ ...validShellNotification, recipientId: '' }), false);
  assert.equal(isShellNotificationUpdatePayload({ ...validShellNotification, unreadCount: 'three' }), false);
  assert.equal(isShellNotificationUpdatePayload({ ...validShellNotification, unreadCount: -1 }), false);
  assert.equal(isShellNotificationUpdatePayload({ ...validShellNotification, unreadCount: 1.5 }), false);
  assert.equal(isShellNotificationUpdatePayload({ ...validShellNotification, occurredAt: 'soon' }), false);
  assert.equal(isShellNotificationUpdatePayload(null), false);
});

test('a usage trigger is accepted in either published format but never unchecked', () => {
  const occurredAt = validShellActivity.occurredAt;
  assert.equal(isShellUsageUpdatePayload({ eventType: USAGE_UPDATE, occurredAt }), true);
  assert.equal(isShellUsageUpdatePayload({ eventType: USAGE_UPDATE, provider: 'agent-tank', occurredAt }), true);
  assert.equal(isShellUsageUpdatePayload({ eventType: USAGE_UPDATE, source: 'agent-tank', occurredAt }), true);
  // Relaxing the required field does not relax what the field means.
  assert.equal(isShellUsageUpdatePayload({ eventType: USAGE_UPDATE, source: 'guesswork', occurredAt }), false);
  assert.equal(isShellUsageUpdatePayload({ eventType: USAGE_UPDATE, provider: '', occurredAt }), false);
  assert.equal(isShellUsageUpdatePayload({ eventType: USAGE_UPDATE, occurredAt: 'soon' }), false);
  assert.equal(isShellUsageUpdatePayload({ eventType: ACTIVITY_UPDATE, occurredAt }), false);
  assert.equal(isShellUsageUpdatePayload(null), false);
});
