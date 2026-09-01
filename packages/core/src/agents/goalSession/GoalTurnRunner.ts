import type { GoalBeginTurnRequest, GoalExecutionIdentity, GoalModelChangeIntent, GoalProviderCorrectiveMessage, GoalSessionControlFence, GoalSessionFence, GoalSessionState, GoalTurnResumeCapabilityOutcome } from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { GoalTurnStreamRunner } from './GoalTurnStreamRunner.js';
import { assertCredentialFreeRecoveryMetadata, sanitizeRecoveryMetadata } from './recoveryMetadata.js';
import { credentialFreeRepositoryIdentity, validateTurnRequestIdentity } from './repositorySecurity.js';
import { assertProviderIdentity, nextState, persistedSnapshot, providerTurnContext, validateControlFence } from './support.js';
import { duplicateTurnResult, type RunGoalTurnResult } from './turnDelivery.js';
import { assertSafeProviderIdentifier, safeDiagnostic } from './securityBoundary.js';
import { compactImmediateModelIntents, immediateModelIntents, nextModelGeneration } from './modelChangeProtocol.js';

export interface RunGoalTurnRequest extends Omit<GoalBeginTurnRequest, 'executionId' | 'attemptId' |
    'correctiveMessages' | 'operationGeneration' | 'operationFence'> {
    executionId: string; attemptId?: string;
}

export type { RunGoalTurnResult } from './turnDelivery.js';

export abstract class GoalTurnRunner extends GoalTurnStreamRunner {
    async runTurn(request: RunGoalTurnRequest): Promise<RunGoalTurnResult> {
        validateControlFence(request);
        validateTurnRequestIdentity(request);
        assertSafeProviderIdentifier(request.requestedModel);
        if (request.context !== undefined) assertCredentialFreeRecoveryMetadata(request.context, this.adapter.provider);
        const safeRequest: RunGoalTurnRequest = {
            goalId: request.goalId, sessionId: request.sessionId,
            controllerEpoch: request.controllerEpoch, turnId: request.turnId,
            executionId: request.executionId, attemptId: request.attemptId,
            objective: safeDiagnostic(request.objective, '[redacted objective]'),
            context: request.context === undefined ? undefined : sanitizeRecoveryMetadata(request.context, this.adapter.provider),
            repository: await credentialFreeRepositoryIdentity(request.repository),
            requestedModel: safeDiagnostic(request.requestedModel, 'default'),
        };
        let state = await this.requireControlledState(safeRequest);
        const execution = turnExecution(
            state, safeRequest,
            () => this.mintAttemptId(), previous => this.mintFreshAttemptId(previous),
        );

        const duplicate = duplicateTurnResult(state, safeRequest.turnId, execution);
        if (duplicate) return duplicate;
        if (state.status !== 'idle') {
            throw new GoalSessionContractError(`Cannot begin a turn while session is ${state.status}`, 'SESSION_NOT_IDLE');
        }

        state = await this.claimImplicitNextTurnModel(safeRequest, state);

        const { requestedModel, activeModelChange, providerModelChange } = resolveDeferredModel(
            state, safeRequest.requestedModel, this.adapter.capabilities.modelChange === 'next_turn',
        );
        assertSafeProviderIdentifier(requestedModel);
        const correctiveMessages = await this.nextTurnCorrectiveMessages(safeRequest);
        const operationGeneration = (state.providerOperationGeneration ?? 0) + 1;
        const activeTurn = {
            ...execution,
            turnId: safeRequest.turnId,
            executionEpoch: safeRequest.controllerEpoch,
            objective: safeRequest.objective,
            requestedModel,
            repository: safeRequest.repository,
            providerOperationGeneration: operationGeneration,
            modelChange: activeModelChange,
            status: 'running' as const,
        };
        const claimed = await this.ports.state.compareAndSet(state, nextState(state, {
            activeTurn,
            requestedModel,
            status: 'running',
            providerOperationGeneration: operationGeneration,
            retryTurn: undefined,
            modelChangeIntent: state.modelChangeIntent,
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
            operationGeneration,
            operationFence: this.turnProviderOperationFence(safeRequest, execution, operationGeneration),
            modelChange: providerModelChange,
        };
        const outcome = await this.driveTurnStream({
            fence: safeRequest,
            execution,
            initial: claimed,
            nextTurnMessages: correctiveMessages,
            openStream: async () => {
                await this.publishProviderOperationBarrier(safeRequest, operationGeneration);
                return this.providerEffect(() => this.adapter.beginTurn(adapterRequest, providerTurnContext(claimed)));
            },
        });
        return { disposition: 'started', state: outcome.state, execution };
    }

    private async claimImplicitNextTurnModel(
        request: GoalSessionControlFence & { requestedModel: string },
        state: GoalSessionState,
    ): Promise<GoalSessionState> {
        if (this.adapter.capabilities.modelChange !== 'next_turn'
            || state.pendingModelChange !== undefined
            || state.currentModel === undefined
            || state.currentModel === request.requestedModel) return state;
        const modelChangeId = this.controlOperationId('model', state);
        const historical = await this.ports.modelChanges.claim(request, modelChangeId, request.requestedModel);
        if (historical.model !== request.requestedModel) {
            throw new GoalSessionContractError('Implicit model identity conflicts with durable history', 'MODEL_OPERATION_CONFLICT');
        }
        const generation = nextModelGeneration(state);
        const intent: GoalModelChangeIntent = {
            modelChangeId, model: request.requestedModel, requestedAt: new Date().toISOString(),
            generation, previousModel: state.currentModel, phase: 'pending',
        };
        return this.commitControlTransition({
            state, fence: request,
            changes: {
                requestedModel: request.requestedModel, pendingModelChange: request.requestedModel,
                modelChangeIntent: intent,
                modelChangeIntents: compactImmediateModelIntents([...immediateModelIntents(state), intent]),
                modelChangeGeneration: generation,
            },
            auditEvents: [{
                type: 'model_change_acknowledged', requestedModel: request.requestedModel, appliesAt: 'next_turn',
            }],
            transitionId: `model-requested:${modelChangeId}`,
        });
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
        const state = await this.requireControlledState(fence);
        if (settledResumeKind(state, 'recovered_after_turn')) {
            return this.continueSettledRecoveredAfterTurn(fence, state);
        }
        if (settledResumeKind(state, 'active_turn')) {
            return this.continueSettledActiveResume(fence, state);
        }
        if (this.adapter.capabilities.pause === 'after_turn') {
            return this.resumeAfterTurn(fence, state);
        }
        return this.resumeActiveTurn(fence, state);
    }

    private resumeAfterTurn(
        fence: GoalSessionControlFence,
        state: GoalSessionState,
    ): Promise<RunGoalTurnResult> | GoalTurnResumeCapabilityOutcome {
        if (state.status === 'paused' && state.activeTurn?.status === 'paused'
            && state.recoveryAttemptId === state.activeTurn.attemptId) {
            return this.retryRecoveredAfterTurn(fence, state);
        }
        return { disposition: 'unsupported_same_turn', supportedBoundary: 'after_turn' };
    }

    private async resumeActiveTurn(
        fence: GoalSessionControlFence,
        initial: GoalSessionState,
    ): Promise<RunGoalTurnResult> {
        let state = initial;
        if (state.status !== 'paused' || !state.activeTurn || state.activeTurn.status !== 'paused') {
            throw new GoalSessionContractError(`Cannot resume a turn while the session is ${state.status}`, 'SESSION_NOT_PAUSED');
        }
        const previousAttemptId = state.activeTurn.attemptId;
        const execution: GoalExecutionIdentity = {
            executionId: state.activeTurn.executionId,
            attemptId: this.mintFreshAttemptId(previousAttemptId),
        };
        const turnFence: GoalSessionFence = { ...fence, turnId: state.activeTurn.turnId };

        state = await this.claimResumeOperation(fence, state, {
            kind: 'active_turn', execution, turnId: turnFence.turnId,
        });
        state = await this.compareAndSetExact(state, {
            activeTurn: {
                ...state.activeTurn!, ...execution, executionEpoch: fence.controllerEpoch,
                providerOperationGeneration: state.resumeIntent!.operationGeneration, status: 'paused',
            },
        }, 'A newer operation replaced the claimed paused turn');
        state = await this.promoteResumeOperation(fence, state);
        const intent = state.resumeIntent!;
        state = await this.requireLiveResumeOperation(fence, intent.operationId, intent.operationGeneration);
        const providerRequest = this.providerResumeRequest(fence, intent);
        let snapshot;
        try {
            await this.publishProviderOperationBarrier(fence, intent.operationGeneration);
            snapshot = await this.providerEffect(() => this.adapter.resumeSession(providerRequest, persistedSnapshot(state)));
        } catch (error) {
            await this.expireResumeOperation(fence, intent.operationId, intent.operationGeneration);
            throw error;
        }
        assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata, this.adapter.provider);
        assertProviderIdentity(state, snapshot);
        state = await this.requireLiveResumeOperation(fence, intent.operationId, intent.operationGeneration);
        state = await this.commitControlTransition({
            state,
            fence,
            changes: {
                status: 'running',
                activeTurn: { ...state.activeTurn!, ...execution, executionEpoch: fence.controllerEpoch, status: 'running' },
                providerSessionId: snapshot.providerSessionId,
                recoveryMetadata: snapshot.recoveryMetadata,
                currentModel: snapshot.model ?? state.currentModel,
                resumeIntent: { ...intent, phase: 'settled' },
                completedResume: {
                    operationId: intent.operationId, operationGeneration: intent.operationGeneration,
                    kind: intent.kind, controllerEpoch: intent.controllerEpoch,
                },
            },
            auditEvents: [{ type: 'session_resumed' }, { type: 'turn_resumed', turnId: turnFence.turnId }],
            transitionId: `resume-settled:${intent.operationId}:${intent.operationGeneration}`,
            execution,
        });

        if (!this.adapter.resumeTurn) {
            throw new GoalSessionContractError('Provider declares active-turn pause without implementing turn resume', 'CAPABILITY_METHOD_MISSING');
        }
        const resumeTurn = this.adapter.resumeTurn.bind(this.adapter);
        const outcome = await this.driveTurnStream({
            fence: turnFence,
            execution,
            initial: state,
            nextTurnMessages: [],
            openStream: async () => {
                await this.publishProviderOperationBarrier(fence, intent.operationGeneration);
                return this.providerEffect(() => resumeTurn({ ...turnFence, ...execution, ...providerRequest }, persistedSnapshot(state)));
            },
        });
        return { disposition: 'started', state: outcome.state, execution };
    }

    private async continueSettledActiveResume(
        fence: GoalSessionControlFence,
        state: GoalSessionState,
    ): Promise<RunGoalTurnResult> {
        if (!this.adapter.resumeTurn || !state.activeTurn || !state.resumeIntent) {
            throw new GoalSessionContractError('Settled active resume is missing its provider primitive', 'CAPABILITY_METHOD_MISSING');
        }
        const turn = state.activeTurn;
        const execution = { executionId: turn.executionId, attemptId: turn.attemptId };
        const turnFence = { ...fence, turnId: turn.turnId };
        const providerRequest = this.providerResumeRequest(fence, state.resumeIntent);
        const resumeTurn = this.adapter.resumeTurn.bind(this.adapter);
        state = await this.requireActiveAttemptState(turnFence, execution);
        const outcome = await this.driveTurnStream({
            fence: turnFence, execution, initial: state, nextTurnMessages: [],
            openStream: async () => {
                await this.publishProviderOperationBarrier(fence, state.resumeIntent!.operationGeneration);
                return this.providerEffect(() => resumeTurn({ ...turnFence, ...execution, ...providerRequest }, persistedSnapshot(state)));
            },
        });
        return { disposition: 'started', state: outcome.state, execution };
    }

    private async continueSettledRecoveredAfterTurn(
        fence: GoalSessionControlFence,
        state: GoalSessionState,
    ): Promise<RunGoalTurnResult> {
        const turn = state.activeTurn!;
        const intent = state.resumeIntent!;
        const execution = { executionId: turn.executionId, attemptId: turn.attemptId };
        const turnFence = { ...fence, turnId: turn.turnId };
        const correctiveMessages = await this.nextTurnCorrectiveMessages(turnFence);
        state = await this.requireActiveAttemptState(turnFence, execution);
        const adapterRequest: GoalBeginTurnRequest = {
            ...turnFence, ...execution, objective: safeDiagnostic(turn.objective, '[redacted objective]'),
            repository: turn.repository, requestedModel: turn.requestedModel,
            correctiveMessages: correctiveMessages.length ? correctiveMessages : undefined,
            providerOperation: this.providerResumeRequest(fence, intent),
            operationGeneration: intent.operationGeneration,
            operationFence: this.turnProviderOperationFence(turnFence, execution, intent.operationGeneration),
        };
        const outcome = await this.driveTurnStream({
            fence: turnFence, execution, initial: state, nextTurnMessages: correctiveMessages,
            openStream: async () => {
                await this.publishProviderOperationBarrier(fence, intent.operationGeneration);
                return this.providerEffect(() => this.adapter.beginTurn(adapterRequest, providerTurnContext(state)));
            },
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
        const initialTurn = state.activeTurn;
        const execution = { executionId: initialTurn.executionId, attemptId: this.mintFreshAttemptId(initialTurn.attemptId) };
        state = await this.claimResumeOperation(fence, state, {
            kind: 'recovered_after_turn', execution, turnId: initialTurn.turnId,
        });
        const { requestedModel, activeModelChange, providerModelChange } = resolveDeferredModel(
            state, state.activeTurn!.requestedModel, this.adapter.capabilities.modelChange === 'next_turn',
        );
        state = await this.promoteResumeOperation(fence, state);
        const intent = state.resumeIntent!;
        state = await this.requireLiveResumeOperation(fence, intent.operationId, intent.operationGeneration);
        const turn = state.activeTurn!;
        const turnFence = { ...fence, turnId: turn.turnId };
        const correctiveMessages = await this.nextTurnCorrectiveMessages(turnFence);
        const activeTurn = {
            ...turn,
            ...execution,
            executionEpoch: fence.controllerEpoch,
            requestedModel,
            modelChange: activeModelChange ?? turn.modelChange,
            status: 'running' as const,
            providerOperationGeneration: intent.operationGeneration,
        };
        const recoveringPause = state.pendingAfterTurnPause === true;
        const claimed = await this.commitControlTransition({
            state,
            fence,
            changes: {
                status: recoveringPause ? 'pause_requested' : 'running',
                activeTurn: recoveringPause ? { ...activeTurn, status: 'pause_requested' } : activeTurn,
                modelChangeIntent: state.modelChangeIntent,
                resumeIntent: { ...intent, phase: 'settled' },
                completedResume: {
                    operationId: intent.operationId, operationGeneration: intent.operationGeneration,
                    kind: intent.kind, controllerEpoch: intent.controllerEpoch,
                },
            },
            auditEvents: [{ type: 'session_resumed' }, { type: 'turn_resumed', turnId: turn.turnId }],
            transitionId: `resume-settled:${intent.operationId}:${intent.operationGeneration}`,
            execution,
        });
        const adapterRequest: GoalBeginTurnRequest = {
            ...turnFence,
            ...execution,
            objective: safeDiagnostic(turn.objective, '[redacted objective]'),
            repository: turn.repository,
            requestedModel,
            correctiveMessages: correctiveMessages.length ? correctiveMessages : undefined,
            providerOperation: this.providerResumeRequest(fence, intent),
            operationGeneration: intent.operationGeneration,
            operationFence: this.turnProviderOperationFence(turnFence, execution, intent.operationGeneration),
            modelChange: providerModelChange,
        };
        const outcome = await this.driveTurnStream({
            fence: turnFence,
            execution,
            initial: claimed,
            nextTurnMessages: correctiveMessages,
            openStream: async () => {
                await this.publishProviderOperationBarrier(fence, intent.operationGeneration);
                return this.providerEffect(() => this.adapter.beginTurn(adapterRequest, providerTurnContext(claimed)));
            },
        });
        return { disposition: 'started', state: outcome.state, execution };
    }

}

function turnExecution(
    state: GoalSessionState,
    request: Pick<RunGoalTurnRequest, 'turnId' | 'executionId' | 'attemptId'>,
    mint: () => string,
    mintFresh: (previous: string) => string,
): GoalExecutionIdentity {
    const retry = state.retryTurn?.turnId === request.turnId
        && state.retryTurn.executionId === request.executionId ? state.retryTurn : undefined;
    return {
        executionId: request.executionId,
        attemptId: retry ? mintFresh(retry.crashedAttemptId) : request.attemptId ?? mint(),
    };
}

function resolveDeferredModel(
    state: GoalSessionState,
    fallback: string,
    enabled: boolean,
): {
    requestedModel: string;
    activeModelChange?: NonNullable<GoalSessionState['activeTurn']>['modelChange'];
    providerModelChange?: GoalBeginTurnRequest['modelChange'];
} {
    const requestedModel = state.pendingModelChange ?? state.modelChangeIntent?.model ?? fallback;
    const modelIntent = enabled && state.pendingModelChange === requestedModel
        && state.modelChangeIntent?.model === requestedModel ? state.modelChangeIntent : undefined;
    const generation = modelIntent?.generation ?? state.modelChangeGeneration ?? 0;
    return {
        requestedModel,
        activeModelChange: modelIntent ? {
            modelChangeId: modelIntent.modelChangeId, generation,
            previousModel: modelIntent.previousModel ?? state.currentModel,
        } : undefined,
        providerModelChange: modelIntent ? { modelChangeId: modelIntent.modelChangeId, generation } : undefined,
    };
}

function settledResumeKind(
    state: GoalSessionState,
    kind: 'active_turn' | 'recovered_after_turn',
): boolean {
    const liveStatus = kind === 'active_turn' ? state.status === 'running'
        : state.status === 'running' || state.status === 'pause_requested';
    return liveStatus && Boolean(state.activeTurn) && state.resumeIntent?.phase === 'settled'
        && state.completedResume?.operationId === state.resumeIntent.operationId
        && state.completedResume.kind === kind;
}
