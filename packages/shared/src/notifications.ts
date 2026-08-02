/**
 * Durable notification contracts shared by the API, backend workers, and UI.
 *
 * All timestamps are canonical, fixed-width UTC strings produced by
 * `Date.prototype.toISOString()`. Use the runtime schemas below at database
 * and API boundaries instead of casting untrusted values to these types.
 */

declare const iso8601TimestampBrand: unique symbol;

/** A canonical `YYYY-MM-DDTHH:mm:ss.sssZ` UTC timestamp. */
export type ISO8601Timestamp = string & {
  readonly [iso8601TimestampBrand]: true;
};

/** Backwards-friendly spelling for consumers that prefer `Iso`. */
export type Iso8601Timestamp = ISO8601Timestamp;

const CANONICAL_ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Normalize a Date-compatible value before writing it to the database. */
export function normalizeISO8601Timestamp(
  value: string | number | Date,
): ISO8601Timestamp {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('Expected a valid timestamp');
  }

  return date.toISOString() as ISO8601Timestamp;
}

/** Validate that an unknown value is already in canonical UTC form. */
export function parseISO8601Timestamp(value: unknown): ISO8601Timestamp {
  if (
    typeof value !== 'string'
    || !CANONICAL_ISO8601_PATTERN.test(value)
    || normalizeISO8601Timestamp(value) !== value
  ) {
    throw new TypeError('Expected a canonical ISO-8601 UTC timestamp');
  }

  return value as ISO8601Timestamp;
}

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

/** An in-application action carried by Inbox and Web Push responses. */
export interface NavigateNotificationAction {
  type: 'navigate';
  label: string;
  /** An application-relative path beginning with one `/`. */
  href: string;
}

/** An action that leaves the application for an absolute HTTP(S) URL. */
export interface ExternalLinkNotificationAction {
  type: 'external_link';
  label: string;
  href: string;
}

/** A user-visible action with exhaustive type discrimination. */
export type NotificationAction =
  | NavigateNotificationAction
  | ExternalLinkNotificationAction;

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

/**
 * Per-recipient state and the channel decision captured at assignment time.
 * Preferences are deliberately not consulted when reading historical rows.
 */
export interface NotificationUserState {
  eventId: string;
  userId: string;
  inboxEnabled: boolean;
  pushEnabled: boolean;
  readAt: ISO8601Timestamp | null;
  dismissedAt: ISO8601Timestamp | null;
  /** Recipient assignment time and the primary descending Inbox cursor. */
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

/** One persisted entry in a complete preference snapshot. */
export interface NotificationPreference extends NotificationPreferenceChannels {
  updatedAt: ISO8601Timestamp;
}

/** A complete preference snapshot keyed by every durable notification kind. */
export type NotificationPreferences = Record<
  NotificationKind,
  NotificationPreference
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

/** Mutable delivery-job states. `processing` is always protected by a lease. */
export const PUSH_DELIVERY_STATUSES = [
  'pending',
  'processing',
  'retryable',
  'delivered',
  'failed',
  'cancelled',
] as const;

export type PushDeliveryJobStatus = (typeof PUSH_DELIVERY_STATUSES)[number];

/** Backwards-compatible name for the mutable delivery-job status. */
export type PushDeliveryStatus = PushDeliveryJobStatus;

interface PushDeliveryJobFields {
  id: string;
  deduplicationKey: string;
  eventId: string;
  userId: string;
  subscriptionId: string;
  attemptCount: number;
  createdAt: ISO8601Timestamp;
  updatedAt: ISO8601Timestamp;
}

interface UnclaimedPushDeliveryJobFields {
  claimToken: null;
  claimedAt: null;
  leaseExpiresAt: null;
}

export interface PendingPushDeliveryJob
  extends PushDeliveryJobFields, UnclaimedPushDeliveryJobFields {
  status: 'pending';
  nextRetryAt: null;
}

export interface ProcessingPushDeliveryJob extends PushDeliveryJobFields {
  status: 'processing';
  nextRetryAt: null;
  claimToken: string;
  claimedAt: ISO8601Timestamp;
  leaseExpiresAt: ISO8601Timestamp;
}

export interface RetryablePushDeliveryJob
  extends PushDeliveryJobFields, UnclaimedPushDeliveryJobFields {
  status: 'retryable';
  nextRetryAt: ISO8601Timestamp;
}

export interface TerminalPushDeliveryJob
  extends PushDeliveryJobFields, UnclaimedPushDeliveryJobFields {
  status: 'delivered' | 'failed' | 'cancelled';
  nextRetryAt: null;
}

/** A schedulable delivery job. Claim and schedule invariants narrow by status. */
export type PushDeliveryJob =
  | PendingPushDeliveryJob
  | ProcessingPushDeliveryJob
  | RetryablePushDeliveryJob
  | TerminalPushDeliveryJob;

/** Immutable outcomes recorded once for each actual Web Push request. */
export const PUSH_DELIVERY_ATTEMPT_STATUSES = [
  'delivered',
  'retryable',
  'failed',
] as const;

export type PushDeliveryAttemptStatus =
  (typeof PUSH_DELIVERY_ATTEMPT_STATUSES)[number];

interface PushDeliveryAttemptFields {
  id: string;
  jobId: string;
  attemptNumber: number;
  claimToken: string;
  attemptedAt: ISO8601Timestamp;
  createdAt: ISO8601Timestamp;
}

export interface DeliveredPushDeliveryAttempt extends PushDeliveryAttemptFields {
  status: 'delivered';
  nextRetryAt: null;
  responseStatus: number;
  errorCode: null;
  errorMessage: null;
}

export interface RetryablePushDeliveryAttempt extends PushDeliveryAttemptFields {
  status: 'retryable';
  nextRetryAt: ISO8601Timestamp;
  responseStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface FailedPushDeliveryAttempt extends PushDeliveryAttemptFields {
  status: 'failed';
  nextRetryAt: null;
  responseStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * An append-only send audit record. Retry scheduling lives on the related job,
 * so recording attempt N never causes attempt N to be polled again.
 */
export type PushDeliveryAttempt =
  | DeliveredPushDeliveryAttempt
  | RetryablePushDeliveryAttempt
  | FailedPushDeliveryAttempt;

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

/**
 * Cursor-paginated Inbox response ordered by recipient assignment time, then
 * event ID, both descending. The cursor remains opaque to API consumers.
 */
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

/** API snapshots are complete and use the same keyed representation everywhere. */
export interface NotificationPreferencesResponse {
  preferences: NotificationPreferences;
}

export interface PushSubscriptionsResponse {
  subscriptions: PushSubscription[];
}

/** Minimal schema interface used without imposing a validation dependency. */
export interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

function invalid(path: string, expectation: string): never {
  throw new TypeError(`${path}: expected ${expectation}`);
}

function parseRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(path, 'an object');
  }
  return value as Record<string, unknown>;
}

function parseString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    return invalid(path, allowEmpty ? 'a string' : 'a non-empty string');
  }
  return value;
}

function parsePositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return invalid(path, 'a positive integer');
  }
  return value as number;
}

function parseOptionalString(
  value: unknown,
  path: string,
): string | undefined {
  return value === undefined ? undefined : parseString(value, path);
}

function parseOptionalPositiveInteger(
  value: unknown,
  path: string,
): number | undefined {
  return value === undefined ? undefined : parsePositiveInteger(value, path);
}

function parseRepository(value: unknown, path: string): string {
  const repository = parseString(value, path);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    return invalid(path, 'a repository in owner/name form');
  }
  return repository;
}

function parseEnum<T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    return invalid(path, `one of ${values.join(', ')}`);
  }
  return value as T[number];
}

export function parseNotificationTarget<K extends NotificationKind>(
  value: unknown,
  expectedKind: K,
): NotificationTargetFor<K>;
export function parseNotificationTarget(value: unknown): NotificationTarget;
export function parseNotificationTarget(
  value: unknown,
  expectedKind?: NotificationKind,
): NotificationTarget {
  const target = parseRecord(value, 'target');
  const type = parseEnum(target.type, NOTIFICATION_KINDS, 'target.type');
  if (expectedKind !== undefined && type !== expectedKind) {
    return invalid('target.type', expectedKind);
  }

  switch (type) {
    case 'plan':
      return {
        type,
        repository: parseRepository(target.repository, 'target.repository'),
        draftId: parseString(target.draftId, 'target.draftId'),
      };
    case 'task': {
      const issueNumber = parseOptionalPositiveInteger(
        target.issueNumber,
        'target.issueNumber',
      );
      const prNumber = parseOptionalPositiveInteger(target.prNumber, 'target.prNumber');
      return {
        type,
        repository: parseRepository(target.repository, 'target.repository'),
        taskId: parseString(target.taskId, 'target.taskId'),
        ...(issueNumber === undefined ? {} : { issueNumber }),
        ...(prNumber === undefined ? {} : { prNumber }),
      };
    }
    case 'review': {
      const taskId = parseOptionalString(target.taskId, 'target.taskId');
      return {
        type,
        repository: parseRepository(target.repository, 'target.repository'),
        prNumber: parsePositiveInteger(target.prNumber, 'target.prNumber'),
        ...(taskId === undefined ? {} : { taskId }),
      };
    }
    case 'pull_request':
      return {
        type,
        repository: parseRepository(target.repository, 'target.repository'),
        prNumber: parsePositiveInteger(target.prNumber, 'target.prNumber'),
      };
    case 'indexing': {
      const branch = parseOptionalString(target.branch, 'target.branch');
      return {
        type,
        repository: parseRepository(target.repository, 'target.repository'),
        ...(branch === undefined ? {} : { branch }),
      };
    }
    case 'system_failure': {
      const correlationId = parseOptionalString(
        target.correlationId,
        'target.correlationId',
      );
      return {
        type,
        component: parseString(target.component, 'target.component'),
        ...(correlationId === undefined ? {} : { correlationId }),
      };
    }
  }
}

export function parseNotificationAction(value: unknown): NotificationAction {
  const action = parseRecord(value, 'action');
  const type = parseEnum(action.type, NOTIFICATION_ACTION_TYPES, 'action.type');
  const label = parseString(action.label, 'action.label');
  const href = parseString(action.href, 'action.href');

  if (type === 'navigate') {
    if (!href.startsWith('/') || href.startsWith('//') || /[\\\u0000-\u001f]/.test(href)) {
      return invalid('action.href', 'a safe application-relative path');
    }
    return { type, label, href };
  }

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return invalid('action.href', 'an absolute HTTP(S) URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.hostname.length === 0
    || url.username.length > 0
    || url.password.length > 0
  ) {
    return invalid('action.href', 'a safe absolute HTTP(S) URL');
  }
  return { type, label, href: url.href };
}

function parseOptionalMetadata(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : { ...parseRecord(value, path) };
}

/** Validate and sanitize the immutable payload before insertion or serialization. */
export function parseNotificationEvent(value: unknown): NotificationEvent {
  const event = parseRecord(value, 'notificationEvent');
  const kind = parseEnum(event.kind, NOTIFICATION_KINDS, 'notificationEvent.kind');
  const action = event.action === undefined
    ? undefined
    : parseNotificationAction(event.action);
  const metadata = parseOptionalMetadata(event.metadata, 'notificationEvent.metadata');

  return {
    id: parseString(event.id, 'notificationEvent.id'),
    deduplicationKey: parseString(
      event.deduplicationKey,
      'notificationEvent.deduplicationKey',
    ),
    kind,
    severity: parseEnum(
      event.severity,
      NOTIFICATION_SEVERITIES,
      'notificationEvent.severity',
    ),
    target: parseNotificationTarget(event.target, kind),
    title: parseString(event.title, 'notificationEvent.title'),
    body: parseString(event.body, 'notificationEvent.body', true),
    ...(action === undefined ? {} : { action }),
    ...(metadata === undefined ? {} : { metadata }),
    occurredAt: parseISO8601Timestamp(event.occurredAt),
    createdAt: parseISO8601Timestamp(event.createdAt),
  } as NotificationEvent;
}

/** Validate an Inbox item immediately before serializing an API response. */
export function parseNotification(value: unknown): Notification {
  const record = parseRecord(value, 'notification');
  const event = parseNotificationEvent(record);
  const readAt = record.readAt === null
    ? null
    : parseISO8601Timestamp(record.readAt);
  const dismissedAt = record.dismissedAt === null
    ? null
    : parseISO8601Timestamp(record.dismissedAt);
  return { ...event, readAt, dismissedAt } as Notification;
}

/** Validate a complete, consistently shaped preference response. */
export function parseNotificationPreferences(
  value: unknown,
): NotificationPreferences {
  const preferences = parseRecord(value, 'preferences');
  const expectedKinds = new Set<string>(NOTIFICATION_KINDS);
  for (const key of Object.keys(preferences)) {
    if (!expectedKinds.has(key)) {
      return invalid('preferences', `only known notification kinds (found ${key})`);
    }
  }

  return Object.fromEntries(NOTIFICATION_KINDS.map((kind) => {
    const preference = parseRecord(preferences[kind], `preferences.${kind}`);
    if (typeof preference.inboxEnabled !== 'boolean') {
      return invalid(`preferences.${kind}.inboxEnabled`, 'a boolean');
    }
    if (typeof preference.pushEnabled !== 'boolean') {
      return invalid(`preferences.${kind}.pushEnabled`, 'a boolean');
    }
    return [kind, {
      inboxEnabled: preference.inboxEnabled,
      pushEnabled: preference.pushEnabled,
      updatedAt: parseISO8601Timestamp(preference.updatedAt),
    }];
  })) as NotificationPreferences;
}

function parseNonnegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(path, 'a nonnegative integer');
  }
  return value as number;
}

/** Validate the complete Inbox envelope immediately before serialization. */
export function parseNotificationListResponse(
  value: unknown,
): NotificationListResponse {
  const response = parseRecord(value, 'notificationListResponse');
  if (!Array.isArray(response.notifications)) {
    return invalid('notificationListResponse.notifications', 'an array');
  }
  const nextCursor = response.nextCursor === null
    ? null
    : parseString(response.nextCursor, 'notificationListResponse.nextCursor');
  return {
    notifications: response.notifications.map(parseNotification),
    unreadCount: parseNonnegativeInteger(
      response.unreadCount,
      'notificationListResponse.unreadCount',
    ),
    nextCursor,
  };
}

export function parseNotificationUnreadCountResponse(
  value: unknown,
): NotificationUnreadCountResponse {
  const response = parseRecord(value, 'notificationUnreadCountResponse');
  return {
    unreadCount: parseNonnegativeInteger(
      response.unreadCount,
      'notificationUnreadCountResponse.unreadCount',
    ),
  };
}

export function parseNotificationStateResponse(
  value: unknown,
): NotificationStateResponse {
  const response = parseRecord(value, 'notificationStateResponse');
  return {
    notification: parseNotification(response.notification),
    unreadCount: parseNonnegativeInteger(
      response.unreadCount,
      'notificationStateResponse.unreadCount',
    ),
  };
}

export function parseNotificationPreferencesResponse(
  value: unknown,
): NotificationPreferencesResponse {
  const response = parseRecord(value, 'notificationPreferencesResponse');
  return {
    preferences: parseNotificationPreferences(response.preferences),
  };
}

export const iso8601TimestampSchema: RuntimeSchema<ISO8601Timestamp> = {
  parse: parseISO8601Timestamp,
};
export const notificationTargetSchema: RuntimeSchema<NotificationTarget> = {
  parse: parseNotificationTarget,
};
export const notificationActionSchema: RuntimeSchema<NotificationAction> = {
  parse: parseNotificationAction,
};
export const notificationEventSchema: RuntimeSchema<NotificationEvent> = {
  parse: parseNotificationEvent,
};
export const notificationSchema: RuntimeSchema<Notification> = {
  parse: parseNotification,
};
export const notificationPreferencesSchema: RuntimeSchema<NotificationPreferences> = {
  parse: parseNotificationPreferences,
};
export const notificationListResponseSchema: RuntimeSchema<NotificationListResponse> = {
  parse: parseNotificationListResponse,
};
export const notificationUnreadCountResponseSchema:
  RuntimeSchema<NotificationUnreadCountResponse> = {
  parse: parseNotificationUnreadCountResponse,
};
export const notificationStateResponseSchema: RuntimeSchema<NotificationStateResponse> = {
  parse: parseNotificationStateResponse,
};
export const notificationPreferencesResponseSchema:
  RuntimeSchema<NotificationPreferencesResponse> = {
  parse: parseNotificationPreferencesResponse,
};
