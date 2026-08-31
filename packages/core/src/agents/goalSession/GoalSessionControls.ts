import type {
    GoalCancelRequest,
    GoalExecutionIdentity,
    GoalMessageDeliveryOutcome,
    GoalModelChangeAcknowledgement,
    GoalModelChangeRequest,
    GoalPauseAcknowledgement,
    GoalPauseRequest,
    GoalPendingCancellationContext,
    GoalSessionControlFence,
    GoalSessionState,
    GoalSteeringRequest,
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { GoalTurnRunner } from './GoalTurnRunner.js';
import { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
import {
    assertProviderIdentity,
    controlExecutionIdentity,
    nextState,
    persistedSnapshot,
} from './support.js';

/** Capability-aware steering, pause, resume, model, and cancellation controls. */
export abstract class GoalSessionControls extends GoalTurnRunner {
    async deliverMessage(request: GoalSteeringRequest): Promise<GoalMessageDeliveryOutcome> {
        const state = await this.requireActiveTurnState(request);
        const pending = (await this.ports.messages.listPending(request)).sort((a, b) => a.sequence - b.sequence);
        const message = pending.find(value => value.messageId === request.messageId);
        if (!message) {
            return { outcome: 'acknowledged', messageId: request.messageId, acknowledgement: 'already_acknowledged' };
        }
        if (this.adapter.capabilities.steering === 'next_turn') {
            return { outcome: 'unsupported_same_turn', messageId: request.messageId, supportedBoundary: 'next_turn' };
        }
        if (pending[0]?.messageId !== request.messageId) {
            throw new GoalSessionContractError(
                `Corrective message "${request.messageId}" is out of order; "${pending[0]?.messageId}" must be delivered first`,
                'MESSAGE_OUT_OF_ORDER',
            );
        }
        if (!this.adapter.deliverMessage) {
            throw new GoalSessionContractError('Provider declares active-turn steering without implementing it', 'CAPABILITY_METHOD_MISSING');
        }
        const acknowledgement = await this.adapter.deliverMessage(
            { ...request, body: message.body },
            persistedSnapshot(state),
        );
        if (acknowledgement.messageId !== request.messageId) {
            throw new GoalSessionContractError('Provider acknowledged a different corrective message', 'MESSAGE_ACK_MISMATCH');
        }
        const stillOwned = await this.requireActiveTurnState(request);
        if (stillOwned.version !== state.version
            || stillOwned.activeTurn?.attemptId !== state.activeTurn?.attemptId) {
            throw new StaleGoalSessionFenceError('A newer operation superseded message delivery');
        }
        const execution = this.activeExecution(state);
        const result = await this.ports.messages.acknowledge(request, execution, request.messageId);
        if (result === 'stale_fence') throw new StaleGoalSessionFenceError();
        if (result === 'not_found') {
            throw new GoalSessionContractError('Corrective message disappeared before acknowledgement', 'MESSAGE_NOT_FOUND');
        }
        if (result === 'acknowledged') {
            await this.append(request, execution, {
                type: 'message_acknowledged', messageId: request.messageId,
            });
        }
        return { outcome: 'acknowledged', messageId: request.messageId, acknowledgement: result };
    }

    async requestPause(request: GoalPauseRequest): Promise<GoalPauseAcknowledgement> {
        if (this.adapter.capabilities.pause === 'after_turn') return this.requestAfterTurnPause(request);
        let state = await this.requireControlledState(request);
        if (state.status !== 'running' && state.status !== 'pause_requested') {
            throw new GoalSessionContractError(`Cannot pause a session while it is ${state.status}`, 'SESSION_NOT_RUNNING');
        }
        if (state.status === 'running') state = await this.markPauseRequested(state);
        if (!this.adapter.requestPause) {
            throw new GoalSessionContractError('Provider declares active-turn pause without implementing it', 'CAPABILITY_METHOD_MISSING');
        }
        const acknowledgement = await this.adapter.requestPause(request, persistedSnapshot(state));
        if (acknowledgement.appliesAt === 'after_turn') {
            throw new GoalSessionContractError('Active-turn provider returned an after-turn pause acknowledgement', 'CAPABILITY_ACK_MISMATCH');
        }
        const stillOwned = await this.requireControlledState(request);
        if (stillOwned.version !== state.version || stillOwned.status === 'terminated' || stillOwned.status === 'failed') {
            throw new StaleGoalSessionFenceError('A newer operation superseded the pause acknowledgement');
        }
        await this.appendControl(request, controlExecutionIdentity(state), {
            type: 'pause_requested', appliesAt: acknowledgement.appliesAt,
        });
        if (acknowledgement.boundaryReached) {
            state = await this.markPaused(state);
            await this.appendControl(request, controlExecutionIdentity(state), {
                type: 'pause_boundary', ...acknowledgement.boundaryReached,
            });
        }
        return acknowledgement;
    }

    async resumeSession(request: GoalSessionControlFence): Promise<GoalSessionState> {
        if (this.adapter.capabilities.pause !== 'after_turn') {
            throw new GoalSessionContractError(
                'An active-turn provider resumes through resumeTurn, not a new turn boundary',
                'UNSUPPORTED_AFTER_TURN_RESUME',
            );
        }
        let state = await this.requireControlledState(request);
        if (state.status !== 'paused' || state.activeTurn) {
            throw new GoalSessionContractError(`Cannot resume a session while it is ${state.status}`, 'SESSION_NOT_PAUSED');
        }
        state = await this.compareAndSetExact(state, {}, 'A newer operation superseded the resume intent');
        const snapshot = await this.adapter.resumeSession(request, persistedSnapshot(state));
        assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata);
        assertProviderIdentity(state, snapshot);
        const resumed = await this.compareAndSetExact(state, {
            providerSessionId: snapshot.providerSessionId,
            recoveryMetadata: snapshot.recoveryMetadata,
            currentModel: snapshot.model ?? state.currentModel,
            status: 'idle',
        }, 'A newer operation superseded the resumed provider snapshot');
        await this.appendControl(request, controlExecutionIdentity(resumed), { type: 'session_resumed' });
        return resumed;
    }

    async requestModelChange(request: GoalModelChangeRequest): Promise<GoalModelChangeAcknowledgement> {
        let state = await this.requireControlledState(request);
        if (state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') {
            throw new GoalSessionContractError(`Cannot change model while the session is ${state.status}`, 'SESSION_NOT_CONTROLLABLE');
        }
        if (this.adapter.capabilities.modelChange === 'next_turn') {
            state = await this.compareAndSetExact(state, {
                requestedModel: request.model, pendingModelChange: request.model,
            }, 'A newer model intent superseded this request');
            const acknowledgement = { requestedModel: request.model, appliesAt: 'next_turn' as const };
            await this.appendControl(request, controlExecutionIdentity(state), {
                type: 'model_change_acknowledged', ...acknowledgement,
            });
            return acknowledgement;
        }
        const previousModel = state.currentModel;
        const previousRequestedModel = state.requestedModel;
        state = await this.compareAndSetExact(state, { requestedModel: request.model }, 'A newer model intent superseded this request');
        let acknowledgement: GoalModelChangeAcknowledgement;
        try {
            acknowledgement = await this.adapter.requestModelChange(request, persistedSnapshot(state));
            if (acknowledgement.requestedModel !== request.model) {
                throw new GoalSessionContractError('Provider acknowledged a different requested model', 'MODEL_ACK_MISMATCH');
            }
            if (acknowledgement.appliesAt === 'next_turn') {
                throw new GoalSessionContractError('Provider deferred beyond its declared model boundary', 'CAPABILITY_ACK_MISMATCH');
            }
            if (acknowledgement.appliesAt === 'immediate'
                && (state.status === 'running' || state.status === 'pause_requested')) {
                throw new GoalSessionContractError('Provider applied a model change before an active-turn safe boundary', 'CAPABILITY_ACK_MISMATCH');
            }
            state = await this.compareAndSetExact(state, {
                currentModel: acknowledgement.effectiveModel ?? state.currentModel,
            }, 'A newer model intent superseded the provider acknowledgement');
        } catch (error) {
            try { await this.compareAndSetExact(state, { requestedModel: previousRequestedModel }); }
            catch { /* A newer intent owns the field; do not roll it back. */ }
            throw error;
        }
        await this.appendControl(request, controlExecutionIdentity(state), {
            type: 'model_change_acknowledged', requestedModel: request.model, appliesAt: acknowledgement.appliesAt,
        });
        if (acknowledgement.effectiveModel) {
            await this.appendControl(request, controlExecutionIdentity(state), {
                type: 'model_changed', previousModel, model: acknowledgement.effectiveModel,
            });
        }
        return acknowledgement;
    }

    async cancel(request: GoalCancelRequest): Promise<GoalSessionState> {
        let state = await this.claimCancellation(request);
        if (state.status === 'terminated') return state;
        const pending = this.pendingCancellationContext(state);
        let signalError: unknown;
        try {
            if (pending) await this.adapter.cancelPending!(request, pending);
            else await this.adapter.cancel(request, persistedSnapshot(state));
        } catch (error) {
            signalError = error;
        }
        state = await this.commitControlCompletion(state, request, {
            status: 'terminated',
            activeTurn: undefined,
            initializationIntent: undefined,
            retryTurn: undefined,
            recoveryAttempt: undefined,
            pendingAfterTurnPause: undefined,
        }, { type: 'completion', outcome: 'cancelled', error: request.reason });
        // Terminal fencing is authoritative even when the adapter reports that
        // its best-effort process signal failed. Surface that failure only after
        // the session can no longer remain permanently stuck in cancelling.
        if (signalError) throw signalError;
        return state;
    }

    private async claimCancellation(request: GoalCancelRequest): Promise<GoalSessionState> {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const state = await this.requireControlledState(request);
            if (state.status === 'terminated' || state.status === 'cancelling') return state;
            if (!state.providerSessionId && (!state.initializationIntent || !this.adapter.cancelPending)) {
                throw new GoalSessionContractError(
                    'A lazy-ID provider must implement pending cancellation before it can be cancelled safely',
                    'CAPABILITY_METHOD_MISSING',
                );
            }
            const claimed = await this.ports.state.compareAndSet(state, nextState(state, { status: 'cancelling' }));
            if (claimed) return claimed;
        }
        throw new StaleGoalSessionFenceError('A newer operation repeatedly superseded cancellation');
    }

    private pendingCancellationContext(state: GoalSessionState): GoalPendingCancellationContext | undefined {
        if (state.providerSessionId) return undefined;
        if (!state.initializationIntent || !this.adapter.cancelPending) {
            throw new GoalSessionContractError(
                'A lazy-ID provider must implement pending cancellation before it can be cancelled safely',
                'CAPABILITY_METHOD_MISSING',
            );
        }
        return {
            initializationIntent: state.initializationIntent,
            activeTurn: state.activeTurn ? {
                turnId: state.activeTurn.turnId,
                executionId: state.activeTurn.executionId,
                attemptId: state.activeTurn.attemptId,
            } : undefined,
        };
    }

    private async requestAfterTurnPause(request: GoalPauseRequest): Promise<GoalPauseAcknowledgement> {
        let state = await this.requireControlledState(request);
        if (state.status === 'paused') return { appliesAt: 'after_turn' };
        if (state.status !== 'idle' && state.status !== 'running' && state.status !== 'pause_requested') {
            throw new GoalSessionContractError(`Cannot pause a session while it is ${state.status}`, 'SESSION_NOT_CONTROLLABLE');
        }
        if (state.status === 'idle') {
            state = await this.compareAndSetExact(state, { status: 'paused' });
            await this.appendControl(request, controlExecutionIdentity(state), {
                type: 'pause_requested', appliesAt: 'after_turn',
            });
            const boundaryReached = { boundary: 'after_turn' };
            await this.appendControl(request, controlExecutionIdentity(state), { type: 'pause_boundary', ...boundaryReached });
            return { appliesAt: 'after_turn', boundaryReached };
        }
        if (state.status === 'running') state = await this.markPauseRequested(state, true);
        await this.appendControl(request, controlExecutionIdentity(state), {
            type: 'pause_requested', appliesAt: 'after_turn',
        });
        return { appliesAt: 'after_turn' };
    }

    private markPauseRequested(state: GoalSessionState, afterTurn = false): Promise<GoalSessionState> {
        return this.compareAndSetExact(state, {
            status: 'pause_requested',
            activeTurn: state.activeTurn ? { ...state.activeTurn, status: 'pause_requested' } : state.activeTurn,
            pendingAfterTurnPause: afterTurn ? true : state.pendingAfterTurnPause,
        });
    }

    private markPaused(state: GoalSessionState): Promise<GoalSessionState> {
        return this.compareAndSetExact(state, {
            status: 'paused',
            activeTurn: state.activeTurn ? { ...state.activeTurn, status: 'paused' } : state.activeTurn,
        });
    }

    private activeExecution(state: GoalSessionState): GoalExecutionIdentity {
        if (!state.activeTurn) throw new StaleGoalSessionFenceError('No active turn owns this operation');
        return { executionId: state.activeTurn.executionId, attemptId: state.activeTurn.attemptId };
    }
}
