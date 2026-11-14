/**
 * The durable repository change-event journal (`repository_events`).
 *
 * Each row records one persisted change to a pull request, an epic queue, a
 * plan issue or a task. `seq` is the cursor: it only grows, and a reader that remembers
 * the last `seq` it handled resumes from there. Payloads carry identifiers and
 * small scalars only, never PR bodies, comment text, diffs, prompts, tool
 * output or log excerpts.
 */

/** Record kinds the journal covers. Additive: append, never reorder. */
export const REPOSITORY_EVENT_DOMAINS = ['pull_request', 'epic_queue', 'plan_issue', 'task'] as const;
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

export const TASK_EVENT_TYPES = ['queued', 'started', 'completed', 'failed', 'cancelled'] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

/** The event types each domain accepts. */
export const REPOSITORY_EVENT_TYPES: { readonly [D in RepositoryEventDomain]: readonly string[] } = {
  pull_request: PULL_REQUEST_EVENT_TYPES,
  epic_queue: EPIC_QUEUE_EVENT_TYPES,
  plan_issue: PLAN_ISSUE_EVENT_TYPES,
  task: TASK_EVENT_TYPES,
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

/** What a journaled task does. Task types outside these kinds (goals, imports) are not journaled. */
export const TASK_EVENT_KINDS = ['implementation', 'follow-up', 'review', 'merge-conflict', 'automation'] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/** The journal kind of a stored task type (`tasks.task_type`, `issueRef.type`), or null when it is not journaled. */
export function taskEventKind(taskType: unknown): TaskEventKind | null {
  switch (taskType ?? 'issue') {
    case 'issue': return 'implementation';
    case 'pr-comment': return 'follow-up';
    case 'review': return 'review';
    case 'merge_conflict': return 'merge-conflict';
    case 'agent-run': return 'automation';
    default: return null;
  }
}

/** Terminal `task` event types. */
export const TASK_TERMINAL_EVENT_TYPES = ['completed', 'failed', 'cancelled'] as const satisfies readonly TaskEventType[];

/** How a terminal task touched a pull request: `opened` a new one, `updated` an existing one, or neither (null). */
export type TaskEventPullRequestOutcome = 'opened' | 'updated' | null;

/**
 * Payload of every `task` event. Identifiers and coded scalars only: never
 * prompt text, agent or tool output, logs, comments or file contents.
 */
export interface TaskEventPayload {
  taskId: string;
  kind: TaskEventKind;
  issueNumber: number | null;
  prNumber: number | null;
  agent: string | null;
  model: string | null;
  /** Retry attempts recorded on the task so far. */
  attempts: number;
}

/** Payload of `task` / `completed`, `failed` and `cancelled`. */
export interface TaskTerminalEventPayload extends TaskEventPayload {
  /** The terminal state: `completed`, `failed` or `cancelled`. */
  status: (typeof TASK_TERMINAL_EVENT_TYPES)[number];
  /** The coded terminal reason (for example `timed_out`, `cancelled_by_user`), when one was recorded. */
  terminalReason: string | null;
  /** Milliseconds from the latest start to the terminal state; null when the task never started. */
  durationMs: number | null;
  pullRequest: TaskEventPullRequestOutcome;
  /** Short coded failure category on `failed` (for example `claude_execution`, `timed_out`); null otherwise. */
  failureCategory: string | null;
}

/** One journal row as a reader sees it. */
export interface RepositoryEvent {
  seq: number;
  repository: string;
  domain: RepositoryEventDomain;
  type: string;
  /** PR number, epic execution id, plan issue id, or task id, as text. */
  entityId: string;
  prNumber: number | null;
  issueNumber: number | null;
  planId: string | null;
  headSha: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}
