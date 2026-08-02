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

/** Largest epoch-millisecond value representable by the fixed-width contract. */
export const MAX_CANONICAL_TIMESTAMP_EPOCH_MS = 253_402_300_799_999;

/**
 * Push-service hosts that notification workers may contact.
 *
 * The supported endpoint families are FCM (Chromium-family browsers), Mozilla
 * Autopush (Firefox), and Apple Web Push (Safari, via the suffix list below).
 * Other browser or vendor endpoints are intentionally unsupported until both
 * this contract and the persisted SQLite allowlist are expanded.
 *
 * Delivery clients must also disable redirects. Keeping this list exact makes
 * a stored subscription safe to use without performing requests to arbitrary
 * user-selected hosts or relying on DNS results captured at registration time.
 * Changing either list requires a schema migration for existing databases;
 * changing this TypeScript constant alone does not update their CHECK clauses.
 */
export const WEB_PUSH_ENDPOINT_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
] as const;

/** Vendor-controlled suffixes explicitly documented for Web Push delivery. */
export const WEB_PUSH_ENDPOINT_HOST_SUFFIXES = ['.push.apple.com'] as const;

/** UTF-8 byte and structural limits shared by API and persistence boundaries. */
export const NOTIFICATION_PAYLOAD_LIMITS = {
  identifierBytes: 255,
  deduplicationKeyBytes: 512,
  repositoryBytes: 255,
  titleBytes: 256,
  bodyBytes: 4_096,
  actionLabelBytes: 128,
  urlBytes: 2_048,
  userAgentBytes: 512,
  errorCodeBytes: 128,
  errorMessageBytes: 2_048,
  metadataBytes: 16_384,
  metadataDepth: 16,
  metadataNodes: 256,
} as const;

/** Normalize a Date-compatible value before writing it to the database. */
export function normalizeISO8601Timestamp(
  value: string | number | Date,
): ISO8601Timestamp {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('Expected a valid timestamp');
  }

  const normalized = date.toISOString();
  if (!CANONICAL_ISO8601_PATTERN.test(normalized)) {
    throw new TypeError('Expected a timestamp in the four-digit-year range');
  }

  return normalized as ISO8601Timestamp;
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

/**
 * A stable destination that every notification client can interpret.
 * Target objects are closed contracts; use event metadata for extensions.
 */
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

/** A closed, user-visible action contract with exhaustive type discrimination. */
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
  /** Recipient assignment time; ordering uses the immutable event occurrence. */
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

/** Defaults used until an authenticated user explicitly changes a category. */
export const DEFAULT_NOTIFICATION_PREFERENCE_CHANNELS:
  Readonly<NotificationPreferenceChannels> = Object.freeze({
  inboxEnabled: true,
  pushEnabled: false,
});

/** One entry in a complete preference snapshot; null until a default is persisted. */
export interface NotificationPreference extends NotificationPreferenceChannels {
  updatedAt: ISO8601Timestamp | null;
}

/** A complete preference snapshot keyed by every durable notification kind. */
export type NotificationPreferences = Record<
  NotificationKind,
  NotificationPreference
>;

/**
 * User-local quiet-hours policy persisted for a future Web Push dispatcher. A
 * null boundary disables the policy; the timezone is retained so enabling it
 * later does not require guessing. The current notification API is storage-only
 * and does not send or suppress Web Push requests.
 */
export interface NotificationQuietHours {
  start: string | null;
  end: string | null;
  timezone: string;
}

export const DEFAULT_NOTIFICATION_QUIET_HOURS:
  Readonly<NotificationQuietHours> = Object.freeze({
  start: null,
  end: null,
  timezone: 'UTC',
});

export type NotificationPreferencePatch = Partial<NotificationPreferenceChannels>;

/** A sparse category map; omitted categories and channels remain unchanged. */
export type NotificationPreferencesPatch = Partial<Record<
  NotificationKind,
  NotificationPreferencePatch
>>;

/** Sparse authenticated-user update accepted by the preferences API. */
export interface NotificationPreferencesUpdate {
  preferences?: NotificationPreferencesPatch;
  quietHours?: Partial<NotificationQuietHours>;
}

/** The encryption keys supplied by the browser Push API. */
export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

/**
 * Browser payload accepted when registering or refreshing a subscription.
 * Refreshes replace the mutable encryption material for the same endpoint.
 */
export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: PushSubscriptionKeys;
}

export interface PushSubscriptionValidationOptions {
  /** Allow HTTP only for loopback hosts used by local browser development. */
  allowInsecureLocalhost?: boolean;
}

/** Alias matching Web Push terminology used by non-browser backend consumers. */
export type WebPushSubscription = PushSubscriptionInput;

/** Safe subscription metadata returned by the API (encryption keys are omitted). */
export interface PushSubscription {
  id: string;
  endpoint: string;
  expiresAt: ISO8601Timestamp | null;
  /**
   * Revocation is best-effort for a delivery whose live lease already loaded
   * key material. Dispatchers must re-read this state immediately before send.
   */
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
  /** Successful HTTP response status in the inclusive 200-299 range. */
  responseStatus: number;
  errorCode: null;
  errorMessage: null;
}

type PushDeliveryFailureDetails =
  | {
    /** Non-successful HTTP response status outside the 200-299 range. */
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

/** Latest known activity fields shared by task and indexing operations. */
interface NotificationSourceActivityFields {
  /** Task ID, or a stable repository/branch key for indexing. */
  key: string;
  repository: string;
  lastActivityAt: ISO8601Timestamp;
  metadata?: JsonObject;
  createdAt: ISO8601Timestamp;
  updatedAt: ISO8601Timestamp;
}

type NotificationSourceActivityState =
  | {
    status: 'queued' | 'processing';
    completedAt: null;
  }
  | {
    status: 'completed' | 'failed' | 'cancelled';
    completedAt: ISO8601Timestamp;
  };

export type TaskNotificationSourceActivity = NotificationSourceActivityFields &
  NotificationSourceActivityState & {
    type: 'task';
    /** Branches belong only to indexing activity. */
    branch?: never;
  };

export type IndexingNotificationSourceActivity = NotificationSourceActivityFields &
  NotificationSourceActivityState & {
    type: 'indexing';
    /** Present when indexing is scoped to one branch. */
    branch?: string;
  };

export type NotificationSourceActivity =
  | TaskNotificationSourceActivity
  | IndexingNotificationSourceActivity;

/**
 * Cursor-paginated Inbox response ordered by event occurrence time, then event
 * ID, both descending. The cursor remains opaque to API consumers.
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
  quietHours: NotificationQuietHours;
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

function assertOnlyKnownProperties(
  value: Record<string, unknown>,
  allowedProperties: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedProperties);
  const unknownProperty = Object.keys(value).find((property) => !allowed.has(property));
  if (unknownProperty !== undefined) {
    invalid(`${path}.${unknownProperty}`, 'a known property');
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseString(
  value: unknown,
  path: string,
  allowEmpty = false,
  maxBytes: number = NOTIFICATION_PAYLOAD_LIMITS.identifierBytes,
): string {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.trim().length === 0)
    || utf8ByteLength(value) > maxBytes
  ) {
    return invalid(
      path,
      `${allowEmpty ? 'a string' : 'a non-empty string'} no larger than ${maxBytes} UTF-8 bytes`,
    );
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
  maxBytes: number = NOTIFICATION_PAYLOAD_LIMITS.identifierBytes,
): string | null {
  return value === null ? null : parseString(value, path, allowEmpty, maxBytes);
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
  const repository = parseString(
    value,
    path,
    false,
    NOTIFICATION_PAYLOAD_LIMITS.repositoryBytes,
  );
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
    || (value as number) > MAX_CANONICAL_TIMESTAMP_EPOCH_MS
  ) {
    return invalid(
      path,
      'an epoch-millisecond number in the canonical four-digit-year range or null',
    );
  }
  return value as number;
}

function parseBase64Url(
  value: unknown,
  path: string,
  expectedBytes: number,
  expectedFirstByte?: number,
): string {
  const encoded = parseString(value, path, false, 128);
  const unpadded = encoded.replace(/=+$/, '');
  const expectedUnpaddedLength = Math.ceil(expectedBytes * 8 / 6);
  const expectedPaddingLength = (3 - (expectedBytes % 3)) % 3;
  const paddingLength = encoded.length - unpadded.length;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const unusedTrailingBits = (unpadded.length * 6) % 8;
  const trailingValue = alphabet.indexOf(unpadded.at(-1) ?? '');
  const firstByte = unpadded.length < 2
    ? -1
    : (alphabet.indexOf(unpadded[0] ?? '') << 2)
      | (alphabet.indexOf(unpadded[1] ?? '') >> 4);
  if (
    !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)
    || unpadded.length !== expectedUnpaddedLength
    || (paddingLength !== 0 && paddingLength !== expectedPaddingLength)
    || (paddingLength !== 0 && encoded.length % 4 !== 0)
    || (unusedTrailingBits > 0
      && (trailingValue & ((1 << unusedTrailingBits) - 1)) !== 0)
    || (expectedFirstByte !== undefined && firstByte !== expectedFirstByte)
  ) {
    return invalid(path, `a ${expectedBytes}-byte base64url-encoded value`);
  }
  return encoded;
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const P256_FIELD_PRIME =
  0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_CURVE_B =
  0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function decodeBase64Url(encoded: string): Uint8Array {
  const bytes: number[] = [];
  let accumulator = 0;
  let availableBits = 0;
  for (const character of encoded.replace(/=+$/, '')) {
    accumulator = (accumulator << 6) | BASE64URL_ALPHABET.indexOf(character);
    availableBits += 6;
    if (availableBits >= 8) {
      availableBits -= 8;
      bytes.push((accumulator >> availableBits) & 0xff);
      accumulator &= (1 << availableBits) - 1;
    }
  }
  return Uint8Array.from(bytes);
}

function unsignedBigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Verify that an uncompressed SEC1 point is a member of the P-256 curve. */
function isP256PublicPoint(encoded: string): boolean {
  const point = decodeBase64Url(encoded);
  if (point.length !== 65 || point[0] !== 0x04) return false;

  const x = unsignedBigEndian(point.subarray(1, 33));
  const y = unsignedBigEndian(point.subarray(33));
  if (x >= P256_FIELD_PRIME || y >= P256_FIELD_PRIME) return false;

  const ySquared = (y * y) % P256_FIELD_PRIME;
  const xCubed = (x * x % P256_FIELD_PRIME) * x % P256_FIELD_PRIME;
  const curveValue = (
    xCubed - 3n * x + P256_CURVE_B + 3n * P256_FIELD_PRIME
  ) % P256_FIELD_PRIME;
  return ySquared === curveValue;
}

const UNSAFE_URL_CHARACTER_PATTERN = /[\\\u0000-\u001f\u007f]/;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const WEB_PUSH_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

function parseSafeAbsoluteUrl(
  value: unknown,
  path: string,
  protocols: readonly string[],
  allowFragment = true,
  expectation = `a safe absolute ${protocols.join(' or ')} URL`,
  allowedHosts?: readonly string[],
  allowedHostSuffixes?: readonly string[],
  defaultHttpsPortOnly = false,
): string {
  const href = parseString(
    value,
    path,
    false,
    NOTIFICATION_PAYLOAD_LIMITS.urlBytes,
  );
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
    // URL.hash is empty for both "no fragment" and a trailing empty `#`.
    // Inspect the original input so runtime validation stays aligned with SQL.
    || (!allowFragment && href.includes('#'))
    || (
      allowedHosts !== undefined
      && !allowedHosts.includes(url.hostname.toLowerCase())
      && !(allowedHostSuffixes ?? []).some((suffix) =>
        url.hostname.length > suffix.length
          && url.hostname.toLowerCase().endsWith(suffix))
    )
    || (defaultHttpsPortOnly && url.port.length > 0)
  ) {
    return invalid(path, expectation);
  }
  return url.href;
}

/**
 * Validate a browser push endpoint without widening the delivery-host
 * allowlist. Local loopback URLs are accepted only when the caller explicitly
 * opts into development behavior.
 */
export function parsePushSubscriptionEndpoint(
  value: unknown,
  options: PushSubscriptionValidationOptions = {},
): string {
  const path = 'pushSubscriptionInput.endpoint';
  const expectation = 'a safe HTTPS browser push endpoint URL';
  const href = parseString(
    value,
    path,
    false,
    NOTIFICATION_PAYLOAD_LIMITS.urlBytes,
  );
  if (UNSAFE_URL_CHARACTER_PATTERN.test(href)) {
    return invalid(path, expectation);
  }

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return invalid(path, expectation);
  }

  const loopback = WEB_PUSH_LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (loopback) {
    if (
      !options.allowInsecureLocalhost
      || (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username.length > 0
      || url.password.length > 0
      || href.includes('#')
    ) {
      return invalid(path, expectation);
    }
    return url.href;
  }

  return parseSafeAbsoluteUrl(
    href,
    path,
    ['https:'],
    false,
    expectation,
    WEB_PUSH_ENDPOINT_HOSTS,
    WEB_PUSH_ENDPOINT_HOST_SUFFIXES,
    true,
  );
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
      assertOnlyKnownProperties(target, ['type', 'repository', 'draftId'], 'target');
      return {
        type,
        repository: parseRepository(target.repository, 'target.repository'),
        draftId: parseString(target.draftId, 'target.draftId'),
      };
    case 'task': {
      assertOnlyKnownProperties(
        target,
        ['type', 'repository', 'taskId', 'issueNumber', 'prNumber'],
        'target',
      );
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
      assertOnlyKnownProperties(
        target,
        ['type', 'repository', 'prNumber', 'taskId'],
        'target',
      );
      const taskId = parseOptionalString(target.taskId, 'target.taskId');
      return {
        type,
        repository: parseRepository(target.repository, 'target.repository'),
        prNumber: parsePositiveInteger(target.prNumber, 'target.prNumber'),
        ...(taskId === undefined ? {} : { taskId }),
      };
    }
    case 'pull_request':
      assertOnlyKnownProperties(target, ['type', 'repository', 'prNumber'], 'target');
      return {
        type,
        repository: parseRepository(target.repository, 'target.repository'),
        prNumber: parsePositiveInteger(target.prNumber, 'target.prNumber'),
      };
    case 'indexing': {
      assertOnlyKnownProperties(target, ['type', 'repository', 'branch'], 'target');
      const branch = parseOptionalString(target.branch, 'target.branch');
      return {
        type,
        repository: parseRepository(target.repository, 'target.repository'),
        ...(branch === undefined ? {} : { branch }),
      };
    }
    case 'system_failure': {
      assertOnlyKnownProperties(
        target,
        ['type', 'component', 'correlationId'],
        'target',
      );
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
  assertOnlyKnownProperties(action, ['type', 'label', 'href'], 'action');
  const label = parseString(
    action.label,
    'action.label',
    false,
    NOTIFICATION_PAYLOAD_LIMITS.actionLabelBytes,
  );
  const href = parseString(
    action.href,
    'action.href',
    false,
    NOTIFICATION_PAYLOAD_LIMITS.urlBytes,
  );

  if (type === 'navigate') {
    if (
      !href.startsWith('/')
      || href.startsWith('//')
      || UNSAFE_URL_CHARACTER_PATTERN.test(href)
    ) {
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
  let nodeCount = 0;
  const parseJsonValue = (
    candidate: unknown,
    candidatePath: string,
    depth: number,
  ): JsonValue => {
    nodeCount += 1;
    if (nodeCount > NOTIFICATION_PAYLOAD_LIMITS.metadataNodes) {
      return invalid(
        path,
        `JSON metadata with at most ${NOTIFICATION_PAYLOAD_LIMITS.metadataNodes} nodes`,
      );
    }
    if (depth > NOTIFICATION_PAYLOAD_LIMITS.metadataDepth) {
      return invalid(
        candidatePath,
        `JSON metadata nested at most ${NOTIFICATION_PAYLOAD_LIMITS.metadataDepth} levels`,
      );
    }
    if (
      candidate === null
      || typeof candidate === 'boolean'
    ) {
      return candidate;
    }
    if (typeof candidate === 'string') {
      if (utf8ByteLength(candidate) > NOTIFICATION_PAYLOAD_LIMITS.metadataBytes) {
        return invalid(candidatePath, 'a bounded JSON string');
      }
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
        if (
          candidate.length
            > NOTIFICATION_PAYLOAD_LIMITS.metadataNodes - nodeCount
        ) {
          return invalid(
            candidatePath,
            `a JSON array within the ${NOTIFICATION_PAYLOAD_LIMITS.metadataNodes}-node limit`,
          );
        }
        const parsedItems: JsonValue[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          parsedItems.push(parseJsonValue(
            candidate[index],
            `${candidatePath}[${index}]`,
            depth + 1,
          ));
        }
        return parsedItems;
      }
      const record = parseRecord(candidate, candidatePath);
      const parsedEntries: Array<[string, JsonValue]> = [];
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
          continue;
        }
        if (utf8ByteLength(key) > NOTIFICATION_PAYLOAD_LIMITS.metadataBytes) {
          return invalid(`${candidatePath}.${key}`, 'a bounded JSON object key');
        }
        parsedEntries.push([
          key,
          parseJsonValue(record[key], `${candidatePath}.${key}`, depth + 1),
        ]);
      }
      return Object.fromEntries(parsedEntries);
    } finally {
      ancestors.delete(candidate);
    }
  };

  const parsed = parseJsonValue(parseRecord(value, path), path, 0) as JsonObject;
  const serialized = JSON.stringify(parsed);
  if (utf8ByteLength(serialized) > NOTIFICATION_PAYLOAD_LIMITS.metadataBytes) {
    return invalid(
      path,
      `JSON metadata no larger than ${NOTIFICATION_PAYLOAD_LIMITS.metadataBytes} UTF-8 bytes`,
    );
  }
  return parsed;
}

/** Validate and sanitize the immutable payload before insertion or serialization. */
export function parseNotificationEvent(value: unknown): NotificationEvent {
  const event = parseRecord(value, 'notificationEvent');
  const kind = parseEnum(event.kind, NOTIFICATION_KINDS, 'notificationEvent.kind');
  const action = event.action === undefined
    ? undefined
    : parseNotificationAction(event.action);
  const metadata = parseOptionalMetadata(event.metadata, 'notificationEvent.metadata');

  const occurredAt = parseISO8601Timestamp(event.occurredAt);
  const createdAt = parseISO8601Timestamp(event.createdAt);
  if (createdAt < occurredAt) {
    return invalid(
      'notificationEvent.createdAt',
      'a timestamp at or after occurredAt',
    );
  }

  return {
    id: parseString(event.id, 'notificationEvent.id'),
    deduplicationKey: parseString(
      event.deduplicationKey,
      'notificationEvent.deduplicationKey',
      false,
      NOTIFICATION_PAYLOAD_LIMITS.deduplicationKeyBytes,
    ),
    kind,
    severity: parseEnum(
      event.severity,
      NOTIFICATION_SEVERITIES,
      'notificationEvent.severity',
    ),
    target: parseNotificationTarget(event.target, kind),
    title: parseString(
      event.title,
      'notificationEvent.title',
      false,
      NOTIFICATION_PAYLOAD_LIMITS.titleBytes,
    ),
    body: parseString(
      event.body,
      'notificationEvent.body',
      true,
      NOTIFICATION_PAYLOAD_LIMITS.bodyBytes,
    ),
    ...(action === undefined ? {} : { action }),
    ...(metadata === undefined ? {} : { metadata }),
    occurredAt,
    createdAt,
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
  if (readAt !== null && readAt < event.createdAt) {
    return invalid('notification.readAt', 'a timestamp at or after event createdAt');
  }
  if (dismissedAt !== null && dismissedAt < event.createdAt) {
    return invalid('notification.dismissedAt', 'a timestamp at or after event createdAt');
  }
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
    updatedAt: preference.updatedAt === null
      ? null
      : parseISO8601Timestamp(preference.updatedAt),
  };
}

export function parseIanaTimezone(value: unknown, path = 'timezone'): string {
  const timezone = parseString(value, path);
  if (timezone !== timezone.trim()) {
    return invalid(path, 'an IANA timezone identifier');
  }
  try {
    // Intl uses the runtime's IANA tz database and rejects numeric offsets and
    // arbitrary labels. Preserve aliases rather than silently rewriting user data.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    return invalid(path, 'an IANA timezone identifier');
  }
  return timezone;
}

export function parseQuietHour(value: unknown, path = 'quietHour'): string {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return invalid(path, 'a time in HH:mm format');
  }
  return value;
}

function parseNullableQuietHour(value: unknown, path: string): string | null {
  return value === null ? null : parseQuietHour(value, path);
}

export function parseNotificationQuietHours(value: unknown): NotificationQuietHours {
  const quietHours = parseRecord(value, 'notificationQuietHours');
  assertOnlyKnownProperties(
    quietHours,
    ['start', 'end', 'timezone'],
    'notificationQuietHours',
  );
  return {
    start: parseNullableQuietHour(quietHours.start, 'notificationQuietHours.start'),
    end: parseNullableQuietHour(quietHours.end, 'notificationQuietHours.end'),
    timezone: parseIanaTimezone(
      quietHours.timezone,
      'notificationQuietHours.timezone',
    ),
  };
}

/** Validate a sparse update without manufacturing values for omitted fields. */
export function parseNotificationPreferencesUpdate(
  value: unknown,
): NotificationPreferencesUpdate {
  const update = parseRecord(value, 'notificationPreferencesUpdate');
  assertOnlyKnownProperties(
    update,
    ['preferences', 'quietHours'],
    'notificationPreferencesUpdate',
  );
  if (update.preferences === undefined && update.quietHours === undefined) {
    return invalid(
      'notificationPreferencesUpdate',
      'at least one preferences or quietHours update',
    );
  }

  let preferences: NotificationPreferencesPatch | undefined;
  if (update.preferences !== undefined) {
    const preferenceUpdates = parseRecord(
      update.preferences,
      'notificationPreferencesUpdate.preferences',
    );
    if (Object.keys(preferenceUpdates).length === 0) {
      return invalid(
        'notificationPreferencesUpdate.preferences',
        'at least one notification category',
      );
    }
    const allowedKinds = new Set<string>(NOTIFICATION_KINDS);
    const parsedEntries = Object.entries(preferenceUpdates).map(([kind, candidate]) => {
      if (!allowedKinds.has(kind)) {
        return invalid(
          `notificationPreferencesUpdate.preferences.${kind}`,
          `one of ${NOTIFICATION_KINDS.join(', ')}`,
        );
      }
      const channels = parseRecord(
        candidate,
        `notificationPreferencesUpdate.preferences.${kind}`,
      );
      assertOnlyKnownProperties(
        channels,
        ['inboxEnabled', 'pushEnabled'],
        `notificationPreferencesUpdate.preferences.${kind}`,
      );
      if (channels.inboxEnabled === undefined && channels.pushEnabled === undefined) {
        return invalid(
          `notificationPreferencesUpdate.preferences.${kind}`,
          'at least one channel update',
        );
      }
      return [kind, {
        ...(channels.inboxEnabled === undefined
          ? {}
          : { inboxEnabled: parseBoolean(
            channels.inboxEnabled,
            `notificationPreferencesUpdate.preferences.${kind}.inboxEnabled`,
          ) }),
        ...(channels.pushEnabled === undefined
          ? {}
          : { pushEnabled: parseBoolean(
            channels.pushEnabled,
            `notificationPreferencesUpdate.preferences.${kind}.pushEnabled`,
          ) }),
      }] as const;
    });
    preferences = Object.fromEntries(parsedEntries) as NotificationPreferencesPatch;
  }

  let quietHours: Partial<NotificationQuietHours> | undefined;
  if (update.quietHours !== undefined) {
    const quietHoursUpdate = parseRecord(
      update.quietHours,
      'notificationPreferencesUpdate.quietHours',
    );
    assertOnlyKnownProperties(
      quietHoursUpdate,
      ['start', 'end', 'timezone'],
      'notificationPreferencesUpdate.quietHours',
    );
    if (Object.keys(quietHoursUpdate).length === 0) {
      return invalid(
        'notificationPreferencesUpdate.quietHours',
        'at least one quiet-hour update',
      );
    }
    quietHours = {
      ...(quietHoursUpdate.start === undefined
        ? {}
        : { start: parseNullableQuietHour(
          quietHoursUpdate.start,
          'notificationPreferencesUpdate.quietHours.start',
        ) }),
      ...(quietHoursUpdate.end === undefined
        ? {}
        : { end: parseNullableQuietHour(
          quietHoursUpdate.end,
          'notificationPreferencesUpdate.quietHours.end',
        ) }),
      ...(quietHoursUpdate.timezone === undefined
        ? {}
        : { timezone: parseIanaTimezone(
          quietHoursUpdate.timezone,
          'notificationPreferencesUpdate.quietHours.timezone',
        ) }),
    };
  }

  return {
    ...(preferences === undefined ? {} : { preferences }),
    ...(quietHours === undefined ? {} : { quietHours }),
  };
}

/** Validate and normalize a browser Push API registration payload. */
export function parsePushSubscriptionInput(
  value: unknown,
  options: PushSubscriptionValidationOptions = {},
): PushSubscriptionInput {
  const subscription = parseRecord(value, 'pushSubscriptionInput');
  assertOnlyKnownProperties(
    subscription,
    ['endpoint', 'expirationTime', 'keys'],
    'pushSubscriptionInput',
  );
  const keys = parseRecord(subscription.keys, 'pushSubscriptionInput.keys');
  assertOnlyKnownProperties(keys, ['p256dh', 'auth'], 'pushSubscriptionInput.keys');
  const p256dh = parseBase64Url(
    keys.p256dh,
    'pushSubscriptionInput.keys.p256dh',
    65,
    0x04,
  );
  if (!isP256PublicPoint(p256dh)) {
    return invalid(
      'pushSubscriptionInput.keys.p256dh',
      'an uncompressed point on the P-256 curve',
    );
  }
  return {
    endpoint: parsePushSubscriptionEndpoint(subscription.endpoint, options),
    expirationTime: parseExpirationTime(
      subscription.expirationTime,
      'pushSubscriptionInput.expirationTime',
    ),
    keys: {
      p256dh,
      auth: parseBase64Url(keys.auth, 'pushSubscriptionInput.keys.auth', 16),
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
  const expiresAt = parseNullableTimestamp(
    subscription.expiresAt,
    'pushSubscription.expiresAt',
  );
  const revokedAt = parseNullableTimestamp(
    subscription.revokedAt,
    'pushSubscription.revokedAt',
  );
  if (expiresAt !== null && expiresAt < createdAt) {
    return invalid('pushSubscription.expiresAt', 'a timestamp at or after createdAt');
  }
  if (revokedAt !== null && (revokedAt < createdAt || revokedAt > updatedAt)) {
    return invalid(
      'pushSubscription.revokedAt',
      'a timestamp between createdAt and updatedAt',
    );
  }
  return {
    id: parseString(subscription.id, 'pushSubscription.id'),
    endpoint: parsePushSubscriptionEndpoint(subscription.endpoint, {
      allowInsecureLocalhost: true,
    }),
    expiresAt,
    revokedAt,
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
      false,
      NOTIFICATION_PAYLOAD_LIMITS.deduplicationKeyBytes,
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
    false,
    NOTIFICATION_PAYLOAD_LIMITS.errorCodeBytes,
  );
  const errorMessage = parseNullableString(
    attempt.errorMessage,
    'pushDeliveryAttempt.errorMessage',
    true,
    NOTIFICATION_PAYLOAD_LIMITS.errorMessageBytes,
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
      || responseStatus < 200
      || responseStatus > 299
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
  if (responseStatus !== null && responseStatus >= 200 && responseStatus <= 299) {
    return invalid(
      'pushDeliveryAttempt.responseStatus',
      'a non-2xx HTTP status for a retryable or failed outcome',
    );
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
  if (lastActivityAt < createdAt || lastActivityAt > updatedAt) {
    return invalid(
      'notificationSourceActivity.lastActivityAt',
      'a timestamp between createdAt and updatedAt',
    );
  }
  if (completedAt !== null && completedAt > updatedAt) {
    return invalid(
      'notificationSourceActivity.completedAt',
      'a timestamp at or before updatedAt',
    );
  }
  const type = parseEnum(
    activity.type,
    NOTIFICATION_SOURCE_ACTIVITY_TYPES,
    'notificationSourceActivity.type',
  );
  const branch = parseOptionalString(activity.branch, 'notificationSourceActivity.branch');
  if (type === 'task' && branch !== undefined) {
    return invalid(
      'notificationSourceActivity.branch',
      'an indexing-only field',
    );
  }
  const metadata = parseOptionalMetadata(
    activity.metadata,
    'notificationSourceActivity.metadata',
  );
  return {
    type,
    key: parseString(activity.key, 'notificationSourceActivity.key'),
    repository: parseRepository(
      activity.repository,
      'notificationSourceActivity.repository',
    ),
    ...(type === 'indexing' && branch !== undefined ? { branch } : {}),
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
      updatedAt: preference.updatedAt === null
        ? null
        : parseISO8601Timestamp(preference.updatedAt),
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
    quietHours: response.quietHours === undefined
      ? { ...DEFAULT_NOTIFICATION_QUIET_HOURS }
      : parseNotificationQuietHours(response.quietHours),
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
export const notificationQuietHoursSchema: RuntimeSchema<NotificationQuietHours> = {
  parse: parseNotificationQuietHours,
};
export const notificationPreferencesUpdateSchema:
RuntimeSchema<NotificationPreferencesUpdate> = {
  parse: parseNotificationPreferencesUpdate,
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
