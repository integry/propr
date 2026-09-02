import type { GoalSessionState, GoalSessionStatePort } from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { safeFailureDiagnostic } from './securityBoundary.js';
import { nextState } from './support.js';

export async function throwPersistedProviderOpenFailure(
    statePort: GoalSessionStatePort,
    state: GoalSessionState,
    error: unknown,
): Promise<never> {
    if (error instanceof GoalSessionContractError && error.code === 'PROVIDER_OPEN_IN_DOUBT') {
        const failed = await statePort.compareAndSet(state, nextState(state, {
            status: 'failed', initializationIntent: undefined,
            failureReason: 'Codex provider open is durably in doubt; automatic reopen is disabled',
        }));
        if (!failed) throw new StaleGoalSessionFenceError(
            'Session ownership changed while provider-open doubt was being persisted',
        );
        throw error;
    }
    if (error instanceof StaleGoalSessionFenceError || error instanceof GoalSessionContractError) throw error;
    await statePort.compareAndSet(state, nextState(state, {
        status: 'failed',
        failureReason: safeFailureDiagnostic(
            error instanceof Error ? error.message : '', 'Unable to create or resume provider session safely',
        ),
    }));
    throw error;
}
