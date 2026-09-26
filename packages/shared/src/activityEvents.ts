/**
 * The general activity push surface.
 *
 * The dashboard, the header, the inbox and the goals console all need to know
 * "something relevant changed". Rather than one event per widget, one envelope
 * describes WHAT changed (domain), HOW it changed (change), and WHERE
 * (repository) — so a new consumer declares its interest instead of requiring a
 * new event name end to end.
 *
 * Consumers filter on the envelope rather than on a worker state string: a
 * client-side heuristic that has to be kept in sync with worker state names is
 * exactly the drift this contract exists to prevent.
 */

export const ACTIVITY_UPDATE = 'activity:update';
export const GOAL_UPDATE = 'goal:update';

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
 * inferred from a state string, because "a human must act" is exactly the
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

export interface ActivityUpdatePayload {
  eventType: typeof ACTIVITY_UPDATE;
  domain: ActivityDomain;
  change: ActivityChange;
  /** Stable identifier of the changed record within its domain. */
  entityId: string;
  /**
   * `owner/repo` when the change is repository-scoped, else null. A consumer
   * showing one repository drops the others without issuing a request to
   * discover the event was irrelevant.
   */
  repository: string | null;
  /** True for the changes that end a unit of work. */
  terminal: boolean;
  /** ISO-8601 instant the change was observed. */
  occurredAt: string;
  /** Monotonic counter where the domain has one; consumers drop older frames. */
  revision?: number;
}

/** A goal's own state transition, published from the transition itself. */
export interface GoalUpdatePayload {
  eventType: typeof GOAL_UPDATE;
  goalId: string;
  repository: string | null;
  /** The goal's task, so a consumer can follow that task's activity. */
  taskId?: string | null;
  desiredState?: string;
  resultState?: string | null;
  occurredAt: string;
  revision?: number;
}

const ACTIVITY_DOMAIN_SET = new Set<string>(ACTIVITY_DOMAINS);
const ACTIVITY_CHANGE_SET = new Set<string>(ACTIVITY_CHANGES);

/** Narrows an untrusted frame to the envelope before anything reacts to it. */
export function isActivityUpdatePayload(value: unknown): value is ActivityUpdatePayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ActivityUpdatePayload>;
  return candidate.eventType === ACTIVITY_UPDATE
    && typeof candidate.domain === 'string' && ACTIVITY_DOMAIN_SET.has(candidate.domain)
    && typeof candidate.change === 'string' && ACTIVITY_CHANGE_SET.has(candidate.change)
    && typeof candidate.entityId === 'string'
    && (candidate.repository === null || typeof candidate.repository === 'string')
    && typeof candidate.occurredAt === 'string';
}
