import type {
    GoalModelChangeAcknowledgement, GoalModelChangeIntent, GoalModelChangeRequest, GoalSessionState,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';

/**
 * Settled generations kept for ambiguous controller retries. Provider-side
 * idempotency identities older than this window have no live local caller and
 * their ordered audit evidence remains in the append-only event stream.
 */
export const MODEL_CHANGE_SETTLED_RETRY_HORIZON = 64;

function isSettled(intent: GoalModelChangeIntent): boolean {
    return (intent.phase === 'committed' || intent.phase === 'superseded') && !intent.applicationToken;
}

/**
 * Deterministically bounds settled intent history without ever removing an
 * unresolved provider obligation. The newest generation is retained even for
 * legacy records whose phase was omitted.
 */
export function compactImmediateModelIntents(
    intents: readonly GoalModelChangeIntent[],
): GoalModelChangeIntent[] {
    if (intents.length <= MODEL_CHANGE_SETTLED_RETRY_HORIZON) return [...intents];
    const settledToRetain = new Set(
        intents
            .filter(isSettled)
            .slice(-MODEL_CHANGE_SETTLED_RETRY_HORIZON)
            .map(intent => intent.modelChangeId),
    );
    const latestId = intents.at(-1)?.modelChangeId;
    return intents.filter(intent =>
        !isSettled(intent) || settledToRetain.has(intent.modelChangeId) || intent.modelChangeId === latestId);
}

export function requestedImmediateModelIntent(
    state: GoalSessionState,
    request: GoalModelChangeRequest,
): { intent?: GoalModelChangeIntent } {
    if (request.operationId !== undefined && !/^[A-Za-z0-9._:-]{1,256}$/.test(request.operationId)) {
        throw new GoalSessionContractError('Model change operationId is invalid', 'INVALID_MODEL_OPERATION_ID');
    }
    let intent = request.operationId
        ? immediateModelIntents(state).find(value => value.modelChangeId === request.operationId)
        : latestImmediateModelIntent(state);
    if (!request.operationId && intent?.model !== request.model) intent = undefined;
    if (intent && intent.model !== request.model) {
        throw new GoalSessionContractError('Model operationId was already used for a different model', 'MODEL_OPERATION_CONFLICT');
    }
    return { intent };
}

export function assertModelControllable(state: GoalSessionState): void {
    if (state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') {
        throw new GoalSessionContractError(
            `Cannot apply a model while the session is ${state.status}`, 'SESSION_NOT_CONTROLLABLE',
        );
    }
}

export function validateImmediateModelAcknowledgement(
    request: GoalModelChangeRequest,
    state: GoalSessionState,
    acknowledgement: GoalModelChangeAcknowledgement,
): void {
    if (acknowledgement.requestedModel !== request.model) {
        throw new GoalSessionContractError('Provider acknowledged a different requested model', 'MODEL_ACK_MISMATCH');
    }
    if (acknowledgement.appliesAt === 'next_turn') {
        throw new GoalSessionContractError('Provider deferred beyond its declared model boundary', 'CAPABILITY_ACK_MISMATCH');
    }
    if (acknowledgement.appliesAt === 'immediate'
        && (state.status === 'running' || state.status === 'pause_requested')) {
        throw new GoalSessionContractError(
            'Provider applied a model change before an active-turn safe boundary', 'CAPABILITY_ACK_MISMATCH',
        );
    }
}

export function immediateModelIntents(state: GoalSessionState): GoalModelChangeIntent[] {
    if (state.modelChangeIntents?.length) return state.modelChangeIntents;
    return state.modelChangeIntent ? [state.modelChangeIntent] : [];
}

export function latestImmediateModelIntent(state: GoalSessionState): GoalModelChangeIntent | undefined {
    return immediateModelIntents(state).at(-1);
}

export function nextModelGeneration(state: GoalSessionState): number {
    const durableMaximum = immediateModelIntents(state).reduce(
        (maximum, intent) => Math.max(maximum, intent.generation ?? 0),
        0,
    );
    return Math.max(state.modelChangeGeneration ?? 0, durableMaximum) + 1;
}

export function replaceImmediateModelIntent(
    state: GoalSessionState,
    replacement: GoalModelChangeIntent,
): GoalModelChangeIntent[] {
    return compactImmediateModelIntents(immediateModelIntents(state).map(intent =>
        intent.modelChangeId === replacement.modelChangeId ? replacement : intent));
}

export function hasUnresolvedImmediateModelIntent(state: GoalSessionState): boolean {
    return immediateModelIntents(state).some(intent =>
        Boolean(intent.applicationToken) || (intent.phase !== 'committed' && intent.phase !== 'superseded'));
}
