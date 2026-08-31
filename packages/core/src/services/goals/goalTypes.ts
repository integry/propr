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
  idempotency_key: string;
  created_at: string;
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
  eventType: string;
  payload: unknown;
  idempotencyKey: string;
  leaseEpoch: number;
  createdAt: string;
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
  idempotencyKey: string;
  createdAt: string;
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
}

export interface AppendEventInput {
  kind: GoalEventKind;
  eventType: string;
  payload?: unknown;
  idempotencyKey: string;
  leaseOwner?: string;
  leaseEpoch?: number;
}

export interface EnqueueMessageInput {
  messageId?: string;
  body: string;
  predefinedKind?: string | null;
  idempotencyKey: string;
}

export interface TransitionInput {
  toState: GoalState;
  expectedVersion?: number;
  leaseOwner?: string;
  leaseEpoch?: number;
  reason?: string;
  terminalReason?: GoalTerminalReason;
}

export interface ListGoalsQuery {
  ownerUserId: string;
  repository?: string;
  state?: GoalState;
  limit?: number;
  cursor?: string | null;
}

export interface ListGoalsResult {
  goals: Goal[];
  nextCursor: string | null;
}

export interface GoalActiveTimeStats {
  elapsedMs: number;
  pausedMs: number;
  activeMs: number;
  currentlyPaused: boolean;
}
