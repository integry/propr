import type { GoalModelChangeIntent, GoalSessionState } from './contract.js';
import { GoalSessionContractError } from './errors.js';

/** Cross-field invariants applied only after every durable field is decoded. */
export function validateStateRelationships(state: GoalSessionState): void {
    validateStatusRelationships(state);
    validateBarrierRelationships(state);
    validateOperationGenerations(state);
    validateStateCollections(state);
    validateModelGenerations(state);
}

function validateStatusRelationships(state: GoalSessionState): void {
    if (hasInvalidStatusTurnRelationship(state)) invalid('status/activeTurn relationship');
    if (state.activeTurn && state.activeTurn.executionEpoch > state.controllerEpoch) invalid('activeTurn.executionEpoch');
    if (state.status === 'cancelling' && (!state.cancellationIntent || state.activeTurn !== undefined)) {
        invalid('cancelling state');
    }
    if (hasCancellationIntentInLiveStatus(state)) invalid('cancellationIntent status');
    if (hasAfterTurnPauseInInvalidStatus(state)) invalid('pendingAfterTurnPause');
    if (state.retryTurn && (state.activeTurn || state.status !== 'idle')) invalid('retryTurn');
}

function hasInvalidStatusTurnRelationship(state: GoalSessionState): boolean {
    const turn = state.activeTurn;
    const live = turn !== undefined && !['completed', 'cancelled', 'failed'].includes(turn.status);
    switch (state.status) {
        case 'running': return turn?.status !== 'running';
        case 'pause_requested': return turn?.status !== 'pause_requested';
        case 'paused': return turn !== undefined && turn.status !== 'paused';
        case 'idle': return live;
        case 'initializing': return turn !== undefined;
        case 'cancelling':
        case 'terminated':
        case 'failed': return live;
    }
}

function hasCancellationIntentInLiveStatus(state: GoalSessionState): boolean {
    if (!state.cancellationIntent) return false;
    return state.status !== 'cancelling' && state.status !== 'terminated' && state.status !== 'failed';
}

function hasAfterTurnPauseInInvalidStatus(state: GoalSessionState): boolean {
    if (!state.pendingAfterTurnPause) return false;
    return state.status !== 'running' && state.status !== 'pause_requested' && state.status !== 'paused';
}

function validateBarrierRelationships(state: GoalSessionState): void {
    validateBarrierGeneration(state);
    if (state.cancellationIntent?.pendingContext && state.providerSessionId) invalid('cancellationIntent.pendingContext');
    if (state.status === 'cancelling' && !state.cancellationIntent) invalid('cancellationIntent');
    validateCancellingBarrier(state);
    validateCancellationBarrierIdentity(state);
    validateBarrierStatus(state);
    validatePendingCancellationKind(state);
    validateTerminalCancellationIdentity(state);
    if (state.initializationIntent && state.providerSessionId) invalid('initializationIntent');
}

function validateBarrierGeneration(state: GoalSessionState): void {
    const barrier = state.providerBarrierIntent;
    if (!barrier) return;
    const generation = state.providerOperationGeneration;
    if (generation === undefined || barrier.generation > generation) invalid('providerBarrierIntent.generation');
    if (barrier.phase === 'pending' && barrier.generation !== generation) invalid('providerBarrierIntent.generation');
}

function validateCancellingBarrier(state: GoalSessionState): void {
    if (state.status !== 'cancelling') return;
    const barrier = state.providerBarrierIntent;
    if (barrier?.kind !== 'cancellation' || barrier.generation !== state.providerOperationGeneration) {
        invalid('cancelling barrier');
    }
}

function validateCancellationBarrierIdentity(state: GoalSessionState): void {
    const barrier = state.providerBarrierIntent;
    if (barrier?.kind !== 'cancellation') return;
    if (!state.cancellationIntent || barrier.pendingCancellationId !== state.cancellationIntent.cancellationId) {
        invalid('providerBarrierIntent.pendingCancellationId');
    }
}

function validateBarrierStatus(state: GoalSessionState): void {
    const kind = state.providerBarrierIntent?.kind;
    if (kind === 'cancellation' && state.status !== 'cancelling') invalid('cancellation barrier status');
    if (kind === 'terminal' && state.status !== 'terminated' && state.status !== 'failed') {
        invalid('terminal barrier status');
    }
}

function validatePendingCancellationKind(state: GoalSessionState): void {
    const barrier = state.providerBarrierIntent;
    if (barrier?.pendingCancellationId === undefined) return;
    if (barrier.kind !== 'cancellation' && barrier.kind !== 'terminal') {
        invalid('providerBarrierIntent.pendingCancellationId');
    }
}

function validateTerminalCancellationIdentity(state: GoalSessionState): void {
    const barrier = state.providerBarrierIntent;
    if (barrier?.kind !== 'terminal') return;
    if (!state.cancellationIntent || barrier.pendingCancellationId !== state.cancellationIntent.cancellationId) {
        invalid('terminal pendingCancellationId');
    }
}

function validateOperationGenerations(state: GoalSessionState): void {
    validateRecoveryGeneration(state);
    validateResumeGeneration(state);
    if (state.resumeIntent && state.recoveryAttempt) invalid('resume/recovery overlap');
    if (state.recoveryAttempt && state.completedRecovery) invalid('recovery/completedRecovery overlap');
    validateRecoveryIdentity(state);
    validateCompletedResume(state);
    validateResumeTurn(state);
    validateProviderOpenGeneration(state);
    validateActiveTurnGeneration(state);
}

function validateRecoveryGeneration(state: GoalSessionState): void {
    const recovery = state.recoveryAttempt;
    if (!recovery) return;
    if (recovery.controllerEpoch > state.controllerEpoch
        || recovery.operationGeneration > (state.providerOperationGeneration ?? -1)) invalid('recoveryAttempt');
}

function validateResumeGeneration(state: GoalSessionState): void {
    const resume = state.resumeIntent;
    if (!resume) return;
    if (resume.controllerEpoch > state.controllerEpoch
        || resume.operationGeneration > (state.providerOperationGeneration ?? -1)) invalid('resumeIntent');
}

function validateRecoveryIdentity(state: GoalSessionState): void {
    const recovery = state.recoveryAttempt;
    if (!recovery) return;
    if (state.recoveryAttemptId !== recovery.attemptId) invalid('recoveryAttemptId');
    if ((recovery.authoritativeAttemptId === undefined) !== (recovery.authoritativeExecutionId === undefined)) {
        invalid('recovery authoritative identity');
    }
    if (hasMismatchedRecoveryTurnIdentity(state)) invalid('recovery authoritative identity');
    if (recovery.sessionStatus !== undefined && recovery.sessionStatus !== state.status) {
        invalid('recovery sessionStatus');
    }
    if (recovery.authoritativeTurnStatus !== undefined
        && recovery.authoritativeTurnStatus !== state.activeTurn?.status) invalid('recovery turnStatus');
}

function hasMismatchedRecoveryTurnIdentity(state: GoalSessionState): boolean {
    const recovery = state.recoveryAttempt;
    if (recovery?.authoritativeAttemptId === undefined) return false;
    return recovery.authoritativeAttemptId !== state.activeTurn?.attemptId
        || recovery.authoritativeExecutionId !== state.activeTurn?.executionId;
}

function validateCompletedResume(state: GoalSessionState): void {
    const resume = state.resumeIntent;
    const completed = state.completedResume;
    if (!resume || !completed) return;
    if (resume.operationId !== completed.operationId
        || resume.operationGeneration !== completed.operationGeneration
        || resume.kind !== completed.kind
        || resume.controllerEpoch !== completed.controllerEpoch
        || resume.phase !== 'settled') invalid('completedResume');
}

function validateResumeTurn(state: GoalSessionState): void {
    const resume = state.resumeIntent;
    if (resume?.kind === 'active_turn' || resume?.kind === 'recovered_after_turn') {
        if (!resume.turnId || resume.turnId !== state.activeTurn?.turnId) invalid('resumeIntent.turnId');
        return;
    }
    if (resume?.turnId !== undefined) invalid('resumeIntent.turnId');
}

function validateProviderOpenGeneration(state: GoalSessionState): void {
    const generation = state.providerOpenOperationGeneration;
    if (generation !== undefined && generation > (state.providerOperationGeneration ?? -1)) {
        invalid('providerOpenOperationGeneration');
    }
    if ((state.providerOpenAttemptId === undefined) !== (generation === undefined)) invalid('provider open identity');
}

function validateActiveTurnGeneration(state: GoalSessionState): void {
    const generation = state.activeTurn?.providerOperationGeneration;
    if (generation !== undefined && generation > (state.providerOperationGeneration ?? -1)) {
        invalid('activeTurn.providerOperationGeneration');
    }
}

function validateStateCollections(state: GoalSessionState): void {
    if (state.completedTurns && (state.completedTurns.some(turn => !state.completedTurnIds.includes(turn.turnId))
        || state.completedTurns.length !== state.completedTurnIds.length)) invalid('completedTurns');
    if (new Set(state.completedTurnIds).size !== state.completedTurnIds.length
        || state.completedTurns && new Set(state.completedTurns.map(turn => turn.turnId)).size !== state.completedTurns.length) {
        invalid('completedTurns');
    }
    if (state.usageAccounting && new Set(state.usageAccounting.occurrences).size !== state.usageAccounting.occurrences.length) {
        invalid('usageAccounting.occurrences');
    }
    validateCompletedCurrentTurnIdentities(state);
}

function validateCompletedCurrentTurnIdentities(state: GoalSessionState): void {
    for (const completed of state.completedTurns ?? []) {
        if (state.activeTurn?.turnId !== completed.turnId) continue;
        if (state.activeTurn.executionId !== completed.executionId
            || state.activeTurn.attemptId !== completed.attemptId
            || !['completed', 'cancelled', 'failed'].includes(state.activeTurn.status)) {
            invalid('completed/current turn identity');
        }
    }
}

function validateModelGenerations(state: GoalSessionState): void {
    const intents = state.modelChangeIntents ?? [];
    validateModelIntentOrder(intents);
    const tail = intents.at(-1);
    validateModelIntentTail(state, tail);
    if ((state.modelChangeGeneration ?? 0) < (tail?.generation ?? 0)) invalid('modelChangeGeneration');
    validatePendingModelChange(state, tail);
    const effectiveIntents = intents.length ? intents : state.modelChangeIntent ? [state.modelChangeIntent] : [];
    for (const intent of effectiveIntents) validateModelIntentRelationships(intent);
    validateEffectiveModel(state, tail);
    validateActiveTurnModelChange(state, effectiveIntents);
}

function validateModelIntentOrder(intents: GoalModelChangeIntent[]): void {
    if (new Set(intents.map(intent => intent.modelChangeId)).size !== intents.length) invalid('duplicate modelChangeIds');
    const generations = intents.map(intent => intent.generation ?? 0);
    if (generations.some((generation, index) => index > 0 && generation <= generations[index - 1])) {
        invalid('modelChangeIntents.generation');
    }
}

function validateModelIntentTail(state: GoalSessionState, tail: GoalModelChangeIntent | undefined): void {
    if (state.modelChangeIntents === undefined) return;
    if (state.modelChangeIntent && (!tail || JSON.stringify(state.modelChangeIntent) !== JSON.stringify(tail))) {
        invalid('modelChangeIntent tail');
    }
    if (!state.modelChangeIntent && tail) invalid('modelChangeIntent tail');
}

function validatePendingModelChange(state: GoalSessionState, tail: GoalModelChangeIntent | undefined): void {
    if (state.pendingModelChange === undefined) return;
    if (!tail || tail.model !== state.pendingModelChange || tail.phase === 'committed' || tail.phase === 'superseded') {
        invalid('pendingModelChange');
    }
}

function validateEffectiveModel(state: GoalSessionState, tail: GoalModelChangeIntent | undefined): void {
    if (tail?.phase !== 'committed' || tail.acknowledgement?.effectiveModel === undefined) return;
    if (state.pendingModelChange === undefined && state.currentModel !== tail.acknowledgement.effectiveModel) {
        invalid('currentModel/model acknowledgement');
    }
}

function validateActiveTurnModelChange(state: GoalSessionState, intents: GoalModelChangeIntent[]): void {
    const active = state.activeTurn?.modelChange;
    if (!active) return;
    const intent = intents.find(candidate => candidate.modelChangeId === active.modelChangeId);
    if (!intent || intent.generation !== active.generation || intent.model !== state.activeTurn?.requestedModel) {
        invalid('activeTurn.modelChange');
    }
}

function validateModelIntentRelationships(intent: GoalModelChangeIntent): void {
    const hasLease = hasModelLease(intent);
    validateCompleteModelLease(intent, hasLease);
    validatePendingModelPhase(intent, hasLease);
    validateProviderInDoubtModelPhase(intent, hasLease);
    validateSettledModelPhase(intent);
    if (intent.acknowledgement?.requestedModel !== undefined
        && intent.acknowledgement.requestedModel !== intent.model) invalid('acknowledgement model mismatch');
    validateModelInvocationEvidence(intent, hasLease);
}

function hasModelLease(intent: GoalModelChangeIntent): boolean {
    return intent.applicationToken !== undefined
        || intent.applicationControllerEpoch !== undefined
        || intent.leaseExpiresAt !== undefined;
}

function validateCompleteModelLease(intent: GoalModelChangeIntent, hasLease: boolean): void {
    if (hasLease && (!intent.applicationToken || intent.applicationControllerEpoch === undefined || !intent.leaseExpiresAt)) {
        invalid('model application lease');
    }
}

function validatePendingModelPhase(intent: GoalModelChangeIntent, hasLease: boolean): void {
    if (intent.phase !== 'pending' && intent.phase !== undefined) return;
    if (hasLease || intent.acknowledgement || intent.invocationEvidence) invalid('pending model phase');
}

function validateProviderInDoubtModelPhase(intent: GoalModelChangeIntent, hasLease: boolean): void {
    if (intent.phase !== 'provider_in_doubt') return;
    if (!hasLease || intent.acknowledgement || intent.invocationEvidence) invalid('provider_in_doubt model phase');
}

function validateSettledModelPhase(intent: GoalModelChangeIntent): void {
    if ((intent.phase === 'committed' || intent.phase === 'superseded') && !intent.acknowledgement) {
        invalid('settled model acknowledgement');
    }
}

function validateModelInvocationEvidence(intent: GoalModelChangeIntent, hasLease: boolean): void {
    const evidence = intent.invocationEvidence;
    if (!evidence) return;
    if (intent.phase !== 'committed' || hasLease
        || evidence.modelChangeId !== intent.modelChangeId
        || evidence.generation !== intent.generation
        || evidence.requestedModel !== intent.model
        || evidence.effectiveModel !== intent.acknowledgement?.effectiveModel) invalid('model invocation evidence');
}

function invalid(field: string): never {
    throw new GoalSessionContractError(`Durable goal session contains an invalid ${field}`, 'INVALID_DURABLE_STATE');
}
