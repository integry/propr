import type { GoalBeginTurnRequest, GoalExecutionIdentity, GoalSessionState } from './contract.js';

export function turnExecution(
    state: GoalSessionState,
    request: { turnId: string; executionId: string; attemptId?: string },
    mint: () => string,
    mintFresh: (previous: string) => string,
): GoalExecutionIdentity {
    const retry = state.retryTurn?.turnId === request.turnId
        && state.retryTurn.executionId === request.executionId ? state.retryTurn : undefined;
    return {
        executionId: request.executionId,
        attemptId: retry ? mintFresh(retry.crashedAttemptId) : request.attemptId ?? mint(),
    };
}

export function resolveDeferredModel(
    state: GoalSessionState,
    fallback: string,
    enabled: boolean,
): {
    requestedModel: string;
    activeModelChange?: NonNullable<GoalSessionState['activeTurn']>['modelChange'];
    providerModelChange?: GoalBeginTurnRequest['modelChange'];
} {
    const requestedModel = state.pendingModelChange ?? state.modelChangeIntent?.model ?? fallback;
    const modelIntent = enabled && state.pendingModelChange === requestedModel
        && state.modelChangeIntent?.model === requestedModel ? state.modelChangeIntent : undefined;
    const generation = modelIntent?.generation ?? state.modelChangeGeneration ?? 0;
    return {
        requestedModel,
        activeModelChange: modelIntent ? {
            modelChangeId: modelIntent.modelChangeId, generation,
            previousModel: modelIntent.previousModel ?? state.currentModel,
        } : undefined,
        providerModelChange: modelIntent ? { modelChangeId: modelIntent.modelChangeId, generation } : undefined,
    };
}

export function settledResumeKind(
    state: GoalSessionState,
    kind: 'active_turn' | 'recovered_after_turn',
): boolean {
    const liveStatus = kind === 'active_turn' ? state.status === 'running'
        : state.status === 'running' || state.status === 'pause_requested';
    return liveStatus && Boolean(state.activeTurn) && state.resumeIntent?.phase === 'settled'
        && state.completedResume?.operationId === state.resumeIntent.operationId
        && state.completedResume.kind === kind;
}
