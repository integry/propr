import { createHash, randomUUID } from 'node:crypto';
import type {
    GoalProviderReconcileResult,
    GoalRepositoryIdentity,
    GoalRepositoryInspection,
    GoalSessionControlFence,
    GoalSessionIdentity,
    GoalSessionState,
    GoalSessionStatus,
    GoalTurnState,
} from './contract.js';
import {
    GoalSessionContractError,
    StaleGoalSessionFenceError,
    UnsupportedGoalSessionTransitionError,
} from './errors.js';
import { GoalSessionControls } from './GoalSessionControls.js';
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
export class GoalSessionSupervisor extends GoalSessionControls {
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
            if (this.adapter.capabilities.nativeSessionId === 'first_turn') {
                return this.openFirstTurnIdentitySession(request, state);
            }
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

    private canRecoverIncompleteInit(state: GoalSessionState): boolean {
        return this.adapter.supportsDeterministicOpen === true && state.initializationIntent !== undefined;
    }

    private async openFirstTurnIdentitySession(
        request: OpenGoalSessionRequest,
        state: GoalSessionState,
    ): Promise<GoalSessionState> {
        if (!state.initializationIntent) {
            throw new GoalSessionContractError(
                'A first-turn provider has no durable initialization intent; refusing to start a different native session',
                'INCOMPLETE_INITIALIZATION',
            );
        }
        const policy = this.adapter.capabilities.nativeSessionId === 'first_turn'
            ? this.adapter.capabilities.firstTurnIdCrashPolicy
            : 'fail';
        if (state.activeTurn && policy === 'retry_deterministically') {
            return this.updateControlledState(request, value => ({
                ...value, status: 'idle', activeTurn: undefined, failureReason: undefined,
            }));
        }
        if (state.activeTurn || (state.status !== 'initializing' && state.status !== 'idle')) {
            throw new GoalSessionContractError(
                `The first provider invocation ended before binding its native session ID (${policy})`,
                'FIRST_TURN_ID_NOT_BOUND',
            );
        }
        if (state.status === 'idle') return state;
        return this.updateControlledState(request, value => ({ ...value, status: 'idle', failureReason: undefined }));
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
            const initializationIntent = this.adapter.capabilities.nativeSessionId === 'first_turn'
                ? createInitializationIntent(request)
                : undefined;
            const initial = await this.ports.state.create({
                ...request,
                status: 'initializing',
                completedTurnIds: [],
                initializationIntent,
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

function createInitializationIntent(
    identity: GoalSessionIdentity & { provider: string },
): NonNullable<GoalSessionState['initializationIntent']> {
    return {
        attemptId: randomUUID(),
        deterministicOpenKey: deterministicOpenKey(identity),
        recordedAt: nowIso(),
    };
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
