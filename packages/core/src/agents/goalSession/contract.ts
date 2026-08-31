import type { GoalProviderOperationGuard } from './providerOperationBoundary.js';
export type { GoalModelChangeHistoryPort, GoalModelChangeHistoryRecord, GoalProviderOperationGuard } from './providerOperationBoundary.js';
export type { GoalSessionRecoveryPort, GoalSessionRuntimePorts } from './runtimePorts.js';

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
    /** Mutable checkout checkpoint for diagnostics/resume, never repository identity. */
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
    /** Cancellation/replacement barrier captured for this provider invocation. */
    providerOperationGeneration?: number;
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

/**
 * Durable claim for one adapter reconciliation call. It is intentionally
 * separate from activeTurn: until the adapter reports that it enacted a
 * replacement, the pre-crash attempt remains the authoritative live identity.
 */
export interface GoalRecoveryAttempt {
    /** Stable idempotency/fencing identity for this recovery provider operation. */
    operationToken: string;
    /** Monotonic durable provider fence. A provider must reject a lower generation. */
    operationGeneration: number;
    executionId: string;
    attemptId: string;
    controllerEpoch: number;
    authoritativeAttemptId?: string;
    authoritativeExecutionId?: string;
    /** Exact live status captured by the durable claim. */
    sessionStatus?: GoalSessionStatus;
    authoritativeTurnStatus?: GoalTurnState['status'];
    claimedAt: string;
    /** A replacement may reclaim an abandoned operation only after this durable lease expires. */
    leaseExpiresAt: string;
    /** Claimed work is cancellation-preemptible until the provider call is durably marked in doubt. */
    phase?: 'claimed' | 'provider_in_doubt';
}

export type GoalResumeKind = 'active_turn' | 'after_turn' | 'recovered_after_turn';

/** Durable exclusive claim around one logical resume provider operation. */
export interface GoalResumeIntent extends GoalExecutionIdentity {
    operationId: string;
    operationGeneration: number;
    kind: GoalResumeKind;
    controllerEpoch: number;
    turnId?: string;
    claimedAt: string;
    leaseExpiresAt: string;
    phase: 'claimed' | 'provider_in_doubt' | 'settled';
}

export interface GoalCompletedResume {
    operationId: string;
    operationGeneration: number;
    kind: GoalResumeKind;
    controllerEpoch: number;
}

/** Atomic recovery-result receipt used to replay an ambiguous committed transaction. */
export interface GoalCompletedRecovery {
    operationToken: string;
    controllerEpoch: number;
    outcome: 'alive' | 'resumed' | 'failed';
    reason: string;
}

/** Durable cancellation claim recorded before the provider cancellation side effect. */
export interface GoalCancellationIntent {
    /** Stable provider idempotency identity, retained through terminal recovery. */
    cancellationId: string;
    reason: string;
    claimedAt: string;
    /** Captured before activeTurn is cleared so lazy-ID cancellation can target the old invocation. */
    pendingContext?: GoalPendingCancellationContext;
}

/** Durable model side-effect intent recorded before calling the provider. */
export interface GoalModelChangeIntent {
    /** Stable provider idempotency identity used for every recovery retry. */
    modelChangeId: string;
    model: string;
    requestedAt: string;
    /** Monotonic session-local ordering for external provider application. */
    generation?: number;
    /** Stable audit predecessor captured when this generation is accepted. */
    previousModel?: string;
    /** Durable provider-call phase; missing is treated as pending for older records. */
    phase?: 'pending' | 'provider_in_doubt' | 'committed' | 'superseded_in_doubt' | 'superseded';
    /** Unique lease owner for one generation-scoped provider application attempt. */
    applicationToken?: string;
    /** Controller generation that owns applicationToken. */
    applicationControllerEpoch?: number;
    /** Durable recovery deadline for a process that disappears during provider application. */
    leaseExpiresAt?: string;
    /** Retained after commit so an ambiguous retry can return the original acknowledgement. */
    acknowledgement?: GoalModelChangeAcknowledgement;
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
    /** Durable obligation to record an after-turn pause boundary with completion. */
    pendingAfterTurnPause?: boolean;
    activeTurn?: GoalTurnState;
    completedTurnIds: string[];
    /** Execution identity of each completed turn, keyed by turnId order of completion. */
    completedTurns?: GoalCompletedTurn[];
    /** Present while a first provider open is in-flight; cleared once persisted. */
    initializationIntent?: GoalSessionInitializationIntent;
    /** Last durably claimed provider open/resume invocation attempt. */
    providerOpenAttemptId?: string;
    providerOpenOperationGeneration?: number;
    /** A crashed first-turn invocation that may be retried with a fresh attempt. */
    retryTurn?: { turnId: string; executionId: string; crashedAttemptId: string };
    /** Last durably claimed reconciliation invocation attempt. */
    recoveryAttemptId?: string;
    /** In-flight reconciliation claim, retained across a thrown call or crash. */
    recoveryAttempt?: GoalRecoveryAttempt;
    /** Last atomically committed reconciliation receipt for same-epoch replay. */
    completedRecovery?: GoalCompletedRecovery;
    /** Last allocated generation across recovery/resume provider operations. */
    providerOperationGeneration?: number;
    resumeIntent?: GoalResumeIntent;
    completedResume?: GoalCompletedResume;
    /** In-flight or completed cancellation identity. Active turn ownership is cleared when this is claimed. */
    cancellationIntent?: GoalCancellationIntent;
    /** Provider model application/reconciliation identity retained across crashes. */
    modelChangeIntent?: GoalModelChangeIntent;
    /**
     * Ordered immediate-model generations. Unresolved work and a bounded settled
     * retry window are retained; canonical audit history lives in the event log.
     */
    modelChangeIntents?: GoalModelChangeIntent[];
    /** Last allocated immediate-model generation. */
    modelChangeGeneration?: number;
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
    | { type: 'pause_boundary'; boundary: string; checkpointId?: string; providerEventId?: string; providerEventOrdinal?: number }
    | { type: 'session_resumed' }
    | { type: 'model_change_acknowledged'; requestedModel: string; appliesAt: 'immediate' | 'next_safe_boundary' | 'next_turn' }
    | { type: 'model_changed'; previousModel?: string; model: string; providerEventId?: string; providerEventOrdinal?: number }
    | { type: 'turn_resumed'; turnId: string }
    | { type: 'reconciliation'; outcome: 'alive' | 'resumed' | 'failed' | 'blocked'; reason: string }
    | { type: 'completion'; outcome: 'succeeded' | 'failed' | 'cancelled'; summary?: string; error?: string };

/** Required occurrence identity contract for provider-streamed atomic transitions. */
export type GoalProviderStreamTransitionEvent = Extract<
    GoalSessionEvent,
    { type: 'model_changed' | 'pause_boundary' }
> & (
    | { providerEventId: string; providerEventOrdinal?: number }
    | { providerEventId?: undefined; providerEventOrdinal: number }
);

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

export interface GoalSessionControlTransition {
    /** Stable idempotency identity for ambiguous post-commit recovery. */
    transitionId: string;
    /** A turn fence makes the transaction authoritative only for the exact live invocation. */
    fence: GoalSessionControlFence | GoalSessionFence;
    /** Explicit because a control request may carry an ignored excess turnId property at runtime. */
    turnScoped?: true;
    execution: GoalExecutionIdentity;
    auditEvents: ReadonlyArray<Exclude<GoalSessionEvent, { type: 'completion' }>>;
}

/** Atomically commits nonterminal state and its canonical ordered audit events. */
export interface GoalSessionTransitionPort {
    commit(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        transition: GoalSessionControlTransition,
    ): Promise<GoalSessionState | null>;
}

export type GoalTerminalCommit =
    | {
        scope: 'turn';
        fence: GoalSessionFence;
        execution: GoalExecutionIdentity;
        /** Ordered audit events committed immediately before terminal completion. */
        auditEvents: ReadonlyArray<Exclude<GoalSessionEvent, { type: 'completion' }>>;
        event: Extract<GoalSessionEvent, { type: 'completion' }>;
    }
    | {
        scope: 'control';
        fence: GoalSessionControlFence;
        execution: GoalExecutionIdentity;
        /** Ordered audit events committed immediately before terminal completion. */
        auditEvents: ReadonlyArray<Exclude<GoalSessionEvent, { type: 'completion' }>>;
        event: Extract<GoalSessionEvent, { type: 'completion' }>;
    };

/**
 * Commits terminal state and its ordered audit/completion events in one durable transaction.
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
    /** Atomically consumes the message and appends its canonical acknowledgement event. */
    acknowledgeWithEvent(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        messageId: string,
    ): Promise<'acknowledged' | 'already_acknowledged' | 'stale_fence' | 'not_found'>;
}

export interface GoalProviderOpenRequest extends GoalSessionIdentity {
    provider: string;
    controllerEpoch: number;
    attemptId: string;
    operationGeneration: number;
    operationGuard: GoalProviderOperationGuard;
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
    operationGeneration: number;
    operationGuard: GoalProviderOperationGuard;
    /**
     * FIFO messages reserved for acceptance by a next-turn-only provider. The
     * provider must acknowledge every supplied ID before reporting success.
     */
    correctiveMessages?: GoalProviderCorrectiveMessage[];
    /** Present when this invocation settles a durable recovered-resume claim. */
    providerOperation?: Pick<GoalProviderResumeRequest, 'operationId' | 'operationGeneration' | 'operationPhase' | 'operationLeaseExpiresAt' | 'kind'>;
}

export interface GoalProviderCorrectiveMessage {
    messageId: string;
    sequence: number;
    body: string;
}

/** Legacy-compatible supervisor command; the provider never receives this weaker shape. */
export interface GoalSteeringCommand extends GoalSessionFence {
    executionId?: string;
    attemptId?: string;
    messageId: string;
    body: string;
}

export interface GoalSteeringRequest extends GoalSessionFence, GoalExecutionIdentity {
    messageId: string; body: string;
    operationGeneration: number; operationGuard: GoalProviderOperationGuard;
}

export interface GoalPauseRequest extends GoalSessionControlFence {
    reason?: string;
    operationGeneration?: number;
    operationGuard?: GoalProviderOperationGuard;
}

export interface GoalModelChangeRequest extends GoalSessionControlFence {
    model: string;
    /** Stable caller identity for direct retry within the supported durable horizon. */
    operationId?: string;
}

/** Provider request; retries with the same modelChangeId must not repeat the external side effect. */
export interface GoalProviderModelChangeRequest extends GoalModelChangeRequest {
    modelChangeId: string;
    /**
     * Durable monotonic application order. Providers must fence older generations
     * after observing a newer one, including delayed completion of an older call.
     */
    applicationGeneration: number;
    operationGeneration: number;
    operationGuard: GoalProviderOperationGuard;
}

export interface GoalCancelRequest extends GoalSessionControlFence {
    reason: string;
}

/** Provider request; retries with the same cancellationId must be idempotent. */
export interface GoalProviderCancelRequest extends GoalCancelRequest {
    cancellationId: string;
    operationGeneration: number;
    operationGuard: GoalProviderOperationGuard;
}
/** Identity available while a lazy-ID provider has not emitted its first checkpoint. */
export interface GoalPendingCancellationContext {
    initializationIntent: GoalSessionInitializationIntent;
    activeTurn?: Pick<GoalTurnState, 'turnId' | 'executionId' | 'attemptId'>;
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
    /** Operator pause cannot retain a resumable active invocation at this boundary. */
    disposition: 'unsupported_same_turn';
    supportedBoundary: 'after_turn';
};

export interface GoalModelChangeAcknowledgement {
    outcome?: 'acknowledged' | 'outside_retry_horizon';
    requestedModel: string;
    appliesAt: 'immediate' | 'next_safe_boundary' | 'next_turn';
    effectiveModel?: string;
}

export interface GoalProviderReconcileRequest extends GoalSessionIdentity, GoalExecutionIdentity {
    controllerEpoch: number;
    /** Durable recovery operation identity; retries/replacements must be fenced by the provider primitive. */
    operationToken: string;
    operationGeneration: number;
    operationPhase: 'provider_in_doubt';
    operationLeaseExpiresAt: string;
    operationGuard: GoalProviderOperationGuard;
    persisted: GoalProviderSessionSnapshot;
    repository: GoalRepositoryInspection;
    container: GoalContainerInspection;
}

export interface GoalProviderResumeRequest extends GoalSessionControlFence {
    operationId: string;
    operationGeneration: number;
    operationPhase: 'provider_in_doubt' | 'settled';
    operationLeaseExpiresAt: string;
    kind: GoalResumeKind;
    operationGuard: GoalProviderOperationGuard;
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
 * requestModelChange must be idempotent by modelChangeId and monotonically
 * fenced by applicationGeneration so recovery after a provider-success/
 * persistence-crash window never applies one intent twice and a delayed older
 * generation cannot overwrite a newer provider effect.
 * cancel and cancelPending must likewise be idempotent by cancellationId because
 * a crash can occur after signalling the provider but before the terminal
 * transaction is observed by the caller.
 * reconcile/resume primitives must durably reject an expired lease or an
 * operationGeneration below the newest generation they have observed, before
 * starting any provider side effect. operationId/token supplies idempotency;
 * generation supplies replacement/cancellation ordering.
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
    /**
     * Every model_changed and pause_boundary occurrence must carry a non-empty
     * providerEventId or a stable non-negative providerEventOrdinal. If both are
     * present, providerEventId is the canonical occurrence identity.
     */
    beginTurn(request: GoalBeginTurnRequest, context: GoalProviderTurnContext): AsyncIterable<GoalSessionEvent>;
    /**
     * Continues the exact active turn identified by the fence after a pause or a
     * container/supervisor restart. The provider resumes from the durable
     * checkpoint and streams further ordered events through to a single
     * completion; it must not start a new logical turn.
     */
    resumeTurn?(request: GoalSessionFence & GoalExecutionIdentity & GoalProviderResumeRequest, snapshot: GoalProviderSessionSnapshot): AsyncIterable<GoalSessionEvent>;
    deliverMessage?(request: GoalSteeringRequest, snapshot: GoalProviderSessionSnapshot): Promise<{ messageId: string }>;
    requestPause?(request: GoalPauseRequest, snapshot: GoalProviderSessionSnapshot): Promise<GoalPauseAcknowledgement>;
    resumeSession(request: GoalProviderResumeRequest, snapshot: GoalProviderSessionSnapshot): Promise<GoalProviderSessionSnapshot>;
    requestModelChange(request: GoalProviderModelChangeRequest, snapshot: GoalProviderSessionSnapshot): Promise<GoalModelChangeAcknowledgement>;
    cancel(request: GoalProviderCancelRequest, snapshot: GoalProviderSessionSnapshot): Promise<void>;
    /** Cancels an invocation/container before a native provider session ID exists. */
    cancelPending?(request: GoalProviderCancelRequest, pending: GoalPendingCancellationContext): Promise<void>;
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
    /** Repository URL/name read from Git rather than copied from the request. */
    observedRepository?: string;
    observedHeadSha?: string;
    observedBranch?: string;
    observedWorktreeFingerprint?: string;
    resolvedWorktreePath?: string;
    reason?: string;
}
