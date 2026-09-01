import type {
    GoalModelChangeIntent, GoalProviderOperationFence, GoalSessionState,
} from './contract.js';
import { StaleGoalSessionFenceError } from './errors.js';
import { controlOperationId } from './controlOperationIdentity.js';

/** Validates the complete serializable provider fence against one locked state row. */
export function assertProviderFirstEffectState(
    state: GoalSessionState | null,
    fence: GoalProviderOperationFence,
): asserts state is GoalSessionState {
    if (!state || state.goalId !== fence.goalId || state.sessionId !== fence.sessionId
        || state.controllerEpoch !== fence.controllerEpoch
        || (state.providerOperationGeneration ?? 0) !== fence.generation
        || state.providerBarrierIntent?.phase === 'pending'
        || expired(fence.leaseExpiresAt)) stale();
    assertExactTurn(state, fence);
    assertKindAuthority(state, fence);
}

function assertExactTurn(state: GoalSessionState, fence: GoalProviderOperationFence): void {
    if (fence.turnId === undefined) return;
    const turn = state.activeTurn;
    if (!turn || turn.turnId !== fence.turnId || turn.executionId !== fence.executionId
        || turn.attemptId !== fence.attemptId
        || (fence.kind === 'turn' || fence.kind === 'steer')
            && (turn.providerOperationGeneration ?? 0) !== fence.generation) stale();
}

function assertKindAuthority(state: GoalSessionState, fence: GoalProviderOperationFence): void {
    switch (fence.kind) {
        case 'open':
            assertOpenAuthority(state, fence);
            return;
        case 'turn':
        case 'steer':
            assertTurnAuthority(state, fence);
            return;
        case 'pause':
            assertPauseAuthority(state, fence);
            return;
        case 'resume':
            assertResumeAuthority(state, fence);
            return;
        case 'reconcile':
            assertRecoveryAuthority(state, fence);
            return;
        case 'model':
            assertModelAuthority(state, fence);
            return;
        case 'cancel':
            assertCancelAuthority(state, fence);
    }
}

function assertOpenAuthority(state: GoalSessionState, fence: GoalProviderOperationFence): void {
    if (state.providerOpenAttemptId !== fence.operationId
        || (fence.attemptId !== undefined && state.providerOpenAttemptId !== fence.attemptId)
        || state.providerOpenOperationGeneration !== fence.generation
        || state.status === 'cancelling' || terminal(state)) stale();
}

function assertTurnAuthority(state: GoalSessionState, fence: GoalProviderOperationFence): void {
    const turn = state.activeTurn;
    const expectedTurnOperation = turn
        ? `${turn.turnId}:${turn.executionId}:${turn.attemptId}` : undefined;
    if (!turn || !['running', 'pause_requested', 'paused'].includes(state.status)
        || fence.kind === 'turn' && fence.operationId !== expectedTurnOperation
        || fence.kind === 'steer' && !/^[A-Za-z0-9._:-]{1,256}$/.test(fence.operationId)) stale();
}

function assertPauseAuthority(state: GoalSessionState, fence: GoalProviderOperationFence): void {
    if ((state.status !== 'pause_requested' && state.status !== 'paused')
        || fence.operationId !== controlOperationId('pause', state)) stale();
}

function assertCancelAuthority(state: GoalSessionState, fence: GoalProviderOperationFence): void {
    if (state.status !== 'cancelling' || state.cancellationIntent?.cancellationId !== fence.operationId
        || state.providerBarrierIntent?.phase !== 'published') stale();
}

function assertResumeAuthority(state: GoalSessionState, fence: GoalProviderOperationFence): void {
    const intent = state.resumeIntent;
    const completed = state.completedResume;
    const callablePhase = intent?.phase === 'provider_in_doubt'
        || (intent?.phase === 'settled' && completed?.operationId === intent.operationId
            && completed.operationGeneration === intent.operationGeneration
            && completed.kind === intent.kind && completed.controllerEpoch === intent.controllerEpoch);
    if (!intent || intent.operationId !== fence.operationId || intent.operationGeneration !== fence.generation
        || !callablePhase || intent.leaseExpiresAt !== fence.leaseExpiresAt
        || expired(intent.leaseExpiresAt)
        || (fence.executionId !== undefined && intent.executionId !== fence.executionId)
        || (fence.attemptId !== undefined && intent.attemptId !== fence.attemptId)) stale();
}

function assertRecoveryAuthority(state: GoalSessionState, fence: GoalProviderOperationFence): void {
    const attempt = state.recoveryAttempt;
    if (!attempt || attempt.operationToken !== fence.operationId
        || attempt.operationGeneration !== fence.generation || attempt.phase !== 'provider_in_doubt'
        || attempt.leaseExpiresAt !== fence.leaseExpiresAt || expired(attempt.leaseExpiresAt)
        || attempt.executionId !== fence.executionId || attempt.attemptId !== fence.attemptId) stale();
}

function assertModelAuthority(state: GoalSessionState, fence: GoalProviderOperationFence): void {
    const intent = modelIntents(state).find(candidate =>
        `${candidate.modelChangeId}:${candidate.applicationToken ?? 'unclaimed'}` === fence.operationId);
    if (!intent || !intent.applicationToken || intent.applicationControllerEpoch !== fence.controllerEpoch
        || (intent.phase !== 'provider_in_doubt' && intent.phase !== 'committed')
        || intent.leaseExpiresAt !== fence.leaseExpiresAt || expired(intent.leaseExpiresAt)) stale();
}

function modelIntents(state: GoalSessionState): GoalModelChangeIntent[] {
    return state.modelChangeIntents ?? (state.modelChangeIntent ? [state.modelChangeIntent] : []);
}

function terminal(state: GoalSessionState): boolean {
    return state.status === 'terminated' || state.status === 'failed';
}

function expired(value: string | undefined): boolean {
    return value !== undefined && Date.parse(value) <= Date.now();
}

function stale(): never {
    throw new StaleGoalSessionFenceError('Provider first effect was durably invalidated');
}
