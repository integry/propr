/**
 * The general activity push surface.
 *
 * The dashboard, the header, the inbox and a planned dashboard summary widget
 * all need to know 'something relevant changed'. Rather than one event per
 * widget, one envelope describes WHAT changed (domain), HOW it changed
 * (change), and WHERE (repository) - so a new consumer declares its interest
 * instead of requiring a new event name end to end.
 */

/** General 'something happened' envelope, derived in the API broadcast layer. */
export const ACTIVITY_UPDATE = 'activity:update';

/** Goal lifecycle transition, published where the transition is persisted. */
export const GOAL_UPDATE = 'goal:update';

/** Notification created / read / dismissed, scoped to its recipients. */
export const NOTIFICATION_UPDATE = 'notification:update';

/** Agent usage (capacity/quota) changed; a bare trigger, never a snapshot. */
export const USAGE_UPDATE = 'usage:update';

/** The record kinds that can produce activity. Additive: append, never reorder. */
export const ACTIVITY_DOMAINS = [
  'task',
  'goal',
  'plan',
  'notification',
  'queue',
  'indexing',
  'usage',
] as const;
export type ActivityDomain = (typeof ACTIVITY_DOMAINS)[number];

/**
 * What happened to the record. `blocked` is first-class rather than being
 * inferred from a state string, because 'a human must act' is exactly the
 * signal the attention panel exists to show and the one a consumer most wants
 * to react to immediately.
 */
export const ACTIVITY_CHANGES = [
  'created',
  'started',
  'progressed',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'read',
  'dismissed',
  'dismissed_all',
] as const;
export type ActivityChange = (typeof ACTIVITY_CHANGES)[number];

/**
 * Changes that end a unit of work, plus the dismissal that ends a card's life.
 * The summary feature regenerates on these.
 */
const TERMINAL_CHANGES = new Set<ActivityChange>([
  'completed',
  'failed',
  'cancelled',
  'dismissed',
]);

export const isTerminalActivityChange = (change: ActivityChange): boolean =>
  TERMINAL_CHANGES.has(change);

export interface ActivityUpdatePayload {
  eventType: typeof ACTIVITY_UPDATE;
  domain: ActivityDomain;
  change: ActivityChange;
  /** Stable identifier of the changed record within its domain. */
  entityId: string;
  /**
   * `owner/repo` when the change is repository-scoped, else null. The dashboard
   * is filtered by repository, so a client can drop an event for a repository
   * it is not showing without issuing a request to find that out.
   */
  repository: string | null;
  /** True only for the terminal changes above. Precomputed so consumers do not re-derive it. */
  terminal: boolean;
  /** ISO-8601 time the change was observed on the server. */
  occurredAt: string;
  /**
   * Monotonic per-entity counter where one exists (task state revision). A
   * consumer that tracks the last revision it acted on can drop a replayed or
   * out-of-order frame instead of issuing a redundant read.
   */
  revision?: number;
}

/**
 * Goal lifecycle states, as a consumer sees them.
 *
 * `queued` is an accepted goal that no worker has claimed yet, and `cancelled`
 * covers a requested cancellation as well as a finalized one: from the outside
 * the goal is over either way, and the cleanup that follows is not a state a
 * client can act on.
 */
export const GOAL_ACTIVITY_STATES = [
  'queued',
  'running',
  'paused',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;
export type GoalActivityState = (typeof GOAL_ACTIVITY_STATES)[number];

export interface GoalUpdatePayload {
  eventType: typeof GOAL_UPDATE;
  goalId: string;
  repository: string;
  state: GoalActivityState;
  /** The task currently executing the goal, when one is running. */
  currentTaskId?: string | null;
  occurredAt: string;
  /**
   * Omitted for goals: no single stored counter advances on both operator
   * control mutations and worker-side terminal writes, and reporting one that
   * does not would let a consumer discard a live transition as stale.
   */
  revision?: number;
}

export const NOTIFICATION_CHANGES = ['created', 'read', 'dismissed', 'dismissed_all'] as const;
export type NotificationChange = (typeof NOTIFICATION_CHANGES)[number];

export interface NotificationUpdatePayload {
  eventType: typeof NOTIFICATION_UPDATE;
  change: NotificationChange;
  /**
   * Null for `dismissed_all`, which is a bulk change with no single subject.
   * The client treats it as 'reconcile the whole list'.
   */
  eventId: string | null;
  /**
   * Recipients this change applies to. The API fans this out to per-user rooms
   * and replaces the field with the receiving recipient before emitting, so one
   * recipient never learns who else was notified.
   */
  recipientIds: string[];
  repository: string | null;
  occurredAt: string;
}

/**
 * Usage is intentionally a trigger, not a snapshot: the existing
 * `/api/config/agent-tank/usage` endpoint owns the projection and its
 * permission check, and duplicating that over the socket would mean two
 * places to keep authorized. The client re-reads on the event, so the timer
 * still goes away.
 */
/** The capacity readings that can trigger a usage refresh. Additive. */
export const USAGE_SOURCES = ['agent-tank'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export interface UsageUpdatePayload {
  eventType: typeof USAGE_UPDATE;
  source: UsageSource;
  occurredAt: string;
}

/** True when `value` carries a parseable ISO-8601 instant. */
export function isActivityTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** A required identifier. An empty string addresses no record, so it is not one. */
const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** `owner/repo` when the change is repository-scoped, else an explicit null. */
const isRepositoryScope = (value: unknown): value is string | null =>
  value === null || isIdentifier(value);

/**
 * An absent revision is legitimate - most domains have no counter - but a
 * present one is compared against the last revision a consumer acted on, so
 * anything that is not a whole non-negative number would make that comparison
 * silently meaningless.
 */
const isOptionalRevision = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

const isMember = (values: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && values.includes(value);

/**
 * Validate at the trust boundary: these frames are decoded from Redis and
 * re-emitted to browsers, so a malformed publish must be dropped rather than
 * forwarded and crash a consumer's switch statement.
 */
export function isActivityUpdatePayload(value: unknown): value is ActivityUpdatePayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActivityUpdatePayload>;
  if (candidate.eventType !== ACTIVITY_UPDATE) return false;
  if (!isIdentifier(candidate.entityId)) return false;
  if (!isActivityTimestamp(candidate.occurredAt)) return false;
  if (!isMember(ACTIVITY_DOMAINS, candidate.domain)) return false;
  if (!isMember(ACTIVITY_CHANGES, candidate.change)) return false;
  // A repository a consumer cannot filter on - a number, an object, a missing
  // key - is worse than no repository: the dashboard would compare it against
  // its selected repo and silently keep or drop the wrong frames.
  if (!isRepositoryScope(candidate.repository)) return false;
  if (!isOptionalRevision(candidate.revision)) return false;
  // `terminal` is precomputed so consumers do not re-derive it. A flag that
  // disagrees with its own change means producer and consumer would read the
  // same event differently, which is malformed rather than merely redundant.
  return candidate.terminal === isTerminalActivityChange(candidate.change as ActivityChange);
}

/**
 * The producer guards below exist for the same reason as the one above: the
 * goal, notification and usage frames are decoded from Redis and forwarded to
 * browsers unchanged, so each one is validated whole - identifiers, enum
 * values, repository scope, revision - before either it or anything derived
 * from it is emitted.
 */
export function isGoalUpdatePayload(value: unknown): value is GoalUpdatePayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GoalUpdatePayload>;
  if (candidate.eventType !== GOAL_UPDATE) return false;
  if (!isIdentifier(candidate.goalId)) return false;
  // A goal is always repository-scoped, unlike the generic envelope.
  if (!isIdentifier(candidate.repository)) return false;
  if (!isMember(GOAL_ACTIVITY_STATES, candidate.state)) return false;
  if (!(candidate.currentTaskId === undefined
    || candidate.currentTaskId === null
    || isIdentifier(candidate.currentTaskId))) return false;
  if (!isOptionalRevision(candidate.revision)) return false;
  return isActivityTimestamp(candidate.occurredAt);
}

export function isNotificationUpdatePayload(value: unknown): value is NotificationUpdatePayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<NotificationUpdatePayload>;
  if (candidate.eventType !== NOTIFICATION_UPDATE) return false;
  if (!isMember(NOTIFICATION_CHANGES, candidate.change)) return false;
  // `dismissed_all` is the one bulk change with no subject; every other change
  // names the event it happened to, and a consumer keyed by that id cannot
  // reconcile a frame that omits it.
  if (candidate.change === 'dismissed_all'
    ? candidate.eventId !== null
    : !isIdentifier(candidate.eventId)) return false;
  if (!Array.isArray(candidate.recipientIds)) return false;
  if (!isRepositoryScope(candidate.repository)) return false;
  return isActivityTimestamp(candidate.occurredAt);
}

export function isUsageUpdatePayload(value: unknown): value is UsageUpdatePayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UsageUpdatePayload>;
  return candidate.eventType === USAGE_UPDATE
    && isMember(USAGE_SOURCES, candidate.source)
    && isActivityTimestamp(candidate.occurredAt);
}
