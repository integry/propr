import type {
    DurableCorrectiveMessage,
    GoalExecutionIdentity,
    GoalProviderSessionSnapshot,
    GoalProviderTurnContext,
    GoalSessionControlFence,
    GoalSessionIdentity,
    GoalSessionState,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { safeDiagnostic } from './securityBoundary.js';
import { sanitizeRecoveryMetadata } from './recoveryMetadata.js';

/** Sentinel turn identity used by session-scoped control/audit events. */
export function controlExecutionIdentity(state: Pick<GoalSessionState, 'sessionId' | 'controllerEpoch'>): GoalExecutionIdentity {
    return {
        executionId: `control-${state.sessionId}`,
        attemptId: `epoch-${state.controllerEpoch}`,
    };
}

export function nowIso(): string {
    return new Date().toISOString();
}

export function validateIdentity(identity: GoalSessionIdentity): void {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(identity.goalId)
        || !/^[A-Za-z0-9._:-]{1,256}$/.test(identity.sessionId)) {
        throw new GoalSessionContractError('goalId and sessionId must be non-empty', 'INVALID_IDENTITY');
    }
}

export function validateEpoch(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
        throw new GoalSessionContractError('controllerEpoch must be a non-negative safe integer', 'INVALID_EPOCH');
    }
}

export function validateControlFence(fence: GoalSessionControlFence): void {
    validateIdentity(fence);
    validateEpoch(fence.controllerEpoch);
}

export function persistedSnapshot(state: GoalSessionState): GoalProviderSessionSnapshot {
    if (!state.providerSessionId || state.recoveryMetadata === undefined) {
        throw new GoalSessionContractError(
            'Provider identity/checkpoint is not durable; the session cannot be resumed safely',
            'SESSION_NOT_RECOVERABLE',
        );
    }
    if (safeDiagnostic(state.providerSessionId, '') !== state.providerSessionId.trim()
        || state.currentModel !== undefined
        && safeDiagnostic(state.currentModel, '') !== state.currentModel.trim()) {
        throw new GoalSessionContractError('Durable provider identity contains an unsafe value', 'UNSAFE_PROVIDER_VALUE');
    }
    return {
        providerSessionId: state.providerSessionId,
        recoveryMetadata: sanitizeRecoveryMetadata(state.recoveryMetadata),
        model: state.currentModel,
    };
}

export function providerTurnContext(state: GoalSessionState): GoalProviderTurnContext {
    if (state.providerSessionId && state.recoveryMetadata !== undefined) {
        return { binding: 'bound', snapshot: persistedSnapshot(state) };
    }
    if (state.initializationIntent) {
        return { binding: 'pending', initializationIntent: state.initializationIntent };
    }
    throw new GoalSessionContractError(
        'The first provider turn has neither a durable native ID nor initialization intent',
        'SESSION_INITIALIZATION_INTENT_MISSING',
    );
}

export function nextState(state: GoalSessionState, changes: Partial<GoalSessionState>): Omit<GoalSessionState, 'version'> {
    const withoutVersion: Partial<GoalSessionState> = { ...state };
    const effectiveChanges = { ...changes };
    delete withoutVersion.version;
    // A committed recovery receipt is valid only until the next durable state
    // mutation. Spread-based updates may echo the same object; only an explicit
    // new receipt (the atomic recovery transaction) is retained.
    delete withoutVersion.completedRecovery;
    if (effectiveChanges.completedRecovery === state.completedRecovery) delete effectiveChanges.completedRecovery;
    return { ...withoutVersion, ...effectiveChanges, updatedAt: nowIso() } as Omit<GoalSessionState, 'version'>;
}

export function assertProviderIdentity(state: GoalSessionState, snapshot: GoalProviderSessionSnapshot): void {
    if (!snapshot.providerSessionId.trim()
        || safeDiagnostic(snapshot.providerSessionId, '') !== snapshot.providerSessionId.trim()
        || (snapshot.model !== undefined && safeDiagnostic(snapshot.model, '') !== snapshot.model.trim())) {
        throw new GoalSessionContractError('Provider snapshot contains an unsafe identity or model', 'UNSAFE_PROVIDER_VALUE');
    }
    if (state.providerSessionId && state.providerSessionId !== snapshot.providerSessionId) {
        throw new GoalSessionContractError(
            `Provider attempted to replace session "${state.providerSessionId}" with "${snapshot.providerSessionId}"`,
            'PROVIDER_SESSION_CHANGED',
        );
    }
}

export function firstPendingCorrectiveMessage(messages: DurableCorrectiveMessage[]): DurableCorrectiveMessage | undefined {
    return [...messages].sort((a, b) => a.sequence - b.sequence)[0];
}
