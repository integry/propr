/**
 * Durable notification contracts shared by the API, backend workers, and UI.
 *
 * Timestamps in this module are serialized ISO-8601 strings. The database
 * deliberately stores the same representation as TEXT instead of relying on
 * driver-specific SQLite timestamp conversion.
 */

/** An ISO-8601 timestamp, normally emitted by `Date.prototype.toISOString()`. */
export type ISO8601Timestamp = string;

/** Backwards-friendly spelling for consumers that prefer `Iso`. */
export type Iso8601Timestamp = ISO8601Timestamp;

export const NOTIFICATION_KINDS = [
  'plan',
  'task',
  'review',
  'pull_request',
  'indexing',
  'system_failure',
] as const;

/** The durable categories that can be independently configured by a user. */
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = [
  'info',
  'success',
  'warning',
  'error',
] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

interface RepositoryNotificationTarget {
  /** Repository in `owner/name` format. */
  repository: string;
}

export interface PlanNotificationTarget extends RepositoryNotificationTarget {
  type: 'plan';
  draftId: string;
}

export interface TaskNotificationTarget extends RepositoryNotificationTarget {
  type: 'task';
  taskId: string;
  issueNumber?: number;
  prNumber?: number;
}

export interface ReviewNotificationTarget extends RepositoryNotificationTarget {
  type: 'review';
  prNumber: number;
  /** Task that produced the review, when one exists. */
  taskId?: string;
}

export interface PullRequestNotificationTarget extends RepositoryNotificationTarget {
  type: 'pull_request';
  prNumber: number;
}

export interface IndexingNotificationTarget extends RepositoryNotificationTarget {
  type: 'indexing';
  branch?: string;
}

export interface SystemFailureNotificationTarget {
  type: 'system_failure';
  /** Service or worker that reported the failure. */
  component: string;
  /** Optional identifier used to correlate the failure with logs. */
  correlationId?: string;
}

/** A stable destination that every notification client can interpret. */
export type NotificationTarget =
  | PlanNotificationTarget
  | TaskNotificationTarget
  | ReviewNotificationTarget
  | PullRequestNotificationTarget
  | IndexingNotificationTarget
  | SystemFailureNotificationTarget;

/** Selects the target belonging to a particular notification kind. */
export type NotificationTargetFor<K extends NotificationKind> = Extract<
  NotificationTarget,
  { type: K }
>;

export const NOTIFICATION_ACTION_TYPES = ['navigate', 'external_link'] as const;

export type NotificationActionType = (typeof NOTIFICATION_ACTION_TYPES)[number];

/** A user-visible action carried by Inbox and Web Push responses. */
export interface NotificationAction {
  type: NotificationActionType;
  label: string;
  /** An application-relative path for `navigate`, or an absolute URL otherwise. */
  href: string;
}

interface NotificationEventFields<K extends NotificationKind> {
  id: string;
  /** Idempotency key supplied by the producer. */
  deduplicationKey: string;
  kind: K;
  severity: NotificationSeverity;
  target: NotificationTargetFor<K>;
  title: string;
  body: string;
  action?: NotificationAction;
  metadata?: Record<string, unknown>;
  occurredAt: ISO8601Timestamp;
  createdAt: ISO8601Timestamp;
}

/**
 * The immutable portion of a notification, shared by every recipient.
 *
 * This conditional form preserves the relationship between `kind` and
 * `target` when the default union is narrowed by a consumer.
 */
export type NotificationEvent<K extends NotificationKind = NotificationKind> =
  K extends NotificationKind ? NotificationEventFields<K> : never;

/** Per-user state for an immutable event. Null means the action has not occurred. */
export interface NotificationUserState {
  eventId: string;
  userId: string;
  readAt: ISO8601Timestamp | null;
  dismissedAt: ISO8601Timestamp | null;
  createdAt: ISO8601Timestamp;
}

/** The Inbox representation returned to an authenticated user. */
export type Notification<K extends NotificationKind = NotificationKind> =
  K extends NotificationKind
    ? NotificationEvent<K> & Pick<NotificationUserState, 'readAt' | 'dismissedAt'>
    : never;

export interface NotificationPreferenceChannels {
  inboxEnabled: boolean;
  pushEnabled: boolean;
}

/** Preferences for one notification kind. */
export interface NotificationPreference extends NotificationPreferenceChannels {
  kind: NotificationKind;
  updatedAt?: ISO8601Timestamp;
}

/** A complete preference snapshot keyed by notification kind. */
export type NotificationPreferences = Record<
  NotificationKind,
  NotificationPreferenceChannels
>;

/** The encryption keys supplied by the browser Push API. */
export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

/** Browser payload accepted when registering or refreshing a subscription. */
export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: PushSubscriptionKeys;
}

/** Alias matching Web Push terminology used by non-browser backend consumers. */
export type WebPushSubscription = PushSubscriptionInput;

/** Safe subscription metadata returned by the API (encryption keys are omitted). */
export interface PushSubscription {
  id: string;
  endpoint: string;
  expiresAt: ISO8601Timestamp | null;
  revokedAt: ISO8601Timestamp | null;
  createdAt: ISO8601Timestamp;
  updatedAt: ISO8601Timestamp;
}

export const PUSH_DELIVERY_STATUSES = [
  'pending',
  'delivered',
  'retryable',
  'failed',
] as const;

export type PushDeliveryStatus = (typeof PUSH_DELIVERY_STATUSES)[number];

/** An auditable Web Push attempt. Retryable rows may carry `nextRetryAt`. */
export interface PushDeliveryAttempt {
  id: string;
  deduplicationKey: string;
  eventId: string;
  userId: string;
  subscriptionId: string;
  attemptNumber: number;
  status: PushDeliveryStatus;
  attemptedAt: ISO8601Timestamp | null;
  nextRetryAt: ISO8601Timestamp | null;
  responseStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: ISO8601Timestamp;
}

export const NOTIFICATION_SOURCE_ACTIVITY_TYPES = ['task', 'indexing'] as const;

export type NotificationSourceActivityType =
  (typeof NOTIFICATION_SOURCE_ACTIVITY_TYPES)[number];

/** Latest known activity for a task or repository-indexing operation. */
export interface NotificationSourceActivity {
  type: NotificationSourceActivityType;
  /** Task ID, or a stable repository/branch key for indexing. */
  key: string;
  repository: string;
  /** Present for branch-scoped indexing activity. */
  branch?: string;
  status: string;
  lastActivityAt: ISO8601Timestamp;
  completedAt: ISO8601Timestamp | null;
  metadata?: Record<string, unknown>;
  createdAt: ISO8601Timestamp;
  updatedAt: ISO8601Timestamp;
}

/** Cursor-paginated Inbox response. */
export interface NotificationListResponse {
  notifications: Notification[];
  unreadCount: number;
  nextCursor: string | null;
}

export interface NotificationUnreadCountResponse {
  unreadCount: number;
}

export interface NotificationStateResponse {
  notification: Notification;
  unreadCount: number;
}

export interface NotificationPreferencesResponse {
  preferences: NotificationPreference[];
}

export interface PushSubscriptionsResponse {
  subscriptions: PushSubscription[];
}
