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

import type { GoalEventEnvelopeV1 } from './goalEvents.js';

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
  'delivering',
  'delivered',
  'acknowledged',
  'failed',
  'cancelled',
] as const;
export type GoalMessageState = (typeof GOAL_MESSAGE_STATES)[number];

/** Stable operator shortcuts. Their resolved text is persisted at enqueue. */
export const GOAL_CANNED_ACTIONS = ['whats_done', 'whats_left'] as const;
export type GoalCannedAction = (typeof GOAL_CANNED_ACTIONS)[number];
export const GOAL_CANNED_ACTION_TEXT: Readonly<Record<GoalCannedAction, string>> = {
  whats_done: "What's done?",
  whats_left: "What's left?",
};
export const GOAL_CANNED_ACTION_MEANING: Readonly<Record<GoalCannedAction, string>> = {
  whats_done: 'Authoritative checklist items currently completed by the controller',
  whats_left: 'Authoritative checklist items not currently completed by the controller',
};

/** How a completed goal's pull requests are merged. */
export const GOAL_MERGE_POLICIES = ['manual', 'auto', 'auto_squash'] as const;
export type GoalMergePolicy = (typeof GOAL_MERGE_POLICIES)[number];

export const GOAL_DEFAULT_MAX_ACTIVE_TASKS = 3;
export const GOAL_MIN_MAX_ACTIVE_TASKS = 1;
export const GOAL_MAX_MAX_ACTIVE_TASKS = 20;
export const GOAL_ULTRAFIX_GOAL_MIN = 1;
export const GOAL_ULTRAFIX_GOAL_MAX = 10;
export const GOAL_ULTRAFIX_MAX_CYCLES_MIN = 1;
export const GOAL_ULTRAFIX_MAX_CYCLES_MAX = 20;
export const GOAL_OBJECTIVE_MAX_LENGTH = 4000;
export const GOAL_MESSAGE_BODY_MAX_LENGTH = 4000;
export const GOAL_REASON_MAX_LENGTH = 1000;
export const GOAL_IDENTIFIER_MAX_LENGTH = 255;
export const GOAL_IDEMPOTENCY_KEY_MAX_LENGTH = 255;
export const GOAL_SEARCH_MAX_LENGTH = 200;
export const GOAL_LIST_DEFAULT_LIMIT = 25;
export const GOAL_LIST_MAX_LIMIT = 100;
export const GOAL_EVENT_DEFAULT_LIMIT = 100;
export const GOAL_EVENT_MAX_LIMIT = 500;
export const GOAL_MESSAGE_DEFAULT_LIMIT = 25;
export const GOAL_MESSAGE_MAX_LIMIT = 100;
export const GOAL_CHECKLIST_DEFAULT_LIMIT = 200;
export const GOAL_CHECKLIST_MAX_LIMIT = 500;
export const GOAL_EVENT_DEFAULT_MAX_BYTES = 256 * 1024;
export const GOAL_EVENT_MAX_BYTES = 1024 * 1024;
export const GOAL_OUTPUT_CHUNK_MAX_BYTES = 64 * 1024;
export const GOAL_CURSOR_MAX_LENGTH = 1024;
export const GOAL_LEASE_TTL_MAX_MS = 86_400_000;

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
  invalidIdempotencyKey: 'goal_invalid_idempotency_key',
  idempotencyConflict: 'goal_idempotency_conflict',
  hierarchyConflict: 'goal_hierarchy_conflict',
  invalidCursor: 'goal_invalid_cursor',
  cursorExpired: 'goal_cursor_expired',
  invalidEventKind: 'goal_invalid_event_kind',
  terminalState: 'goal_terminal_state',
  messageOrderConflict: 'goal_message_order_conflict',
  replayItemTooLarge: 'goal_replay_item_too_large',
  reconnectRequired: 'goal_reconnect_required',
  recoveryMetadataInvalid: 'goal_recovery_metadata_invalid',
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

/** Explicit goal-capability discriminator used by agent and model catalogs. */
export interface GoalCapability {
  /** Whether the agent/model may drive a long-running goal. */
  goalCapable: boolean;
}

export function isGoalCapableEntry(
  entry: Partial<GoalCapability> | null | undefined
): boolean {
  return entry?.goalCapable === true;
}

/** Shared create contract consumed by the API and goal UI. */
export interface CreateGoalRequest {
  objective: string;
  repository: string;
  agent: string;
  model: string;
  maxActiveTasks: number;
  mergePolicy: GoalMergePolicy;
  ultrafixEnabled: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
  /** Compatible fallback when the canonical Idempotency-Key header is unavailable. */
  idempotencyKey: string;
}

/** Shared body shape for pause, resume, and cancel mutations. */
export interface GoalMutationRequest {
  idempotencyKey: string;
  expectedVersion?: number;
  reason?: string;
}

export interface GoalModelChangeRequest extends GoalMutationRequest {
  model: string;
}

export interface GoalMessageRequest {
  idempotencyKey: string;
  body?: string;
  cannedAction?: GoalCannedAction;
}

/** Credential-free, bounded recovery checkpoint persisted for a provider session. */
export interface GoalRecoveryMetadata {
  schemaVersion: 1;
  reason?: string;
  attempt?: number;
  lastEventSequence?: number;
  providerState?: 'starting' | 'active' | 'interrupted' | 'recoverable';
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
  mergePolicy: GoalMergePolicy;
  ultrafixEnabled: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
  version: number;
  nodeCount: number;
  activeNodeCount: number;
  latestSequence: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Canonical goal shape exposed by authenticated HTTP routes. Persistence and
 * controller-only ownership/lease fields deliberately do not belong here.
 */
export interface PublicGoalDto {
  goalId: string;
  repository: string;
  objective: string;
  state: GoalState;
  agent: string;
  requestedModel: string;
  effectiveModel: string;
  maxActiveTasks: number;
  ultrafixEnabled: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
  mergePolicy: GoalMergePolicy;
  version: number;
  terminalReason: GoalTerminalReason | null;
  createdAt: string;
  updatedAt: string;
}

/** Public hierarchy node without durable idempotency/controller metadata. */
export interface PublicGoalNodeDto {
  nodeId: string;
  goalId: string;
  parentNodeId: string | null;
  kind: GoalNodeKind;
  externalRef: string | null;
  externalKind: string | null;
  title: string | null;
  status: GoalNodeStatus;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

/** Public corrective-message state without delivery-worker internals. */
export interface PublicGoalMessageDto {
  messageId: string;
  goalId: string;
  sequence: number;
  body: string;
  authorUserId: string | null;
  cannedAction: GoalCannedAction | null;
  predefinedKind: string | null;
  state: GoalMessageState;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/** The canonical REST/socket event envelope without database identity or fence. */
export type PublicGoalEventDto = GoalEventEnvelopeV1;

export interface PublicGoalStatsDto {
  elapsedMs: number;
  pausedMs: number;
  activeMs: number;
  currentlyPaused: boolean;
  recoveryMs: number;
  issues: { total: number; ready: number; active: number; processed: number; failed: number; blocked: number };
  pullRequests: { open: number; reviewPending: number; ultrafixPending: number; mergeReady: number; merged: number };
  tokens: {
    input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number;
    byProviderModel: Array<{
      provider: string; model: string; input: number; output: number;
      cacheRead: number; cacheWrite: number; reasoning: number; total: number;
    }>;
  };
  activeProviders: string[];
  activeModels: string[];
  controllerState: GoalState;
}

/** Canonical public detail read model shared by the API and UI. */
export interface PublicGoalDetailDto {
  goal: PublicGoalDto;
  nodes: PublicGoalNodeDto[];
  dependencies: Array<{ nodeId: string; dependsOnNodeId: string }>;
  messages: PublicGoalMessageDto[];
  messagesNextCursor: string | null;
  checklistNextCursor: string | null;
  summary: GoalSummaryView;
  stats: PublicGoalStatsDto;
  /** Provider suggestions; never authoritative execution checklist state. */
  providerAdvisoryTodos: Array<{
    sessionId: string;
    todoId: string;
    body: string;
    status: 'pending' | 'in_progress' | 'completed';
    eventSequence: number;
  }>;
  asOfVersion: number;
  asOfSequence: number;
}

export interface GoalEventPage {
  events: PublicGoalEventDto[];
  nextCursor: string | null;
  asOfSequence: number;
}

export interface GoalMessagePage {
  messages: PublicGoalMessageDto[];
  nextCursor: string | null;
  asOfSequence: number;
}

export interface GoalChecklistPage {
  nodes: PublicGoalNodeDto[];
  nextCursor: string | null;
  asOfSequence: number;
}

/** Canonical keyset-paginated list contract shared by API and UI. */
export interface GoalListRequest {
  cursor?: string | null;
  limit?: number;
  repository?: string;
  state?: GoalState;
  search?: string;
}

export interface GoalListResponse {
  goals: GoalSummaryView[];
  nextCursor: string | null;
}
