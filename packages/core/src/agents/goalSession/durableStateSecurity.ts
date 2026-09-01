import type {
    GoalCancellationIntent,
    GoalCompletedRecovery,
    GoalCompletedResume,
    GoalCompletedTurn,
    GoalModelChangeAcknowledgement,
    GoalModelChangeIntent,
    GoalProviderBarrierIntent,
    GoalRecoveryAttempt,
    GoalRepositoryIdentity,
    GoalResumeIntent,
    GoalSessionInitializationIntent,
    GoalSessionJsonValue,
    GoalSessionState,
    GoalTurnState,
    GoalUsageAccounting,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { sanitizeRecoveryMetadata } from './recoveryMetadata.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SECRET = /(?:Bearer\s*\S+|gh[oprsu]_|github_pat_|sk-|AKIA|secret|token|password|credential|private.?key|-----BEGIN|https?:\/\/[^\s]*@)/i;
const SECRET_ID = /^(?:Bearer|gh[oprsu]_|github_pat_|sk-|AKIA)/i;
const MAX_COMPLETED_TURNS = 10_000;
const MAX_MODEL_INTENTS = 512;
const MAX_USAGE_OCCURRENCES = 256;

const STATE_FIELDS = [
    'goalId', 'sessionId', 'provider', 'providerSessionId', 'recoveryMetadata', 'controllerEpoch', 'status',
    'currentModel', 'requestedModel', 'pendingModelChange', 'pendingAfterTurnPause', 'activeTurn',
    'completedTurnIds', 'completedTurns', 'initializationIntent', 'providerOpenAttemptId',
    'providerOpenOperationGeneration', 'retryTurn', 'recoveryAttemptId', 'recoveryAttempt', 'completedRecovery',
    'providerOperationGeneration', 'providerBarrierIntent', 'resumeIntent', 'completedResume', 'cancellationIntent',
    'modelChangeIntent', 'modelChangeIntents', 'modelChangeGeneration', 'usageAccounting', 'failureReason',
    'version', 'createdAt', 'updatedAt',
] as const;

/**
 * Reconstructs a durable state into fresh closed DTOs.  No caller receives the
 * persistence object's prototype or excess properties, and any malformed known
 * field rejects before a supervisor can mutate history, state, events, or a
 * provider.  This is intentionally not a scrubber: ambiguous durable identity
 * is evidence of corruption and must never be repaired by invention.
 */
export function decodeDurableGoalSessionState(value: unknown): GoalSessionState {
    const state = record(value, STATE_FIELDS, 'goal session state');
    const result: GoalSessionState = {
        goalId: id(state.goalId, 'goalId'),
        sessionId: id(state.sessionId, 'sessionId'),
        provider: id(state.provider, 'provider'),
        controllerEpoch: integer(state.controllerEpoch, 'controllerEpoch'),
        status: closed(state.status, ['initializing', 'idle', 'running', 'pause_requested', 'paused', 'cancelling', 'terminated', 'failed'], 'status'),
        completedTurnIds: idArray(state.completedTurnIds, 'completedTurnIds', MAX_COMPLETED_TURNS),
        version: positiveInteger(state.version, 'version'),
        createdAt: timestamp(state.createdAt, 'createdAt'),
        updatedAt: timestamp(state.updatedAt, 'updatedAt'),
    };
    optionalId(state, result, 'providerSessionId');
    optionalId(state, result, 'currentModel');
    optionalId(state, result, 'requestedModel');
    optionalId(state, result, 'pendingModelChange');
    optionalId(state, result, 'providerOpenAttemptId');
    optionalId(state, result, 'recoveryAttemptId');
    optionalDiagnostic(state, result, 'failureReason');
    optionalInteger(state, result, 'providerOpenOperationGeneration');
    optionalInteger(state, result, 'providerOperationGeneration');
    optionalInteger(state, result, 'modelChangeGeneration');
    if (state.pendingAfterTurnPause !== undefined) result.pendingAfterTurnPause = boolean(state.pendingAfterTurnPause, 'pendingAfterTurnPause');
    if (state.recoveryMetadata !== undefined) {
        result.recoveryMetadata = sanitizeRecoveryMetadata(state.recoveryMetadata as GoalSessionJsonValue, result.provider);
    }
    if (state.activeTurn !== undefined) result.activeTurn = decodeTurn(state.activeTurn);
    if (state.completedTurns !== undefined) result.completedTurns = array(state.completedTurns, 'completedTurns', MAX_COMPLETED_TURNS).map(decodeCompletedTurn);
    if (state.initializationIntent !== undefined) result.initializationIntent = decodeInitialization(state.initializationIntent);
    if (state.retryTurn !== undefined) result.retryTurn = decodeRetryTurn(state.retryTurn);
    if (state.recoveryAttempt !== undefined) result.recoveryAttempt = decodeRecovery(state.recoveryAttempt);
    if (state.completedRecovery !== undefined) result.completedRecovery = decodeCompletedRecovery(state.completedRecovery);
    if (state.providerBarrierIntent !== undefined) result.providerBarrierIntent = decodeBarrier(state.providerBarrierIntent);
    if (state.resumeIntent !== undefined) result.resumeIntent = decodeResume(state.resumeIntent);
    if (state.completedResume !== undefined) result.completedResume = decodeCompletedResume(state.completedResume);
    if (state.cancellationIntent !== undefined) result.cancellationIntent = decodeCancellation(state.cancellationIntent);
    if (state.modelChangeIntent !== undefined) result.modelChangeIntent = decodeModelIntent(state.modelChangeIntent);
    if (state.modelChangeIntents !== undefined) result.modelChangeIntents = array(
        state.modelChangeIntents, 'modelChangeIntents', MAX_MODEL_INTENTS,
    ).map(decodeModelIntent);
    if (state.usageAccounting !== undefined) result.usageAccounting = decodeUsageAccounting(state.usageAccounting);
    validateStateRelationships(result);
    return result;
}

/** @deprecated Strict reopening replaced mutation-based legacy scrubbing. */
export const stripLegacyStateExtras = decodeDurableGoalSessionState;

function decodeTurn(value: unknown): GoalTurnState {
    const input = record(value, [
        'turnId', 'executionId', 'attemptId', 'executionEpoch', 'objective', 'requestedModel', 'repository',
        'providerOperationGeneration', 'modelChange', 'status',
    ], 'activeTurn');
    const result: GoalTurnState = {
        turnId: id(input.turnId, 'activeTurn.turnId'),
        executionId: id(input.executionId, 'activeTurn.executionId'),
        attemptId: id(input.attemptId, 'activeTurn.attemptId'),
        executionEpoch: integer(input.executionEpoch, 'activeTurn.executionEpoch'),
        objective: diagnostic(input.objective, 'activeTurn.objective', 2048),
        requestedModel: id(input.requestedModel, 'activeTurn.requestedModel'),
        repository: decodeRepository(input.repository),
        status: closed(input.status, ['running', 'pause_requested', 'paused', 'completed', 'cancelled', 'failed'], 'activeTurn.status'),
    };
    if (input.providerOperationGeneration !== undefined) {
        result.providerOperationGeneration = integer(input.providerOperationGeneration, 'activeTurn.providerOperationGeneration');
    }
    if (input.modelChange !== undefined) {
        const modelChange = record(input.modelChange, ['modelChangeId', 'generation', 'previousModel'], 'activeTurn.modelChange');
        result.modelChange = {
            modelChangeId: id(modelChange.modelChangeId, 'activeTurn.modelChange.modelChangeId'),
            generation: integer(modelChange.generation, 'activeTurn.modelChange.generation'),
            previousModel: modelChange.previousModel === undefined
                ? undefined : id(modelChange.previousModel, 'activeTurn.modelChange.previousModel'),
        };
    }
    return result;
}

function decodeRepository(value: unknown): GoalRepositoryIdentity {
    const input = record(value, ['repository', 'worktreePath', 'branch', 'headSha'], 'repository');
    const worktreePath = string(input.worktreePath, 'repository.worktreePath', 4096);
    if (!worktreePath.startsWith('/') || worktreePath.includes('\0')) invalid('repository.worktreePath');
    const result: GoalRepositoryIdentity = {
        repository: diagnostic(input.repository, 'repository.repository', 1024),
        worktreePath,
        branch: diagnostic(input.branch, 'repository.branch', 512),
    };
    if (input.headSha !== undefined) result.headSha = id(input.headSha, 'repository.headSha');
    return result;
}

function decodeCompletedTurn(value: unknown): GoalCompletedTurn {
    const input = record(value, ['turnId', 'executionId', 'attemptId'], 'completed turn');
    return { turnId: id(input.turnId, 'completedTurn.turnId'), executionId: id(input.executionId, 'completedTurn.executionId'), attemptId: id(input.attemptId, 'completedTurn.attemptId') };
}

function decodeInitialization(value: unknown): GoalSessionInitializationIntent {
    const input = record(value, ['attemptId', 'deterministicOpenKey', 'recordedAt'], 'initializationIntent');
    return { attemptId: id(input.attemptId, 'initializationIntent.attemptId'), deterministicOpenKey: id(input.deterministicOpenKey, 'initializationIntent.deterministicOpenKey'), recordedAt: timestamp(input.recordedAt, 'initializationIntent.recordedAt') };
}

function decodeRetryTurn(value: unknown): NonNullable<GoalSessionState['retryTurn']> {
    const input = record(value, ['turnId', 'executionId', 'crashedAttemptId'], 'retryTurn');
    return { turnId: id(input.turnId, 'retryTurn.turnId'), executionId: id(input.executionId, 'retryTurn.executionId'), crashedAttemptId: id(input.crashedAttemptId, 'retryTurn.crashedAttemptId') };
}

function decodeRecovery(value: unknown): GoalRecoveryAttempt {
    const input = record(value, [
        'operationToken', 'operationGeneration', 'executionId', 'attemptId', 'controllerEpoch',
        'authoritativeAttemptId', 'authoritativeExecutionId', 'sessionStatus', 'authoritativeTurnStatus',
        'claimedAt', 'leaseExpiresAt', 'phase',
    ], 'recoveryAttempt');
    const result: GoalRecoveryAttempt = {
        operationToken: id(input.operationToken, 'recoveryAttempt.operationToken'),
        operationGeneration: integer(input.operationGeneration, 'recoveryAttempt.operationGeneration'),
        executionId: id(input.executionId, 'recoveryAttempt.executionId'),
        attemptId: id(input.attemptId, 'recoveryAttempt.attemptId'),
        controllerEpoch: integer(input.controllerEpoch, 'recoveryAttempt.controllerEpoch'),
        claimedAt: timestamp(input.claimedAt, 'recoveryAttempt.claimedAt'),
        leaseExpiresAt: timestamp(input.leaseExpiresAt, 'recoveryAttempt.leaseExpiresAt'),
    };
    if (input.authoritativeAttemptId !== undefined) result.authoritativeAttemptId = id(input.authoritativeAttemptId, 'recoveryAttempt.authoritativeAttemptId');
    if (input.authoritativeExecutionId !== undefined) result.authoritativeExecutionId = id(input.authoritativeExecutionId, 'recoveryAttempt.authoritativeExecutionId');
    if (input.sessionStatus !== undefined) result.sessionStatus = closed(input.sessionStatus, ['initializing', 'idle', 'running', 'pause_requested', 'paused', 'cancelling', 'terminated', 'failed'], 'recoveryAttempt.sessionStatus') as GoalRecoveryAttempt['sessionStatus'];
    if (input.authoritativeTurnStatus !== undefined) result.authoritativeTurnStatus = closed(input.authoritativeTurnStatus, ['running', 'pause_requested', 'paused', 'completed', 'cancelled', 'failed'], 'recoveryAttempt.authoritativeTurnStatus') as GoalRecoveryAttempt['authoritativeTurnStatus'];
    if (input.phase !== undefined) result.phase = closed(input.phase, ['claimed', 'provider_in_doubt'], 'recoveryAttempt.phase') as GoalRecoveryAttempt['phase'];
    return result;
}

function decodeCompletedRecovery(value: unknown): GoalCompletedRecovery {
    const input = record(value, ['operationToken', 'controllerEpoch', 'outcome', 'reason'], 'completedRecovery');
    return { operationToken: id(input.operationToken, 'completedRecovery.operationToken'), controllerEpoch: integer(input.controllerEpoch, 'completedRecovery.controllerEpoch'), outcome: closed(input.outcome, ['alive', 'resumed', 'failed'], 'completedRecovery.outcome'), reason: diagnostic(input.reason, 'completedRecovery.reason', 512) };
}

function decodeBarrier(value: unknown): GoalProviderBarrierIntent {
    const input = record(value, ['generation', 'operationId', 'kind', 'phase', 'claimedAt', 'pendingCancellationId'], 'providerBarrierIntent');
    const result: GoalProviderBarrierIntent = {
        generation: integer(input.generation, 'providerBarrierIntent.generation'),
        operationId: id(input.operationId, 'providerBarrierIntent.operationId'),
        kind: closed(input.kind, ['cancellation', 'terminal', 'replacement', 'lease_expiry'], 'providerBarrierIntent.kind'),
        phase: closed(input.phase, ['pending', 'published'], 'providerBarrierIntent.phase'),
        claimedAt: timestamp(input.claimedAt, 'providerBarrierIntent.claimedAt'),
    };
    if (input.pendingCancellationId !== undefined) result.pendingCancellationId = id(input.pendingCancellationId, 'providerBarrierIntent.pendingCancellationId');
    return result;
}

function decodeResume(value: unknown): GoalResumeIntent {
    const input = record(value, ['executionId', 'attemptId', 'operationId', 'operationGeneration', 'kind', 'controllerEpoch', 'turnId', 'claimedAt', 'leaseExpiresAt', 'phase'], 'resumeIntent');
    const result: GoalResumeIntent = {
        executionId: id(input.executionId, 'resumeIntent.executionId'), attemptId: id(input.attemptId, 'resumeIntent.attemptId'),
        operationId: id(input.operationId, 'resumeIntent.operationId'), operationGeneration: integer(input.operationGeneration, 'resumeIntent.operationGeneration'),
        kind: closed(input.kind, ['active_turn', 'after_turn', 'recovered_after_turn'], 'resumeIntent.kind'),
        controllerEpoch: integer(input.controllerEpoch, 'resumeIntent.controllerEpoch'), claimedAt: timestamp(input.claimedAt, 'resumeIntent.claimedAt'),
        leaseExpiresAt: timestamp(input.leaseExpiresAt, 'resumeIntent.leaseExpiresAt'), phase: closed(input.phase, ['claimed', 'provider_in_doubt', 'settled'], 'resumeIntent.phase'),
    };
    if (input.turnId !== undefined) result.turnId = id(input.turnId, 'resumeIntent.turnId');
    return result;
}

function decodeCompletedResume(value: unknown): GoalCompletedResume {
    const input = record(value, ['operationId', 'operationGeneration', 'kind', 'controllerEpoch'], 'completedResume');
    return { operationId: id(input.operationId, 'completedResume.operationId'), operationGeneration: integer(input.operationGeneration, 'completedResume.operationGeneration'), kind: closed(input.kind, ['active_turn', 'after_turn', 'recovered_after_turn'], 'completedResume.kind'), controllerEpoch: integer(input.controllerEpoch, 'completedResume.controllerEpoch') };
}

function decodeCancellation(value: unknown): GoalCancellationIntent {
    const input = record(value, ['cancellationId', 'reason', 'claimedAt', 'pendingContext'], 'cancellationIntent');
    const result: GoalCancellationIntent = {
        cancellationId: id(input.cancellationId, 'cancellationIntent.cancellationId'),
        reason: diagnostic(input.reason, 'cancellationIntent.reason', 512),
        claimedAt: timestamp(input.claimedAt, 'cancellationIntent.claimedAt'),
    };
    if (input.pendingContext !== undefined) {
        const pending = record(input.pendingContext, ['initializationIntent', 'activeTurn'], 'cancellationIntent.pendingContext');
        const active = pending.activeTurn === undefined ? undefined : decodeCompletedTurn(pending.activeTurn);
        result.pendingContext = { initializationIntent: decodeInitialization(pending.initializationIntent), activeTurn: active };
    }
    return result;
}

function decodeModelIntent(value: unknown): GoalModelChangeIntent {
    const input = record(value, [
        'modelChangeId', 'model', 'requestedAt', 'generation', 'previousModel', 'phase', 'applicationToken',
        'applicationControllerEpoch', 'leaseExpiresAt', 'acknowledgement', 'invocationEvidence',
    ], 'modelChangeIntent');
    const result: GoalModelChangeIntent = {
        modelChangeId: id(input.modelChangeId, 'modelChangeIntent.modelChangeId'), model: id(input.model, 'modelChangeIntent.model'),
        requestedAt: timestamp(input.requestedAt, 'modelChangeIntent.requestedAt'),
    };
    if (input.generation !== undefined) result.generation = integer(input.generation, 'modelChangeIntent.generation');
    if (input.previousModel !== undefined) result.previousModel = id(input.previousModel, 'modelChangeIntent.previousModel');
    if (input.phase !== undefined) result.phase = closed(input.phase, ['pending', 'provider_in_doubt', 'committed', 'superseded_in_doubt', 'superseded'], 'modelChangeIntent.phase') as GoalModelChangeIntent['phase'];
    if (input.applicationToken !== undefined) result.applicationToken = id(input.applicationToken, 'modelChangeIntent.applicationToken');
    if (input.applicationControllerEpoch !== undefined) result.applicationControllerEpoch = integer(input.applicationControllerEpoch, 'modelChangeIntent.applicationControllerEpoch');
    if (input.leaseExpiresAt !== undefined) result.leaseExpiresAt = timestamp(input.leaseExpiresAt, 'modelChangeIntent.leaseExpiresAt');
    if (input.acknowledgement !== undefined) result.acknowledgement = decodeAcknowledgement(input.acknowledgement);
    if (input.invocationEvidence !== undefined) {
        const evidence = record(input.invocationEvidence, ['executionId', 'attemptId', 'occurrenceId', 'acceptedAt'], 'modelChangeIntent.invocationEvidence');
        result.invocationEvidence = { executionId: id(evidence.executionId, 'invocationEvidence.executionId'), attemptId: id(evidence.attemptId, 'invocationEvidence.attemptId'), occurrenceId: id(evidence.occurrenceId, 'invocationEvidence.occurrenceId'), acceptedAt: timestamp(evidence.acceptedAt, 'invocationEvidence.acceptedAt') };
    }
    return result;
}

function decodeAcknowledgement(value: unknown): GoalModelChangeAcknowledgement {
    const input = record(value, ['outcome', 'requestedModel', 'appliesAt', 'effectiveModel'], 'model acknowledgement');
    const result: GoalModelChangeAcknowledgement = { requestedModel: id(input.requestedModel, 'acknowledgement.requestedModel'), appliesAt: closed(input.appliesAt, ['immediate', 'next_safe_boundary', 'next_turn'], 'acknowledgement.appliesAt') };
    if (input.outcome !== undefined) result.outcome = closed(input.outcome, ['acknowledged', 'outside_retry_horizon'], 'acknowledgement.outcome') as GoalModelChangeAcknowledgement['outcome'];
    if (input.effectiveModel !== undefined) result.effectiveModel = id(input.effectiveModel, 'acknowledgement.effectiveModel');
    return result;
}

function decodeUsageAccounting(value: unknown): GoalUsageAccounting {
    const input = record(value, ['version', 'lastWatermark', 'occurrences'], 'usageAccounting');
    if (input.version !== 1) invalid('usageAccounting.version');
    return { version: 1, lastWatermark: integer(input.lastWatermark, 'usageAccounting.lastWatermark'), occurrences: idArray(input.occurrences, 'usageAccounting.occurrences', MAX_USAGE_OCCURRENCES) };
}

function validateStateRelationships(state: GoalSessionState): void {
    validateBarrierRelationships(state);
    validateOperationGenerations(state);
    validateStateCollections(state);
    validateModelGenerations(state);
}

function validateBarrierRelationships(state: GoalSessionState): void {
    if (state.providerBarrierIntent && (state.providerOperationGeneration === undefined
        || state.providerBarrierIntent.generation > state.providerOperationGeneration
        || (state.providerBarrierIntent.phase === 'pending'
            && state.providerBarrierIntent.generation !== state.providerOperationGeneration))) {
        invalid('providerBarrierIntent.generation');
    }
    if (state.cancellationIntent?.pendingContext && state.providerSessionId) invalid('cancellationIntent.pendingContext');
    if (state.status === 'cancelling' && !state.cancellationIntent) invalid('cancellationIntent');
    if (state.providerBarrierIntent?.kind === 'cancellation'
        && (!state.cancellationIntent
            || state.providerBarrierIntent.pendingCancellationId !== state.cancellationIntent.cancellationId)) {
        invalid('providerBarrierIntent.pendingCancellationId');
    }
    if (state.activeTurn && state.activeTurn.executionEpoch > state.controllerEpoch) invalid('activeTurn.executionEpoch');
    if (state.initializationIntent && state.providerSessionId) invalid('initializationIntent');
}

function validateOperationGenerations(state: GoalSessionState): void {
    if (state.recoveryAttempt && (state.recoveryAttempt.controllerEpoch > state.controllerEpoch
        || state.recoveryAttempt.operationGeneration > (state.providerOperationGeneration ?? -1))) {
        invalid('recoveryAttempt');
    }
    if (state.resumeIntent && (state.resumeIntent.controllerEpoch > state.controllerEpoch
        || state.resumeIntent.operationGeneration > (state.providerOperationGeneration ?? -1))) invalid('resumeIntent');
    if (state.providerOpenOperationGeneration !== undefined
        && state.providerOpenOperationGeneration > (state.providerOperationGeneration ?? -1)) {
        invalid('providerOpenOperationGeneration');
    }
}

function validateStateCollections(state: GoalSessionState): void {
    if (state.completedTurns && state.completedTurns.some(turn => !state.completedTurnIds.includes(turn.turnId))) invalid('completedTurns');
    if (new Set(state.completedTurnIds).size !== state.completedTurnIds.length
        || state.completedTurns && new Set(state.completedTurns.map(turn => turn.turnId)).size !== state.completedTurns.length) {
        invalid('completedTurns');
    }
    if (state.usageAccounting && new Set(state.usageAccounting.occurrences).size !== state.usageAccounting.occurrences.length) {
        invalid('usageAccounting.occurrences');
    }
}

function validateModelGenerations(state: GoalSessionState): void {
    const generations = state.modelChangeIntents?.map(intent => intent.generation ?? 0) ?? [];
    if (generations.some((generation, index) => index > 0 && generation <= generations[index - 1])) invalid('modelChangeIntents.generation');
}

function record<const T extends readonly string[]>(value: unknown, fields: T, name: string): Record<T[number], unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(name);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(name);
    const allowed = new Set<string>(fields);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0
        || Object.entries(descriptors).some(([key, descriptor]) =>
            !allowed.has(key) || !descriptor.enumerable || !('value' in descriptor))) {
        invalid(`${name} excess or accessor field`);
    }
    return value as Record<T[number], unknown>;
}

function id(value: unknown, name: string): string {
    if (typeof value !== 'string' || !SAFE_ID.test(value) || SECRET_ID.test(value)) invalid(name);
    return value;
}

function string(value: unknown, name: string, max: number): string {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max || value.includes('\0')) invalid(name);
    return value;
}

function diagnostic(value: unknown, name: string, max: number): string {
    const result = string(value, name, max);
    if (SECRET.test(result)) invalid(name);
    return result;
}

function integer(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(name);
    return value;
}

function positiveInteger(value: unknown, name: string): number {
    const result = integer(value, name);
    if (result === 0) invalid(name);
    return result;
}

function boolean(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean') invalid(name);
    return value;
}

function timestamp(value: unknown, name: string): string {
    if (typeof value !== 'string') invalid(name);
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) invalid(name);
    return value;
}

function closed<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(name);
    return value as T;
}

function array(value: unknown, name: string, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) invalid(name);
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) invalid(name);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid(name);
    }
    if (Object.keys(descriptors).some(key => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key))) invalid(name);
    return value;
}

function idArray(value: unknown, name: string, max: number): string[] {
    const result = array(value, name, max).map(item => id(item, name));
    if (new Set(result).size !== result.length) invalid(name);
    return result;
}

function optionalId<K extends keyof GoalSessionState>(input: Record<string, unknown>, output: GoalSessionState, key: K): void {
    if (input[key as string] !== undefined) (output as unknown as Record<string, unknown>)[key as string] = id(input[key as string], String(key));
}

function optionalInteger<K extends keyof GoalSessionState>(input: Record<string, unknown>, output: GoalSessionState, key: K): void {
    if (input[key as string] !== undefined) (output as unknown as Record<string, unknown>)[key as string] = integer(input[key as string], String(key));
}

function optionalDiagnostic<K extends keyof GoalSessionState>(input: Record<string, unknown>, output: GoalSessionState, key: K): void {
    if (input[key as string] !== undefined) (output as unknown as Record<string, unknown>)[key as string] = diagnostic(input[key as string], String(key), 512);
}

function invalid(field: string): never {
    throw new GoalSessionContractError(`Durable goal session contains an invalid ${field}`, 'INVALID_DURABLE_STATE');
}
