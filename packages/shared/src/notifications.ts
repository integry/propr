/**
 * Durable notification contracts shared by the API, backend workers, and UI.
 *
 * All timestamps are canonical, fixed-width UTC strings produced by
 * `Date.prototype.toISOString()`. Use the runtime schemas below at database
 * and API boundaries instead of casting untrusted values to these types.
 * Immutable event and delivery audit records have indefinite retention; any
 * future archival policy must preserve their referential history explicitly.
 */

declare const iso8601TimestampBrand: unique symbol;

/** A canonical `YYYY-MM-DDTHH:mm:ss.sssZ` UTC timestamp. */
export type ISO8601Timestamp = string & {
  readonly [iso8601TimestampBrand]: true;
};

/** Backwards-friendly spelling for consumers that prefer `Iso`. */
export type Iso8601Timestamp = ISO8601Timestamp;

/** Values that can be safely persisted as JSON and serialized by an API. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

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
  metadata?: JsonObject;
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
interface NotificationUserStateFields {
  eventId: string;
  userId: string;
  /** Recipient assignment time and the primary descending Inbox cursor. */
  createdAt: ISO8601Timestamp;
}

export type NotificationUserState = NotificationUserStateFields & (
  | {
    inboxEnabled: true;
    pushEnabled: boolean;
    readAt: ISO8601Timestamp | null;
    dismissedAt: ISO8601Timestamp | null;
  }
  | {
    inboxEnabled: false;
    pushEnabled: true;
    readAt: null;
    dismissedAt: null;
  }
);

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
  attemptCount: 0;
  nextRetryAt: null;
}

export interface ProcessingPushDeliveryJob extends PushDeliveryJobFields {
  status: 'processing';
  attemptCount: number;
  nextRetryAt: null;
  claimToken: string;
  claimedAt: ISO8601Timestamp;
  leaseExpiresAt: ISO8601Timestamp;
}

export interface RetryablePushDeliveryJob
  extends PushDeliveryJobFields, UnclaimedPushDeliveryJobFields {
  status: 'retryable';
  attemptCount: number;
  nextRetryAt: ISO8601Timestamp;
}

export interface TerminalPushDeliveryJob
  extends PushDeliveryJobFields, UnclaimedPushDeliveryJobFields {
  status: 'delivered' | 'failed' | 'cancelled';
  attemptCount: number;
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

type PushDeliveryFailureDetails =
  | {
    responseStatus: number;
    errorCode: string | null;
    errorMessage: string | null;
  }
  | {
    responseStatus: null;
    errorCode: string;
    errorMessage: string | null;
  };

export type RetryablePushDeliveryAttempt = PushDeliveryAttemptFields &
  PushDeliveryFailureDetails & {
    status: 'retryable';
    nextRetryAt: ISO8601Timestamp;
  };

export type FailedPushDeliveryAttempt = PushDeliveryAttemptFields &
  PushDeliveryFailureDetails & {
    status: 'failed';
    nextRetryAt: null;
  };

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

export const NOTIFICATION_SOURCE_ACTIVITY_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;

export type NotificationSourceActivityStatus =
  (typeof NOTIFICATION_SOURCE_ACTIVITY_STATUSES)[number];

/** Latest known activity for a task or repository-indexing operation. */
interface NotificationSourceActivityFields {
  type: NotificationSourceActivityType;
  /** Task ID, or a stable repository/branch key for indexing. */
  key: string;
  repository: string;
  /** Present for branch-scoped indexing activity. */
  branch?: string;
  lastActivityAt: ISO8601Timestamp;
  metadata?: JsonObject;
  createdAt: ISO8601Timestamp;
  updatedAt: ISO8601Timestamp;
}

export type NotificationSourceActivity = NotificationSourceActivityFields & (
  | {
    status: 'queued' | 'processing';
    completedAt: null;
  }
  | {
    status: 'completed' | 'failed' | 'cancelled';
    completedAt: ISO8601Timestamp;
  }
);

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
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
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

function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    return invalid(path, 'a boolean');
  }
  return value;
}

function parseNullableString(
  value: unknown,
  path: string,
  allowEmpty = false,
): string | null {
  return value === null ? null : parseString(value, path, allowEmpty);
}

function parseNullableTimestamp(
  value: unknown,
  path: string,
): ISO8601Timestamp | null {
  try {
    return value === null ? null : parseISO8601Timestamp(value);
  } catch {
    return invalid(path, 'a canonical ISO-8601 UTC timestamp or null');
  }
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

function parseResponseStatus(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 599) {
    return invalid(path, 'an integer HTTP status from 100 through 599 or null');
  }
  return value as number;
}

function parseExpirationTime(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || (value as number) < 0
    || (value as number) > 8_640_000_000_000_000
  ) {
    return invalid(path, 'a Date-compatible epoch-millisecond number or null');
  }
  return value as number;
}

function parseBase64Url(value: unknown, path: string): string {
  const encoded = parseString(value, path);
  const unpadded = encoded.replace(/=+$/, '');
  if (
    !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)
    || unpadded.length % 4 === 1
    || (encoded.includes('=') && encoded.length % 4 !== 0)
  ) {
    return invalid(path, 'a base64url-encoded value');
  }
  return encoded;
}

const UNSAFE_URL_CHARACTER_PATTERN = /[\\\u0000-\u001f\u007f]/;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function parseSafeAbsoluteUrl(
  value: unknown,
  path: string,
  protocols: readonly string[],
  allowFragment = true,
  expectation = `a safe absolute ${protocols.join(' or ')} URL`,
): string {
  const href = parseString(value, path);
  if (UNSAFE_URL_CHARACTER_PATTERN.test(href)) {
    return invalid(path, expectation);
  }

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return invalid(path, expectation);
  }

  const hostnameLabels = url.hostname.split('.');
  if (
    !protocols.includes(url.protocol)
    || url.hostname.length === 0
    || url.hostname.length > 253
    || (url.hostname !== 'localhost' && !url.hostname.includes('.'))
    || !/[a-z]$/i.test(url.hostname)
    || hostnameLabels.some((label) => !HOST_LABEL_PATTERN.test(label))
    || url.username.length > 0
    || url.password.length > 0
    || (!allowFragment && url.hash.length > 0)
  ) {
    return invalid(path, expectation);
  }
  return url.href;
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

  return {
    type,
    label,
    href: parseSafeAbsoluteUrl(
      href,
      'action.href',
      ['http:', 'https:'],
      true,
      'a safe absolute HTTP(S) URL',
    ),
  };
}

function parseOptionalMetadata(
  value: unknown,
  path: string,
): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }

  const ancestors = new WeakSet<object>();
  const parseJsonValue = (candidate: unknown, candidatePath: string): JsonValue => {
    if (
      candidate === null
      || typeof candidate === 'string'
      || typeof candidate === 'boolean'
    ) {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        return invalid(candidatePath, 'a finite JSON number');
      }
      return candidate;
    }
    if (typeof candidate !== 'object') {
      return invalid(candidatePath, 'a JSON value');
    }
    if (ancestors.has(candidate)) {
      return invalid(candidatePath, 'an acyclic JSON value');
    }

    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return Array.from(candidate, (item, index) =>
          parseJsonValue(item, `${candidatePath}[${index}]`));
      }
      const record = parseRecord(candidate, candidatePath);
      return Object.fromEntries(Object.entries(record).map(([key, item]) => [
        key,
        parseJsonValue(item, `${candidatePath}.${key}`),
      ]));
    } finally {
      ancestors.delete(candidate);
    }
  };

  return parseJsonValue(parseRecord(value, path), path) as JsonObject;
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

/** Validate the persisted per-recipient state at a database boundary. */
export function parseNotificationUserState(value: unknown): NotificationUserState {
  const state = parseRecord(value, 'notificationUserState');
  const inboxEnabled = parseBoolean(
    state.inboxEnabled,
    'notificationUserState.inboxEnabled',
  );
  const pushEnabled = parseBoolean(
    state.pushEnabled,
    'notificationUserState.pushEnabled',
  );
  const readAt = parseNullableTimestamp(state.readAt, 'notificationUserState.readAt');
  const dismissedAt = parseNullableTimestamp(
    state.dismissedAt,
    'notificationUserState.dismissedAt',
  );
  const createdAt = parseISO8601Timestamp(state.createdAt);

  if (!inboxEnabled && !pushEnabled) {
    return invalid('notificationUserState', 'at least one enabled channel');
  }
  if (!inboxEnabled && (readAt !== null || dismissedAt !== null)) {
    return invalid(
      'notificationUserState',
      'no Inbox timestamps when Inbox delivery is disabled',
    );
  }
  if (readAt !== null && readAt < createdAt) {
    return invalid('notificationUserState.readAt', 'a timestamp at or after createdAt');
  }
  if (dismissedAt !== null && dismissedAt < createdAt) {
    return invalid(
      'notificationUserState.dismissedAt',
      'a timestamp at or after createdAt',
    );
  }

  return {
    eventId: parseString(state.eventId, 'notificationUserState.eventId'),
    userId: parseString(state.userId, 'notificationUserState.userId'),
    inboxEnabled,
    pushEnabled,
    readAt,
    dismissedAt,
    createdAt,
  } as NotificationUserState;
}

export function parseNotificationPreferenceChannels(
  value: unknown,
): NotificationPreferenceChannels {
  const channels = parseRecord(value, 'notificationPreferenceChannels');
  return {
    inboxEnabled: parseBoolean(
      channels.inboxEnabled,
      'notificationPreferenceChannels.inboxEnabled',
    ),
    pushEnabled: parseBoolean(
      channels.pushEnabled,
      'notificationPreferenceChannels.pushEnabled',
    ),
  };
}

export function parseNotificationPreference(value: unknown): NotificationPreference {
  const preference = parseRecord(value, 'notificationPreference');
  return {
    ...parseNotificationPreferenceChannels(preference),
    updatedAt: parseISO8601Timestamp(preference.updatedAt),
  };
}

/** Validate and normalize a browser Push API registration payload. */
export function parsePushSubscriptionInput(value: unknown): PushSubscriptionInput {
  const subscription = parseRecord(value, 'pushSubscriptionInput');
  const keys = parseRecord(subscription.keys, 'pushSubscriptionInput.keys');
  return {
    endpoint: parseSafeAbsoluteUrl(
      subscription.endpoint,
      'pushSubscriptionInput.endpoint',
      ['https:'],
      false,
    ),
    expirationTime: parseExpirationTime(
      subscription.expirationTime,
      'pushSubscriptionInput.expirationTime',
    ),
    keys: {
      p256dh: parseBase64Url(keys.p256dh, 'pushSubscriptionInput.keys.p256dh'),
      auth: parseBase64Url(keys.auth, 'pushSubscriptionInput.keys.auth'),
    },
  };
}

/** Validate safe subscription metadata before returning it from an API. */
export function parsePushSubscription(value: unknown): PushSubscription {
  const subscription = parseRecord(value, 'pushSubscription');
  const createdAt = parseISO8601Timestamp(subscription.createdAt);
  const updatedAt = parseISO8601Timestamp(subscription.updatedAt);
  if (updatedAt < createdAt) {
    return invalid('pushSubscription.updatedAt', 'a timestamp at or after createdAt');
  }
  return {
    id: parseString(subscription.id, 'pushSubscription.id'),
    endpoint: parseSafeAbsoluteUrl(
      subscription.endpoint,
      'pushSubscription.endpoint',
      ['https:'],
      false,
    ),
    expiresAt: parseNullableTimestamp(
      subscription.expiresAt,
      'pushSubscription.expiresAt',
    ),
    revokedAt: parseNullableTimestamp(
      subscription.revokedAt,
      'pushSubscription.revokedAt',
    ),
    createdAt,
    updatedAt,
  };
}

/** Validate mutable delivery scheduling state and all status-specific fields. */
export function parsePushDeliveryJob(value: unknown): PushDeliveryJob {
  const job = parseRecord(value, 'pushDeliveryJob');
  const status = parseEnum(job.status, PUSH_DELIVERY_STATUSES, 'pushDeliveryJob.status');
  const attemptCount = parseNonnegativeInteger(
    job.attemptCount,
    'pushDeliveryJob.attemptCount',
  );
  const createdAt = parseISO8601Timestamp(job.createdAt);
  const updatedAt = parseISO8601Timestamp(job.updatedAt);
  if (updatedAt < createdAt) {
    return invalid('pushDeliveryJob.updatedAt', 'a timestamp at or after createdAt');
  }

  const nextRetryAt = parseNullableTimestamp(
    job.nextRetryAt,
    'pushDeliveryJob.nextRetryAt',
  );
  const claimedAt = parseNullableTimestamp(job.claimedAt, 'pushDeliveryJob.claimedAt');
  const leaseExpiresAt = parseNullableTimestamp(
    job.leaseExpiresAt,
    'pushDeliveryJob.leaseExpiresAt',
  );
  const claimToken = parseNullableString(job.claimToken, 'pushDeliveryJob.claimToken');
  const common = {
    id: parseString(job.id, 'pushDeliveryJob.id'),
    deduplicationKey: parseString(
      job.deduplicationKey,
      'pushDeliveryJob.deduplicationKey',
    ),
    eventId: parseString(job.eventId, 'pushDeliveryJob.eventId'),
    userId: parseString(job.userId, 'pushDeliveryJob.userId'),
    subscriptionId: parseString(job.subscriptionId, 'pushDeliveryJob.subscriptionId'),
    attemptCount,
    createdAt,
    updatedAt,
  };

  if (status === 'processing') {
    if (
      nextRetryAt !== null
      || claimToken === null
      || claimedAt === null
      || leaseExpiresAt === null
      || claimedAt < createdAt
      || leaseExpiresAt <= claimedAt
    ) {
      return invalid('pushDeliveryJob', 'valid processing claim and lease fields');
    }
    return {
      ...common,
      status,
      nextRetryAt: null,
      claimToken,
      claimedAt,
      leaseExpiresAt,
    };
  }

  if (claimToken !== null || claimedAt !== null || leaseExpiresAt !== null) {
    return invalid('pushDeliveryJob', 'null claim fields outside processing');
  }
  if (status === 'retryable') {
    if (nextRetryAt === null || attemptCount === 0) {
      return invalid('pushDeliveryJob', 'a retry schedule after at least one attempt');
    }
    return {
      ...common,
      status,
      nextRetryAt,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
    };
  }
  if (nextRetryAt !== null) {
    return invalid('pushDeliveryJob.nextRetryAt', 'null outside retryable');
  }
  if (status === 'pending' && attemptCount !== 0) {
    return invalid('pushDeliveryJob.attemptCount', 'zero while pending');
  }
  if ((status === 'delivered' || status === 'failed') && attemptCount === 0) {
    return invalid(
      'pushDeliveryJob.attemptCount',
      'at least one attempt for a delivered or failed job',
    );
  }
  return {
    ...common,
    status,
    nextRetryAt: null,
    claimToken: null,
    claimedAt: null,
    leaseExpiresAt: null,
  } as PendingPushDeliveryJob | TerminalPushDeliveryJob;
}

/** Validate one append-only delivery audit record. */
export function parsePushDeliveryAttempt(value: unknown): PushDeliveryAttempt {
  const attempt = parseRecord(value, 'pushDeliveryAttempt');
  const status = parseEnum(
    attempt.status,
    PUSH_DELIVERY_ATTEMPT_STATUSES,
    'pushDeliveryAttempt.status',
  );
  const attemptedAt = parseISO8601Timestamp(attempt.attemptedAt);
  const createdAt = parseISO8601Timestamp(attempt.createdAt);
  if (createdAt < attemptedAt) {
    return invalid('pushDeliveryAttempt.createdAt', 'a timestamp at or after attemptedAt');
  }
  const nextRetryAt = parseNullableTimestamp(
    attempt.nextRetryAt,
    'pushDeliveryAttempt.nextRetryAt',
  );
  const responseStatus = parseResponseStatus(
    attempt.responseStatus,
    'pushDeliveryAttempt.responseStatus',
  );
  const errorCode = parseNullableString(
    attempt.errorCode,
    'pushDeliveryAttempt.errorCode',
  );
  const errorMessage = parseNullableString(
    attempt.errorMessage,
    'pushDeliveryAttempt.errorMessage',
    true,
  );
  const common = {
    id: parseString(attempt.id, 'pushDeliveryAttempt.id'),
    jobId: parseString(attempt.jobId, 'pushDeliveryAttempt.jobId'),
    attemptNumber: parsePositiveInteger(
      attempt.attemptNumber,
      'pushDeliveryAttempt.attemptNumber',
    ),
    claimToken: parseString(attempt.claimToken, 'pushDeliveryAttempt.claimToken'),
    attemptedAt,
    createdAt,
  };

  if (status === 'delivered') {
    if (
      responseStatus === null
      || errorCode !== null
      || errorMessage !== null
      || nextRetryAt !== null
    ) {
      return invalid('pushDeliveryAttempt', 'a successful delivered outcome');
    }
    return { ...common, status, nextRetryAt: null, responseStatus, errorCode: null, errorMessage: null };
  }

  if (responseStatus === null && errorCode === null) {
    return invalid('pushDeliveryAttempt', 'a response status or non-empty error code');
  }
  if (status === 'retryable') {
    if (nextRetryAt === null || nextRetryAt <= attemptedAt) {
      return invalid('pushDeliveryAttempt.nextRetryAt', 'a timestamp after attemptedAt');
    }
    return {
      ...common,
      status,
      nextRetryAt,
      responseStatus,
      errorCode,
      errorMessage,
    } as RetryablePushDeliveryAttempt;
  }
  if (nextRetryAt !== null) {
    return invalid('pushDeliveryAttempt.nextRetryAt', 'null for a failed outcome');
  }
  return {
    ...common,
    status,
    nextRetryAt: null,
    responseStatus,
    errorCode,
    errorMessage,
  } as FailedPushDeliveryAttempt;
}

/** Validate a source heartbeat or terminal activity snapshot. */
export function parseNotificationSourceActivity(
  value: unknown,
): NotificationSourceActivity {
  const activity = parseRecord(value, 'notificationSourceActivity');
  const status = parseEnum(
    activity.status,
    NOTIFICATION_SOURCE_ACTIVITY_STATUSES,
    'notificationSourceActivity.status',
  );
  const lastActivityAt = parseISO8601Timestamp(activity.lastActivityAt);
  const completedAt = parseNullableTimestamp(
    activity.completedAt,
    'notificationSourceActivity.completedAt',
  );
  const terminal = ['completed', 'failed', 'cancelled'].includes(status);
  if (terminal !== (completedAt !== null)) {
    return invalid(
      'notificationSourceActivity.completedAt',
      terminal ? 'a terminal timestamp' : 'null for active work',
    );
  }
  if (completedAt !== null && completedAt < lastActivityAt) {
    return invalid(
      'notificationSourceActivity.completedAt',
      'a timestamp at or after lastActivityAt',
    );
  }
  const createdAt = parseISO8601Timestamp(activity.createdAt);
  const updatedAt = parseISO8601Timestamp(activity.updatedAt);
  if (updatedAt < createdAt) {
    return invalid('notificationSourceActivity.updatedAt', 'a timestamp at or after createdAt');
  }
  const branch = parseOptionalString(activity.branch, 'notificationSourceActivity.branch');
  const metadata = parseOptionalMetadata(
    activity.metadata,
    'notificationSourceActivity.metadata',
  );
  return {
    type: parseEnum(
      activity.type,
      NOTIFICATION_SOURCE_ACTIVITY_TYPES,
      'notificationSourceActivity.type',
    ),
    key: parseString(activity.key, 'notificationSourceActivity.key'),
    repository: parseRepository(
      activity.repository,
      'notificationSourceActivity.repository',
    ),
    ...(branch === undefined ? {} : { branch }),
    status,
    lastActivityAt,
    completedAt,
    ...(metadata === undefined ? {} : { metadata }),
    createdAt,
    updatedAt,
  } as NotificationSourceActivity;
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

export function parsePushSubscriptionsResponse(
  value: unknown,
): PushSubscriptionsResponse {
  const response = parseRecord(value, 'pushSubscriptionsResponse');
  if (!Array.isArray(response.subscriptions)) {
    return invalid('pushSubscriptionsResponse.subscriptions', 'an array');
  }
  return { subscriptions: response.subscriptions.map(parsePushSubscription) };
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
export const notificationUserStateSchema: RuntimeSchema<NotificationUserState> = {
  parse: parseNotificationUserState,
};
export const notificationPreferenceChannelsSchema:
  RuntimeSchema<NotificationPreferenceChannels> = {
  parse: parseNotificationPreferenceChannels,
};
export const notificationPreferenceSchema: RuntimeSchema<NotificationPreference> = {
  parse: parseNotificationPreference,
};
export const notificationPreferencesSchema: RuntimeSchema<NotificationPreferences> = {
  parse: parseNotificationPreferences,
};
export const pushSubscriptionInputSchema: RuntimeSchema<PushSubscriptionInput> = {
  parse: parsePushSubscriptionInput,
};
export const pushSubscriptionSchema: RuntimeSchema<PushSubscription> = {
  parse: parsePushSubscription,
};
export const pushDeliveryJobSchema: RuntimeSchema<PushDeliveryJob> = {
  parse: parsePushDeliveryJob,
};
export const pushDeliveryAttemptSchema: RuntimeSchema<PushDeliveryAttempt> = {
  parse: parsePushDeliveryAttempt,
};
export const notificationSourceActivitySchema:
  RuntimeSchema<NotificationSourceActivity> = {
  parse: parseNotificationSourceActivity,
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
export const pushSubscriptionsResponseSchema: RuntimeSchema<PushSubscriptionsResponse> = {
  parse: parsePushSubscriptionsResponse,
};
