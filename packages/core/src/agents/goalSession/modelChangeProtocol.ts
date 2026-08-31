import type { GoalModelChangeIntent, GoalSessionState } from './contract.js';

/**
 * Settled generations kept for ambiguous controller retries. Provider-side
 * idempotency identities older than this window have no live local caller and
 * their ordered audit evidence remains in the append-only event stream.
 */
export const MODEL_CHANGE_SETTLED_RETRY_HORIZON = 64;

function isSettled(intent: GoalModelChangeIntent): boolean {
    return intent.phase === 'committed' || intent.phase === 'superseded';
}

/**
 * Deterministically bounds settled intent history without ever removing an
 * unresolved provider obligation. The newest generation is retained even for
 * legacy records whose phase was omitted.
 */
export function compactImmediateModelIntents(
    intents: readonly GoalModelChangeIntent[],
): GoalModelChangeIntent[] {
    if (intents.length <= MODEL_CHANGE_SETTLED_RETRY_HORIZON) return [...intents];
    const settledToRetain = new Set(
        intents
            .filter(isSettled)
            .slice(-MODEL_CHANGE_SETTLED_RETRY_HORIZON)
            .map(intent => intent.modelChangeId),
    );
    const latestId = intents.at(-1)?.modelChangeId;
    return intents.filter(intent =>
        !isSettled(intent) || settledToRetain.has(intent.modelChangeId) || intent.modelChangeId === latestId);
}

export function immediateModelIntents(state: GoalSessionState): GoalModelChangeIntent[] {
    if (state.modelChangeIntents?.length) return state.modelChangeIntents;
    return state.modelChangeIntent ? [state.modelChangeIntent] : [];
}

export function latestImmediateModelIntent(state: GoalSessionState): GoalModelChangeIntent | undefined {
    return immediateModelIntents(state).at(-1);
}

export function nextModelGeneration(state: GoalSessionState): number {
    const durableMaximum = immediateModelIntents(state).reduce(
        (maximum, intent) => Math.max(maximum, intent.generation ?? 0),
        0,
    );
    return Math.max(state.modelChangeGeneration ?? 0, durableMaximum) + 1;
}

export function replaceImmediateModelIntent(
    state: GoalSessionState,
    replacement: GoalModelChangeIntent,
): GoalModelChangeIntent[] {
    return compactImmediateModelIntents(immediateModelIntents(state).map(intent =>
        intent.modelChangeId === replacement.modelChangeId ? replacement : intent));
}

export function hasUnresolvedImmediateModelIntent(state: GoalSessionState): boolean {
    return immediateModelIntents(state).some(intent =>
        intent.phase !== 'committed' && intent.phase !== 'superseded');
}
