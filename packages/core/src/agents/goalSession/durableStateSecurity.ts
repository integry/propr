import type { GoalSessionState } from './contract.js';

const STATE_FIELDS = [
    'goalId', 'sessionId', 'provider', 'providerSessionId', 'recoveryMetadata', 'controllerEpoch', 'status',
    'currentModel', 'requestedModel', 'pendingModelChange', 'pendingAfterTurnPause', 'activeTurn',
    'completedTurnIds', 'completedTurns', 'initializationIntent', 'providerOpenAttemptId',
    'providerOpenOperationGeneration', 'retryTurn', 'recoveryAttemptId', 'recoveryAttempt', 'completedRecovery',
    'providerOperationGeneration', 'resumeIntent', 'completedResume', 'cancellationIntent', 'modelChangeIntent',
    'modelChangeIntents', 'modelChangeGeneration', 'failureReason', 'version', 'createdAt', 'updatedAt',
] as const;
const TURN_FIELDS = [
    'turnId', 'executionId', 'attemptId', 'executionEpoch', 'objective', 'requestedModel', 'repository',
    'providerOperationGeneration', 'status',
] as const;
const REPOSITORY_FIELDS = ['repository', 'worktreePath', 'branch', 'headSha'] as const;
const INIT_FIELDS = ['attemptId', 'deterministicOpenKey', 'recordedAt'] as const;
const RECOVERY_FIELDS = [
    'operationToken', 'operationGeneration', 'executionId', 'attemptId', 'controllerEpoch',
    'authoritativeAttemptId', 'authoritativeExecutionId', 'sessionStatus', 'authoritativeTurnStatus',
    'claimedAt', 'leaseExpiresAt', 'phase',
] as const;
const RESUME_FIELDS = [
    'executionId', 'attemptId', 'operationId', 'operationGeneration', 'kind', 'controllerEpoch', 'turnId',
    'claimedAt', 'leaseExpiresAt', 'phase',
] as const;
const MODEL_FIELDS = [
    'modelChangeId', 'model', 'requestedAt', 'generation', 'previousModel', 'phase', 'applicationToken',
    'applicationControllerEpoch', 'leaseExpiresAt', 'acknowledgement',
] as const;

/** Removes every undeclared top-level and nested legacy state field before reopen. */
export function stripLegacyStateExtras(state: GoalSessionState): GoalSessionState {
    const result = pick(state, STATE_FIELDS) as unknown as GoalSessionState;
    if (state.activeTurn) result.activeTurn = {
        ...pick(state.activeTurn, TURN_FIELDS),
        repository: pick(state.activeTurn.repository, REPOSITORY_FIELDS),
    } as GoalSessionState['activeTurn'];
    if (state.completedTurns) result.completedTurns = state.completedTurns.map(value =>
        pick(value, ['turnId', 'executionId', 'attemptId'] as const)) as GoalSessionState['completedTurns'];
    if (state.initializationIntent) result.initializationIntent = pick(state.initializationIntent, INIT_FIELDS);
    if (state.retryTurn) result.retryTurn = pick(state.retryTurn, ['turnId', 'executionId', 'crashedAttemptId'] as const);
    if (state.recoveryAttempt) result.recoveryAttempt = pick(state.recoveryAttempt, RECOVERY_FIELDS);
    if (state.completedRecovery) result.completedRecovery = pick(
        state.completedRecovery, ['operationToken', 'controllerEpoch', 'outcome', 'reason'] as const,
    );
    if (state.resumeIntent) result.resumeIntent = pick(state.resumeIntent, RESUME_FIELDS);
    if (state.completedResume) result.completedResume = pick(
        state.completedResume, ['operationId', 'operationGeneration', 'kind', 'controllerEpoch'] as const,
    );
    if (state.cancellationIntent) result.cancellationIntent = {
        ...pick(state.cancellationIntent, ['cancellationId', 'reason', 'claimedAt'] as const),
        pendingContext: state.cancellationIntent.pendingContext ? {
            initializationIntent: pick(state.cancellationIntent.pendingContext.initializationIntent, INIT_FIELDS),
            activeTurn: state.cancellationIntent.pendingContext.activeTurn
                ? pick(state.cancellationIntent.pendingContext.activeTurn, ['turnId', 'executionId', 'attemptId'] as const)
                : undefined,
        } : undefined,
    };
    if (state.modelChangeIntent) result.modelChangeIntent = stripModelIntent(state.modelChangeIntent);
    if (state.modelChangeIntents) result.modelChangeIntents = state.modelChangeIntents.map(stripModelIntent);
    return result;
}

function stripModelIntent(intent: NonNullable<GoalSessionState['modelChangeIntent']>) {
    const result = pick(intent, MODEL_FIELDS);
    if (intent.acknowledgement) result.acknowledgement = pick(
        intent.acknowledgement, ['outcome', 'requestedModel', 'appliesAt', 'effectiveModel'] as const,
    );
    return result;
}

function pick<T extends object, K extends readonly (keyof T)[]>(value: T, fields: K): Pick<T, K[number]> {
    const result: Partial<T> = {};
    for (const field of fields) if (Object.prototype.hasOwnProperty.call(value, field)) result[field] = value[field];
    return result as Pick<T, K[number]>;
}
