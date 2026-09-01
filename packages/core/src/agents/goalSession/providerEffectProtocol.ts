import type {
    GoalProviderFirstEffectPort, GoalProviderOperationFence, GoalProviderResumeRequest,
    GoalResumeIntent, GoalSessionControlFence,
} from './contract.js';

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
                    return iterator.next();
                });
            },
            return: async () => iterator?.return ? iterator.return() : { done: true, value: undefined },
        }),
    };
}
