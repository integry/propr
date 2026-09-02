import {
  NOTIFICATION_SOURCE_ACTIVITY_STATUSES,
  notificationSourceActivitySchema,
  notificationUserStateSchema,
  parseNotificationSourceActivity,
  parseNotificationUserState,
  parsePushDeliveryAttempt,
  parsePushDeliveryJob,
  parsePushSubscription,
  parsePushSubscriptionInput,
  parsePushSubscriptionsResponse,
  pushDeliveryAttemptSchema,
  pushDeliveryJobSchema,
  pushSubscriptionInputSchema,
  pushSubscriptionSchema,
  pushSubscriptionsResponseSchema,
  type JsonObject,
  type JsonValue,
  type ISO8601Timestamp,
  type NotificationSourceActivity,
  type NotificationUserState,
  type PushDeliveryAttempt,
  type RetryablePushDeliveryAttempt,
  type PushDeliveryJob,
  type PushSubscription,
  type PushSubscriptionInput,
  type PushSubscriptionsResponse,
  type RuntimeSchema,
} from '@propr/shared';

declare const timestamp: ISO8601Timestamp;

// @ts-expect-error A recipient snapshot must keep at least one channel enabled.
const disabledRecipient: NotificationUserState = {
  eventId: 'event-1',
  userId: 'user-1',
  inboxEnabled: false,
  pushEnabled: false,
  readAt: null,
  dismissedAt: null,
  createdAt: timestamp,
};

// @ts-expect-error Failed sends require a response status or an error code.
const detailFreeAttempt: RetryablePushDeliveryAttempt = {
  id: 'attempt-1',
  jobId: 'job-1',
  attemptNumber: 1,
  claimToken: 'claim-1',
  status: 'retryable',
  responseStatus: null,
  errorCode: null,
  errorMessage: null,
  attemptedAt: timestamp,
  nextRetryAt: timestamp,
  createdAt: timestamp,
};

// @ts-expect-error Active source work cannot carry a terminal timestamp.
const contradictoryActivity: NotificationSourceActivity = {
  type: 'task',
  key: 'task-1',
  repository: 'integry/propr',
  status: 'processing',
  lastActivityAt: timestamp,
  completedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

// @ts-expect-error A task activity cannot carry an indexing-only branch.
const taskActivityWithBranch: NotificationSourceActivity = {
  type: 'task',
  key: 'task-1',
  repository: 'integry/propr',
  branch: 'main',
  status: 'processing',
  lastActivityAt: timestamp,
  completedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const jsonValue: JsonValue = { nested: [true, 1, null] } satisfies JsonObject;
const schemas: Array<RuntimeSchema<unknown>> = [
  notificationSourceActivitySchema,
  notificationUserStateSchema,
  pushDeliveryAttemptSchema,
  pushDeliveryJobSchema,
  pushSubscriptionInputSchema,
  pushSubscriptionSchema,
  pushSubscriptionsResponseSchema,
];
const parsers = [
  parseNotificationSourceActivity,
  parseNotificationUserState,
  parsePushDeliveryAttempt,
  parsePushDeliveryJob,
  parsePushSubscription,
  parsePushSubscriptionInput,
  parsePushSubscriptionsResponse,
];

export type PublicNotificationTypes =
  | NotificationSourceActivity
  | NotificationUserState
  | PushDeliveryAttempt
  | PushDeliveryJob
  | PushSubscription
  | PushSubscriptionInput
  | PushSubscriptionsResponse;

void jsonValue;
void schemas;
void parsers;
void NOTIFICATION_SOURCE_ACTIVITY_STATUSES;
void disabledRecipient;
void detailFreeAttempt;
void contradictoryActivity;
void taskActivityWithBranch;
