import type {
    GoalExecutionIdentity,
    GoalMessageDeliveryOutcome,
    GoalPauseAcknowledgement,
    GoalPauseRequest,
    GoalSessionControlFence,
    GoalSessionState,
    GoalSteeringCommand,
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { GoalCancellationControls } from './GoalCancellationControls.js';
import { assertCredentialFreeRecoveryMetadata, sanitizeRecoveryMetadata } from './recoveryMetadata.js';
import { safeDiagnostic, safeFailureDiagnostic, sanitizeGoalSessionEvent } from './securityBoundary.js';
import {
    assertProviderIdentity,
    controlExecutionIdentity,
    persistedSnapshot,
} from './support.js';
import {
    rebuildMessageAcknowledgement, rebuildPauseAcknowledgement, rebuildProviderSnapshot,
} from './providerResultBoundary.js';

/** Capability-aware steering, pause, resume, model, and cancellation controls. */
export abstract class GoalSessionControls extends GoalCancellationControls {
    async deliverMessage(request: GoalSteeringCommand): Promise<GoalMessageDeliveryOutcome> {
        let state = await this.requireActiveTurnState(request);
        const execution = this.activeExecution(state);
        if ((request.executionId && request.executionId !== execution.executionId)
            || (request.attemptId && request.attemptId !== execution.attemptId)) {
            throw new StaleGoalSessionFenceError('Steering request does not own the exact current provider attempt');
        }
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
        sanitizeGoalSessionEvent({ type: 'message_acknowledged', messageId: request.messageId });
        state = await this.requireActiveAttemptState(request, execution);
        const operationGeneration = state.providerOperationGeneration ?? 0;
        await this.publishProviderOperationBarrier(request, operationGeneration);
        await this.requireTurnProviderGeneration(request, execution, operationGeneration);
        const operationFence = this.providerOperationFence(
            request, operationGeneration, { kind: 'steer', operationId: request.messageId },
        );
        const acknowledgement = await this.providerResult(() => this.adapter.deliverMessage!(
            {
                goalId: request.goalId, sessionId: request.sessionId,
                controllerEpoch: request.controllerEpoch, turnId: request.turnId,
                ...execution, operationGeneration, operationFence,
                messageId: request.messageId, body: safeDiagnostic(message.body, '[redacted corrective message]'),
            },
            persistedSnapshot(state),
        ), rebuildMessageAcknowledgement);
        if (acknowledgement.messageId !== request.messageId) {
            throw new GoalSessionContractError('Provider acknowledged a different corrective message', 'MESSAGE_ACK_MISMATCH');
        }
        const stillOwned = await this.requireActiveTurnState(request);
        if (stillOwned.version !== state.version
            || stillOwned.activeTurn?.attemptId !== state.activeTurn?.attemptId) {
            throw new StaleGoalSessionFenceError('A newer operation superseded message delivery');
        }
        const result = await this.ports.messages.acknowledgeWithEvent(request, execution, request.messageId);
        if (result === 'stale_fence') throw new StaleGoalSessionFenceError();
        if (result === 'not_found') {
            throw new GoalSessionContractError('Corrective message disappeared before acknowledgement', 'MESSAGE_NOT_FOUND');
        }
        return { outcome: 'acknowledged', messageId: request.messageId, acknowledgement: result };
    }

    async requestPause(request: GoalPauseRequest): Promise<GoalPauseAcknowledgement> {
        if (this.adapter.capabilities.pause === 'after_turn') return this.requestAfterTurnPause(request);
        let state = await this.requireControlledState(request);
        if (state.status !== 'running' && state.status !== 'pause_requested') {
            throw new GoalSessionContractError(`Cannot pause a session while it is ${state.status}`, 'SESSION_NOT_RUNNING');
        }
        if (state.status === 'running') {
            const activeTurn = state.activeTurn;
            if (!activeTurn) throw new StaleGoalSessionFenceError('No active turn owns the pause request');
            state = await this.commitControlTransition({
                state,
                fence: request,
                changes: {
                    status: 'pause_requested',
                    activeTurn: { ...activeTurn, status: 'pause_requested' },
                    resumeIntent: undefined,
                    completedResume: undefined,
                    providerOperationGeneration: (state.providerOperationGeneration ?? 0) + 1,
                },
                auditEvents: [{ type: 'pause_requested', appliesAt: 'next_safe_boundary' }],
                transitionId: this.controlOperationId('pause-active-requested', state),
            });
        }
        if (!this.adapter.requestPause) {
            throw new GoalSessionContractError('Provider declares active-turn pause without implementing it', 'CAPABILITY_METHOD_MISSING');
        }
        const operationGeneration = state.providerOperationGeneration ?? 0;
        await this.publishProviderOperationBarrier(request, operationGeneration);
        await this.requireProviderGeneration(request, operationGeneration);
        const operationFence = this.providerOperationFence(
            request, operationGeneration,
            { kind: 'pause', operationId: this.controlOperationId('pause', state) },
        );
        const acknowledgement = await this.providerResult(() => this.adapter.requestPause!({
            goalId: request.goalId, sessionId: request.sessionId, controllerEpoch: request.controllerEpoch,
            reason: request.reason ? safeFailureDiagnostic(request.reason, 'Operator requested pause') : undefined,
            operationGeneration, operationFence,
        }, persistedSnapshot(state)), rebuildPauseAcknowledgement);
        if (acknowledgement.appliesAt === 'after_turn') {
            throw new GoalSessionContractError('Active-turn provider returned an after-turn pause acknowledgement', 'CAPABILITY_ACK_MISMATCH');
        }
        const stillOwned = await this.requireControlledState(request);
        if (stillOwned.version !== state.version || stillOwned.status === 'terminated' || stillOwned.status === 'failed') {
            throw new StaleGoalSessionFenceError('A newer operation superseded the pause acknowledgement');
        }
        if (acknowledgement.boundaryReached) {
            const activeTurn = state.activeTurn;
            if (!activeTurn) throw new StaleGoalSessionFenceError('No active turn owns the pause boundary');
            state = await this.commitControlTransition({
                state,
                fence: request,
                changes: {
                    status: 'paused',
                    activeTurn: { ...activeTurn, status: 'paused' },
                },
                auditEvents: [{ type: 'pause_boundary', ...acknowledgement.boundaryReached }],
                transitionId: this.controlOperationId('pause-active-boundary', state),
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
        if (state.status === 'idle' && state.completedResume?.kind === 'after_turn'
            && state.completedResume.controllerEpoch === request.controllerEpoch) return state;
        if (state.status !== 'paused' || state.activeTurn) {
            throw new GoalSessionContractError(`Cannot resume a session while it is ${state.status}`, 'SESSION_NOT_PAUSED');
        }
        const execution = controlExecutionIdentity(state);
        state = await this.claimResumeOperation(request, state, { kind: 'after_turn', execution });
        state = await this.promoteResumeOperation(request, state);
        const intent = state.resumeIntent!;
        state = await this.requireLiveResumeOperation(request, intent.operationId, intent.operationGeneration);
        let snapshot;
        try {
            const providerRequest = this.providerResumeRequest(request, intent);
            await this.publishProviderOperationBarrier(request, intent.operationGeneration);
            await this.requireProviderGeneration(request, intent.operationGeneration);
            snapshot = await this.providerResult(() => this.adapter.resumeSession(
                providerRequest, persistedSnapshot(state),
            ), value => rebuildProviderSnapshot(value, this.adapter.provider));
        } catch (error) {
            await this.expireResumeOperation(request, intent.operationId, intent.operationGeneration);
            throw error;
        }
        assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata, this.adapter.provider);
        assertProviderIdentity(state, snapshot);
        state = await this.requireLiveResumeOperation(request, intent.operationId, intent.operationGeneration);
        return this.commitControlTransition({
            state,
            fence: request,
            changes: {
                providerSessionId: snapshot.providerSessionId,
                recoveryMetadata: sanitizeRecoveryMetadata(snapshot.recoveryMetadata, this.adapter.provider),
                currentModel: snapshot.model ?? state.currentModel,
                status: 'idle',
                resumeIntent: { ...intent, phase: 'settled' },
                completedResume: {
                    operationId: intent.operationId, operationGeneration: intent.operationGeneration,
                    kind: intent.kind, controllerEpoch: intent.controllerEpoch,
                },
            },
            auditEvents: [{ type: 'session_resumed' }],
            transitionId: `resume-settled:${intent.operationId}:${intent.operationGeneration}`,
            execution,
        });
    }

    private async requestAfterTurnPause(request: GoalPauseRequest): Promise<GoalPauseAcknowledgement> {
        let state = await this.requireControlledState(request);
        if (state.status === 'paused') return { appliesAt: 'after_turn' };
        if (state.status !== 'idle' && state.status !== 'running' && state.status !== 'pause_requested') {
            throw new GoalSessionContractError(`Cannot pause a session while it is ${state.status}`, 'SESSION_NOT_CONTROLLABLE');
        }
        if (state.status === 'idle') {
            const boundaryReached = { boundary: 'after_turn' };
            state = await this.commitControlTransition({
                state,
                fence: request,
                changes: {
                    status: 'paused', resumeIntent: undefined, completedResume: undefined,
                    providerOperationGeneration: (state.providerOperationGeneration ?? 0) + 1,
                },
                auditEvents: [
                    { type: 'pause_requested', appliesAt: 'after_turn' },
                    { type: 'pause_boundary', ...boundaryReached },
                ],
                transitionId: this.controlOperationId('pause-after-turn', state),
            });
            await this.publishProviderOperationBarrier(request, state.providerOperationGeneration ?? 0);
            return { appliesAt: 'after_turn', boundaryReached };
        }
        if (state.status === 'running') {
            state = await this.commitControlTransition({
                state,
                fence: request,
                changes: {
                    status: 'pause_requested',
                    activeTurn: state.activeTurn ? { ...state.activeTurn, status: 'pause_requested' } : state.activeTurn,
                    pendingAfterTurnPause: true,
                    resumeIntent: undefined,
                    completedResume: undefined,
                },
                auditEvents: [{ type: 'pause_requested', appliesAt: 'after_turn' }],
                transitionId: this.controlOperationId('pause-after-turn', state),
            });
        }
        return { appliesAt: 'after_turn' };
    }

    private activeExecution(state: GoalSessionState): GoalExecutionIdentity {
        if (!state.activeTurn) throw new StaleGoalSessionFenceError('No active turn owns this operation');
        return { executionId: state.activeTurn.executionId, attemptId: state.activeTurn.attemptId };
    }
}
