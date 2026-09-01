import type { GoalMergePolicy, GoalNodeKind, GoalNodeStatus } from '@propr/shared';
import type { GoalLeaseFence } from './goalTypes.js';

export const GOAL_PLAN_SCHEMA_VERSION = 1 as const;
export const GOAL_PLAN_MAX_NODES = 200;
export const GOAL_PLAN_MAX_DEPTH = 8;
export const GOAL_PLAN_MAX_ESTIMATE = 10_000;

export interface GoalPlanNodeInput {
  /** Stable planner-selected key. It survives plan revisions and drives IDs. */
  key: string;
  kind: GoalNodeKind;
  title: string;
  parentKey?: string | null;
  dependsOn?: string[];
  estimate: number;
  acceptanceCriteria: string[];
  noCode?: boolean;
}

export interface GoalPlanInput {
  schemaVersion: typeof GOAL_PLAN_SCHEMA_VERSION;
  baseBranch: string;
  nodes: GoalPlanNodeInput[];
}

export interface ValidatedGoalPlanNode {
  nodeId: string;
  key: string;
  kind: GoalNodeKind;
  title: string;
  parentNodeId: string | null;
  dependencyNodeIds: string[];
  estimate: number;
  acceptanceCriteria: string[];
  depth: number;
  orderIndex: number;
  baseBranch: string;
  headBranch: string;
  noCode: boolean;
}

export interface ValidatedGoalPlan {
  schemaVersion: typeof GOAL_PLAN_SCHEMA_VERSION;
  goalId: string;
  baseBranch: string;
  hash: string;
  nodes: ValidatedGoalPlanNode[];
}

export type GoalAttemptStatus =
  | 'reserved' | 'dispatching' | 'running' | 'safe_boundary'
  | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface GoalAttempt {
  attemptId: string;
  goalId: string;
  nodeId: string;
  executionId: string;
  attemptNumber: number;
  sessionId: string | null;
  status: GoalAttemptStatus;
  requestedModel: string;
  effectiveModel: string;
  parallelismSnapshot: number;
  ultrafixEnabled: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
  leaseGeneration: number;
  externalRef: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalDispatchReservation {
  reservationId: string;
  expiresAt: string;
  attempt: GoalAttempt;
  node: ValidatedGoalPlanNode & { status: GoalNodeStatus };
}

export type GoalArtifactKind = 'issue' | 'branch' | 'pull_request' | 'comment' | 'label';
export type GoalArtifactState = 'expected' | 'present' | 'closed' | 'merged' | 'deleted' | 'no_diff';

export interface GoalArtifactMarker {
  schemaVersion: 1;
  repository: string;
  goalId: string;
  nodeId: string;
  artifactKind: GoalArtifactKind;
  head: string | null;
  base: string | null;
}

export interface GoalGitHubArtifact {
  artifactId: string;
  goalId: string;
  nodeId: string;
  kind: GoalArtifactKind;
  repository: string;
  remoteId: string | null;
  number: number | null;
  url: string | null;
  headBranch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  baseSha: string | null;
  state: GoalArtifactState;
  marker: string;
  lastObservedAt: string | null;
}

export type GoalOutboxOperationKind =
  | 'create_issue' | 'create_branch' | 'create_pull_request'
  | 'update_issue' | 'update_pull_request' | 'merge_pull_request';

export interface GoalOutboxOperation {
  operationId: string;
  goalId: string;
  nodeId: string;
  artifactId: string | null;
  operationKind: GoalOutboxOperationKind;
  idempotencyKey: string;
  marker: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export type GoalEvidenceKind = 'ci' | 'review' | 'ultrafix' | 'freshness';

export interface GoalValidationEvidenceInput extends GoalLeaseFence {
  kind: GoalEvidenceKind;
  headSha: string;
  baseSha: string;
  policyHash: string;
  cycle?: number;
  expectedChecks?: string[];
  result: Record<string, unknown>;
  status: 'pending' | 'passed' | 'failed';
  observedAt?: string;
}

export interface GoalReadinessPolicy {
  policyHash: string;
  requiredEvidence: GoalEvidenceKind[];
  expectedChecks?: string[];
  mergePolicy: GoalMergePolicy;
}

export interface GoalNodeReadiness {
  ready: boolean;
  reasons: string[];
}

export interface GoalCompletionReadiness extends GoalNodeReadiness {
  terminalAction: 'complete' | 'wait_for_merge' | null;
}

export interface GoalRuntimeDispatch {
  goalId: string;
  nodeId: string;
  executionId: string;
  attemptNumber: number;
  attemptId: string;
  repository: string;
  issueNumber: number | null;
  baseBranch: string;
  headBranch: string;
  model: string;
  acceptanceCriteria: string[];
  controllerFence: GoalLeaseFence;
}

/** The runtime port intentionally contains no filesystem/container primitive. */
export interface GoalRuntimePort {
  dispatch(input: GoalRuntimeDispatch): Promise<{ sessionId: string; externalRef?: string }>;
  sendFollowup?(input: { attemptId: string; sessionId: string; body: string; controllerFence: GoalLeaseFence }): Promise<void>;
  requestSafeBoundary?(input: { attemptId: string; sessionId: string; controllerFence: GoalLeaseFence }): Promise<void>;
  resume?(input: { attemptId: string; sessionId: string; controllerFence: GoalLeaseFence }): Promise<void>;
}

export interface GoalGitHubRemoteArtifact {
  remoteId: string;
  number?: number;
  url?: string;
  repository: string;
  kind: GoalArtifactKind;
  marker: string;
  headBranch?: string | null;
  baseBranch?: string | null;
  headSha?: string | null;
  baseSha?: string | null;
  state: GoalArtifactState;
}

/** All GitHub mutations are mediated by persisted outbox operations. */
export interface GoalGitHubPort {
  findByMarker(marker: GoalArtifactMarker): Promise<GoalGitHubRemoteArtifact | null>;
  execute(operation: GoalOutboxOperation, marker: GoalArtifactMarker): Promise<GoalGitHubRemoteArtifact | null>;
  inspectGoal(repository: string, markers: GoalArtifactMarker[]): Promise<GoalGitHubRemoteArtifact[]>;
  branchHasDiff(repository: string, head: string, base: string): Promise<boolean>;
}

export interface GoalEventPort {
  emit(input: { goalId: string; type: string; payload: Record<string, unknown>; controllerFence: GoalLeaseFence }): Promise<void>;
}
