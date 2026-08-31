import { createHash, randomUUID } from 'node:crypto';
import type {
    GoalCancelRequest,
    GoalExecutionIdentity,
    GoalModelChangeAcknowledgement,
    GoalModelChangeRequest,
    GoalPauseAcknowledgement,
    GoalPauseRequest,
    GoalProviderReconcileResult,
    GoalRepositoryIdentity,
    GoalRepositoryInspection,
    GoalSessionControlFence,
    GoalSessionIdentity,
    GoalSessionState,
    GoalSessionStatus,
    GoalSteeringRequest,
    GoalTurnState,
} from './contract.js';
import {
    GoalSessionContractError,
    StaleGoalSessionFenceError,
    UnsupportedGoalSessionTransitionError,
} from './errors.js';
import { GoalTurnRunner } from './GoalTurnRunner.js';
import { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
import {
    assertProviderIdentity,
    controlExecutionIdentity,
    nextState,
    nowIso,
    persistedSnapshot,
    validateEpoch,
    validateIdentity,
} from './support.js';

export interface OpenGoalSessionRequest extends GoalSessionIdentity {
    provider: string;
    controllerEpoch: number;
}

export type ReconcileGoalSessionResult = {
    outcome: 'alive' | 'resumed' | 'failed' | 'blocked';
    reason: string;
    state: GoalSessionState;
};

/**
 * Coordinates durable goal turns. The class has no dependency on API routes or
 * queue implementations; callers inject the goal persistence/event/message ports.
 * Turn execution lives in {@link GoalTurnRunner}; this layer owns session open,
 * crash recovery, and the session-scoped control operations.
 */
export class GoalSessionSupervisor extends GoalTurnRunner {
    async openSession(request: OpenGoalSessionRequest): Promise<GoalSessionState> {
        validateIdentity(request);
        validateEpoch(request.controllerEpoch);
        if (request.provider !== this.adapter.provider) {
            throw new GoalSessionContractError(
                `Adapter "${this.adapter.provider}" cannot open provider "${request.provider}"`,
                'UNSUPPORTED_PROVIDER',
            );
        }

        const opened = await this.loadOrCreateForOpen(request);
        let state = opened.state;
        if (request.controllerEpoch > state.controllerEpoch) state = await this.takeover(request, request.controllerEpoch);
        if (state.status === 'terminated') {
            throw new GoalSessionContractError('A terminated provider session cannot be resumed', 'SESSION_TERMINATED');
        }

        let deterministicOpenKey: string | undefined;
        if (!state.providerSessionId) {
            if (!opened.created && !this.canRecoverIncompleteInit(state)) {
                throw new GoalSessionContractError(
                    'The previous controller stopped before persisting a provider session identity; reconcile or fail this goal explicitly',
                    'INCOMPLETE_INITIALIZATION',
                );
            }
            state = await this.recordInitializationIntent(request, state);
            deterministicOpenKey = state.initializationIntent?.deterministicOpenKey;
        }

        return this.callProviderOpen(request, state, deterministicOpenKey);
    }

    async takeover(identity: GoalSessionIdentity, controllerEpoch: number): Promise<GoalSessionState> {
        validateIdentity(identity);
        validateEpoch(controllerEpoch);
        const state = await this.requireState(identity);
        if (controllerEpoch <= state.controllerEpoch) {
            if (controllerEpoch === state.controllerEpoch) return state;
            throw new StaleGoalSessionFenceError();
        }
        const saved = await this.ports.state.compareAndSet(state, nextState(state, { controllerEpoch }));
        if (!saved) throw new StaleGoalSessionFenceError('Another controller acquired the session concurrently');
        return saved;
    }

    async deliverMessage(request: GoalSteeringRequest): Promise<'acknowledged' | 'already_acknowledged'> {
        const state = await this.requireActiveTurnState(request);
        const pending = (await this.ports.messages.listPending(request)).sort((a, b) => a.sequence - b.sequence);
        const message = pending.find(value => value.messageId === request.messageId);
        if (!message) return 'already_acknowledged';
        if (pending[0]?.messageId !== request.messageId) {
            throw new GoalSessionContractError(
                `Corrective message "${request.messageId}" is out of order; "${pending[0]?.messageId}" must be delivered first`,
                'MESSAGE_OUT_OF_ORDER',
            );
        }
        const acknowledgement = await this.adapter.deliverMessage({ ...request, body: message.body }, persistedSnapshot(state));
        if (acknowledgement.messageId !== request.messageId) {
            throw new GoalSessionContractError('Provider acknowledged a different corrective message', 'MESSAGE_ACK_MISMATCH');
        }
        const result = await this.ports.messages.acknowledge(request, request.messageId);
        if (result === 'stale_fence') throw new StaleGoalSessionFenceError();
        if (result === 'not_found') throw new GoalSessionContractError('Corrective message disappeared before acknowledgement', 'MESSAGE_NOT_FOUND');
        if (result === 'acknowledged') {
            await this.append(request, this.activeExecution(state), { type: 'message_acknowledged', messageId: request.messageId });
        }
        return result;
    }

    async requestPause(request: GoalPauseRequest): Promise<GoalPauseAcknowledgement> {
        let state = await this.requireControlledState(request);
        if (state.status !== 'running' && state.status !== 'pause_requested') {
            throw new GoalSessionContractError(`Cannot pause a session while it is ${state.status}`, 'SESSION_NOT_RUNNING');
        }
        if (state.status === 'running') {
            state = await this.updateControlledState(request, value => ({
                ...value,
                status: 'pause_requested',
                activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'pause_requested' } : value.activeTurn,
            }));
        }
        const acknowledgement = await this.adapter.requestPause(request, persistedSnapshot(state));
        await this.appendControl(request, controlExecutionIdentity(state), { type: 'pause_requested', appliesAt: acknowledgement.appliesAt });
        if (acknowledgement.boundaryReached) {
            state = await this.updateControlledState(request, value => ({
                ...value,
                status: 'paused',
                activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'paused' } : value.activeTurn,
            }));
            await this.appendControl(request, controlExecutionIdentity(state), { type: 'pause_boundary', ...acknowledgement.boundaryReached });
        }
        return acknowledgement;
    }

    async requestModelChange(request: GoalModelChangeRequest): Promise<GoalModelChangeAcknowledgement> {
        let state = await this.requireControlledState(request);
        if (state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') {
            throw new GoalSessionContractError(`Cannot change model while the session is ${state.status}`, 'SESSION_NOT_CONTROLLABLE');
        }
        const previousModel = state.currentModel;
        const acknowledgement = await this.adapter.requestModelChange(request, persistedSnapshot(state));
        if (acknowledgement.requestedModel !== request.model) {
            throw new GoalSessionContractError('Provider acknowledged a different requested model', 'MODEL_ACK_MISMATCH');
        }
        state = await this.updateControlledState(request, value => ({
            ...value,
            requestedModel: request.model,
            currentModel: acknowledgement.effectiveModel ?? value.currentModel,
        }));
        await this.appendControl(request, controlExecutionIdentity(state), {
            type: 'model_change_acknowledged',
            requestedModel: request.model,
            appliesAt: acknowledgement.appliesAt,
        });
        if (acknowledgement.effectiveModel) {
            await this.appendControl(request, controlExecutionIdentity(state), {
                type: 'model_changed',
                previousModel,
                model: acknowledgement.effectiveModel,
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
        await this.appendControl(request, controlExecutionIdentity(state), { type: 'completion', outcome: 'cancelled', error: request.reason });
        return state;
    }

    async reconcile(
        identity: GoalSessionIdentity,
        controllerEpoch: number,
        repository: GoalRepositoryIdentity,
    ): Promise<ReconcileGoalSessionResult> {
        let state = await this.requireState(identity);
        if (controllerEpoch < state.controllerEpoch) throw new StaleGoalSessionFenceError();
        if (controllerEpoch > state.controllerEpoch) state = await this.takeover(identity, controllerEpoch);
        const controlFence: GoalSessionControlFence = { ...identity, controllerEpoch };
        const [container, repositoryInspection] = await Promise.all([
            this.ports.recovery.inspectContainer(identity),
            this.ports.recovery.inspectRepository(repository),
        ]);

        const mismatch = verifyReconciliationTarget(repository, repositoryInspection);
        if (mismatch) {
            await this.appendControl(controlFence, controlExecutionIdentity(state), { type: 'reconciliation', outcome: 'blocked', reason: mismatch });
            return { outcome: 'blocked', reason: mismatch, state };
        }

        const result = await this.adapter.reconcile({ ...identity, controllerEpoch, persisted: persistedSnapshot(state), container, repository: repositoryInspection });
        const snapshot = 'snapshot' in result ? result.snapshot : undefined;
        if (snapshot) {
            assertProviderIdentity(state, snapshot);
            assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata);
        }
        const reconciled = reconcileRecoveredTurn(state, result.outcome);
        const saved = await this.ports.state.compareAndSet(state, nextState(state, {
            status: reconciled.status,
            activeTurn: reconciled.activeTurn,
            failureReason: result.outcome === 'failed' ? result.reason : undefined,
            providerSessionId: snapshot?.providerSessionId ?? state.providerSessionId,
            recoveryMetadata: snapshot?.recoveryMetadata ?? state.recoveryMetadata,
            currentModel: snapshot?.model ?? state.currentModel,
        }));
        if (!saved) throw new StaleGoalSessionFenceError('Ownership changed during crash reconciliation');
        await this.appendControl(controlFence, controlExecutionIdentity(saved), { type: 'reconciliation', outcome: result.outcome, reason: result.reason });
        return { ...result, state: saved };
    }

    private activeExecution(state: GoalSessionState): GoalExecutionIdentity {
        if (!state.activeTurn) throw new StaleGoalSessionFenceError('No active turn owns this operation');
        return { executionId: state.activeTurn.executionId, attemptId: state.activeTurn.attemptId };
    }

    private canRecoverIncompleteInit(state: GoalSessionState): boolean {
        return this.adapter.supportsDeterministicOpen === true && state.initializationIntent !== undefined;
    }

    private async recordInitializationIntent(
        request: OpenGoalSessionRequest,
        state: GoalSessionState,
    ): Promise<GoalSessionState> {
        if (this.adapter.supportsDeterministicOpen !== true || state.initializationIntent) return state;
        return this.updateControlledState(request, value => ({
            ...value,
            initializationIntent: {
                attemptId: randomUUID(),
                deterministicOpenKey: deterministicOpenKey(request),
                recordedAt: nowIso(),
            },
        }));
    }

    private async loadOrCreateForOpen(request: OpenGoalSessionRequest): Promise<{ state: GoalSessionState; created: boolean }> {
        let state = await this.ports.state.load(request);
        let created = false;
        if (!state) {
            const timestamp = nowIso();
            const initial = await this.ports.state.create({
                ...request,
                status: 'initializing',
                completedTurnIds: [],
                createdAt: timestamp,
                updatedAt: timestamp,
            });
            if (initial) { state = initial; created = true; }
            else state = await this.requireState(request);
        }
        if (state.provider !== request.provider) {
            throw new UnsupportedGoalSessionTransitionError('A session cannot change providers while resuming', 'UNSUPPORTED_PROVIDER_TRANSITION');
        }
        if (request.controllerEpoch < state.controllerEpoch) throw new StaleGoalSessionFenceError();
        return { state, created };
    }

    private async callProviderOpen(
        request: OpenGoalSessionRequest,
        state: GoalSessionState,
        deterministicOpenKey: string | undefined,
    ): Promise<GoalSessionState> {
        const persisted = state.providerSessionId ? persistedSnapshot(state) : undefined;
        try {
            const snapshot = await this.adapter.openSession({ ...request, persisted, deterministicOpenKey });
            assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata);
            assertProviderIdentity(state, snapshot);
            const saved = await this.ports.state.compareAndSet(state, nextState(state, {
                providerSessionId: snapshot.providerSessionId,
                recoveryMetadata: snapshot.recoveryMetadata,
                currentModel: snapshot.model ?? state.currentModel,
                status: state.status === 'initializing' ? 'idle' : state.status,
                initializationIntent: undefined,
                failureReason: undefined,
            }));
            if (!saved) throw new StaleGoalSessionFenceError('Session ownership changed while provider identity was being persisted');
            return saved;
        } catch (error) {
            if (error instanceof StaleGoalSessionFenceError || error instanceof GoalSessionContractError) throw error;
            await this.ports.state.compareAndSet(state, nextState(state, { status: 'failed', failureReason: `Unable to create or resume provider session: ${(error as Error).message}` }));
            throw error;
        }
    }
}

function deterministicOpenKey(identity: GoalSessionIdentity & { provider: string }): string {
    return createHash('sha256').update(`${identity.provider}\0${identity.goalId}\0${identity.sessionId}`).digest('hex');
}

/**
 * Reconciles the recovered session status and its active turn into a coherent
 * state. A turn that was still running/pause-requested/paused when the container
 * was lost becomes an explicitly paused, resumable turn so a replacement
 * supervisor continues the exact execution/attempt rather than letting a new
 * turn overwrite it. A failed reconcile fails the session; any other outcome
 * leaves the durable turn untouched.
 */
function reconcileRecoveredTurn(
    state: GoalSessionState,
    outcome: GoalProviderReconcileResult['outcome'],
): { status: GoalSessionStatus; activeTurn: GoalTurnState | undefined } {
    if (outcome === 'failed') return { status: 'failed', activeTurn: state.activeTurn };
    if (outcome !== 'resumed') return { status: state.status, activeTurn: state.activeTurn };
    const turn = state.activeTurn;
    if (turn && (turn.status === 'running' || turn.status === 'pause_requested' || turn.status === 'paused')) {
        return { status: 'paused', activeTurn: { ...turn, status: 'paused' } };
    }
    return { status: 'idle', activeTurn: turn };
}

/**
 * Verifies the worktree matches the expected identity before any resume side
 * effect. It also blocks when the expected branch/head cannot actually be
 * observed, so a worktree whose state could not be inspected never passes by the
 * mere absence of an observed value.
 */
function verifyReconciliationTarget(
    expected: GoalRepositoryIdentity,
    inspection: GoalRepositoryInspection,
): string | null {
    if (!inspection.exists) {
        return `Worktree ${expected.worktreePath} is unavailable: ${inspection.reason ?? 'not found'}`;
    }
    if (!inspection.observedBranch) {
        return `Worktree ${expected.worktreePath} branch could not be observed: ${inspection.reason ?? 'branch unavailable'}`;
    }
    if (inspection.observedBranch !== expected.branch) {
        return `Worktree branch mismatch: expected ${expected.branch}, found ${inspection.observedBranch}`;
    }
    if (expected.headSha) {
        if (!inspection.observedHeadSha) {
            return `Worktree ${expected.worktreePath} head could not be observed: ${inspection.reason ?? 'head unavailable'}`;
        }
        if (inspection.observedHeadSha !== expected.headSha) {
            return `Worktree head mismatch: expected ${expected.headSha}, found ${inspection.observedHeadSha}`;
        }
    }
    return null;
}

export {
    GoalSessionContractError,
    StaleGoalSessionFenceError,
    UnsupportedGoalSessionTransitionError,
} from './errors.js';
export { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
export { firstPendingCorrectiveMessage } from './support.js';
export type { RunGoalTurnRequest, RunGoalTurnResult } from './GoalTurnRunner.js';
