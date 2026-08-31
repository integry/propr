/** JSON values are used for recovery data so it can be persisted without provider objects. */
export type GoalSessionJsonValue =
    | string
    | number
    | boolean
    | null
    | GoalSessionJsonValue[]
    | { [key: string]: GoalSessionJsonValue };

export interface GoalSessionIdentity {
    goalId: string;
    /** ProPR's stable session identity. This is distinct from a provider session ID. */
    sessionId: string;
}

export interface GoalSessionFence extends GoalSessionIdentity {
    /** Monotonically increasing ownership generation. */
    controllerEpoch: number;
    turnId: string;
}

export interface GoalRepositoryIdentity {
    repository: string;
    worktreePath: string;
    branch: string;
    headSha?: string;
}

export interface GoalExecutionIdentity {
    /** Stable across queue redelivery of this turn. */
    executionId: string;
    /** Unique for an actual provider invocation, including a recovered retry. */
    attemptId: string;
}

export type GoalSessionStatus =
    | 'initializing'
    | 'idle'
    | 'running'
    | 'pause_requested'
    | 'paused'
    | 'cancelling'
    | 'terminated'
    | 'failed';

export interface GoalTurnState extends GoalExecutionIdentity {
    turnId: string;
    objective: string;
    requestedModel: string;
    repository: GoalRepositoryIdentity;
    status: 'running' | 'pause_requested' | 'paused' | 'completed' | 'cancelled' | 'failed';
}

export interface GoalProviderSessionSnapshot {
    /** Stable, provider-issued identity. It must never be replaced during resume. */
    providerSessionId: string;
    /** Serializable, credential-free provider checkpoint/recovery metadata. */
    recoveryMetadata: GoalSessionJsonValue;
    model?: string;
}

export interface GoalSessionState extends GoalSessionIdentity {
    provider: string;
    providerSessionId?: string;
    recoveryMetadata?: GoalSessionJsonValue;
    controllerEpoch: number;
    status: GoalSessionStatus;
    currentModel?: string;
    requestedModel?: string;
    activeTurn?: GoalTurnState;
    completedTurnIds: string[];
    failureReason?: string;
    /** Optimistic concurrency token owned by the state port. */
    version: number;
    createdAt: string;
    updatedAt: string;
}

export type GoalToolPhase = 'started' | 'progress' | 'completed' | 'failed';

export type GoalSessionEvent =
    | { type: 'output'; channel: 'stdout' | 'stderr'; data: string }
    | { type: 'assistant'; messageId?: string; content: string; data?: GoalSessionJsonValue }
    | { type: 'tool'; toolCallId: string; name: string; phase: GoalToolPhase; data?: GoalSessionJsonValue }
    | { type: 'todo'; todoId: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; data?: GoalSessionJsonValue }
    | { type: 'usage'; model?: string; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number; data?: GoalSessionJsonValue }
    | { type: 'checkpoint'; checkpointId: string; recoveryMetadata: GoalSessionJsonValue; providerSessionId?: string }
    | { type: 'message_acknowledged'; messageId: string }
    | { type: 'pause_requested'; appliesAt: 'immediate' | 'next_safe_boundary' }
    | { type: 'pause_boundary'; boundary: string; checkpointId?: string }
    | { type: 'session_resumed' }
    | { type: 'model_change_acknowledged'; requestedModel: string; appliesAt: 'immediate' | 'next_safe_boundary' | 'next_turn' }
    | { type: 'model_changed'; previousModel?: string; model: string }
    | { type: 'reconciliation'; outcome: 'alive' | 'resumed' | 'failed'; reason: string }
    | { type: 'completion'; outcome: 'succeeded' | 'failed' | 'cancelled'; summary?: string; error?: string };

export interface PersistedGoalSessionEvent extends GoalSessionFence, GoalExecutionIdentity {
    sequence: number;
    recordedAt: string;
    event: GoalSessionEvent;
}

export type GoalEventAppendResult =
    | { accepted: true; persisted: PersistedGoalSessionEvent }
    | { accepted: false; reason: 'stale_fence' | 'wrong_goal' | 'turn_not_active' };

/**
 * State changes are compare-and-swap operations. Implementations must scope a
 * sessionId to its original goalId and reject cross-goal reads or writes.
 */
export interface GoalSessionStatePort {
    load(identity: GoalSessionIdentity): Promise<GoalSessionState | null>;
    create(state: Omit<GoalSessionState, 'version'>): Promise<GoalSessionState | null>;
    compareAndSet(expected: GoalSessionState, next: Omit<GoalSessionState, 'version'>): Promise<GoalSessionState | null>;
}

/**
 * An append is authoritative only when goal/session/epoch/turn still match.
 * The fence check and append must be one atomic durable operation. Appending a
 * delta (rather than replacing a snapshot) preserves replay across restarts.
 */
export interface GoalSessionEventSink {
    append(fence: GoalSessionFence, execution: GoalExecutionIdentity, event: GoalSessionEvent): Promise<GoalEventAppendResult>;
    replay(identity: GoalSessionIdentity, afterSequence?: number): Promise<PersistedGoalSessionEvent[]>;
}

export interface DurableCorrectiveMessage extends GoalSessionIdentity {
    messageId: string;
    sequence: number;
    body: string;
    createdAt: string;
    acknowledgedAt?: string;
}

/** Message creation belongs to goal persistence/API code; the runtime only consumes and acknowledges it. */
export interface GoalSessionMessagePort {
    listPending(identity: GoalSessionIdentity): Promise<DurableCorrectiveMessage[]>;
    acknowledge(fence: GoalSessionFence, messageId: string): Promise<'acknowledged' | 'already_acknowledged' | 'stale_fence' | 'not_found'>;
}

export interface GoalProviderOpenRequest extends GoalSessionIdentity {
    provider: string;
    controllerEpoch: number;
    persisted?: GoalProviderSessionSnapshot;
}

export interface GoalBeginTurnRequest extends GoalSessionFence, GoalExecutionIdentity {
    objective: string;
    context?: GoalSessionJsonValue;
    repository: GoalRepositoryIdentity;
    requestedModel: string;
}

export interface GoalSteeringRequest extends GoalSessionFence {
    messageId: string;
    body: string;
}

export interface GoalPauseRequest extends GoalSessionFence {
    reason?: string;
}

export interface GoalModelChangeRequest extends GoalSessionFence {
    model: string;
}

export interface GoalCancelRequest extends GoalSessionFence {
    reason: string;
}

export interface GoalPauseAcknowledgement {
    appliesAt: 'immediate' | 'next_safe_boundary';
    /** Present when the control call itself reached the boundary; otherwise the turn stream reports it later. */
    boundaryReached?: { boundary: string; checkpointId?: string };
}

export interface GoalModelChangeAcknowledgement {
    requestedModel: string;
    appliesAt: 'immediate' | 'next_safe_boundary' | 'next_turn';
    effectiveModel?: string;
}

export interface GoalProviderReconcileRequest extends GoalSessionIdentity {
    controllerEpoch: number;
    persisted: GoalProviderSessionSnapshot;
    repository: GoalRepositoryInspection;
    container: GoalContainerInspection;
}

export type GoalProviderReconcileResult =
    | { outcome: 'alive'; snapshot?: GoalProviderSessionSnapshot; reason: string }
    | { outcome: 'resumed'; snapshot: GoalProviderSessionSnapshot; reason: string }
    | { outcome: 'failed'; reason: string };

/**
 * Provider-specific CLI parsing and resume semantics live behind this adapter.
 * Pause/model-change requests are immediate control calls, but their effects may
 * be deferred as explicitly reported by the acknowledgement and later events.
 * deliverMessage must be idempotent by messageId so crash retries do not steer twice.
 */
export interface GoalSessionAdapter {
    readonly provider: string;
    openSession(request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot>;
    beginTurn(request: GoalBeginTurnRequest, snapshot: GoalProviderSessionSnapshot): AsyncIterable<GoalSessionEvent>;
    deliverMessage(request: GoalSteeringRequest, snapshot: GoalProviderSessionSnapshot): Promise<{ messageId: string }>;
    requestPause(request: GoalPauseRequest, snapshot: GoalProviderSessionSnapshot): Promise<GoalPauseAcknowledgement>;
    resumeSession(request: GoalSessionFence, snapshot: GoalProviderSessionSnapshot): Promise<GoalProviderSessionSnapshot>;
    requestModelChange(request: GoalModelChangeRequest, snapshot: GoalProviderSessionSnapshot): Promise<GoalModelChangeAcknowledgement>;
    cancel(request: GoalCancelRequest, snapshot: GoalProviderSessionSnapshot): Promise<void>;
    reconcile(request: GoalProviderReconcileRequest): Promise<GoalProviderReconcileResult>;
}

export type GoalContainerStatus = 'running' | 'exited' | 'missing' | 'daemon_unavailable';

export interface GoalContainerInspection {
    status: GoalContainerStatus;
    containerId?: string;
    containerName?: string;
    reason?: string;
}

export interface GoalRepositoryInspection extends GoalRepositoryIdentity {
    exists: boolean;
    dirty?: boolean;
    observedHeadSha?: string;
    observedBranch?: string;
    reason?: string;
}

export interface GoalSessionRecoveryPort {
    inspectContainer(identity: GoalSessionIdentity): Promise<GoalContainerInspection>;
    inspectRepository(repository: GoalRepositoryIdentity): Promise<GoalRepositoryInspection>;
}

export interface GoalSessionRuntimePorts {
    state: GoalSessionStatePort;
    events: GoalSessionEventSink;
    messages: GoalSessionMessagePort;
    recovery: GoalSessionRecoveryPort;
}
