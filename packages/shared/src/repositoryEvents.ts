/**
 * The durable repository change-event journal (`repository_events`).
 *
 * Each row records one persisted change to a pull request, an epic queue or a
 * plan issue. `seq` is the cursor: it only grows, and a reader that remembers
 * the last `seq` it handled resumes from there. Payloads carry identifiers and
 * small scalars only, never PR bodies, comment text, diffs or log excerpts.
 */

/** Record kinds the journal covers. Additive: append, never reorder. */
export const REPOSITORY_EVENT_DOMAINS = ['pull_request', 'epic_queue', 'plan_issue'] as const;
export type RepositoryEventDomain = (typeof REPOSITORY_EVENT_DOMAINS)[number];

export const PULL_REQUEST_EVENT_TYPES = [
  'opened',
  'head_changed',
  'review_scored',
  'ultrafix_started',
  'ultrafix_ended',
  'auto_merge_decision',
  'merged',
  'closed',
] as const;
export type PullRequestEventType = (typeof PULL_REQUEST_EVENT_TYPES)[number];

export const EPIC_QUEUE_EVENT_TYPES = ['started', 'advanced', 'blocked', 'completed'] as const;
export type EpicQueueEventType = (typeof EPIC_QUEUE_EVENT_TYPES)[number];

export const PLAN_ISSUE_EVENT_TYPES = ['status_changed'] as const;
export type PlanIssueEventType = (typeof PLAN_ISSUE_EVENT_TYPES)[number];

/** The event types each domain accepts. */
export const REPOSITORY_EVENT_TYPES: { readonly [D in RepositoryEventDomain]: readonly string[] } = {
  pull_request: PULL_REQUEST_EVENT_TYPES,
  epic_queue: EPIC_QUEUE_EVENT_TYPES,
  plan_issue: PLAN_ISSUE_EVENT_TYPES,
};

export function isRepositoryEventType(domain: unknown, type: unknown): boolean {
  return typeof domain === 'string' && typeof type === 'string'
    && (REPOSITORY_EVENT_DOMAINS as readonly string[]).includes(domain)
    && REPOSITORY_EVENT_TYPES[domain as RepositoryEventDomain].includes(type);
}

/**
 * How an Ultrafix loop ended. Shared by the MCP command progress view, which
 * reconstructs it from task history, and the journal's `ultrafix_ended` event.
 */
export const ULTRAFIX_OUTCOMES = ['goal_reached', 'cycles_exhausted', 'style_findings_only', 'stopped', 'failed'] as const;
export type UltrafixOutcome = (typeof ULTRAFIX_OUTCOMES)[number];

export function isUltrafixOutcome(value: unknown): value is UltrafixOutcome {
  return typeof value === 'string' && (ULTRAFIX_OUTCOMES as readonly string[]).includes(value);
}

/** Payload of `pull_request` / `review_scored`. */
export interface ReviewScoredEventPayload {
  score: number;
  goal: number | null;
  goalReached: boolean | null;
  source: 'review' | 'ultrafix';
  cycle: number | null;
  reviewerModel: string | null;
}

/** Payload of `pull_request` / `ultrafix_started`. */
export interface UltrafixStartedEventPayload {
  goal: number;
  maxCycles: number;
  workEpoch: number;
}

/** Payload of `pull_request` / `ultrafix_ended`. */
export interface UltrafixEndedEventPayload {
  outcome: UltrafixOutcome;
  finalScore: number | null;
  /** The loop's own short completion reason, capped in length. */
  reason: string | null;
  workEpoch: number;
}

/** Payload of `epic_queue` / `advanced`. */
export interface EpicQueueAdvancedEventPayload {
  fromIssue: number;
  toIssue: number;
  cursor: number;
}

/** Payload of `epic_queue` / `blocked`. */
export interface EpicQueueBlockedEventPayload {
  headIssue: number | null;
  blockedReason: string;
}

/** Payload of `plan_issue` / `status_changed`. */
export interface PlanIssueStatusChangedEventPayload {
  from: string | null;
  to: string;
}

/** One journal row as a reader sees it. */
export interface RepositoryEvent {
  seq: number;
  repository: string;
  domain: RepositoryEventDomain;
  type: string;
  /** PR number, epic execution id, or plan issue id, as text. */
  entityId: string;
  prNumber: number | null;
  issueNumber: number | null;
  planId: string | null;
  headSha: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}
