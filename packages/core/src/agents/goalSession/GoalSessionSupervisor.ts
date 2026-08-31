/* eslint-disable max-lines -- turn lifecycle and recovery share one fenced state machine */
import { randomUUID } from 'node:crypto';
import type {
    DurableCorrectiveMessage,
    GoalBeginTurnRequest,
    GoalCancelRequest,
    GoalExecutionIdentity,
    GoalModelChangeAcknowledgement,
    GoalModelChangeRequest,
    GoalPauseAcknowledgement,
    GoalPauseRequest,
    GoalProviderSessionSnapshot,
    GoalRepositoryIdentity,
    GoalSessionAdapter,
    GoalSessionEvent,
    GoalSessionFence,
    GoalSessionIdentity,
    GoalSessionRuntimePorts,
    GoalSessionJsonValue,
    GoalSessionState,
    GoalSteeringRequest,
} from './contract.js';

export class GoalSessionContractError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = 'GoalSessionContractError';
    }
}

export class StaleGoalSessionFenceError extends GoalSessionContractError {
    constructor(message = 'The goal session controller fence is stale') {
        super(message, 'STALE_FENCE');
        this.name = 'StaleGoalSessionFenceError';
    }
}

export class UnsupportedGoalSessionTransitionError extends GoalSessionContractError {
    constructor(message: string, code: 'UNSUPPORTED_MODEL_TRANSITION' | 'UNSUPPORTED_PROVIDER_TRANSITION') {
        super(message, code);
        this.name = 'UnsupportedGoalSessionTransitionError';
    }
}

const SENSITIVE_RECOVERY_KEY_SUFFIXES = ['apikey', 'authorization', 'credential', 'password', 'privatekey', 'secret', 'token'];

/** Recovery metadata is durable state, never a credential transport. */
export function assertCredentialFreeRecoveryMetadata(value: GoalSessionJsonValue): void {
    const visit = (candidate: GoalSessionJsonValue, path: string): void => {
        if (candidate === undefined || typeof candidate === 'bigint' || typeof candidate === 'function' || typeof candidate === 'symbol') {
            throw new GoalSessionContractError(`Recovery metadata contains a non-JSON value at ${path}`, 'INVALID_RECOVERY_METADATA');
        }
        if (typeof candidate === 'number' && !Number.isFinite(candidate)) {
            throw new GoalSessionContractError(`Recovery metadata contains a non-finite number at ${path}`, 'INVALID_RECOVERY_METADATA');
        }
        if (Array.isArray(candidate)) {
            candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
            return;
        }
        if (candidate && typeof candidate === 'object') {
            const prototype = Object.getPrototypeOf(candidate);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new GoalSessionContractError(`Recovery metadata contains a non-JSON object at ${path}`, 'INVALID_RECOVERY_METADATA');
            }
            for (const [key, nested] of Object.entries(candidate)) {
                const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
                if (SENSITIVE_RECOVERY_KEY_SUFFIXES.some(suffix => normalizedKey.endsWith(suffix))) {
                    throw new GoalSessionContractError(`Recovery metadata cannot persist credential-like field "${key}"`, 'RECOVERY_METADATA_CONTAINS_CREDENTIAL');
                }
                visit(nested, `${path}.${key}`);
            }
        }
    };
    visit(value, '$');
}

export interface OpenGoalSessionRequest extends GoalSessionIdentity {
    provider: string;
    controllerEpoch: number;
}

export interface RunGoalTurnRequest extends Omit<GoalBeginTurnRequest, 'executionId' | 'attemptId'> {
    executionId: string;
    attemptId?: string;
}

export type RunGoalTurnResult =
    | { disposition: 'started'; state: GoalSessionState; execution: GoalExecutionIdentity }
    | { disposition: 'duplicate'; state: GoalSessionState; execution: GoalExecutionIdentity };

export type ReconcileGoalSessionResult = {
    outcome: 'alive' | 'resumed' | 'failed';
    reason: string;
    state: GoalSessionState;
};

function now(): string {
    return new Date().toISOString();
}

function validateIdentity(identity: GoalSessionIdentity): void {
    if (!identity.goalId.trim() || !identity.sessionId.trim()) {
        throw new GoalSessionContractError('goalId and sessionId must be non-empty', 'INVALID_IDENTITY');
    }
}

function validateEpoch(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
        throw new GoalSessionContractError('controllerEpoch must be a non-negative safe integer', 'INVALID_EPOCH');
    }
}

function persistedSnapshot(state: GoalSessionState): GoalProviderSessionSnapshot {
    if (!state.providerSessionId || state.recoveryMetadata === undefined) {
        throw new GoalSessionContractError(
            'Provider identity/checkpoint is not durable; the session cannot be resumed safely',
            'SESSION_NOT_RECOVERABLE',
        );
    }
    return {
        providerSessionId: state.providerSessionId,
        recoveryMetadata: state.recoveryMetadata,
        model: state.currentModel,
    };
}

function nextState(state: GoalSessionState, changes: Partial<GoalSessionState>): Omit<GoalSessionState, 'version'> {
    const withoutVersion: Partial<GoalSessionState> = { ...state };
    delete withoutVersion.version;
    return { ...withoutVersion, ...changes, updatedAt: now() } as Omit<GoalSessionState, 'version'>;
}

function assertProviderIdentity(state: GoalSessionState, snapshot: GoalProviderSessionSnapshot): void {
    if (state.providerSessionId && state.providerSessionId !== snapshot.providerSessionId) {
        throw new GoalSessionContractError(
            `Provider attempted to replace session "${state.providerSessionId}" with "${snapshot.providerSessionId}"`,
            'PROVIDER_SESSION_CHANGED',
        );
    }
}

/**
 * Coordinates durable goal turns. The class has no dependency on API routes or
 * queue implementations; callers inject the goal persistence/event/message ports.
 */
export class GoalSessionSupervisor {
    constructor(
        private readonly adapter: GoalSessionAdapter,
        private readonly ports: GoalSessionRuntimePorts,
    ) {}

    async openSession(request: OpenGoalSessionRequest): Promise<GoalSessionState> {
        validateIdentity(request);
        validateEpoch(request.controllerEpoch);
        if (request.provider !== this.adapter.provider) {
            throw new GoalSessionContractError(
                `Adapter "${this.adapter.provider}" cannot open provider "${request.provider}"`,
                'UNSUPPORTED_PROVIDER',
            );
        }

        let state = await this.ports.state.load(request);
        let created = false;
        if (!state) {
            const timestamp = now();
            const initial = await this.ports.state.create({
                ...request,
                status: 'initializing',
                completedTurnIds: [],
                createdAt: timestamp,
                updatedAt: timestamp,
            });
            if (initial) {
                state = initial;
                created = true;
            } else {
                state = await this.requireState(request);
            }
        }

        if (state.provider !== request.provider) {
            throw new UnsupportedGoalSessionTransitionError(
                'A session cannot change providers while resuming',
                'UNSUPPORTED_PROVIDER_TRANSITION',
            );
        }
        if (request.controllerEpoch < state.controllerEpoch) throw new StaleGoalSessionFenceError();
        if (request.controllerEpoch > state.controllerEpoch) state = await this.takeover(request, request.controllerEpoch);

        if (!created && !state.providerSessionId) {
            throw new GoalSessionContractError(
                'The previous controller stopped before persisting a provider session identity; reconcile or fail this goal explicitly',
                'INCOMPLETE_INITIALIZATION',
            );
        }
        if (state.status === 'terminated') {
            throw new GoalSessionContractError('A terminated provider session cannot be resumed', 'SESSION_TERMINATED');
        }

        const persisted = state.providerSessionId ? persistedSnapshot(state) : undefined;
        try {
            const snapshot = await this.adapter.openSession({ ...request, persisted });
            assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata);
            assertProviderIdentity(state, snapshot);
            const saved = await this.ports.state.compareAndSet(state, nextState(state, {
                providerSessionId: snapshot.providerSessionId,
                recoveryMetadata: snapshot.recoveryMetadata,
                currentModel: snapshot.model ?? state.currentModel,
                status: state.status === 'initializing' ? 'idle' : state.status,
                failureReason: undefined,
            }));
            if (!saved) throw new StaleGoalSessionFenceError('Session ownership changed while provider identity was being persisted');
            return saved;
        } catch (error) {
            if (error instanceof StaleGoalSessionFenceError || error instanceof GoalSessionContractError) throw error;
            await this.tryFailState(state, `Unable to create or resume provider session: ${(error as Error).message}`);
            throw error;
        }
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

    // The branches mirror the durable turn-state transitions kept in this method.
    // eslint-disable-next-line complexity
    async runTurn(request: RunGoalTurnRequest): Promise<RunGoalTurnResult> {
        this.validateFence(request);
        if (!request.turnId.trim() || !request.executionId.trim()) {
            throw new GoalSessionContractError('turnId and executionId must be non-empty', 'INVALID_TURN');
        }
        const attemptId = request.attemptId ?? randomUUID();
        const execution = { executionId: request.executionId, attemptId };
        let state = await this.requireFencedState(request);

        if (state.completedTurnIds.includes(request.turnId) || state.activeTurn?.turnId === request.turnId) {
            return {
                disposition: 'duplicate',
                state,
                execution: state.activeTurn?.turnId === request.turnId ? state.activeTurn : execution,
            };
        }
        if (state.status !== 'idle') {
            throw new GoalSessionContractError(`Cannot begin a turn while session is ${state.status}`, 'SESSION_NOT_IDLE');
        }

        const activeTurn = {
            ...execution,
            turnId: request.turnId,
            objective: request.objective,
            requestedModel: request.requestedModel,
            repository: request.repository,
            status: 'running' as const,
        };
        const claimed = await this.ports.state.compareAndSet(state, nextState(state, {
            activeTurn,
            requestedModel: request.requestedModel,
            status: 'running',
        }));
        if (!claimed) {
            state = await this.requireFencedState(request);
            if (state.completedTurnIds.includes(request.turnId) || state.activeTurn?.turnId === request.turnId) {
                return { disposition: 'duplicate', state, execution: state.activeTurn ?? execution };
            }
            throw new StaleGoalSessionFenceError('Another delivery claimed the session turn');
        }

        const adapterRequest: GoalBeginTurnRequest = { ...request, ...execution };
        let current = claimed;
        let reachedPause = false;
        let completed = false;
        try {
            for await (const event of this.adapter.beginTurn(adapterRequest, persistedSnapshot(current))) {
                if (completed) {
                    throw new GoalSessionContractError('Provider emitted an event after turn completion', 'EVENT_AFTER_COMPLETION');
                }
                if (event.type === 'checkpoint') current = await this.persistCheckpoint(request, current, event);
                if (event.type === 'model_changed') current = await this.updateFencedState(request, value => ({ ...value, currentModel: event.model }));
                if (event.type === 'pause_boundary') {
                    reachedPause = true;
                    current = await this.updateFencedState(request, value => ({
                        ...value,
                        status: 'paused',
                        activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'paused' } : value.activeTurn,
                    }));
                }
                if (event.type === 'completion') {
                    completed = true;
                    current = await this.finishTurn(request, event.outcome, event.error);
                }
                await this.append(request, execution, event);
            }

            if (!completed && !reachedPause) {
                const error = 'Provider stream ended without a completion or safe pause boundary';
                current = await this.finishTurn(request, 'failed', error);
                await this.append(request, execution, { type: 'completion', outcome: 'failed', error });
            }
            return { disposition: 'started', state: current, execution };
        } catch (error) {
            if (error instanceof StaleGoalSessionFenceError) throw error;
            const message = `Provider turn failed: ${(error as Error).message}`;
            current = await this.finishTurnIfOwned(request, message);
            await this.appendIfOwned(request, execution, { type: 'completion', outcome: 'failed', error: message });
            throw error;
        }
    }

    async deliverMessage(request: GoalSteeringRequest): Promise<'acknowledged' | 'already_acknowledged'> {
        const state = await this.requireFencedState(request);
        const pending = (await this.ports.messages.listPending(request)).sort((a, b) => a.sequence - b.sequence);
        const message = pending.find(value => value.messageId === request.messageId);
        if (!message) return 'already_acknowledged';
        if (pending[0]?.messageId !== request.messageId) {
            throw new GoalSessionContractError(
                `Corrective message "${request.messageId}" is out of order; "${pending[0]?.messageId}" must be delivered first`,
                'MESSAGE_OUT_OF_ORDER',
            );
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
        if (result === 'not_found') throw new GoalSessionContractError('Corrective message disappeared before acknowledgement', 'MESSAGE_NOT_FOUND');
        if (result === 'acknowledged') {
            await this.append(request, this.executionFor(state), { type: 'message_acknowledged', messageId: request.messageId });
        }
        return result;
    }

    async requestPause(request: GoalPauseRequest): Promise<GoalPauseAcknowledgement> {
        let state = await this.requireFencedState(request);
        if (state.status !== 'running' && state.status !== 'pause_requested') {
            throw new GoalSessionContractError(`Cannot pause a session while it is ${state.status}`, 'SESSION_NOT_RUNNING');
        }
        if (state.status === 'running') {
            state = await this.updateFencedState(request, value => ({
                ...value,
                status: 'pause_requested',
                activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'pause_requested' } : value.activeTurn,
            }));
        }
        const acknowledgement = await this.adapter.requestPause(request, persistedSnapshot(state));
        await this.append(request, this.executionFor(state), { type: 'pause_requested', appliesAt: acknowledgement.appliesAt });
        if (acknowledgement.boundaryReached) {
            state = await this.updateFencedState(request, value => ({
                ...value,
                status: 'paused',
                activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'paused' } : value.activeTurn,
            }));
            await this.append(request, this.executionFor(state), {
                type: 'pause_boundary',
                ...acknowledgement.boundaryReached,
            });
        }
        return acknowledgement;
    }

    async resumeSession(fence: GoalSessionFence): Promise<GoalSessionState> {
        let state = await this.requireFencedState(fence);
        if (state.status !== 'paused') {
            throw new GoalSessionContractError(`Cannot resume a session while it is ${state.status}`, 'SESSION_NOT_PAUSED');
        }
        const snapshot = await this.adapter.resumeSession(fence, persistedSnapshot(state));
        assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata);
        assertProviderIdentity(state, snapshot);
        state = await this.updateFencedState(fence, value => ({
            ...value,
            providerSessionId: snapshot.providerSessionId,
            recoveryMetadata: snapshot.recoveryMetadata,
            currentModel: snapshot.model ?? value.currentModel,
            status: 'idle',
        }));
        await this.append(fence, this.executionFor(state), { type: 'session_resumed' });
        return state;
    }

    async requestModelChange(request: GoalModelChangeRequest): Promise<GoalModelChangeAcknowledgement> {
        let state = await this.requireFencedState(request);
        const previousModel = state.currentModel;
        const acknowledgement = await this.adapter.requestModelChange(request, persistedSnapshot(state));
        if (acknowledgement.requestedModel !== request.model) {
            throw new GoalSessionContractError('Provider acknowledged a different requested model', 'MODEL_ACK_MISMATCH');
        }
        state = await this.updateFencedState(request, value => ({
            ...value,
            requestedModel: request.model,
            currentModel: acknowledgement.effectiveModel ?? value.currentModel,
        }));
        await this.append(request, this.executionFor(state), {
            type: 'model_change_acknowledged',
            requestedModel: request.model,
            appliesAt: acknowledgement.appliesAt,
        });
        if (acknowledgement.effectiveModel) {
            await this.append(request, this.executionFor(state), {
                type: 'model_changed',
                previousModel,
                model: acknowledgement.effectiveModel,
            });
        }
        return acknowledgement;
    }

    async cancel(request: GoalCancelRequest): Promise<GoalSessionState> {
        let state = await this.requireFencedState(request);
        if (state.status === 'terminated') return state;
        state = await this.updateFencedState(request, value => ({ ...value, status: 'cancelling' }));
        await this.adapter.cancel(request, persistedSnapshot(state));
        state = await this.updateFencedState(request, value => ({
            ...value,
            status: 'terminated',
            activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'cancelled' } : value.activeTurn,
        }));
        await this.append(request, this.executionFor(state), { type: 'completion', outcome: 'cancelled', error: request.reason });
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
        const [container, repositoryInspection] = await Promise.all([
            this.ports.recovery.inspectContainer(identity),
            this.ports.recovery.inspectRepository(repository),
        ]);
        const result = await this.adapter.reconcile({
            ...identity,
            controllerEpoch,
            persisted: persistedSnapshot(state),
            container,
            repository: repositoryInspection,
        });
        const snapshot = 'snapshot' in result ? result.snapshot : undefined;
        if (snapshot) assertProviderIdentity(state, snapshot);
        if (snapshot) assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata);
        const status = result.outcome === 'failed' ? 'failed' : result.outcome === 'resumed' ? 'idle' : state.status;
        const saved = await this.ports.state.compareAndSet(state, nextState(state, {
            status,
            failureReason: result.outcome === 'failed' ? result.reason : undefined,
            providerSessionId: snapshot?.providerSessionId ?? state.providerSessionId,
            recoveryMetadata: snapshot?.recoveryMetadata ?? state.recoveryMetadata,
            currentModel: snapshot?.model ?? state.currentModel,
        }));
        if (!saved) throw new StaleGoalSessionFenceError('Ownership changed during crash reconciliation');
        const fence = this.reconciliationFence(saved);
        await this.append(fence, this.executionFor(saved), { type: 'reconciliation', outcome: result.outcome, reason: result.reason });
        return { ...result, state: saved };
    }

    private validateFence(fence: GoalSessionFence): void {
        validateIdentity(fence);
        validateEpoch(fence.controllerEpoch);
        if (!fence.turnId.trim()) throw new GoalSessionContractError('turnId must be non-empty', 'INVALID_TURN');
    }

    private async requireState(identity: GoalSessionIdentity): Promise<GoalSessionState> {
        const state = await this.ports.state.load(identity);
        if (!state) throw new GoalSessionContractError('Goal session does not exist', 'SESSION_NOT_FOUND');
        return state;
    }

    private async requireFencedState(fence: GoalSessionFence): Promise<GoalSessionState> {
        this.validateFence(fence);
        const state = await this.requireState(fence);
        if (state.controllerEpoch !== fence.controllerEpoch) throw new StaleGoalSessionFenceError();
        if (state.activeTurn && state.activeTurn.turnId !== fence.turnId && state.status !== 'idle') {
            throw new StaleGoalSessionFenceError('Turn fence does not own the active session turn');
        }
        return state;
    }

    private async updateFencedState(
        fence: GoalSessionFence,
        update: (state: GoalSessionState) => Partial<GoalSessionState>,
    ): Promise<GoalSessionState> {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const state = await this.requireFencedState(fence);
            const saved = await this.ports.state.compareAndSet(state, nextState(state, update(state)));
            if (saved) return saved;
        }
        throw new StaleGoalSessionFenceError('Could not persist a fenced session update');
    }

    private async persistCheckpoint(
        fence: GoalSessionFence,
        state: GoalSessionState,
        event: Extract<GoalSessionEvent, { type: 'checkpoint' }>,
    ): Promise<GoalSessionState> {
        if (event.providerSessionId && event.providerSessionId !== state.providerSessionId) {
            throw new GoalSessionContractError('Checkpoint attempted to replace the provider session identity', 'PROVIDER_SESSION_CHANGED');
        }
        assertCredentialFreeRecoveryMetadata(event.recoveryMetadata);
        return this.updateFencedState(fence, value => ({ ...value, recoveryMetadata: event.recoveryMetadata }));
    }

    private async finishTurn(
        fence: GoalSessionFence,
        outcome: 'succeeded' | 'failed' | 'cancelled',
        error?: string,
    ): Promise<GoalSessionState> {
        return this.updateFencedState(fence, state => ({
            ...state,
            status: outcome === 'cancelled' ? 'terminated' : outcome === 'failed' ? 'failed' : 'idle',
            failureReason: outcome === 'failed' ? error ?? 'Provider reported turn failure' : undefined,
            activeTurn: state.activeTurn ? {
                ...state.activeTurn,
                status: outcome === 'succeeded' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed',
            } : state.activeTurn,
            completedTurnIds: state.completedTurnIds.includes(fence.turnId)
                ? state.completedTurnIds
                : [...state.completedTurnIds, fence.turnId],
        }));
    }

    private async finishTurnIfOwned(fence: GoalSessionFence, error: string): Promise<GoalSessionState> {
        try { return await this.finishTurn(fence, 'failed', error); }
        catch (cause) {
            if (cause instanceof StaleGoalSessionFenceError) throw cause;
            return this.requireState(fence);
        }
    }

    private async tryFailState(state: GoalSessionState, failureReason: string): Promise<void> {
        await this.ports.state.compareAndSet(state, nextState(state, { status: 'failed', failureReason }));
    }

    private executionFor(state: GoalSessionState): GoalExecutionIdentity {
        return state.activeTurn ?? { executionId: `session-${state.sessionId}`, attemptId: `epoch-${state.controllerEpoch}` };
    }

    private reconciliationFence(state: GoalSessionState): GoalSessionFence {
        return {
            goalId: state.goalId,
            sessionId: state.sessionId,
            controllerEpoch: state.controllerEpoch,
            turnId: state.activeTurn?.turnId ?? `reconciliation-${state.controllerEpoch}`,
        };
    }

    private async append(fence: GoalSessionFence, execution: GoalExecutionIdentity, event: GoalSessionEvent): Promise<void> {
        const result = await this.ports.events.append(fence, execution, event);
        if (!result.accepted) throw new StaleGoalSessionFenceError(`Durable event sink rejected output: ${result.reason}`);
    }

    private async appendIfOwned(fence: GoalSessionFence, execution: GoalExecutionIdentity, event: GoalSessionEvent): Promise<void> {
        const result = await this.ports.events.append(fence, execution, event);
        if (!result.accepted && result.reason !== 'stale_fence') {
            throw new GoalSessionContractError(`Durable event sink rejected output: ${result.reason}`, 'EVENT_REJECTED');
        }
    }
}

export function firstPendingCorrectiveMessage(messages: DurableCorrectiveMessage[]): DurableCorrectiveMessage | undefined {
    return [...messages].sort((a, b) => a.sequence - b.sequence)[0];
}
