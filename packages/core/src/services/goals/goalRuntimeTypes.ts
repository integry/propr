import type { GoalEventKind, GoalMergePolicy } from '@propr/shared';
import type { Goal } from './goalTypes.js';

export const GOAL_RUNTIME_EXECUTION_STATES = [
  'allocated', 'starting', 'active', 'pausing', 'paused', 'interrupted',
  'cancelling', 'completing', 'completed', 'failed', 'cancelled',
] as const;

export type GoalRuntimeExecutionState = typeof GOAL_RUNTIME_EXECUTION_STATES[number];

/** Immutable policy handed to native goal mode. */
export interface NativeGoalPolicy {
  schemaVersion: 1;
  maxActiveTasks: number;
  mergePolicy: GoalMergePolicy;
  ultrafix: {
    enabled: boolean;
    goal: number | null;
    maxCycles: number | null;
  };
  finalPullRequest: {
    draft: true;
    requireHumanApproval: boolean;
  };
}

export interface GoalWorkspaceIdentity {
  worktreeId: string;
  /** Durable host path. Recovery must use this exact path before consulting config. */
  worktreePath: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
}

export interface GoalRuntimeExecution {
  executionId: string;
  goalId: string;
  attemptNumber: number;
  schemaVersion: 1;
  state: GoalRuntimeExecutionState;
  agent: string;
  effectiveModel: string;
  providerSessionId: string | null;
  providerThreadId: string | null;
  runtimeId: string | null;
  workspace: GoalWorkspaceIdentity;
  policy: NativeGoalPolicy;
  policyHash: string;
  lastCheckpoint: string | null;
  lastNativeEventSequence: number;
  leaseGeneration: number;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalRuntimeSessionIdentity {
  providerSessionId: string;
  providerThreadId: string;
  runtimeId?: string | null;
  worktreeId: string;
}

export interface GoalRuntimeEvent {
  /** Provider-stable identity used to deduplicate reconnect/replay. */
  eventId: string;
  kind: GoalEventKind;
  eventType: string;
  payload?: unknown;
  checkpoint?: string;
  nativeSequence?: number;
}

export type GoalReportedArtifactKind =
  | 'epic_pr'
  | 'sub_epic'
  | 'implementation_issue'
  | 'implementation_pr';

export interface GoalReportedArtifact {
  /** Provider-stable correlation key, not a controller-generated hierarchy ID. */
  artifactKey: string;
  kind: GoalReportedArtifactKind;
  repository: string;
  externalRef: string;
  url?: string | null;
  headBranch?: string | null;
  baseBranch?: string | null;
  headSha?: string | null;
  state?: string | null;
  draft?: boolean | null;
  /** Durable hidden marker reported by the provider/GitHub integration. */
  marker: string;
  finalEpicPullRequest?: boolean;
}

export interface PersistedGoalReportedArtifact extends GoalReportedArtifact {
  artifactId: string;
  goalId: string;
  executionId: string;
  leaseGeneration: number;
  createdAt: string;
  updatedAt: string;
}

export interface GoalRuntimeCallbacks {
  /** Must be called before the runtime describes the session as recoverable. */
  onSessionIdentity(identity: GoalRuntimeSessionIdentity): Promise<void>;
  onEvent(event: GoalRuntimeEvent): Promise<void>;
  onArtifact(artifact: GoalReportedArtifact): Promise<void>;
}

export interface GoalRuntimeAuthority {
  controllerId: string;
  leaseGeneration: number;
  /** Recheck immediately before a provider/container/GitHub side effect. */
  assertCurrent(): Promise<void>;
}

export interface GoalRuntimeRequest {
  goal: Goal;
  execution: GoalRuntimeExecution;
  command: string;
  authority: GoalRuntimeAuthority;
  callbacks: GoalRuntimeCallbacks;
  signal: AbortSignal;
}

export type GoalRuntimeResult =
  | { outcome: 'completed' }
  | { outcome: 'paused' }
  | { outcome: 'cancelled' }
  | { outcome: 'interrupted'; reason?: string; checkpoint?: string }
  | { outcome: 'failed'; error: string; recoverable: boolean };

export interface GoalSteeringRequest {
  execution: GoalRuntimeExecution;
  providerMessageId: string;
  body: string;
  predefinedKind: string | null;
  authority: GoalRuntimeAuthority;
}

/** Provider boundary owned by #2007; #2010 only supervises this contract. */
export interface GoalProviderRuntime {
  /** Idempotent by execution.executionId; retries must adopt the same session. */
  start(request: GoalRuntimeRequest): Promise<GoalRuntimeResult>;
  /** Resumes request.execution.providerThreadId in the snapshotted worktree. */
  resume(request: GoalRuntimeRequest): Promise<GoalRuntimeResult>;
  /** Idempotent by providerMessageId. */
  steer(request: GoalSteeringRequest): Promise<{ acknowledged: boolean }>;
  /** Safe-boundary operations are idempotent by execution identity and target. */
  pause(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void>;
  cancel(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void>;
  changeModel(
    execution: GoalRuntimeExecution,
    model: string,
    authority: GoalRuntimeAuthority
  ): Promise<{ effectiveModel: string }>;
  /** Wait until provider work and late notifications have reached a closed boundary. */
  settle(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void>;
  /** Bounded-settlement fallback; idempotent for the exact provider session/container. */
  terminate(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void>;
}

export interface GoalNativeProjection {
  plan: unknown | null;
  todos: unknown | null;
  status: unknown | null;
  nativeSequence: number;
  updatedAt: string | null;
}

export interface VerifiedGoalPullRequest {
  repository: string;
  externalRef: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  state: 'open';
  draft: true;
  merged: false;
  markerPresent: true;
}

export interface GoalArtifactVerifier {
  verifyFinalPullRequest(artifact: PersistedGoalReportedArtifact): Promise<VerifiedGoalPullRequest>;
}

export interface GoalProviderRuntimeResolver {
  resolve(agentAlias: string): Promise<GoalProviderRuntime> | GoalProviderRuntime;
}
