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

/**
 * Session-scoped ownership fence. Control operations (pause, resume, model
 * change, cancel, reconcile) are authorized by goal/session/epoch alone and do
 * not require an active turn. This is deliberately separate from the turn fence
 * so control/audit events can be appended even when no turn is running.
 */
export interface GoalSessionControlFence extends GoalSessionIdentity {
    /** Monotonically increasing ownership generation. */
    controllerEpoch: number;
}

/** Turn-scoped fence. Adds the specific logical turn a caller claims to own. */
export interface GoalSessionFence extends GoalSessionControlFence {
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
    /** Controller epoch that started this concrete provider invocation. */
    executionEpoch: number;
    objective: string;
    requestedModel: string;
    repository: GoalRepositoryIdentity;
    status: 'running' | 'pause_requested' | 'paused' | 'completed' | 'cancelled' | 'failed';
}

/**
 * Durable record of a finished logical turn's real execution identity. It lets a
 * late queue redelivery of an older turn recover the exact execution/attempt it
 * ran under, instead of fabricating a fresh attempt id, even after a subsequent
 * turn has replaced {@link GoalSessionState.activeTurn}.
 */
export interface GoalCompletedTurn extends GoalExecutionIdentity {
    turnId: string;
}

/**
 * Durable marker recorded before the first provider initialization/open call. It lets a
 * later controller distinguish an ordinary crash window (recoverable when the
 * provider can deterministically/idempotently re-open) from a session that was
 * never intended to be initialized.
 */
export interface GoalSessionInitializationIntent {
    attemptId: string;
    /** Stable key a deterministic provider uses to re-open or retry the same initialization. */
    deterministicOpenKey: string;
    recordedAt: string;
}

export type GoalNativeSessionIdTiming = 'eager' | 'first_turn';
export type GoalSteeringBoundary = 'active_turn' | 'next_turn';
export type GoalPauseBoundary = 'active_turn' | 'after_turn';
export type GoalModelChangeBoundary = 'next_safe_boundary' | 'next_turn';

/**
 * Provider behavior that the supervisor can rely on. A first-turn provider
 * must also state what happens if its first invocation dies before exposing a
 * native ID; the supervisor never invents an ID or silently opens a new one.
 */
export type GoalProviderCapabilities = {
    nativeSessionId: 'eager';
    steering: GoalSteeringBoundary;
    pause: GoalPauseBoundary;
    modelChange: GoalModelChangeBoundary;
} | {
    nativeSessionId: 'first_turn';
    firstTurnIdCrashPolicy: 'retry_deterministically' | 'fail';
    steering: GoalSteeringBoundary;
    pause: GoalPauseBoundary;
    modelChange: GoalModelChangeBoundary;
};

export interface GoalProviderSessionSnapshot {
    /** Stable, provider-issued identity. It must never be replaced during resume. */
    providerSessionId: string;
    /** Serializable, credential-free provider checkpoint/recovery metadata. */
    recoveryMetadata: GoalSessionJsonValue;
    model?: string;
}

/** Provider context for a turn; pending identity never contains a fake native ID. */
export type GoalProviderTurnContext =
    | { binding: 'bound'; snapshot: GoalProviderSessionSnapshot }
    | { binding: 'pending'; initializationIntent: GoalSessionInitializationIntent };

export interface GoalSessionState extends GoalSessionIdentity {
    provider: string;
    providerSessionId?: string;
    recoveryMetadata?: GoalSessionJsonValue;
    controllerEpoch: number;
    status: GoalSessionStatus;
    currentModel?: string;
    requestedModel?: string;
    /** Deferred model request awaiting the provider's declared next-turn boundary. */
    pendingModelChange?: string;
    activeTurn?: GoalTurnState;
    completedTurnIds: string[];
    /** Execution identity of each completed turn, keyed by turnId order of completion. */
    completedTurns?: GoalCompletedTurn[];
    /** Present while a first provider open is in-flight; cleared once persisted. */
    initializationIntent?: GoalSessionInitializationIntent;
    /** Last durably claimed provider open/resume invocation attempt. */
    providerOpenAttemptId?: string;
    /** A crashed first-turn invocation that may be retried with a fresh attempt. */
    retryTurn?: { turnId: string; executionId: string; crashedAttemptId: string };
    /** Last durably claimed reconciliation invocation attempt. */
    recoveryAttemptId?: string;
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
    | { type: 'pause_requested'; appliesAt: 'immediate' | 'next_safe_boundary' | 'after_turn' }
    | { type: 'pause_boundary'; boundary: string; checkpointId?: string }
    | { type: 'session_resumed' }
    | { type: 'model_change_acknowledged'; requestedModel: string; appliesAt: 'immediate' | 'next_safe_boundary' | 'next_turn' }
    | { type: 'model_changed'; previousModel?: string; model: string }
    | { type: 'turn_resumed'; turnId: string }
    | { type: 'reconciliation'; outcome: 'alive' | 'resumed' | 'failed' | 'blocked'; reason: string }
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

export type GoalTerminalCommit =
    | {
        scope: 'turn';
        fence: GoalSessionFence;
        execution: GoalExecutionIdentity;
        event: Extract<GoalSessionEvent, { type: 'completion' }>;
    }
    | {
        scope: 'control';
        fence: GoalSessionControlFence;
        execution: GoalExecutionIdentity;
        event: Extract<GoalSessionEvent, { type: 'completion' }>;
    };

/**
 * Commits terminal state and its completion event in one durable transaction.
 * Implementations must be idempotent by scope/fence/execution, so an ambiguous
 * post-commit transport failure can be retried without a duplicate event.
 */
export interface GoalSessionTerminalPort {
    commit(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        completion: GoalTerminalCommit,
    ): Promise<GoalSessionState | null>;
}

/**
 * An append is authoritative only when goal/session/epoch/turn still match.
 * The fence check and append must be one atomic durable operation. Appending a
 * delta (rather than replacing a snapshot) preserves replay across restarts.
 */
export interface GoalSessionEventSink {
    /**
     * Turn-scoped append. Authoritative only when goal/session/epoch match AND
     * the fence owns the currently active turn. Rejects output attributed to a
     * turn that is not active (including terminal turns).
     */
    append(fence: GoalSessionFence, execution: GoalExecutionIdentity, event: GoalSessionEvent): Promise<GoalEventAppendResult>;
    /**
     * Session-scoped control/audit append. Authoritative when goal/session/epoch
     * match; it does not require an active turn, so model-change, cancel, resume
     * and reconciliation remain auditable in idle state. It must never be
     * attributed to an unrelated completed turn.
     */
    appendControl(fence: GoalSessionControlFence, execution: GoalExecutionIdentity, event: GoalSessionEvent): Promise<GoalEventAppendResult>;
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
    attemptId: string;
    persisted?: GoalProviderSessionSnapshot;
    /**
     * Stable key a deterministic provider uses to re-open the same underlying
     * session after a crash that happened before the provider identity was
     * persisted. Only meaningful when the adapter reports supportsDeterministicOpen.
     */
    deterministicOpenKey?: string;
}

export interface GoalBeginTurnRequest extends GoalSessionFence, GoalExecutionIdentity {
    objective: string;
    context?: GoalSessionJsonValue;
    repository: GoalRepositoryIdentity;
    requestedModel: string;
    /**
     * FIFO messages reserved for acceptance by a next-turn-only provider. The
     * provider must acknowledge every supplied ID before reporting success.
     */
    correctiveMessages?: GoalProviderCorrectiveMessage[];
}

export interface GoalProviderCorrectiveMessage {
    messageId: string;
    sequence: number;
    body: string;
}

export interface GoalSteeringRequest extends GoalSessionFence {
    messageId: string;
    body: string;
}

export interface GoalPauseRequest extends GoalSessionControlFence {
    reason?: string;
}

export interface GoalModelChangeRequest extends GoalSessionControlFence {
    model: string;
}

export interface GoalCancelRequest extends GoalSessionControlFence {
    reason: string;
}

export interface GoalPauseAcknowledgement {
    appliesAt: 'immediate' | 'next_safe_boundary' | 'after_turn';
    /** Present when the control call itself reached the boundary; otherwise the turn stream reports it later. */
    boundaryReached?: { boundary: string; checkpointId?: string };
}

export type GoalMessageDeliveryOutcome =
    | { outcome: 'acknowledged'; messageId: string; acknowledgement: 'acknowledged' | 'already_acknowledged' }
    | { outcome: 'unsupported_same_turn'; messageId: string; supportedBoundary: 'next_turn' };

export type GoalTurnResumeCapabilityOutcome = {
    disposition: 'unsupported_same_turn';
    supportedBoundary: 'after_turn';
};

export interface GoalModelChangeAcknowledgement {
    requestedModel: string;
    appliesAt: 'immediate' | 'next_safe_boundary' | 'next_turn';
    effectiveModel?: string;
}

export interface GoalProviderReconcileRequest extends GoalSessionIdentity, GoalExecutionIdentity {
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
    readonly capabilities: GoalProviderCapabilities;
    /**
     * When true, openSession is idempotent for a given deterministicOpenKey: a
     * repeated call re-opens the same provider session instead of creating a new
     * one. This is what makes a crash before provider-identity persistence
     * recoverable rather than permanently failed.
     */
    readonly supportsDeterministicOpen?: boolean;
    openSession(request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot>;
    beginTurn(request: GoalBeginTurnRequest, context: GoalProviderTurnContext): AsyncIterable<GoalSessionEvent>;
    /**
     * Continues the exact active turn identified by the fence after a pause or a
     * container/supervisor restart. The provider resumes from the durable
     * checkpoint and streams further ordered events through to a single
     * completion; it must not start a new logical turn.
     */
    resumeTurn?(request: GoalSessionFence & GoalExecutionIdentity, snapshot: GoalProviderSessionSnapshot): AsyncIterable<GoalSessionEvent>;
    deliverMessage?(request: GoalSteeringRequest, snapshot: GoalProviderSessionSnapshot): Promise<{ messageId: string }>;
    requestPause?(request: GoalPauseRequest, snapshot: GoalProviderSessionSnapshot): Promise<GoalPauseAcknowledgement>;
    resumeSession(request: GoalSessionControlFence, snapshot: GoalProviderSessionSnapshot): Promise<GoalProviderSessionSnapshot>;
    requestModelChange(request: GoalModelChangeRequest, snapshot: GoalProviderSessionSnapshot): Promise<GoalModelChangeAcknowledgement>;
    cancel(request: GoalCancelRequest, snapshot: GoalProviderSessionSnapshot): Promise<void>;
    reconcile(request: GoalProviderReconcileRequest): Promise<GoalProviderReconcileResult>;
}

export type GoalContainerStatus = 'running' | 'exited' | 'missing' | 'daemon_unavailable';

export interface GoalContainerInspection {
    status: GoalContainerStatus;
    containerId?: string;
    containerName?: string;
    /** Authoritative labels read from the recovered container itself. */
    recoveryIdentity?: GoalRecoveryIdentity;
    reason?: string;
}

export interface GoalRecoveryIdentity extends GoalSessionIdentity {
    executionEpoch: number;
    turnId: string;
    attemptId: string;
    worktreeFingerprint: string;
}

export interface GoalRepositoryInspection extends GoalRepositoryIdentity {
    exists: boolean;
    dirty?: boolean;
    observedHeadSha?: string;
    observedBranch?: string;
    observedWorktreeFingerprint?: string;
    resolvedWorktreePath?: string;
    reason?: string;
}

export interface GoalSessionRecoveryPort {
    inspectContainer(identity: GoalSessionIdentity): Promise<GoalContainerInspection>;
    inspectRepository(repository: GoalRepositoryIdentity): Promise<GoalRepositoryInspection>;
}

export interface GoalSessionRuntimePorts {
    state: GoalSessionStatePort;
    events: GoalSessionEventSink;
    terminal: GoalSessionTerminalPort;
    messages: GoalSessionMessagePort;
    recovery: GoalSessionRecoveryPort;
}
