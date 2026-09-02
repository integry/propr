import type {
    GoalExecutionIdentity,
    GoalModelChangeAcknowledgement,
    GoalRepositoryIdentity,
    GoalSessionIdentity,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { isSafeIdentifier } from './safeIdentifier.js';

export interface GoalProviderBarrierIntent {
    generation: number;
    operationId: string;
    kind: 'cancellation' | 'terminal' | 'replacement' | 'lease_expiry';
    phase: 'pending' | 'published';
    claimedAt: string;
    pendingCancellationId?: string;
}

export interface GoalModelInvocationEvidence extends GoalExecutionIdentity {
    modelChangeId: string;
    generation: number;
    occurrenceId: string;
    requestedModel: string;
    effectiveModel: string;
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
    /** Supervisor-minted durable key binding response-loss adoption. */
    deterministicOpenKey?: string;
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
    readonly controllerEpoch: number;
    readonly generation: number;
    readonly operationId: string;
    readonly kind: 'open' | 'turn' | 'resume' | 'reconcile' | 'steer' | 'model' | 'pause' | 'cancel';
    readonly leaseExpiresAt?: string;
    readonly turnId?: string;
    readonly executionId?: string;
    readonly attemptId?: string;
}

/** Closed identity for one real external stage within a logical operation. */
export type GoalProviderEffectStage = 'provider_primitive' | 'stream_first_next' | 'container_spawn';

const PROVIDER_EFFECT_STAGES: ReadonlySet<string> = new Set([
    'provider_primitive', 'stream_first_next', 'container_spawn',
]);
const PROVIDER_OPERATION_KINDS: ReadonlySet<string> = new Set([
    'open', 'turn', 'resume', 'reconcile', 'steer', 'model', 'pause', 'cancel',
]);
const PROVIDER_FENCE_FIELDS = new Set([
    'goalId', 'sessionId', 'controllerEpoch', 'generation', 'operationId', 'kind',
    'leaseExpiresAt', 'turnId', 'executionId', 'attemptId',
]);

/** Runtime boundary for JavaScript callers and values decoded from persistence. */
export function assertGoalProviderEffectStage(value: unknown): asserts value is GoalProviderEffectStage {
    if (typeof value !== 'string' || !PROVIDER_EFFECT_STAGES.has(value)) {
        throw new GoalSessionContractError(
            'Provider effect stage is not one of the three internal stages', 'INVALID_PROVIDER_FENCE',
        );
    }
}

/** Closed runtime decoder for provider fences received from JS and persistence. */
export function assertGoalProviderOperationFence(value: unknown): asserts value is GoalProviderOperationFence {
    let descriptors: PropertyDescriptorMap;
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalidFence();
        descriptors = Object.getOwnPropertyDescriptors(value);
        if (Object.getOwnPropertySymbols(value).length > 0
            || Object.entries(descriptors).some(([key, descriptor]) =>
                !PROVIDER_FENCE_FIELDS.has(key) || !descriptor.enumerable || !('value' in descriptor))) invalidFence();
    } catch (error) {
        if (error instanceof GoalSessionContractError) throw error;
        invalidFence();
    }
    const field = (name: string): unknown => descriptors[name]?.value;
    for (const name of ['goalId', 'sessionId', 'operationId']) {
        if (!isSafeIdentifier(field(name))) invalidFence();
    }
    const kind = field('kind');
    if (typeof kind !== 'string' || !PROVIDER_OPERATION_KINDS.has(kind)) invalidFence();
    for (const name of ['controllerEpoch', 'generation']) {
        const number = field(name);
        if (!Number.isSafeInteger(number) || (number as number) < 0) invalidFence();
    }
    for (const name of ['turnId', 'executionId', 'attemptId']) {
        const candidate = field(name);
        if (candidate !== undefined && !isSafeIdentifier(candidate)) invalidFence();
    }
    const leaseExpiresAt = field('leaseExpiresAt');
    if (leaseExpiresAt !== undefined
        && (typeof leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(leaseExpiresAt)))) invalidFence();
    if ((kind === 'turn' || kind === 'steer')
        && (!field('turnId') || !field('executionId') || !field('attemptId'))) invalidFence();
    if (kind === 'reconcile' && (!field('executionId') || !field('attemptId'))) invalidFence();
}

function invalidFence(): never {
    throw new GoalSessionContractError('Provider operation fence is invalid', 'INVALID_PROVIDER_FENCE');
}

export interface GoalStartedProviderEffectCleanup {
    readonly kind: 'rollback_or_cancel';
    readonly run: () => void | Promise<void>;
}

/**
 * Proof that a provider primitive was synchronously and irrevocably started.
 * The authoritative transaction is committed after this handle is returned;
 * only its completion is awaited after the transaction has released its lock.
 */
export interface GoalStartedProviderEffect<T> {
    readonly completion: Promise<T>;
    /** Owns the already-started primitive if its authoritative transaction fails. */
    readonly cleanup: GoalStartedProviderEffectCleanup;
}

/**
 * Linearizes a provider primitive's first external effect with state invalidation.
 * A production implementation must execute `effect` while holding the same
 * database transaction/serialization lock used by GoalSessionStatePort writes.
 * The callback must start the primitive synchronously and return an explicit
 * non-Promise handle. Implementations reject callbacks that escape through an
 * async return, commit after the handle is obtained, and await completion only
 * after releasing the authoritative transaction.
 */
export interface GoalProviderFirstEffectPort {
    start<T, R>(
        fence: GoalProviderOperationFence,
        stage: GoalProviderEffectStage,
        effect: () => GoalStartedProviderEffect<T>,
        /** Rebuilds a fresh, bounded operation-specific DTO before settlement. */
        rebuild: (value: T) => R,
    ): Promise<R>;
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
