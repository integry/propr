/**
 * Row and domain types for the goal control plane. Row types mirror the SQLite
 * columns created by 20260831000000_create_goal_control_plane; domain types are
 * the camelCased shapes returned by the repository.
 */

import type {
  GoalState,
  GoalNodeKind,
  GoalNodeStatus,
  GoalEventKind,
  GoalMessageState,
  GoalMergePolicy,
  GoalTerminalReason,
  GoalRecoveryMetadata,
  GoalListRequest,
  GoalListResponse,
  GoalCannedAction,
  DurableGoalEventInput,
  DurableGoalEventType,
} from '@propr/shared';

export interface GoalRecord {
  goal_id: string;
  owner_user_id: string;
  repository: string;
  objective: string;
  state: GoalState;
  agent: string;
  requested_model: string;
  effective_model: string;
  max_active_tasks: number;
  ultrafix_enabled: number;
  ultrafix_goal: number | null;
  ultrafix_max_cycles: number | null;
  merge_policy: GoalMergePolicy;
  version: number;
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  terminal_reason: GoalTerminalReason | null;
  created_at: string;
  updated_at: string;
}

export interface GoalNodeRecord {
  node_id: string;
  requested_node_id: string | null;
  goal_id: string;
  parent_node_id: string | null;
  kind: GoalNodeKind;
  idempotency_key: string;
  external_ref: string | null;
  external_kind: string | null;
  title: string | null;
  status: GoalNodeStatus;
  attempt_count: number;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface GoalEventRecord {
  id: number;
  goal_id: string;
  sequence: number;
  kind: GoalEventKind;
  event_type: string;
  payload_json: string | null;
  idempotency_key: string;
  lease_epoch: number;
  created_at: string;
  schema_version?: number;
  source_session_id?: string | null;
  source_turn_id?: string | null;
  source_execution_id?: string | null;
  source_attempt_id?: string | null;
  source_provider_sequence?: number | null;
  source_chunk_index?: number | null;
  lease_generation?: number | null;
  payload_bytes?: number;
}

export interface GoalMessageRecord {
  message_id: string;
  goal_id: string;
  sequence: number;
  body: string;
  predefined_kind: string | null;
  state: GoalMessageState;
  delivered_at: string | null;
  acknowledged_at: string | null;
  delivery_attempts: number;
  last_error: string | null;
  idempotency_key: string;
  created_at: string;
  queue_ordinal?: number;
  canned_action?: GoalCannedAction | null;
  author_user_id?: string | null;
  claimed_by?: string | null;
  claimed_turn_id?: string | null;
  claimed_lease_generation?: number | null;
  delivery_key?: string | null;
  cancelled_at?: string | null;
  failed_at?: string | null;
  retry_count?: number;
  enqueue_event_sequence?: number | null;
  state_event_sequence?: number | null;
}

export interface GoalProviderSessionRecord {
  session_id: string;
  goal_id: string;
  agent: string;
  provider_thread_id: string | null;
  runtime_id: string | null;
  worktree_id: string | null;
  last_checkpoint: string | null;
  effective_model: string;
  recovery_metadata_json: string | null;
  lease_generation: number;
  created_at: string;
  updated_at: string;
  current_turn_id?: string | null;
  current_execution_id?: string | null;
  current_attempt_id?: string | null;
}

export interface GoalIdempotencyRecord {
  owner_user_id: string;
  operation: string;
  idempotency_key: string;
  request_hash: string;
  claim_token: string | null;
  goal_id: string | null;
  response_json: string | null;
  created_at: string;
}

export interface Goal {
  goalId: string;
  ownerUserId: string;
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
  leaseOwner: string | null;
  leaseEpoch: number;
  leaseExpiresAt: string | null;
  terminalReason: GoalTerminalReason | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalNode {
  nodeId: string;
  goalId: string;
  parentNodeId: string | null;
  kind: GoalNodeKind;
  idempotencyKey: string;
  externalRef: string | null;
  externalKind: string | null;
  title: string | null;
  status: GoalNodeStatus;
  attemptCount: number;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface GoalEvent {
  id: number;
  goalId: string;
  sequence: number;
  kind: GoalEventKind;
  eventType: string | DurableGoalEventType;
  payload: unknown;
  idempotencyKey: string;
  leaseEpoch: number;
  createdAt: string;
  schemaVersion: number;
}

export interface GoalMessage {
  messageId: string;
  goalId: string;
  sequence: number;
  body: string;
  predefinedKind: string | null;
  state: GoalMessageState;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  deliveryAttempts: number;
  lastError: string | null;
  idempotencyKey: string;
  createdAt: string;
  queueOrdinal: number;
  cannedAction: GoalCannedAction | null;
  authorUserId: string | null;
  claimedBy: string | null;
  claimedTurnId: string | null;
  claimedLeaseGeneration: number | null;
  deliveryKey: string | null;
  cancelledAt: string | null;
  failedAt: string | null;
  retryCount: number;
  enqueueEventSequence: number | null;
  stateEventSequence: number | null;
}

export interface CreateGoalInput {
  goalId?: string;
  ownerUserId: string;
  repository: string;
  objective: string;
  agent: string;
  requestedModel: string;
  effectiveModel?: string;
  maxActiveTasks?: number;
  ultrafixEnabled?: boolean;
  ultrafixGoal?: number | null;
  ultrafixMaxCycles?: number | null;
  mergePolicy?: GoalMergePolicy;
  idempotencyKey?: string;
}

export interface CreateNodeInput {
  nodeId?: string;
  parentNodeId?: string | null;
  kind: GoalNodeKind;
  idempotencyKey: string;
  externalRef?: string | null;
  externalKind?: string | null;
  title?: string | null;
  status?: GoalNodeStatus;
  orderIndex?: number;
  leaseOwner: string;
  leaseEpoch: number;
}

export interface AppendEventInput {
  kind: GoalEventKind;
  eventType: string;
  payload?: unknown;
  idempotencyKey: string;
  leaseOwner: string;
  leaseEpoch: number;
}

export interface EnqueueMessageInput {
  messageId?: string;
  body: string;
  predefinedKind?: string | null;
  idempotencyKey: string;
  cannedAction?: GoalCannedAction | null;
  authorUserId?: string;
}

export type AppendTypedGoalEventInput = DurableGoalEventInput;

export interface GoalEventPageResult {
  events: GoalEvent[];
  nextCursor: string | null;
  lastCursor: string | null;
  asOfSequence: number;
}

export interface GoalMessagePageResult {
  messages: GoalMessage[];
  nextCursor: string | null;
  asOfSequence: number;
}

export interface GoalNodePageResult {
  nodes: GoalNode[];
  nextCursor: string | null;
}

export interface ClaimMessageInput extends GoalLeaseFence {
  sessionId: string;
  turnId: string;
  deliveryKey: string;
}

export interface TransitionInput extends GoalLeaseFence {
  toState: GoalState;
  expectedVersion?: number;
  reason?: string;
  terminalReason?: GoalTerminalReason;
  idempotencyKey?: string;
  idempotencyOperation?: string;
}

export interface OperatorIntentInput {
  expectedVersion?: number;
  reason?: string;
  idempotencyKey?: string;
}

export interface CancelIntentInput extends OperatorIntentInput {
  terminalReason?: GoalTerminalReason;
}

export interface GoalLeaseFence {
  leaseOwner: string;
  leaseEpoch: number;
}

export interface ProviderSessionUpdate extends GoalLeaseFence {
  providerThreadId?: string | null;
  runtimeId?: string | null;
  worktreeId?: string | null;
  lastCheckpoint?: string | null;
  effectiveModel?: string;
  recoveryMetadata?: GoalRecoveryMetadata | null;
  turnId?: string | null;
  executionId?: string | null;
  attemptId?: string | null;
}

export type ListGoalsQuery = GoalListRequest & (
  | { visibility: 'owner'; ownerUserId: string }
  | { visibility: 'all-demo' }
);

export type ListGoalsResult = GoalListResponse;

export interface GoalActiveTimeStats {
  elapsedMs: number;
  pausedMs: number;
  activeMs: number;
  currentlyPaused: boolean;
  recoveryMs: number;
}

export interface GoalStatistics extends GoalActiveTimeStats {
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
