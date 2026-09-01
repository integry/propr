import type {
    GoalSessionControlFence, GoalSessionRuntimePorts, GoalSessionState,
} from './contract.js';
import { nextState } from './support.js';

const PROVIDER_BOUNDARY_TIMEOUT_MS = 1_000;

/** Bounds an adapter barrier without leaving a late rejection unobserved. */
export async function boundedProviderBoundary<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Provider boundary timed out')), PROVIDER_BOUNDARY_TIMEOUT_MS);
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
        void operation.catch(() => undefined);
    }
}

/** Stages lease expiry durably, publishes it, then records replay completion. */
export async function expireResumeLease(options: {
    ports: GoalSessionRuntimePorts;
    fence: GoalSessionControlFence;
    operationId: string;
    operationGeneration: number;
    load: () => Promise<GoalSessionState>;
    publish: (state: GoalSessionState, generation: number) => Promise<void>;
}): Promise<void> {
    const state = await options.load();
    const intent = state.resumeIntent;
    if (!intent || intent.operationId !== options.operationId
        || intent.operationGeneration !== options.operationGeneration
        || state.providerBarrierIntent?.phase === 'pending') return;
    const generation = (state.providerOperationGeneration ?? 0) + 1;
    const barrierOperationId = `${options.operationId}:lease-expiry`;
    const staged = await options.ports.state.compareAndSet(state, nextState(state, {
        providerOperationGeneration: generation,
        resumeIntent: { ...intent, leaseExpiresAt: new Date(0).toISOString() },
        providerBarrierIntent: {
            generation, operationId: barrierOperationId, kind: 'lease_expiry', phase: 'pending',
            claimedAt: new Date().toISOString(),
        },
    }));
    if (!staged) return;
    await options.publish(staged, generation);
    const current = await options.load();
    if (current.providerBarrierIntent?.operationId !== barrierOperationId) return;
    await options.ports.state.compareAndSet(current, nextState(current, {
        providerBarrierIntent: { ...current.providerBarrierIntent, phase: 'published' },
    }));
}

export async function expireRecoveryLease(options: {
    ports: GoalSessionRuntimePorts;
    fence: GoalSessionControlFence;
    operationToken: string;
    load: () => Promise<GoalSessionState>;
    publish: (generation: number) => Promise<void>;
}): Promise<void> {
    const state = await options.load();
    const recovery = state.recoveryAttempt;
    if (!recovery || recovery.operationToken !== options.operationToken
        || state.providerBarrierIntent?.phase === 'pending') return;
    const generation = (state.providerOperationGeneration ?? 0) + 1;
    const operationId = `${options.operationToken}:lease-expiry`;
    const staged = await options.ports.state.compareAndSet(state, nextState(state, {
        providerOperationGeneration: generation,
        recoveryAttempt: { ...recovery, leaseExpiresAt: new Date(0).toISOString() },
        providerBarrierIntent: {
            generation, operationId, kind: 'lease_expiry', phase: 'pending',
            claimedAt: new Date().toISOString(),
        },
    }));
    if (!staged) return;
    await options.publish(generation);
    const current = await options.load();
    if (current.providerBarrierIntent?.operationId !== operationId) return;
    await options.ports.state.compareAndSet(current, nextState(current, {
        providerBarrierIntent: { ...current.providerBarrierIntent, phase: 'published' },
    }));
}
