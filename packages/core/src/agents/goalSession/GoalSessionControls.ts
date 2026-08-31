import type {
    GoalCancelRequest,
    GoalExecutionIdentity,
    GoalMessageDeliveryOutcome,
    GoalModelChangeAcknowledgement,
    GoalModelChangeRequest,
    GoalPauseAcknowledgement,
    GoalPauseRequest,
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
        const result = await this.ports.messages.acknowledge(request, request.messageId);
        if (result === 'stale_fence') throw new StaleGoalSessionFenceError();
        if (result === 'not_found') {
            throw new GoalSessionContractError('Corrective message disappeared before acknowledgement', 'MESSAGE_NOT_FOUND');
        }
        if (result === 'acknowledged') {
            await this.append(request, this.activeExecution(state), {
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
        if (state.status === 'running') state = await this.markPauseRequested(request);
        if (!this.adapter.requestPause) {
            throw new GoalSessionContractError('Provider declares active-turn pause without implementing it', 'CAPABILITY_METHOD_MISSING');
        }
        const acknowledgement = await this.adapter.requestPause(request, persistedSnapshot(state));
        if (acknowledgement.appliesAt === 'after_turn') {
            throw new GoalSessionContractError('Active-turn provider returned an after-turn pause acknowledgement', 'CAPABILITY_ACK_MISMATCH');
        }
        await this.appendControl(request, controlExecutionIdentity(state), {
            type: 'pause_requested', appliesAt: acknowledgement.appliesAt,
        });
        if (acknowledgement.boundaryReached) {
            state = await this.markPaused(request);
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
        const state = await this.requireControlledState(request);
        if (state.status !== 'paused' || state.activeTurn) {
            throw new GoalSessionContractError(`Cannot resume a session while it is ${state.status}`, 'SESSION_NOT_PAUSED');
        }
        const snapshot = await this.adapter.resumeSession(request, persistedSnapshot(state));
        assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata);
        assertProviderIdentity(state, snapshot);
        const resumed = await this.updateControlledState(request, value => ({
            ...value,
            providerSessionId: snapshot.providerSessionId,
            recoveryMetadata: snapshot.recoveryMetadata,
            currentModel: snapshot.model ?? value.currentModel,
            status: 'idle',
        }));
        await this.appendControl(request, controlExecutionIdentity(resumed), { type: 'session_resumed' });
        return resumed;
    }

    async requestModelChange(request: GoalModelChangeRequest): Promise<GoalModelChangeAcknowledgement> {
        let state = await this.requireControlledState(request);
        if (state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') {
            throw new GoalSessionContractError(`Cannot change model while the session is ${state.status}`, 'SESSION_NOT_CONTROLLABLE');
        }
        if (this.adapter.capabilities.modelChange === 'next_turn') {
            state = await this.updateControlledState(request, value => ({
                ...value, requestedModel: request.model, pendingModelChange: request.model,
            }));
            const acknowledgement = { requestedModel: request.model, appliesAt: 'next_turn' as const };
            await this.appendControl(request, controlExecutionIdentity(state), {
                type: 'model_change_acknowledged', ...acknowledgement,
            });
            return acknowledgement;
        }
        const previousModel = state.currentModel;
        const acknowledgement = await this.adapter.requestModelChange(request, persistedSnapshot(state));
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
        state = await this.updateControlledState(request, value => ({
            ...value,
            requestedModel: request.model,
            currentModel: acknowledgement.effectiveModel ?? value.currentModel,
        }));
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
        let state = await this.requireControlledState(request);
        if (state.status === 'terminated') return state;
        state = await this.updateControlledState(request, value => ({ ...value, status: 'cancelling' }));
        await this.adapter.cancel(request, persistedSnapshot(state));
        state = await this.updateControlledState(request, value => ({
            ...value,
            status: 'terminated',
            activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'cancelled' } : value.activeTurn,
        }));
        await this.appendControl(request, controlExecutionIdentity(state), {
            type: 'completion', outcome: 'cancelled', error: request.reason,
        });
        return state;
    }

    private async requestAfterTurnPause(request: GoalPauseRequest): Promise<GoalPauseAcknowledgement> {
        let state = await this.requireControlledState(request);
        if (state.status === 'paused') return { appliesAt: 'after_turn' };
        if (state.status !== 'idle' && state.status !== 'running' && state.status !== 'pause_requested') {
            throw new GoalSessionContractError(`Cannot pause a session while it is ${state.status}`, 'SESSION_NOT_CONTROLLABLE');
        }
        if (state.status === 'idle') {
            state = await this.updateControlledState(request, value => ({ ...value, status: 'paused' }));
            await this.appendControl(request, controlExecutionIdentity(state), {
                type: 'pause_requested', appliesAt: 'after_turn',
            });
            const boundaryReached = { boundary: 'after_turn' };
            await this.appendControl(request, controlExecutionIdentity(state), { type: 'pause_boundary', ...boundaryReached });
            return { appliesAt: 'after_turn', boundaryReached };
        }
        if (state.status === 'running') state = await this.markPauseRequested(request);
        await this.appendControl(request, controlExecutionIdentity(state), {
            type: 'pause_requested', appliesAt: 'after_turn',
        });
        return { appliesAt: 'after_turn' };
    }

    private markPauseRequested(request: GoalPauseRequest): Promise<GoalSessionState> {
        return this.updateControlledState(request, value => ({
            ...value,
            status: 'pause_requested',
            activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'pause_requested' } : value.activeTurn,
        }));
    }

    private markPaused(request: GoalPauseRequest): Promise<GoalSessionState> {
        return this.updateControlledState(request, value => ({
            ...value,
            status: 'paused',
            activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'paused' } : value.activeTurn,
        }));
    }

    private activeExecution(state: GoalSessionState): GoalExecutionIdentity {
        if (!state.activeTurn) throw new StaleGoalSessionFenceError('No active turn owns this operation');
        return { executionId: state.activeTurn.executionId, attemptId: state.activeTurn.attemptId };
    }
}
