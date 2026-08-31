import type {
    GoalContainerInspection,
    GoalExecutionIdentity,
    GoalRepositoryIdentity,
    GoalRepositoryInspection,
    GoalSessionControlFence,
    GoalSessionIdentity,
    GoalSessionState,
} from './contract.js';
import { StaleGoalSessionFenceError } from './errors.js';
import { GoalSessionControls } from './GoalSessionControls.js';
import { hasUnresolvedImmediateModelIntent } from './modelChangeProtocol.js';
import { trackProviderOperation, waitForProviderOperations } from './providerOperationCoordinator.js';
import { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
import { reconcileRecoveredTurn } from './reconcileRecoveredTurn.js';
import { verifyReconciliationTarget, verifyRecoveredContainer } from './reconciliationIdentity.js';
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

export type ReconcileGoalSessionResult = {
    outcome: 'alive' | 'resumed' | 'failed' | 'blocked';
    reason: string;
    state: GoalSessionState;
};

type PreparedRecovery = {
    state: GoalSessionState;
    fence: GoalSessionControlFence;
    container: GoalContainerInspection;
    repository: GoalRepositoryInspection;
};

/** Ownership takeover and cancellation-aware provider recovery operations. */
export abstract class GoalSessionRecoveryControls extends GoalSessionControls {
    async takeover(identity: GoalSessionIdentity, controllerEpoch: number): Promise<GoalSessionState> {
        validateIdentity(identity);
        validateEpoch(controllerEpoch);
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const state = await this.requireState(identity);
            if (controllerEpoch <= state.controllerEpoch) {
                if (controllerEpoch === state.controllerEpoch) return state;
                throw new StaleGoalSessionFenceError();
            }
            const saved = await this.ports.state.compareAndSet(state, nextState(state, { controllerEpoch }));
            if (saved) return saved;
        }
        throw new StaleGoalSessionFenceError('Another controller repeatedly changed the session during takeover');
    }

    async reconcile(
        identity: GoalSessionIdentity,
        controllerEpoch: number,
        repository: GoalRepositoryIdentity,
    ): Promise<ReconcileGoalSessionResult> {
        const prepared = await this.prepareRecovery(identity, controllerEpoch, repository);
        if ('outcome' in prepared) return prepared;
        await waitForProviderOperations(this.ports.state, identity, 'reconcile');
        let state = await this.requireControlledState(prepared.fence);
        const recovery = await this.claimRecoveryAttempt(state, controllerEpoch);
        try {
            state = await this.promoteRecoveryAttempt(recovery.state, recovery.execution, controllerEpoch);
        } catch (error) {
            return this.handleRecoveryPromotionLoss(error, identity, prepared.fence);
        }
        const result = await trackProviderOperation(
            this.ports.state,
            identity,
            'reconcile',
            () => this.adapter.reconcile({
                ...identity,
                ...recovery.execution,
                controllerEpoch,
                persisted: persistedSnapshot(state),
                container: prepared.container,
                repository: prepared.repository,
            }),
        );
        return this.persistRecoveryResult(prepared.fence, state, recovery.execution, result);
    }

    private async prepareRecovery(
        identity: GoalSessionIdentity,
        controllerEpoch: number,
        repository: GoalRepositoryIdentity,
    ): Promise<PreparedRecovery | ReconcileGoalSessionResult> {
        let state = await this.requireState(identity);
        if (controllerEpoch < state.controllerEpoch) throw new StaleGoalSessionFenceError();
        if (controllerEpoch > state.controllerEpoch) state = await this.takeover(identity, controllerEpoch);
        const fence = { ...identity, controllerEpoch };
        const guarded = await this.guardReconciliationState(state, fence);
        if (guarded) return guarded;
        const durableRepository = state.activeTurn?.repository ?? repository;
        const requestedFingerprint = fingerprintGoalWorktree(repository);
        const durableFingerprint = fingerprintGoalWorktree(durableRepository);
        if (requestedFingerprint !== durableFingerprint) {
            return this.blockRecovery(fence, state,
                'Requested worktree does not match the active turn\'s authoritative repository identity');
        }
        const [container, repositoryInspection] = await Promise.all([
            this.ports.recovery.inspectContainer(identity),
            this.ports.recovery.inspectRepository(durableRepository),
        ]);
        const mismatch = verifyReconciliationTarget(durableRepository, repositoryInspection)
            ?? verifyRecoveredContainer(state, container, durableFingerprint);
        if (mismatch) return this.blockRecovery(fence, state, mismatch);
        return { state, fence, container, repository: repositoryInspection };
    }

    private async blockRecovery(
        fence: GoalSessionControlFence,
        state: GoalSessionState,
        reason: string,
    ): Promise<ReconcileGoalSessionResult> {
        await this.appendControl(fence, controlExecutionIdentity(state), {
            type: 'reconciliation', outcome: 'blocked', reason,
        });
        return { outcome: 'blocked', reason, state };
    }

    private async handleRecoveryPromotionLoss(
        error: unknown,
        identity: GoalSessionIdentity,
        fence: GoalSessionControlFence,
    ): Promise<ReconcileGoalSessionResult> {
        if (!(error instanceof StaleGoalSessionFenceError)) throw error;
        const state = await this.requireState(identity);
        const cancelled = await this.guardReconciliationState(state, fence);
        if (cancelled) return cancelled;
        throw error;
    }

    private async persistRecoveryResult(
        fence: GoalSessionControlFence,
        state: GoalSessionState,
        execution: GoalExecutionIdentity,
        result: Awaited<ReturnType<typeof this.adapter.reconcile>>,
    ): Promise<ReconcileGoalSessionResult> {
        const snapshot = 'snapshot' in result ? result.snapshot : undefined;
        if (snapshot) {
            assertProviderIdentity(state, snapshot);
            assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata);
        }
        const reconciled = reconcileRecoveredTurn(state, execution, result.outcome);
        const preserveIntentModel = this.adapter.capabilities.modelChange === 'next_safe_boundary'
            && hasUnresolvedImmediateModelIntent(state);
        const saved = await this.ports.state.compareAndSet(state, nextState(state, {
            status: reconciled.status,
            activeTurn: reconciled.activeTurn,
            recoveryAttempt: undefined,
            failureReason: result.outcome === 'failed' ? result.reason : undefined,
            providerSessionId: snapshot?.providerSessionId ?? state.providerSessionId,
            recoveryMetadata: snapshot?.recoveryMetadata ?? state.recoveryMetadata,
            currentModel: preserveIntentModel ? state.currentModel : snapshot?.model ?? state.currentModel,
        }));
        if (!saved) throw new StaleGoalSessionFenceError('Ownership changed during crash reconciliation');
        await this.appendControl(fence, execution, { type: 'reconciliation', outcome: result.outcome, reason: result.reason });
        const recovered = await this.resumeImmediateModelChangeIntent(fence, saved);
        return { ...result, state: recovered };
    }

    private async guardReconciliationState(
        state: GoalSessionState,
        fence: GoalSessionControlFence,
    ): Promise<ReconcileGoalSessionResult | null> {
        if (state.status === 'terminated' || state.status === 'failed') {
            return { outcome: 'blocked', reason: `A ${state.status} session cannot be reconciled`, state };
        }
        if (state.status !== 'cancelling') return null;
        const cancelled = state.cancellationIntent
            ? await this.resumeClaimedCancellation(fence, state)
            : await this.cancel({
                ...fence,
                reason: state.failureReason ?? 'Resume pending cancellation during reconciliation',
            });
        return {
            outcome: 'blocked',
            reason: 'Cancellation recovery completed without reconciling provider work',
            state: cancelled,
        };
    }

    private async claimRecoveryAttempt(
        state: GoalSessionState,
        controllerEpoch: number,
    ): Promise<{ state: GoalSessionState; execution: GoalExecutionIdentity }> {
        const previousAttempt = state.recoveryAttempt?.attemptId
            ?? state.recoveryAttemptId
            ?? state.activeTurn?.attemptId
            ?? state.providerOpenAttemptId;
        const attemptId = previousAttempt ? this.mintFreshAttemptId(previousAttempt) : this.mintAttemptId();
        const execution = {
            executionId: state.activeTurn?.executionId ?? `reconcile-${state.sessionId}`,
            attemptId,
        };
        const saved = await this.compareAndSetExact(state, {
            recoveryAttemptId: attemptId,
            recoveryAttempt: {
                ...execution,
                controllerEpoch,
                authoritativeAttemptId: state.activeTurn?.attemptId,
                claimedAt: nowIso(),
                phase: 'claimed',
            },
        }, 'A newer operation superseded crash reconciliation');
        return { state: saved, execution };
    }

    private promoteRecoveryAttempt(
        state: GoalSessionState,
        execution: GoalExecutionIdentity,
        controllerEpoch: number,
    ): Promise<GoalSessionState> {
        if (state.recoveryAttempt?.attemptId !== execution.attemptId
            || state.recoveryAttempt.executionId !== execution.executionId
            || state.recoveryAttempt.controllerEpoch !== controllerEpoch
            || state.recoveryAttempt.phase === 'provider_in_doubt') {
            throw new StaleGoalSessionFenceError('Reconciliation no longer owns its provider-call lease');
        }
        return this.compareAndSetExact(state, {
            recoveryAttempt: { ...state.recoveryAttempt, phase: 'provider_in_doubt' },
        }, 'Cancellation fenced reconciliation before its provider call');
    }
}
