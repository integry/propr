import type {
    GoalProviderFirstEffectPort, GoalProviderOperationFence, GoalProviderResumeRequest,
    GoalResumeIntent, GoalSessionAdapter, GoalSessionControlFence, GoalSessionState, GoalStartedProviderEffect,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { persistedSnapshot } from './support.js';
import { assertGoalProviderEffectStage } from './providerOperationBoundary.js';

const STARTED_PROVIDER_EFFECTS = new WeakSet<object>();

type OperationIdentity = Pick<GoalProviderOperationFence, 'kind' | 'operationId' | 'leaseExpiresAt'>
    & Partial<Pick<GoalProviderOperationFence, 'turnId' | 'executionId' | 'attemptId'>>;

export function createProviderOperationFence(
    identity: GoalSessionControlFence,
    generation: number,
    operation: OperationIdentity,
): GoalProviderOperationFence {
    return {
        goalId: identity.goalId, sessionId: identity.sessionId,
        controllerEpoch: identity.controllerEpoch, generation,
        kind: operation.kind, operationId: operation.operationId,
        leaseExpiresAt: operation.leaseExpiresAt, turnId: operation.turnId,
        executionId: operation.executionId, attemptId: operation.attemptId,
    };
}

export function createProviderResumeRequest(
    fence: GoalSessionControlFence,
    intent: GoalResumeIntent,
): GoalProviderResumeRequest {
    return {
        goalId: fence.goalId, sessionId: fence.sessionId, controllerEpoch: fence.controllerEpoch,
        operationId: intent.operationId, operationGeneration: intent.operationGeneration,
        operationPhase: intent.phase === 'settled' ? 'settled' : 'provider_in_doubt', kind: intent.kind,
        operationLeaseExpiresAt: intent.leaseExpiresAt,
        operationFence: createProviderOperationFence(fence, intent.operationGeneration, {
            kind: 'resume', operationId: intent.operationId, leaseExpiresAt: intent.leaseExpiresAt,
            turnId: intent.turnId, executionId: intent.executionId, attemptId: intent.attemptId,
        }),
    };
}

/** Builds the only value accepted from a synchronous first-effect callback. */
export function startedProviderEffect<T>(
    completion: Promise<T>,
    rollbackOrCancel: () => void | Promise<void>,
): GoalStartedProviderEffect<T> {
    if (!isExactNativePromise(completion) || typeof rollbackOrCancel !== 'function') {
        throw new GoalSessionContractError(
            'Provider first effect must expose native completion and cleanup ownership', 'INVALID_FIRST_EFFECT_HANDLE',
        );
    }
    // Observe rejection at ownership acceptance, before a receipt/COMMIT failure
    // can divert control into cleanup. The original promise remains unchanged
    // and still rejects for its normal consumer.
    void completion.catch(() => undefined);
    const cleanup = Object.freeze({ kind: 'rollback_or_cancel' as const, run: rollbackOrCancel });
    const handle = Object.create(null) as GoalStartedProviderEffect<T>;
    Object.defineProperties(handle, {
        completion: { value: completion, enumerable: true },
        cleanup: { value: cleanup, enumerable: true },
    });
    STARTED_PROVIDER_EFFECTS.add(handle);
    return Object.freeze(handle);
}

/** Runtime guard for untyped embedders and JavaScript callers. */
export function assertStartedProviderEffect<T>(value: unknown): asserts value is GoalStartedProviderEffect<T> {
    if (!isExactStartedProviderEffect<T>(value)) {
        throw new GoalSessionContractError(
            'Provider first-effect callback must synchronously return a started-effect handle',
            'ASYNC_FIRST_EFFECT_CALLBACK',
        );
    }
}

export async function cleanupStartedProviderEffect(value: GoalStartedProviderEffect<unknown>): Promise<void> {
    await value.cleanup.run();
}

export function startedProviderEffectCleanup(value: unknown): GoalStartedProviderEffect<unknown>['cleanup'] | undefined {
    if (!value || typeof value !== 'object') return undefined;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, 'cleanup');
        return descriptor && !('get' in descriptor) && isExactCleanup(descriptor.value)
            ? descriptor.value as GoalStartedProviderEffect<unknown>['cleanup'] : undefined;
    } catch { return undefined; }
}

export async function rollbackStartedProviderPrimitive(
    adapter: GoalSessionAdapter,
    fence: GoalProviderOperationFence,
    state: GoalSessionState,
): Promise<void> {
    const request = {
        goalId: fence.goalId, sessionId: fence.sessionId, controllerEpoch: fence.controllerEpoch,
        reason: 'Authoritative provider-effect transaction failed after start',
        cancellationId: fence.operationId, operationGeneration: fence.generation,
        operationFence: { ...fence, kind: 'cancel' as const },
    };
    if (!state.providerSessionId && state.initializationIntent && adapter.cancelPending) {
        await adapter.cancelPending(request, {
            initializationIntent: state.initializationIntent,
            activeTurn: state.activeTurn ? {
                turnId: state.activeTurn.turnId,
                executionId: state.activeTurn.executionId,
                attemptId: state.activeTurn.attemptId,
            } : undefined,
        });
        return;
    }
    await adapter.cancel(request, persistedSnapshot(state));
}

function isExactStartedProviderEffect<T>(value: unknown): value is GoalStartedProviderEffect<T> {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== null || !Object.isFrozen(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.keys(descriptors);
    const symbols = Object.getOwnPropertySymbols(value);
    if (names.length !== 2 || !names.includes('completion') || !names.includes('cleanup')
        || symbols.length !== 0 || !STARTED_PROVIDER_EFFECTS.has(value)) return false;
    const completion = descriptors.completion;
    const cleanup = descriptors.cleanup;
    if (!completion || 'get' in completion || !isExactNativePromise(completion.value)
        || !cleanup || 'get' in cleanup || !isExactCleanup(cleanup.value)) return false;
    return !Object.hasOwn(value, 'then');
}

function isExactCleanup(value: unknown): boolean {
    if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(descriptors).length === 2
        && descriptors.kind?.value === 'rollback_or_cancel'
        && typeof descriptors.run?.value === 'function'
        && !('get' in descriptors.kind) && !('get' in descriptors.run);
}

function isExactNativePromise(value: unknown): value is Promise<unknown> {
    return value instanceof Promise && Object.getPrototypeOf(value) === Promise.prototype
        && !Object.hasOwn(value, 'then');
}

/** Defers an async iterable's real first effect to its first `next()` call. */
export function providerFirstEffectStream<T>(
    port: GoalProviderFirstEffectPort,
    fence: GoalProviderOperationFence,
    create: () => AsyncIterable<T>,
): AsyncIterable<T> {
    assertGoalProviderEffectStage('stream_first_next');
    let iterator: AsyncIterator<T> | undefined;
    let started = false;
    return {
        [Symbol.asyncIterator]: () => ({
            next: async () => {
                if (started) return iterator!.next();
                started = true;
                return port.start(fence, 'stream_first_next', () => {
                    iterator = create()[Symbol.asyncIterator]();
                    if (!iterator.return) throw new GoalSessionContractError(
                        'Provider stream must expose synchronous cancellation ownership', 'INVALID_FIRST_EFFECT_HANDLE',
                    );
                    const completion = iterator.next();
                    return startedProviderEffect(completion, async () => { await iterator!.return!(); });
                });
            },
            return: async () => iterator?.return ? iterator.return() : { done: true, value: undefined },
        }),
    };
}
