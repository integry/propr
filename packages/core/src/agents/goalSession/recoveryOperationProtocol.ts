import type {
    GoalExecutionIdentity, GoalSessionState,
} from './contract.js';
import { StaleGoalSessionFenceError } from './errors.js';

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

export function assertRecoverableExactState(state: GoalSessionState, controllerEpoch: number): void {
    if (state.controllerEpoch !== controllerEpoch || !isRecoverableStatus(state.status)) {
        throw new StaleGoalSessionFenceError('Session is no longer in an exact recoverable live state');
    }
    const recovery = state.recoveryAttempt;
    const changed = recovery?.authoritativeAttemptId !== undefined
        && recovery.authoritativeAttemptId !== state.activeTurn?.attemptId
        || recovery?.authoritativeExecutionId !== undefined
        && recovery.authoritativeExecutionId !== state.activeTurn?.executionId
        || recovery?.sessionStatus !== undefined && recovery.sessionStatus !== state.status
        || recovery?.authoritativeTurnStatus !== undefined
        && recovery.authoritativeTurnStatus !== state.activeTurn?.status;
    if (changed) throw new StaleGoalSessionFenceError('The authoritative recovery subject changed');
}

export function assertLiveRecoveryLease(
    state: GoalSessionState,
    execution: GoalExecutionIdentity,
    operationToken: string,
): void {
    assertRecoverableExactState(state, state.controllerEpoch);
    const recovery = state.recoveryAttempt;
    if (!recovery || recovery.operationToken !== operationToken
        || recovery.executionId !== execution.executionId || recovery.attemptId !== execution.attemptId
        || recovery.phase !== 'provider_in_doubt'
        || recovery.operationGeneration !== state.providerOperationGeneration
        || Date.parse(recovery.leaseExpiresAt) <= Date.now()) {
        throw new StaleGoalSessionFenceError('Reconciliation provider operation was durably preempted');
    }
}

export function completedRecoveryResult(state: GoalSessionState, controllerEpoch: number): {
    outcome: 'alive' | 'resumed' | 'failed'; reason: string; state: GoalSessionState;
} | null {
    const recovery = state.completedRecovery;
    if (state.controllerEpoch !== controllerEpoch || recovery?.controllerEpoch !== controllerEpoch
        || state.status === 'cancelling' || state.status === 'terminated') return null;
    return { outcome: recovery.outcome, reason: recovery.reason, state };
}
