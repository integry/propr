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
export type GoalActivityState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

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

export type NotificationChange = 'created' | 'read' | 'dismissed' | 'dismissed_all';

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
export interface UsageUpdatePayload {
  eventType: typeof USAGE_UPDATE;
  source: 'agent-tank';
  occurredAt: string;
}

/** True when `value` carries a parseable ISO-8601 instant. */
export function isActivityTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function isActivityUpdatePayload(value: unknown): value is ActivityUpdatePayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActivityUpdatePayload>;
  // Validate at the trust boundary: these frames are decoded from Redis and
  // re-emitted to browsers, so a malformed publish must be dropped rather than
  // forwarded and crash a consumer's switch statement.
  return candidate.eventType === ACTIVITY_UPDATE
    && typeof candidate.entityId === 'string'
    && isActivityTimestamp(candidate.occurredAt)
    && (ACTIVITY_DOMAINS as readonly string[]).includes(candidate.domain as string)
    && (ACTIVITY_CHANGES as readonly string[]).includes(candidate.change as string);
}
