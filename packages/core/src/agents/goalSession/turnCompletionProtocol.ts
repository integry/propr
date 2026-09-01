import type { GoalSessionEvent, GoalSessionState } from './contract.js';

export function completesAtAfterTurnPause(
    state: GoalSessionState,
    outcome: Extract<GoalSessionEvent, { type: 'completion' }>['outcome'],
    pauseCapability: 'active_turn' | 'after_turn',
): boolean {
    return outcome === 'succeeded'
        && pauseCapability === 'after_turn'
        && (state.status === 'pause_requested'
            || state.status === 'paused'
            || state.pendingAfterTurnPause === true);
}

export function needsAfterTurnPauseAudit(
    state: GoalSessionState,
    outcome: Extract<GoalSessionEvent, { type: 'completion' }>['outcome'],
    pauseCapability: 'active_turn' | 'after_turn',
): boolean {
    return completesAtAfterTurnPause(state, outcome, pauseCapability)
        && (state.status === 'pause_requested' || state.pendingAfterTurnPause === true);
}
