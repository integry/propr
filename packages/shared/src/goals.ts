// Shared goal control-plane contracts.
//
// These types define the source-of-truth domain for long-running goals: their
// lifecycle state machine, hierarchical nodes, provider sessions, events,
// corrective messages, and the fenced controller-lease semantics. They are the
// stable surface consumed by the SQLite repositories, the HTTP API, and the UI.
//
// The state machine and error codes live here (not in the database or a single
// service) so every consumer agrees on what a valid transition and an
// actionable conflict look like.

/**
 * Explicit goal lifecycle states. `pausing`/`recovering`/`completing` are
 * transient controller states; `completed`/`failed`/`cancelled` are terminal.
 */
export const GOAL_STATES = [
  'queued',
  'planning',
  'running',
  'pausing',
  'paused',
  'recovering',
  'completing',
  'completed',
  'failed',
  'cancelled',
] as const;

export type GoalState = (typeof GOAL_STATES)[number];

/** Terminal states admit no further transitions. */
export const TERMINAL_GOAL_STATES: readonly GoalState[] = [
  'completed',
  'failed',
  'cancelled',
];

export function isTerminalGoalState(state: GoalState): boolean {
  return TERMINAL_GOAL_STATES.includes(state);
}

/**
 * Allowed forward transitions of the lifecycle state machine. Pause is
 * nonterminal (`paused` can resume back into `planning`/`running`), and
 * cancellation is reachable from every non-terminal state so active work can
 * always be stopped distinctly from a pause.
 */
export const GOAL_STATE_TRANSITIONS: Record<GoalState, readonly GoalState[]> = {
  queued: ['planning', 'running', 'pausing', 'cancelled', 'failed'],
  planning: ['running', 'pausing', 'completing', 'cancelled', 'failed'],
  running: ['pausing', 'recovering', 'completing', 'cancelled', 'failed'],
  pausing: ['paused', 'cancelled', 'failed'],
  paused: ['planning', 'running', 'recovering', 'cancelled', 'failed'],
  recovering: ['running', 'planning', 'pausing', 'cancelled', 'failed'],
  completing: ['completed', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isValidGoalTransition(from: GoalState, to: GoalState): boolean {
  return GOAL_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Hierarchy node kinds, from the root epic down to concrete work items. */
export const GOAL_NODE_KINDS = [
  'root_epic',
  'sub_epic',
  'implementation_issue',
  'implementation_pr',
] as const;
export type GoalNodeKind = (typeof GOAL_NODE_KINDS)[number];

export const GOAL_NODE_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;
export type GoalNodeStatus = (typeof GOAL_NODE_STATUSES)[number];

/** Append-only event families sharing one monotonic per-goal sequence. */
export const GOAL_EVENT_KINDS = ['lifecycle', 'output', 'domain'] as const;
export type GoalEventKind = (typeof GOAL_EVENT_KINDS)[number];

/** Corrective-message delivery lifecycle. */
export const GOAL_MESSAGE_STATES = [
  'queued',
  'delivered',
  'acknowledged',
] as const;
export type GoalMessageState = (typeof GOAL_MESSAGE_STATES)[number];

/** How a completed goal's pull requests are merged. */
export const GOAL_MERGE_POLICIES = ['manual', 'auto', 'auto_squash'] as const;
export type GoalMergePolicy = (typeof GOAL_MERGE_POLICIES)[number];

export const GOAL_DEFAULT_MAX_ACTIVE_TASKS = 3;
export const GOAL_MIN_MAX_ACTIVE_TASKS = 1;
export const GOAL_MAX_MAX_ACTIVE_TASKS = 20;

/** Stable machine-readable error codes for actionable API responses. */
export const GOAL_ERROR_CODES = {
  notFound: 'goal_not_found',
  unauthorized: 'goal_unauthorized',
  invalidTransition: 'goal_invalid_transition',
  versionConflict: 'goal_version_conflict',
  leaseConflict: 'goal_lease_conflict',
  staleLease: 'goal_stale_lease',
  validation: 'goal_validation_error',
  repositoryForbidden: 'goal_repository_forbidden',
  invalidCatalogSelection: 'goal_invalid_catalog_selection',
  concurrencyBound: 'goal_concurrency_bound_exceeded',
  idempotencyConflict: 'goal_idempotency_conflict',
} as const;

export type GoalErrorCode =
  (typeof GOAL_ERROR_CODES)[keyof typeof GOAL_ERROR_CODES];

/** Reasons a goal reached a terminal state, retained for audit/UX. */
export const GOAL_TERMINAL_REASONS = [
  'objective_met',
  'user_cancelled',
  'unrecoverable_error',
  'concurrency_exhausted',
  'superseded',
] as const;
export type GoalTerminalReason = (typeof GOAL_TERMINAL_REASONS)[number];

/**
 * Optional goal-capability discriminator layered onto the model catalog. Older
 * consumers that do not know this field simply ignore it; goal creation only
 * accepts models flagged capable (or, when unset, falls back to the default
 * allowlist so existing catalogs keep working).
 */
export interface GoalCapability {
  /** Whether the agent/model may drive a long-running goal. */
  goalCapable: boolean;
}

export function isGoalCapableEntry(
  entry: Partial<GoalCapability> | null | undefined
): boolean {
  // Undefined is tolerated for compatibility: absence is not a hard "no".
  return entry?.goalCapable !== false;
}

export interface GoalSummaryView {
  goalId: string;
  state: GoalState;
  objective: string;
  repository: string;
  agent: string;
  requestedModel: string;
  effectiveModel: string;
  maxActiveTasks: number;
  version: number;
  nodeCount: number;
  activeNodeCount: number;
  latestSequence: number;
}
