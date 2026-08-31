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
import { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
import { isRecoverableStatus, RECOVERY_LEASE_MS, sameRecoverySubject, stoppedReconciliationResult } from './recoveryOperationProtocol.js';
import { reconcileRecoveredTurn } from './reconcileRecoveredTurn.js';
import { sanitizeRepositoryInspection, verifyReconciliationTarget, verifyRecoveredContainer } from './reconciliationIdentity.js';
import { normalizeRecoveryRepositories } from './repositorySecurity.js';
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
        const committed = await this.committedRecoveryResult(identity, controllerEpoch);
        if (committed) return committed;
        let prepared: PreparedRecovery | ReconcileGoalSessionResult;
        try {
            prepared = await this.prepareRecovery(identity, controllerEpoch, repository);
        } catch (error) {
            if (error instanceof RecoveryGuardResult) return error.result;
            throw error;
        }
        if ('outcome' in prepared) return prepared;
        let state: GoalSessionState;
        try {
            state = await this.revalidatePreparedRecovery(prepared);
        } catch (error) {
            if (error instanceof RecoveryGuardResult) return error.result;
            throw error;
        }
        const recovery = await this.claimRecoveryAttempt(state, controllerEpoch);
        if (!recovery) {
            return {
                outcome: 'blocked',
                reason: 'Another process owns the durable reconciliation lease',
                state: await this.requireControlledState(prepared.fence),
            };
        }
        try {
            state = await this.promoteRecoveryAttempt(recovery.state, recovery.execution, controllerEpoch);
        } catch (error) {
            return this.handleRecoveryPromotionLoss(error, identity, prepared.fence);
        }
        // This durable reload closes the promotion-to-provider-call gap. A
        // cancellation that preempts the token before this await resolves makes
        // the call impossible; a cancellation after it resolves treats the call
        // as genuinely started and progresses through the provider cancel API.
        state = await this.requireLiveRecoveryLease(prepared.fence, recovery.execution, state.recoveryAttempt!.operationToken);
        let result: Awaited<ReturnType<typeof this.adapter.reconcile>>;
        try {
            result = await this.adapter.reconcile({
                ...identity,
                ...recovery.execution,
                controllerEpoch,
                operationToken: state.recoveryAttempt!.operationToken,
                persisted: persistedSnapshot(state),
                container: prepared.container,
                repository: prepared.repository,
            });
        } catch (error) {
            await this.requireLiveRecoveryLease(
                prepared.fence, recovery.execution, state.recoveryAttempt!.operationToken,
            );
            await this.expireRecoveryLeaseIfOwned(prepared.fence, state.recoveryAttempt!.operationToken);
            throw error;
        }
        state = await this.requireLiveRecoveryLease(
            prepared.fence, recovery.execution, state.recoveryAttempt!.operationToken,
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
        // guardReconciliationState is asynchronous for cancellation recovery.
        // Reload once after that gap and synchronously reject every non-live
        // state before opening either inspection primitive.
        state = await this.requireControlledState(fence);
        const stopped = stoppedReconciliationResult(state);
        if (stopped) {
            if (state.status !== 'cancelling') return stopped;
            return (await this.guardReconciliationState(state, fence))!;
        }
        const repositories = normalizeRecoveryRepositories(state, repository);
        if (!repositories) return this.blockRecovery(fence, state,
            'Recovery repository does not contain a trustworthy credential-free identity');
        const { requested: requestedRepository, durable: durableRepository } = repositories;
        if (state.activeTurn && state.activeTurn.repository.repository !== durableRepository.repository) {
            state = await this.compareAndSetExact(state, { activeTurn: { ...state.activeTurn, repository: durableRepository } },
                'A newer operation superseded repository credential scrubbing');
        }
        const durableFingerprint = fingerprintGoalWorktree(durableRepository);
        if (fingerprintGoalWorktree(requestedRepository) !== durableFingerprint) return this.blockRecovery(fence, state,
            'Requested worktree does not match the active turn\'s authoritative repository identity');
        const container = await this.ports.recovery.inspectContainer(identity);
        state = await this.revalidateInspectionState(state, fence);
        const rawRepositoryInspection = await this.ports.recovery.inspectRepository(durableRepository);
        state = await this.revalidateInspectionState(state, fence);
        const repositoryInspection = sanitizeRepositoryInspection(durableRepository, rawRepositoryInspection);
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
        try {
            const saved = await this.commitControlTransition({
                state,
                fence,
                changes: {},
                auditEvents: [{ type: 'reconciliation', outcome: 'blocked', reason }],
                transitionId: `${this.controlOperationId('recovery-blocked', state)}:${reason}`,
                execution: controlExecutionIdentity(state),
            });
            return { outcome: 'blocked', reason, state: saved };
        } catch (error) {
            if (!(error instanceof StaleGoalSessionFenceError)) throw error;
            const current = await this.requireState(fence);
            const guarded = await this.guardReconciliationState(current, fence);
            if (guarded) return guarded;
            throw error;
        }
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
        let saved: GoalSessionState;
        try {
            saved = await this.commitControlTransition({
                state,
                fence,
                changes: {
                    status: reconciled.status,
                    activeTurn: reconciled.activeTurn,
                    recoveryAttempt: undefined,
                    completedRecovery: {
                        operationToken: state.recoveryAttempt!.operationToken,
                        controllerEpoch: fence.controllerEpoch,
                        outcome: result.outcome,
                        reason: result.reason,
                    },
                    failureReason: result.outcome === 'failed' ? result.reason : undefined,
                    providerSessionId: snapshot?.providerSessionId ?? state.providerSessionId,
                    recoveryMetadata: snapshot?.recoveryMetadata ?? state.recoveryMetadata,
                    currentModel: preserveIntentModel ? state.currentModel : snapshot?.model ?? state.currentModel,
                },
                auditEvents: [{ type: 'reconciliation', outcome: result.outcome, reason: result.reason }],
                transitionId: `recovery-result:${state.recoveryAttempt!.operationToken}`,
                execution,
            });
        } catch (error) {
            await this.expireRecoveryLeaseIfOwned(fence, state.recoveryAttempt!.operationToken);
            throw error;
        }
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
        if (state.status !== 'cancelling') {
            if (isRecoverableStatus(state.status)) return null;
            return { outcome: 'blocked', reason: `A ${state.status} session cannot be reconciled`, state };
        }
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
    ): Promise<{ state: GoalSessionState; execution: GoalExecutionIdentity } | null> {
        this.assertRecoverableExactState(state, controllerEpoch);
        if (Date.parse(state.recoveryAttempt?.leaseExpiresAt ?? '') > Date.now()) return null;
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
            completedRecovery: undefined,
            recoveryAttempt: {
                operationToken: this.controlOperationId('recovery-provider', state),
                ...execution,
                controllerEpoch,
                authoritativeAttemptId: state.activeTurn?.attemptId,
                authoritativeExecutionId: state.activeTurn?.executionId,
                sessionStatus: state.status,
                authoritativeTurnStatus: state.activeTurn?.status,
                claimedAt: nowIso(),
                leaseExpiresAt: new Date(Date.now() + RECOVERY_LEASE_MS).toISOString(),
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
        this.assertRecoverableExactState(state, controllerEpoch);
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

    private async revalidatePreparedRecovery(prepared: PreparedRecovery): Promise<GoalSessionState> {
        return this.revalidateInspectionState(prepared.state, prepared.fence);
    }

    private async committedRecoveryResult(
        identity: GoalSessionIdentity,
        controllerEpoch: number,
    ): Promise<ReconcileGoalSessionResult | null> {
        const state = await this.requireState(identity);
        const recovery = state.completedRecovery;
        if (state.controllerEpoch !== controllerEpoch || recovery?.controllerEpoch !== controllerEpoch
            || state.status === 'cancelling' || state.status === 'terminated') {
            return null;
        }
        return {
            outcome: recovery.outcome,
            reason: recovery.reason,
            state,
        };
    }

    private async expireRecoveryLeaseIfOwned(
        fence: GoalSessionControlFence,
        operationToken: string,
    ): Promise<void> {
        try {
            const state = await this.requireControlledState(fence);
            if (state.recoveryAttempt?.operationToken !== operationToken) return;
            await this.ports.state.compareAndSet(state, nextState(state, {
                recoveryAttempt: {
                    ...state.recoveryAttempt,
                    leaseExpiresAt: new Date(0).toISOString(),
                },
            }));
        } catch (error) {
            if (!(error instanceof StaleGoalSessionFenceError)) throw error;
        }
    }

    private async revalidateInspectionState(
        expected: GoalSessionState,
        fence: GoalSessionControlFence,
    ): Promise<GoalSessionState> {
        const current = await this.requireControlledState(fence);
        const guarded = await this.guardReconciliationState(current, fence);
        if (guarded) throw new RecoveryGuardResult(guarded);
        const revalidated = await this.requireControlledState(fence);
        const stopped = stoppedReconciliationResult(revalidated);
        if (stopped) {
            if (revalidated.status === 'cancelling') {
                const cancelled = await this.guardReconciliationState(revalidated, fence);
                throw new RecoveryGuardResult(cancelled!);
            }
            throw new RecoveryGuardResult(stopped);
        }
        if (!sameRecoverySubject(expected, revalidated)) {
            throw new StaleGoalSessionFenceError('Recovery subject changed during durable inspection');
        }
        return revalidated;
    }

    private async requireLiveRecoveryLease(
        fence: GoalSessionControlFence,
        execution: GoalExecutionIdentity,
        operationToken: string,
    ): Promise<GoalSessionState> {
        const state = await this.requireControlledState(fence);
        this.assertRecoverableExactState(state, fence.controllerEpoch);
        const recovery = state.recoveryAttempt;
        if (!recovery || recovery.operationToken !== operationToken
            || recovery.executionId !== execution.executionId
            || recovery.attemptId !== execution.attemptId
            || recovery.phase !== 'provider_in_doubt') {
            throw new StaleGoalSessionFenceError('Reconciliation provider operation was durably preempted');
        }
        return state;
    }

    private assertRecoverableExactState(state: GoalSessionState, controllerEpoch: number): void {
        if (state.controllerEpoch !== controllerEpoch || !isRecoverableStatus(state.status)) {
            throw new StaleGoalSessionFenceError('Session is no longer in an exact recoverable live state');
        }
        const recovery = state.recoveryAttempt;
        if (recovery?.authoritativeAttemptId !== undefined
            && recovery.authoritativeAttemptId !== state.activeTurn?.attemptId) {
            throw new StaleGoalSessionFenceError('The authoritative recovery attempt changed');
        }
        if (recovery?.authoritativeExecutionId !== undefined
            && recovery.authoritativeExecutionId !== state.activeTurn?.executionId) {
            throw new StaleGoalSessionFenceError('The authoritative recovery execution changed');
        }
        if (recovery?.sessionStatus !== undefined && recovery.sessionStatus !== state.status) {
            throw new StaleGoalSessionFenceError('The authoritative recovery status changed');
        }
        if (recovery?.authoritativeTurnStatus !== undefined
            && recovery.authoritativeTurnStatus !== state.activeTurn?.status) {
            throw new StaleGoalSessionFenceError('The authoritative recovery turn status changed');
        }
    }
}

class RecoveryGuardResult extends Error {
    constructor(readonly result: ReconcileGoalSessionResult) { super(result.reason); }
}
