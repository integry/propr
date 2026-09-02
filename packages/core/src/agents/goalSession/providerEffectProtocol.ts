import type {
    GoalProviderFirstEffectPort, GoalProviderOperationFence, GoalProviderResumeRequest,
    GoalResumeIntent, GoalSessionControlFence, GoalStartedProviderEffect,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';

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
export function startedProviderEffect<T>(completion: Promise<T>): GoalStartedProviderEffect<T> {
    if (!completion || typeof completion.then !== 'function') {
        throw new GoalSessionContractError(
            'Provider first effect must expose Promise completion', 'INVALID_FIRST_EFFECT_HANDLE',
        );
    }
    return Object.freeze({ completion });
}

/** Runtime guard for untyped embedders and JavaScript callers. */
export function assertStartedProviderEffect<T>(value: unknown): asserts value is GoalStartedProviderEffect<T> {
    if (value instanceof Promise || !value || typeof value !== 'object'
        || typeof (value as Partial<GoalStartedProviderEffect<T>>).completion?.then !== 'function') {
        throw new GoalSessionContractError(
            'Provider first-effect callback must synchronously return a started-effect handle',
            'ASYNC_FIRST_EFFECT_CALLBACK',
        );
    }
}

/** Defers an async iterable's real first effect to its first `next()` call. */
export function providerFirstEffectStream<T>(
    port: GoalProviderFirstEffectPort,
    fence: GoalProviderOperationFence,
    create: () => AsyncIterable<T>,
): AsyncIterable<T> {
    let iterator: AsyncIterator<T> | undefined;
    let started = false;
    return {
        [Symbol.asyncIterator]: () => ({
            next: async () => {
                if (started) return iterator!.next();
                started = true;
                return port.start(fence, () => {
                    iterator = create()[Symbol.asyncIterator]();
                    return startedProviderEffect(iterator.next());
                });
            },
            return: async () => iterator?.return ? iterator.return() : { done: true, value: undefined },
        }),
    };
}
