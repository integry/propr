import type {
    GoalExecutionIdentity,
    GoalProviderReconcileResult,
    GoalSessionState,
    GoalSessionStatus,
    GoalTurnState,
} from './contract.js';

/**
 * Applies a proven reconciliation outcome to the active turn. Merely observing
 * the old container as alive leaves its identity untouched. Only a resumed
 * outcome promotes the fresh reconciliation attempt to authoritative state.
 */
export function reconcileRecoveredTurn(
    state: GoalSessionState,
    execution: GoalExecutionIdentity,
    outcome: GoalProviderReconcileResult['outcome'],
): { status: GoalSessionStatus; activeTurn: GoalTurnState | undefined } {
    if (outcome === 'failed') return { status: 'failed', activeTurn: state.activeTurn };
    if (outcome !== 'resumed') return { status: state.status, activeTurn: state.activeTurn };
    const turn = state.activeTurn;
    if (turn && (turn.status === 'running' || turn.status === 'pause_requested' || turn.status === 'paused')) {
        return {
            status: 'paused',
            activeTurn: {
                ...turn,
                ...execution,
                executionEpoch: state.controllerEpoch,
                status: 'paused',
            },
        };
    }
    return { status: 'idle', activeTurn: turn };
}
