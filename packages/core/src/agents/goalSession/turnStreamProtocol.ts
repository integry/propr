import { createHash } from 'node:crypto';
import type {
    GoalExecutionIdentity,
    GoalNativeSessionIdTiming,
    GoalSessionFence,
    GoalSessionEvent,
    GoalSessionState,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';

export function assertFirstTurnIdentityEvent(
    state: GoalSessionState,
    event: GoalSessionEvent,
    idTiming: GoalNativeSessionIdTiming,
): void {
    if (state.providerSessionId || idTiming !== 'first_turn') return;
    if (event.type !== 'checkpoint' || !event.providerSessionId?.trim()) {
        throw new GoalSessionContractError(
            'A first-turn provider must durably bind its native session ID before emitting authoritative work',
            'FIRST_TURN_ID_NOT_BOUND',
        );
    }
}

export function assertSuppliedMessagesAcknowledged(
    event: GoalSessionEvent,
    awaitingMessageIds: string[],
): void {
    if (event.type !== 'completion' || event.outcome !== 'succeeded' || awaitingMessageIds.length === 0) return;
    throw new GoalSessionContractError(
        `Provider reported success without acknowledging supplied corrective message "${awaitingMessageIds[0]}"`,
        'MESSAGE_ACK_MISSING',
    );
}

export function isAtomicTurnAudit(event: GoalSessionEvent): boolean {
    return event.type === 'model_changed' || event.type === 'pause_boundary' || event.type === 'usage';
}

export function streamAuditTransitionId(
    fence: GoalSessionFence,
    execution: GoalExecutionIdentity,
    event: Extract<GoalSessionEvent, { type: 'model_changed' | 'pause_boundary' }>,
): string {
    const occurrence = streamTransitionOccurrence(event);
    const digest = createHash('sha256')
        .update(JSON.stringify([
            fence.goalId,
            fence.sessionId,
            fence.controllerEpoch,
            fence.turnId,
            execution.executionId,
            execution.attemptId,
            occurrence,
        ]))
        .digest('hex')
        .slice(0, 32);
    return `stream-audit-${digest}`;
}

/** Validates and selects the provider-stable occurrence identity. IDs win over ordinals. */
export function streamTransitionOccurrence(
    event: Extract<GoalSessionEvent, { type: 'model_changed' | 'pause_boundary' }>,
): readonly ['provider_event_id', string] | readonly ['provider_event_ordinal', number] {
    if (event.providerEventId !== undefined) {
        if (typeof event.providerEventId !== 'string' || !event.providerEventId.trim()) {
            throw new GoalSessionContractError(
                'Streamed model/pause transition providerEventId must be non-empty',
                'STREAM_TRANSITION_ID_INVALID',
            );
        }
        return ['provider_event_id', event.providerEventId];
    }
    if (Number.isSafeInteger(event.providerEventOrdinal) && (event.providerEventOrdinal ?? -1) >= 0) {
        return ['provider_event_ordinal', event.providerEventOrdinal as number];
    }
    throw new GoalSessionContractError(
        'Streamed model/pause transition requires a stable providerEventId or providerEventOrdinal',
        'STREAM_TRANSITION_ID_MISSING',
    );
}
