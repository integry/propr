import type {
    GoalCancelRequest,
    GoalExecutionIdentity,
    GoalMessageDeliveryOutcome,
    GoalPauseAcknowledgement,
    GoalPauseRequest,
    GoalPendingCancellationContext,
    GoalSessionControlFence,
    GoalSessionState,
    GoalSteeringRequest,
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { GoalImmediateModelControls } from './GoalImmediateModelControls.js';
import { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
import { safeDiagnostic, sanitizeGoalSessionEvent } from './securityBoundary.js';
import {
    assertProviderIdentity,
    controlExecutionIdentity,
    nextState,
    persistedSnapshot,
} from './support.js';

/** Capability-aware steering, pause, resume, model, and cancellation controls. */
export abstract class GoalSessionControls extends GoalImmediateModelControls {
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
            {
                goalId: request.goalId, sessionId: request.sessionId,
                controllerEpoch: request.controllerEpoch, turnId: request.turnId,
                messageId: request.messageId, body: safeDiagnostic(message.body, '[redacted corrective message]'),
            },
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
        sanitizeGoalSessionEvent({ type: 'message_acknowledged', messageId: request.messageId });
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
        const acknowledgement = await this.adapter.requestPause({
            goalId: request.goalId, sessionId: request.sessionId, controllerEpoch: request.controllerEpoch,
            reason: request.reason ? safeDiagnostic(request.reason, 'Operator requested pause') : undefined,
        }, persistedSnapshot(state));
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
            snapshot = await this.adapter.resumeSession(
                this.providerResumeRequest(request, intent), persistedSnapshot(state),
            );
        } catch (error) {
            await this.expireResumeOperation(request, intent.operationId, intent.operationGeneration);
            throw error;
        }
        assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata);
        assertProviderIdentity(state, snapshot);
        state = await this.requireLiveResumeOperation(request, intent.operationId, intent.operationGeneration);
        return this.commitControlTransition({
            state,
            fence: request,
            changes: {
                providerSessionId: snapshot.providerSessionId,
                recoveryMetadata: snapshot.recoveryMetadata,
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

    async cancel(request: GoalCancelRequest): Promise<GoalSessionState> {
        const state = await this.claimCancellation(request);
        if (state.status === 'terminated' || state.status === 'failed') return state;
        return this.resumeClaimedCancellation(request, state);
    }

    /** Replays a durable cancelling claim during open/recovery without starting provider work. */
    protected async resumeClaimedCancellation(
        fence: GoalSessionControlFence,
        state: GoalSessionState,
    ): Promise<GoalSessionState> {
        if (state.status === 'terminated') return state;
        if (state.status !== 'cancelling' || !state.cancellationIntent) {
            throw new GoalSessionContractError('Cancelling state is missing its durable cancellation intent', 'CANCELLATION_INTENT_MISSING');
        }
        const intent = state.cancellationIntent;
        const request = {
            goalId: fence.goalId, sessionId: fence.sessionId, controllerEpoch: fence.controllerEpoch,
            reason: intent.reason,
            cancellationId: intent.cancellationId,
        };
        let signalError: unknown;
        try {
            if (intent.pendingContext) await this.adapter.cancelPending!(request, intent.pendingContext);
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
            completedRecovery: undefined,
            resumeIntent: undefined,
            completedResume: undefined,
            providerOperationGeneration: (state.providerOperationGeneration ?? 0) + 1,
            pendingAfterTurnPause: undefined,
            modelChangeIntent: undefined,
            modelChangeIntents: undefined,
        }, { type: 'completion', outcome: 'cancelled', error: intent.reason });
        // Terminal fencing is authoritative even when the adapter reports that
        // its best-effort process signal failed. Surface that failure only after
        // the session can no longer remain permanently stuck in cancelling.
        if (signalError) throw signalError;
        return state;
    }

    private async claimCancellation(request: GoalCancelRequest): Promise<GoalSessionState> {
        for (;;) {
            const state = await this.requireControlledState(request);
            if (state.status === 'terminated' || state.status === 'failed') return state;
            if (state.status === 'cancelling' && state.cancellationIntent) return state;
            if (!state.providerSessionId && (!state.initializationIntent || !this.adapter.cancelPending)) {
                throw new GoalSessionContractError(
                    'A lazy-ID provider must implement pending cancellation before it can be cancelled safely',
                    'CAPABILITY_METHOD_MISSING',
                );
            }
            const pendingContext = this.pendingCancellationContext(state);
            const reason = safeDiagnostic(request.reason, 'Operator cancelled the goal session');
            const claimed = await this.ports.state.compareAndSet(state, nextState(state, {
                status: 'cancelling',
                activeTurn: undefined,
                recoveryAttempt: undefined,
                completedRecovery: undefined,
                resumeIntent: undefined,
                completedResume: undefined,
                providerOperationGeneration: (state.providerOperationGeneration ?? 0) + 1,
                cancellationIntent: {
                    cancellationId: this.controlOperationId('cancel', state),
                    reason,
                    claimedAt: new Date().toISOString(),
                    pendingContext,
                },
            }));
            if (claimed) return claimed;
        }
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
                    providerOperationGeneration: (state.providerOperationGeneration ?? 0) + 1,
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
