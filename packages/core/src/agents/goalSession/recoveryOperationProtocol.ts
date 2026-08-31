import type { GoalSessionState } from './contract.js';

export const RECOVERY_LEASE_MS = 30_000;

const RECOVERABLE_STATUSES = new Set<GoalSessionState['status']>([
    'initializing', 'idle', 'running', 'pause_requested', 'paused',
]);

export function isRecoverableStatus(status: GoalSessionState['status']): boolean {
    return RECOVERABLE_STATUSES.has(status);
}

export function stoppedReconciliationResult(state: GoalSessionState): {
    outcome: 'blocked'; reason: string; state: GoalSessionState;
} | null {
    if (isRecoverableStatus(state.status)) return null;
    return {
        outcome: 'blocked',
        reason: state.status === 'cancelling'
            ? 'Cancellation recovery must complete without reconciling provider work'
            : `A ${state.status} session cannot be reconciled`,
        state,
    };
}

export function sameRecoverySubject(expected: GoalSessionState, current: GoalSessionState): boolean {
    return expected.controllerEpoch === current.controllerEpoch
        && isRecoverableStatus(current.status)
        && expected.status === current.status
        && expected.providerSessionId === current.providerSessionId
        && expected.activeTurn?.turnId === current.activeTurn?.turnId
        && expected.activeTurn?.executionId === current.activeTurn?.executionId
        && expected.activeTurn?.attemptId === current.activeTurn?.attemptId
        && expected.activeTurn?.status === current.activeTurn?.status
        && expected.activeTurn?.executionEpoch === current.activeTurn?.executionEpoch;
}
