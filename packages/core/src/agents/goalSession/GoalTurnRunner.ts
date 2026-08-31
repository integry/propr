import type {
    GoalBeginTurnRequest,
    GoalExecutionIdentity,
    GoalProviderCorrectiveMessage,
    GoalSessionControlFence,
    GoalSessionEvent,
    GoalSessionFence,
    GoalSessionState,
    GoalTurnResumeCapabilityOutcome,
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { GoalSessionCore } from './GoalSessionCore.js';
import { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
import { credentialFreeRepositoryRequest, validateTurnRequestIdentity } from './repositorySecurity.js';
import {
    assertProviderIdentity,
    nextState,
    persistedSnapshot,
    providerTurnContext,
    validateControlFence,
} from './support.js';
import { duplicateTurnResult, type RunGoalTurnResult } from './turnDelivery.js';
import { assertFirstTurnIdentityEvent, assertSuppliedMessagesAcknowledged, isAtomicTurnAudit, streamAuditTransitionId } from './turnStreamProtocol.js';

export interface RunGoalTurnRequest extends Omit<GoalBeginTurnRequest, 'executionId' | 'attemptId' | 'correctiveMessages'> {
    executionId: string;
    attemptId?: string;
}

export type { RunGoalTurnResult } from './turnDelivery.js';

type TurnStreamOutcome = { state: GoalSessionState; completed: boolean; reachedPause: boolean };

interface TurnStreamOptions {
    fence: GoalSessionFence;
    execution: GoalExecutionIdentity;
    initial: GoalSessionState;
    nextTurnMessages: GoalProviderCorrectiveMessage[];
    openStream: () => AsyncIterable<GoalSessionEvent>;
}

type TurnEventOptions = { fence: GoalSessionFence; current: GoalSessionState;
    execution: GoalExecutionIdentity; event: GoalSessionEvent };

export abstract class GoalTurnRunner extends GoalSessionCore {
    async runTurn(request: RunGoalTurnRequest): Promise<RunGoalTurnResult> {
        validateControlFence(request);
        validateTurnRequestIdentity(request);
        const safeRequest = credentialFreeRepositoryRequest(request);
        let state = await this.requireControlledState(safeRequest);
        const recoveringRetry = state.retryTurn?.turnId === safeRequest.turnId
            && state.retryTurn.executionId === safeRequest.executionId;
        const execution: GoalExecutionIdentity = {
            executionId: safeRequest.executionId,
            attemptId: recoveringRetry
                ? this.mintFreshAttemptId(state.retryTurn!.crashedAttemptId)
                : safeRequest.attemptId ?? this.mintAttemptId(),
        };

        const duplicate = duplicateTurnResult(state, safeRequest.turnId, execution);
        if (duplicate) return duplicate;
        if (state.status !== 'idle') {
            throw new GoalSessionContractError(`Cannot begin a turn while session is ${state.status}`, 'SESSION_NOT_IDLE');
        }

        const requestedModel = state.pendingModelChange ?? state.modelChangeIntent?.model ?? safeRequest.requestedModel;
        state = await this.applyModelAtTurnBoundary(safeRequest, state, requestedModel);
        const correctiveMessages = await this.nextTurnCorrectiveMessages(safeRequest);
        const activeTurn = {
            ...execution,
            turnId: safeRequest.turnId,
            executionEpoch: safeRequest.controllerEpoch,
            objective: safeRequest.objective,
            requestedModel,
            repository: safeRequest.repository,
            status: 'running' as const,
        };
        const claimed = await this.ports.state.compareAndSet(state, nextState(state, {
            activeTurn,
            requestedModel,
            status: 'running',
            retryTurn: undefined,
            modelChangeIntent: this.adapter.capabilities.modelChange === 'next_turn'
                ? undefined
                : state.modelChangeIntent,
        }));
        if (!claimed) {
            state = await this.requireControlledState(safeRequest);
            const redelivery = duplicateTurnResult(state, safeRequest.turnId, execution);
            if (redelivery) return redelivery;
            throw new StaleGoalSessionFenceError('Another delivery claimed the session turn');
        }

        const adapterRequest: GoalBeginTurnRequest = {
            ...safeRequest,
            ...execution,
            requestedModel,
            correctiveMessages: correctiveMessages.length ? correctiveMessages : undefined,
        };
        const outcome = await this.driveTurnStream({
            fence: safeRequest,
            execution,
            initial: claimed,
            nextTurnMessages: correctiveMessages,
            openStream: () => this.adapter.beginTurn(adapterRequest, providerTurnContext(claimed)),
        });
        return { disposition: 'started', state: outcome.state, execution };
    }

    private async applyModelAtTurnBoundary(
        request: GoalSessionControlFence,
        state: GoalSessionState,
        requestedModel: string,
    ): Promise<GoalSessionState> {
        if (this.adapter.capabilities.modelChange !== 'next_turn') return state;
        if (state.currentModel === requestedModel) {
            if (state.pendingModelChange !== requestedModel) return state;
            return this.compareAndSetExact(state, {
                requestedModel,
                pendingModelChange: undefined,
            }, 'A newer model intent superseded the turn-boundary model acknowledgement');
        }
        if (!state.providerSessionId) return state;
        let intent = state.modelChangeIntent?.model === requestedModel ? state.modelChangeIntent : undefined;
        if (!intent) {
            intent = {
                modelChangeId: this.controlOperationId('model', state),
                model: requestedModel,
                requestedAt: new Date().toISOString(),
            };
            state = await this.compareAndSetExact(state, {
                requestedModel,
                modelChangeIntent: intent,
            }, 'A newer model intent superseded the turn-boundary provider claim');
        }
        const acknowledgement = await this.adapter.requestModelChange(
            {
                ...request,
                model: requestedModel,
                modelChangeId: intent.modelChangeId,
                applicationGeneration: intent.generation ?? state.modelChangeGeneration ?? 1,
            },
            persistedSnapshot(state),
        );
        if (acknowledgement.requestedModel !== requestedModel
            || acknowledgement.effectiveModel !== requestedModel) {
            throw new GoalSessionContractError('Provider did not apply the requested model at the turn boundary', 'MODEL_ACK_MISMATCH');
        }
        const changed = await this.commitControlTransition({
            state,
            fence: request,
            changes: {
                requestedModel,
                currentModel: requestedModel,
                pendingModelChange: undefined,
            },
            auditEvents: [{ type: 'model_changed', previousModel: state.currentModel, model: requestedModel }],
            transitionId: `model-applied:${intent.modelChangeId}`,
        });
        return changed;
    }

    private async nextTurnCorrectiveMessages(
        request: GoalSessionControlFence,
    ): Promise<GoalProviderCorrectiveMessage[]> {
        if (this.adapter.capabilities.steering !== 'next_turn') return [];
        const pending = await this.ports.messages.listPending(request);
        return pending
            .sort((left, right) => left.sequence - right.sequence)
            .map(({ messageId, sequence, body }) => ({ messageId, sequence, body }));
    }

    async resumeTurn(fence: GoalSessionControlFence): Promise<RunGoalTurnResult | GoalTurnResumeCapabilityOutcome> {
        let state = await this.requireControlledState(fence);
        if (this.adapter.capabilities.pause === 'after_turn') {
            if (state.status === 'paused'
                && state.activeTurn?.status === 'paused'
                && state.recoveryAttemptId === state.activeTurn.attemptId) {
                return this.retryRecoveredAfterTurn(fence, state);
            }
            return { disposition: 'unsupported_same_turn', supportedBoundary: 'after_turn' };
        }
        if (state.status !== 'paused' || !state.activeTurn || state.activeTurn.status !== 'paused') {
            throw new GoalSessionContractError(`Cannot resume a turn while the session is ${state.status}`, 'SESSION_NOT_PAUSED');
        }
        const previousAttemptId = state.activeTurn.attemptId;
        const execution: GoalExecutionIdentity = {
            executionId: state.activeTurn.executionId,
            attemptId: this.mintFreshAttemptId(previousAttemptId),
        };
        const turnFence: GoalSessionFence = { ...fence, turnId: state.activeTurn.turnId };

        state = await this.compareAndSetExact(state, {
            status: 'running',
            activeTurn: { ...state.activeTurn, ...execution, executionEpoch: fence.controllerEpoch, status: 'running' },
        }, 'A newer operation claimed the paused turn before recovery');

        let snapshot;
        try {
            snapshot = await this.adapter.resumeSession(fence, persistedSnapshot(state));
        } catch (error) {
            try {
                await this.compareAndSetExact(state, {
                    status: 'paused',
                    activeTurn: state.activeTurn ? { ...state.activeTurn, status: 'paused' } : state.activeTurn,
                });
            } catch { /* A newer operation owns the session; do not roll it back. */ }
            throw error;
        }
        assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata);
        assertProviderIdentity(state, snapshot);
        state = await this.compareAndSetExact(state, {
            providerSessionId: snapshot.providerSessionId,
            recoveryMetadata: snapshot.recoveryMetadata,
            currentModel: snapshot.model ?? state.currentModel,
        }, 'A newer operation superseded the recovered provider snapshot');
        await this.appendControl(fence, execution, { type: 'session_resumed' });
        await this.append(turnFence, execution, { type: 'turn_resumed', turnId: turnFence.turnId });

        if (!this.adapter.resumeTurn) {
            throw new GoalSessionContractError('Provider declares active-turn pause without implementing turn resume', 'CAPABILITY_METHOD_MISSING');
        }
        const resumeTurn = this.adapter.resumeTurn.bind(this.adapter);
        const outcome = await this.driveTurnStream({
            fence: turnFence,
            execution,
            initial: state,
            nextTurnMessages: [],
            openStream: () => resumeTurn({ ...turnFence, ...execution }, persistedSnapshot(state)),
        });
        return { disposition: 'started', state: outcome.state, execution };
    }

    /**
     * A discrete after-turn provider cannot resume an operator-paused invocation,
     * but a reconciled crash retains a paused active turn. Retry that exact logical
     * turn through a fresh discrete invocation on the already-bound native session.
     */
    private async retryRecoveredAfterTurn(fence: GoalSessionControlFence, state: GoalSessionState): Promise<RunGoalTurnResult> {
        const originalTurn = state.activeTurn!;
        if (!state.providerSessionId) {
            throw new GoalSessionContractError('A crashed after-turn invocation cannot continue before its native session ID is bound', 'FIRST_TURN_ID_NOT_BOUND');
        }
        state = await this.requireControlledState(fence);
        if (state.status !== 'paused' || state.activeTurn?.turnId !== originalTurn.turnId
            || state.activeTurn.attemptId !== originalTurn.attemptId) {
            throw new StaleGoalSessionFenceError('A newer operation superseded the recovered turn boundary');
        }
        const requestedModel = state.pendingModelChange ?? state.modelChangeIntent?.model ?? state.activeTurn.requestedModel;
        state = await this.applyModelAtTurnBoundary(fence, state, requestedModel);
        const turn = state.activeTurn!;
        const execution = { executionId: turn.executionId, attemptId: this.mintFreshAttemptId(turn.attemptId) };
        const turnFence = { ...fence, turnId: turn.turnId };
        const correctiveMessages = await this.nextTurnCorrectiveMessages(turnFence);
        const activeTurn = {
            ...turn,
            ...execution,
            executionEpoch: fence.controllerEpoch,
            requestedModel,
            status: 'running' as const,
        };
        const recoveringPause = state.pendingAfterTurnPause === true;
        const claimed = await this.compareAndSetExact(state, {
            status: recoveringPause ? 'pause_requested' : 'running',
            activeTurn: recoveringPause ? { ...activeTurn, status: 'pause_requested' } : activeTurn,
            modelChangeIntent: this.adapter.capabilities.modelChange === 'next_turn'
                ? undefined
                : state.modelChangeIntent,
        },
            'A newer operation claimed the reconciled turn before recovery');
        const adapterRequest: GoalBeginTurnRequest = {
            ...turnFence,
            ...execution,
            objective: turn.objective,
            repository: turn.repository,
            requestedModel,
            correctiveMessages: correctiveMessages.length ? correctiveMessages : undefined,
        };
        await this.appendControl(fence, execution, { type: 'session_resumed' });
        await this.append(turnFence, execution, { type: 'turn_resumed', turnId: turn.turnId });
        const outcome = await this.driveTurnStream({
            fence: turnFence,
            execution,
            initial: claimed,
            nextTurnMessages: correctiveMessages,
            openStream: () => this.adapter.beginTurn(adapterRequest, providerTurnContext(claimed)),
        });
        return { disposition: 'started', state: outcome.state, execution };
    }

    private async driveTurnStream(options: TurnStreamOptions): Promise<TurnStreamOutcome> {
        const { fence, execution } = options;
        let current = options.initial;
        const awaitingMessageIds = options.nextTurnMessages.map(message => message.messageId);
        let reachedPause = false;
        let completed = false;
        try {
            // Invoke the provider inside the fenced try so a synchronous/early
            // invocation failure is normalized into failed state plus one
            // completion event, never leaving the session stranded as running.
            const stream = options.openStream();
            for await (const event of stream) {
                if (completed) {
                    throw new GoalSessionContractError('Provider emitted an event after turn completion', 'EVENT_AFTER_COMPLETION');
                }
                assertFirstTurnIdentityEvent(current, event, this.adapter.capabilities.nativeSessionId);
                if (event.type === 'message_acknowledged') {
                    await this.acknowledgeNextTurnMessage(fence, execution, event.messageId, awaitingMessageIds);
                    await this.append(fence, execution, event);
                    continue;
                }
                assertSuppliedMessagesAcknowledged(event, awaitingMessageIds);
                if (event.type === 'completion' && this.adapter.capabilities.pause === 'after_turn') {
                    current = await this.requireActiveAttemptState(fence, execution);
                }
                current = await this.applyTurnEvent({ fence, current, execution, event });
                if (event.type === 'pause_boundary') reachedPause = true;
                if (event.type === 'completion') completed = true;
                if (event.type !== 'completion' && !isAtomicTurnAudit(event)) {
                    await this.append(fence, execution, event);
                }
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
            const message = `Provider turn failed: ${(error as Error).message}`;
            current = await this.finishTurnIfOwned(fence, execution, message);
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
        const result = await this.ports.messages.acknowledge(fence, execution, messageId);
        if (result === 'stale_fence') throw new StaleGoalSessionFenceError();
        if (result === 'not_found') {
            throw new GoalSessionContractError('Corrective message disappeared before acknowledgement', 'MESSAGE_NOT_FOUND');
        }
        awaitingMessageIds.shift();
    }

    private async applyTurnEvent(options: TurnEventOptions): Promise<GoalSessionState> {
        const { fence, current, execution, event } = options;
        if (event.type === 'checkpoint') return this.persistCheckpoint(fence, current, execution, event);
        if (event.type === 'model_changed') {
            return this.commitTurnTransition({
                state: current,
                fence,
                execution,
                update: value => ({
                    currentModel: event.model,
                    pendingModelChange: value.pendingModelChange === event.model ? undefined : value.pendingModelChange,
                }),
                auditEvents: [event],
                transitionId: streamAuditTransitionId(fence, execution, event),
            });
        }
        if (event.type === 'pause_boundary') {
            return this.commitTurnTransition({
                state: current,
                fence,
                execution,
                update: value => ({
                    status: 'paused',
                    activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'paused' } : value.activeTurn,
                }),
                auditEvents: [event],
                transitionId: streamAuditTransitionId(fence, execution, event),
            });
        }
        if (event.type === 'completion') return this.commitTurnCompletion(fence, execution, event);
        return current;
    }

    private async persistCheckpoint(
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
                ? value.activeTurn?.requestedModel ?? value.currentModel
                : value.currentModel,
            pendingModelChange: event.providerSessionId
                && !value.providerSessionId
                && value.pendingModelChange === value.activeTurn?.requestedModel
                ? undefined
                : value.pendingModelChange,
        }));
    }

    private async finishTurnIfOwned(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        error: string,
    ): Promise<GoalSessionState> {
        try {
            return await this.commitTurnCompletion(fence, execution, { type: 'completion', outcome: 'failed', error });
        }
        catch { return this.requireState(fence); }
    }
}
