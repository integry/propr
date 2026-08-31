import type { GoalModelChangeIntent, GoalModelChangeRequest, GoalSessionState } from './contract.js';
import { createHash } from 'node:crypto';
import { GoalSessionContractError } from './errors.js';

/**
 * Settled generations kept for ambiguous controller retries. Provider-side
 * idempotency identities older than this window have no live local caller and
 * their ordered audit evidence remains in the append-only event stream.
 */
export const MODEL_CHANGE_SETTLED_RETRY_HORIZON = 64;
const RETIRED_FILTER_BYTES = 6 * 1024;
const RETIRED_HASH_COUNT = 6;
const RETIRED_FILTER_TEXT_LENGTH = Math.ceil(RETIRED_FILTER_BYTES / 3) * 4;

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

export function retireCompactedModelIds(
    filter: string | undefined,
    before: readonly GoalModelChangeIntent[],
    retained: readonly GoalModelChangeIntent[],
): string | undefined {
    const retainedIds = new Set(retained.map(intent => intent.modelChangeId));
    const retired = before.filter(intent => !retainedIds.has(intent.modelChangeId));
    if (!retired.length) return filter;
    const bits = filter && filter.length === RETIRED_FILTER_TEXT_LENGTH
        ? Buffer.from(filter, 'base64') : Buffer.alloc(RETIRED_FILTER_BYTES);
    for (const intent of retired) setRetiredBits(bits, intent.modelChangeId);
    return bits.toString('base64');
}

export function retiredFilterAfterCompaction(
    state: GoalSessionState,
    retained: readonly GoalModelChangeIntent[],
): string | undefined {
    return retireCompactedModelIds(state.modelChangeRetiredFilter, immediateModelIntents(state), retained);
}

export function wasModelOperationRetired(filter: string | undefined, operationId: string): boolean {
    if (!filter || filter.length !== RETIRED_FILTER_TEXT_LENGTH) return false;
    const bits = Buffer.from(filter, 'base64');
    return retiredIndexes(operationId).every(index => (bits[index >>> 3] & (1 << (index & 7))) !== 0);
}

export function requestedImmediateModelIntent(
    state: GoalSessionState,
    request: GoalModelChangeRequest,
): { intent?: GoalModelChangeIntent; retired: boolean } {
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
    return {
        intent,
        retired: Boolean(!intent && request.operationId
            && wasModelOperationRetired(state.modelChangeRetiredFilter, request.operationId)),
    };
}

export function assertModelControllable(state: GoalSessionState): void {
    if (state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') {
        throw new GoalSessionContractError(
            `Cannot apply a model while the session is ${state.status}`, 'SESSION_NOT_CONTROLLABLE',
        );
    }
}

function setRetiredBits(bits: Buffer, operationId: string): void {
    for (const index of retiredIndexes(operationId)) bits[index >>> 3] |= 1 << (index & 7);
}

function retiredIndexes(operationId: string): number[] {
    const digest = createHash('sha256').update(operationId).digest();
    const count = RETIRED_FILTER_BYTES * 8;
    return Array.from({ length: RETIRED_HASH_COUNT }, (_, offset) => digest.readUInt32BE(offset * 4) % count);
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
