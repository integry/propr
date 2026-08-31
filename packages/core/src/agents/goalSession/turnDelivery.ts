import type { GoalExecutionIdentity, GoalSessionState } from './contract.js';

export type RunGoalTurnResult =
    | { disposition: 'started'; state: GoalSessionState; execution: GoalExecutionIdentity }
    /** A redelivery observes durable state and never invokes or completes the provider itself. */
    | { disposition: 'duplicate'; reattached: boolean; state: GoalSessionState; execution: GoalExecutionIdentity };

export function duplicateTurnResult(
    state: GoalSessionState,
    turnId: string,
    fallback: GoalExecutionIdentity,
): RunGoalTurnResult | undefined {
    if (state.activeTurn?.turnId === turnId) {
        const execution = { executionId: state.activeTurn.executionId, attemptId: state.activeTurn.attemptId };
        return { disposition: 'duplicate', reattached: true, state, execution };
    }
    if (!state.completedTurnIds.includes(turnId)) return undefined;
    const recorded = state.completedTurns?.find(turn => turn.turnId === turnId);
    if (recorded) {
        return {
            disposition: 'duplicate',
            reattached: true,
            state,
            execution: { executionId: recorded.executionId, attemptId: recorded.attemptId },
        };
    }
    return { disposition: 'duplicate', reattached: false, state, execution: fallback };
}
