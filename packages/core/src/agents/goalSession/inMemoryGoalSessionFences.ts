import type {
    GoalExecutionIdentity, GoalSessionControlTransition, GoalSessionFence,
    GoalSessionState, GoalTerminalCommit,
} from './contract.js';

export function matchesLiveMessageFence(
    state: GoalSessionState | undefined,
    fence: GoalSessionFence,
    execution: GoalExecutionIdentity,
): state is GoalSessionState {
    return Boolean(state && state.controllerEpoch === fence.controllerEpoch
        && state.providerBarrierIntent?.phase !== 'pending'
        && !['cancelling', 'terminated', 'failed'].includes(state.status)
        && state.activeTurn?.turnId === fence.turnId
        && state.activeTurn.executionId === execution.executionId
        && state.activeTurn.attemptId === execution.attemptId
        && !['completed', 'cancelled', 'failed'].includes(state.activeTurn.status));
}

export function matchesTransitionLiveFence(
    current: GoalSessionState | undefined,
    transition: GoalSessionControlTransition,
): current is GoalSessionState {
    if (!current || current.controllerEpoch !== transition.fence.controllerEpoch
        || current.providerBarrierIntent?.phase === 'pending'
        || current.status === 'cancelling' || current.status === 'terminated' || current.status === 'failed') return false;
    if (transition.turnScoped !== true) return true;
    if (!('turnId' in transition.fence)) return false;
    return current.activeTurn?.turnId === transition.fence.turnId
        && current.activeTurn.executionId === transition.execution.executionId
        && current.activeTurn.attemptId === transition.execution.attemptId
        && current.activeTurn.status !== 'completed'
        && current.activeTurn.status !== 'cancelled'
        && current.activeTurn.status !== 'failed';
}

export function terminalCommitKey(completion: GoalTerminalCommit): string {
    return JSON.stringify([
        completion.scope, completion.fence.goalId, completion.fence.sessionId,
        completion.fence.controllerEpoch,
        completion.scope === 'turn' ? completion.fence.turnId : null,
        completion.execution.executionId, completion.execution.attemptId,
    ]);
}

export function transitionCommitKey(transition: GoalSessionControlTransition): string {
    return JSON.stringify([
        transition.fence.goalId, transition.fence.sessionId, transition.fence.controllerEpoch,
        transition.turnScoped === true && 'turnId' in transition.fence ? transition.fence.turnId : null,
        transition.execution.executionId, transition.execution.attemptId, transition.transitionId,
    ]);
}
