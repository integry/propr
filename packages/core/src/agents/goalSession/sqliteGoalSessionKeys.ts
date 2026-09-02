import type {
    GoalSessionControlTransition, GoalSessionIdentity, GoalTerminalCommit,
} from './contract.js';

export function sqliteGoalScope(identity: GoalSessionIdentity): string {
    return `${identity.goalId}\0${identity.sessionId}`;
}

export function sqliteTransitionKey(value: GoalSessionControlTransition): string {
    return JSON.stringify([sqliteGoalScope(value.fence), value.fence.controllerEpoch,
        value.turnScoped === true && 'turnId' in value.fence ? value.fence.turnId : null,
        value.execution.executionId, value.execution.attemptId, value.transitionId]);
}

export function sqliteTerminalKey(value: GoalTerminalCommit): string {
    return JSON.stringify([value.scope, sqliteGoalScope(value.fence), value.fence.controllerEpoch,
        value.scope === 'turn' ? value.fence.turnId : null,
        value.execution.executionId, value.execution.attemptId]);
}
