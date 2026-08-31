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
    return event.type === 'model_changed' || event.type === 'pause_boundary';
}

export function streamAuditTransitionId(
    fence: GoalSessionFence,
    execution: GoalExecutionIdentity,
    event: Extract<GoalSessionEvent, { type: 'model_changed' | 'pause_boundary' }>,
    streamOrdinal: number,
): string {
    const semanticEvent = event.type === 'model_changed'
        ? [event.type, event.model]
        : [event.type, event.boundary, event.checkpointId ?? null];
    const digest = createHash('sha256')
        .update(JSON.stringify([
            fence.turnId,
            execution.executionId,
            execution.attemptId,
            event.providerEventId ?? null,
            event.providerEventOrdinal ?? streamOrdinal,
            semanticEvent,
        ]))
        .digest('hex')
        .slice(0, 32);
    return `stream-audit-${digest}`;
}
