import type { GoalModelChangeIntent, GoalSessionState } from './contract.js';

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
    return immediateModelIntents(state).map(intent =>
        intent.modelChangeId === replacement.modelChangeId ? replacement : intent);
}

export function hasUnresolvedImmediateModelIntent(state: GoalSessionState): boolean {
    return immediateModelIntents(state).some(intent =>
        intent.phase !== 'committed' && intent.phase !== 'superseded');
}
