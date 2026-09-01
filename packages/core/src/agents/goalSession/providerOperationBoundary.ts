import type {
    GoalExecutionIdentity,
    GoalModelChangeAcknowledgement,
    GoalRepositoryIdentity,
    GoalSessionIdentity,
} from './contract.js';

export interface GoalProviderBarrierIntent {
    generation: number;
    operationId: string;
    kind: 'cancellation' | 'terminal' | 'replacement' | 'lease_expiry';
    phase: 'pending' | 'published';
    claimedAt: string;
    pendingCancellationId?: string;
}

export interface GoalModelInvocationEvidence extends GoalExecutionIdentity {
    occurrenceId: string;
    acceptedAt: string;
}

export interface GoalUsageAccounting {
    version: 1;
    lastWatermark: number;
    occurrences: string[];
}

export interface GoalProviderDuplexTransport {
    readonly output: AsyncIterable<string>;
    write(message: string): Promise<void>;
    closeInput(): void;
    cancel(): Promise<void>;
    readonly completion: Promise<{ exitCode: number | null }>;
}

export interface GoalProviderOpenContext extends GoalExecutionIdentity {
    repository: GoalRepositoryIdentity;
    requestedModel: string;
    providerHomeTarget: string;
    credentialTargets: string[];
    transport: GoalProviderDuplexTransport;
}

/**
 * Serializable capability presented to the provider primitive at its first
 * external effect. It contains no process-local callback or object identity.
 * The provider atomically compares generation against its durable high-water
 * mark and rejects a lower generation before opening a process, stream, socket,
 * repository, container, or remote request.
 * A present leaseExpiresAt is compared in that same atomic effect transaction.
 */
export interface GoalProviderOperationFence extends GoalSessionIdentity {
    readonly generation: number;
    readonly operationId: string;
    readonly kind: 'open' | 'turn' | 'resume' | 'reconcile' | 'steer' | 'model' | 'pause' | 'cancel';
    readonly leaseExpiresAt?: string;
}

/** Monotonic provider-visible high-water publication. */
export interface GoalProviderBarrierPublication extends GoalSessionIdentity {
    readonly generation: number;
    readonly publishedAt: string;
    /** Cancellation remains addressable after a bounded caller timeout. */
    readonly pendingCancellationId?: string;
}

export interface GoalModelChangeHistoryRecord {
    operationId: string;
    model: string;
    /** Atomically allocated, unique and strictly increasing within goal/session scope. */
    sequence: number;
    status: 'pending' | 'settled' | 'retired';
    acknowledgement?: GoalModelChangeAcknowledgement;
}

/**
 * Exact durable addressability ledger, stored separately from bounded session
 * state. claim allocates sequence in the same transaction as the unique
 * (scope, operationId) insert. Concurrent callers either observe the one exact
 * row or retry a uniqueness/busy conflict; they never derive ordering from an
 * aggregate read. settle atomically records the acknowledgement and retires
 * settled rows older than the deterministic newest 64. Retired exact
 * tombstones remain addressable and never use probabilistic membership.
 */
export interface GoalModelChangeHistoryPort {
    claim(identity: GoalSessionIdentity, operationId: string, model: string): Promise<GoalModelChangeHistoryRecord>;
    settle(
        identity: GoalSessionIdentity,
        operationId: string,
        acknowledgement: GoalModelChangeAcknowledgement,
    ): Promise<void>;
}
