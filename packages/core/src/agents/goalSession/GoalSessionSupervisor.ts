import { createHash } from 'node:crypto';
import type {
    GoalContainerInspection,
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
import { fingerprintGoalWorktree } from './worktreeIdentity.js';

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
            state = await this.recordInitializationIntent(request, state, !opened.created);
            deterministicOpenKey = state.initializationIntent?.deterministicOpenKey;
        } else {
            state = await this.recordProviderOpenAttempt(state);
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
        const durableRepository = state.activeTurn?.repository ?? repository;
        const requestedFingerprint = fingerprintGoalWorktree(repository);
        const durableFingerprint = fingerprintGoalWorktree(durableRepository);
        if (requestedFingerprint !== durableFingerprint) {
            const reason = 'Requested worktree does not match the active turn\'s authoritative repository identity';
            await this.appendControl(controlFence, controlExecutionIdentity(state), { type: 'reconciliation', outcome: 'blocked', reason });
            return { outcome: 'blocked', reason, state };
        }
        const [container, repositoryInspection] = await Promise.all([
            this.ports.recovery.inspectContainer(identity),
            this.ports.recovery.inspectRepository(durableRepository),
        ]);

        const mismatch = verifyReconciliationTarget(durableRepository, repositoryInspection)
            ?? verifyRecoveredContainer(state, container, durableFingerprint);
        if (mismatch) {
            await this.appendControl(controlFence, controlExecutionIdentity(state), { type: 'reconciliation', outcome: 'blocked', reason: mismatch });
            return { outcome: 'blocked', reason: mismatch, state };
        }

        const recovery = await this.claimRecoveryAttempt(state, controllerEpoch);
        state = recovery.state;
        const result = await this.adapter.reconcile({
            ...identity,
            ...recovery.execution,
            controllerEpoch,
            persisted: persistedSnapshot(state),
            container,
            repository: repositoryInspection,
        });
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
        await this.appendControl(controlFence, recovery.execution, { type: 'reconciliation', outcome: result.outcome, reason: result.reason });
        return { ...result, state: saved };
    }

    private async claimRecoveryAttempt(
        state: GoalSessionState,
        controllerEpoch: number,
    ): Promise<{ state: GoalSessionState; execution: { executionId: string; attemptId: string } }> {
        const previousAttempt = state.activeTurn?.attemptId
            ?? state.recoveryAttemptId
            ?? state.providerOpenAttemptId;
        const attemptId = previousAttempt
            ? this.mintFreshAttemptId(previousAttempt)
            : this.mintAttemptId();
        const execution = {
            executionId: state.activeTurn?.executionId ?? `reconcile-${state.sessionId}`,
            attemptId,
        };
        const saved = await this.compareAndSetExact(state, {
            recoveryAttemptId: attemptId,
            activeTurn: state.activeTurn ? {
                ...state.activeTurn,
                ...execution,
                executionEpoch: controllerEpoch,
            } : state.activeTurn,
        }, 'A newer operation superseded crash reconciliation');
        return { state: saved, execution };
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
            const crashedTurn = state.activeTurn;
            return this.updateControlledState(request, value => ({
                ...value,
                status: 'idle',
                retryTurn: value.activeTurn ? {
                    turnId: value.activeTurn.turnId,
                    executionId: value.activeTurn.executionId,
                    crashedAttemptId: value.activeTurn.attemptId,
                } : undefined,
                activeTurn: undefined,
                completedTurnIds: value.completedTurnIds.filter(turnId => turnId !== crashedTurn.turnId),
                completedTurns: value.completedTurns?.filter(turn => turn.turnId !== crashedTurn.turnId),
                initializationIntent: value.initializationIntent ? {
                    ...value.initializationIntent,
                    attemptId: this.mintFreshAttemptId(value.initializationIntent.attemptId),
                    recordedAt: nowIso(),
                } : value.initializationIntent,
                failureReason: undefined,
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
        recovery: boolean,
    ): Promise<GoalSessionState> {
        if (state.initializationIntent && !recovery) return state;
        const attemptId = state.initializationIntent
            ? this.mintFreshAttemptId(state.initializationIntent.attemptId)
            : this.mintAttemptId();
        return this.compareAndSetExact(state, {
            initializationIntent: {
                attemptId,
                deterministicOpenKey: state.initializationIntent?.deterministicOpenKey ?? deterministicOpenKey(request),
                recordedAt: nowIso(),
            },
            providerOpenAttemptId: attemptId,
        });
    }

    private recordProviderOpenAttempt(state: GoalSessionState): Promise<GoalSessionState> {
        const attemptId = state.providerOpenAttemptId
            ? this.mintFreshAttemptId(state.providerOpenAttemptId)
            : this.mintAttemptId();
        return this.compareAndSetExact(state, { providerOpenAttemptId: attemptId });
    }

    private async loadOrCreateForOpen(request: OpenGoalSessionRequest): Promise<{ state: GoalSessionState; created: boolean }> {
        let state = await this.ports.state.load(request);
        let created = false;
        if (!state) {
            const timestamp = nowIso();
            const initializationIntent = this.adapter.capabilities.nativeSessionId === 'first_turn'
                ? createInitializationIntent(request, this.mintAttemptId())
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
            if (!state.providerOpenAttemptId) {
                throw new GoalSessionContractError('Provider open attempt was not durably claimed', 'OPEN_ATTEMPT_MISSING');
            }
            const snapshot = await this.adapter.openSession({
                ...request,
                persisted,
                deterministicOpenKey,
                attemptId: state.providerOpenAttemptId,
            });
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
    attemptId: string,
): NonNullable<GoalSessionState['initializationIntent']> {
    return {
        attemptId,
        deterministicOpenKey: deterministicOpenKey(identity),
        recordedAt: nowIso(),
    };
}

function verifyRecoveredContainer(
    state: GoalSessionState,
    inspection: GoalContainerInspection,
    worktreeFingerprint: string,
): string | null {
    if (inspection.status === 'missing') return null;
    if (inspection.status === 'daemon_unavailable') {
        return `Container identity could not be inspected: ${inspection.reason ?? 'Docker unavailable'}`;
    }
    const turn = state.activeTurn;
    if (!turn) return 'A recovered container exists without an authoritative active turn';
    const observed = inspection.recoveryIdentity;
    if (!observed) return 'Recovered container is missing authoritative recovery metadata';
    const expected = {
        goalId: state.goalId,
        sessionId: state.sessionId,
        executionEpoch: turn.executionEpoch,
        turnId: turn.turnId,
        attemptId: turn.attemptId,
        worktreeFingerprint,
    };
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
        if (observed[key] !== expected[key]) {
            return `Recovered container ${key} mismatch: expected ${expected[key]}, found ${observed[key]}`;
        }
    }
    return null;
}

/**
 * Reconciles the recovered session status and its active turn into a coherent
 * state. A turn that was still running/pause-requested/paused when the container
 * was lost becomes an explicitly paused, resumable turn so a replacement
 * supervisor continues the exact logical execution rather than letting a new
 * turn overwrite it. The later provider resume durably replaces the crashed
 * attempt ID with a fresh one. A failed reconcile fails the session; any other
 * outcome leaves the durable turn untouched.
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
    const expectedFingerprint = fingerprintGoalWorktree(expected);
    if (!inspection.observedWorktreeFingerprint) {
        return `Worktree ${expected.worktreePath} fingerprint could not be observed: ${inspection.reason ?? 'metadata unavailable'}`;
    }
    if (inspection.observedWorktreeFingerprint !== expectedFingerprint) {
        return `Worktree fingerprint mismatch: expected ${expectedFingerprint}, found ${inspection.observedWorktreeFingerprint}`;
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
