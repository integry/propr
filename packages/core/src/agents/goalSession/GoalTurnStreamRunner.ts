import type {
    GoalExecutionIdentity, GoalProviderCorrectiveMessage, GoalSessionEvent,
    GoalSessionFence, GoalSessionState,
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { GoalSessionCore } from './GoalSessionCore.js';
import { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
import { safeDiagnostic, sanitizeGoalSessionEvent } from './securityBoundary.js';
import {
    assertFirstTurnIdentityEvent, assertSuppliedMessagesAcknowledged,
    isAtomicTurnAudit, streamAuditTransitionId,
} from './turnStreamProtocol.js';

type TurnStreamOutcome = { state: GoalSessionState; completed: boolean; reachedPause: boolean };

interface TurnStreamOptions {
    fence: GoalSessionFence;
    execution: GoalExecutionIdentity;
    initial: GoalSessionState;
    nextTurnMessages: GoalProviderCorrectiveMessage[];
    openStream: () => AsyncIterable<GoalSessionEvent>;
}

/** Exact-attempt stream consumption and atomic event/state persistence. */
export abstract class GoalTurnStreamRunner extends GoalSessionCore {
    protected async driveTurnStream(options: TurnStreamOptions): Promise<TurnStreamOutcome> {
        const { fence, execution } = options;
        let current = options.initial;
        const awaitingMessageIds = options.nextTurnMessages.map(message => message.messageId);
        let reachedPause = false;
        let completed = false;
        try {
            const stream = options.openStream();
            for await (const rawEvent of stream) {
                const event = sanitizeGoalSessionEvent(rawEvent);
                if (completed) throw new GoalSessionContractError('Provider emitted an event after turn completion', 'EVENT_AFTER_COMPLETION');
                assertFirstTurnIdentityEvent(current, event, this.adapter.capabilities.nativeSessionId);
                if (event.type === 'message_acknowledged') {
                    await this.acknowledgeNextTurnMessage(fence, execution, event.messageId, awaitingMessageIds);
                    continue;
                }
                assertSuppliedMessagesAcknowledged(event, awaitingMessageIds);
                if (event.type === 'completion' && this.adapter.capabilities.pause === 'after_turn') {
                    current = await this.requireActiveAttemptState(fence, execution);
                }
                current = await this.applyTurnEvent({ fence, current, execution, event });
                if (event.type === 'pause_boundary') reachedPause = true;
                if (event.type === 'completion') completed = true;
                if (event.type !== 'completion' && !isAtomicTurnAudit(event)) await this.append(fence, execution, event);
                if (event.type === 'pause_boundary' && this.adapter.capabilities.pause === 'active_turn') break;
                if (event.type === 'completion' && current.status === 'paused') reachedPause = true;
            }
            if (!completed && !reachedPause) {
                const error = 'Provider stream ended without a completion or safe pause boundary';
                current = await this.commitTurnCompletion(fence, execution, { type: 'completion', outcome: 'failed', error });
                completed = true;
            }
            return { state: current, completed, reachedPause };
        } catch (error) {
            if (error instanceof StaleGoalSessionFenceError) throw error;
            const message = `Provider turn failed: ${safeDiagnostic((error as Error).message, 'provider operation failed safely')}`;
            await this.finishTurnIfOwned(fence, execution, message);
            throw error;
        }
    }

    private async acknowledgeNextTurnMessage(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        messageId: string,
        awaitingMessageIds: string[],
    ): Promise<void> {
        const expected = awaitingMessageIds[0];
        if (expected !== messageId) {
            throw new GoalSessionContractError(
                `Provider acknowledged corrective message "${messageId}" while "${expected ?? 'none'}" was next`,
                'MESSAGE_ACK_OUT_OF_ORDER',
            );
        }
        sanitizeGoalSessionEvent({ type: 'message_acknowledged', messageId });
        const result = await this.ports.messages.acknowledgeWithEvent(fence, execution, messageId);
        if (result === 'stale_fence') throw new StaleGoalSessionFenceError();
        if (result === 'not_found') throw new GoalSessionContractError(
            'Corrective message disappeared before acknowledgement', 'MESSAGE_NOT_FOUND',
        );
        awaitingMessageIds.shift();
    }

    private async applyTurnEvent(options: {
        fence: GoalSessionFence; current: GoalSessionState;
        execution: GoalExecutionIdentity; event: GoalSessionEvent;
    }): Promise<GoalSessionState> {
        const { fence, current, execution, event } = options;
        if (event.type === 'checkpoint') return this.persistCheckpoint(fence, current, execution, event);
        if (event.type === 'model_changed') return this.commitTurnTransition({
            state: current, fence, execution,
            update: value => ({
                currentModel: event.model,
                pendingModelChange: value.pendingModelChange === event.model ? undefined : value.pendingModelChange,
            }),
            auditEvents: [event], transitionId: streamAuditTransitionId(fence, execution, event),
        });
        if (event.type === 'pause_boundary') return this.commitTurnTransition({
            state: current, fence, execution,
            update: value => ({
                status: 'paused',
                activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'paused' } : value.activeTurn,
            }),
            auditEvents: [event], transitionId: streamAuditTransitionId(fence, execution, event),
        });
        if (event.type === 'completion') return this.commitTurnCompletion(fence, execution, event);
        return current;
    }

    private persistCheckpoint(
        fence: GoalSessionFence,
        state: GoalSessionState,
        execution: GoalExecutionIdentity,
        event: Extract<GoalSessionEvent, { type: 'checkpoint' }>,
    ): Promise<GoalSessionState> {
        if (event.providerSessionId && state.providerSessionId && event.providerSessionId !== state.providerSessionId) {
            throw new GoalSessionContractError('Checkpoint attempted to replace the provider session identity', 'PROVIDER_SESSION_CHANGED');
        }
        assertCredentialFreeRecoveryMetadata(event.recoveryMetadata);
        return this.updateActiveTurnState(fence, execution, value => ({
            ...value,
            providerSessionId: event.providerSessionId ?? value.providerSessionId,
            recoveryMetadata: event.recoveryMetadata,
            initializationIntent: event.providerSessionId ? undefined : value.initializationIntent,
            currentModel: event.providerSessionId && !value.providerSessionId
                ? value.activeTurn?.requestedModel ?? value.currentModel : value.currentModel,
            pendingModelChange: event.providerSessionId && !value.providerSessionId
                && value.pendingModelChange === value.activeTurn?.requestedModel
                ? undefined : value.pendingModelChange,
        }));
    }

    private async finishTurnIfOwned(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        error: string,
    ): Promise<GoalSessionState> {
        try {
            return await this.commitTurnCompletion(fence, execution, { type: 'completion', outcome: 'failed', error });
        } catch {
            return this.requireState(fence);
        }
    }
}
