import type { GoalSessionIdentity, GoalSessionStatePort } from './contract.js';

const active = new WeakMap<GoalSessionStatePort, Map<string, Set<Promise<void>>>>();

/**
 * Tracks provider side effects in one live process. Durable generations remain
 * authoritative across process replacement; this lets cached acknowledgements
 * wait for older calls before performing their final stable reconciliation.
 */
export async function trackProviderOperation<T>(
    statePort: GoalSessionStatePort,
    identity: GoalSessionIdentity,
    operation: string,
    run: () => Promise<T>,
): Promise<T> {
    let portOperations = active.get(statePort);
    if (!portOperations) {
        portOperations = new Map();
        active.set(statePort, portOperations);
    }
    const key = `${identity.goalId}\0${identity.sessionId}\0${operation}`;
    const operations = portOperations.get(key) ?? new Set<Promise<void>>();
    portOperations.set(key, operations);
    let complete!: () => void;
    const completion = new Promise<void>(resolve => { complete = resolve; });
    operations.add(completion);
    try {
        return await run();
    } finally {
        complete();
        operations.delete(completion);
        if (operations.size === 0) portOperations.delete(key);
    }
}

/** Waits for already-running calls, then lets the caller perform one final stable reconciliation. */
export async function waitForProviderOperations(
    statePort: GoalSessionStatePort,
    identity: GoalSessionIdentity,
    operation: string,
): Promise<void> {
    const key = `${identity.goalId}\0${identity.sessionId}\0${operation}`;
    const operations = active.get(statePort)?.get(key);
    if (!operations?.size) return;
    await Promise.all([...operations.values()]);
}

export function hasProviderOperations(
    statePort: GoalSessionStatePort,
    identity: GoalSessionIdentity,
    operation: string,
): boolean {
    const key = `${identity.goalId}\0${identity.sessionId}\0${operation}`;
    return Boolean(active.get(statePort)?.get(key)?.size);
}
