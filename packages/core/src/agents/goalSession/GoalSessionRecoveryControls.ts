import type {
    GoalContainerInspection, GoalExecutionIdentity, GoalRepositoryIdentity, GoalRepositoryInspection,
    GoalSessionControlFence, GoalSessionIdentity, GoalSessionState,
} from './contract.js';
import { StaleGoalSessionFenceError } from './errors.js';
import { GoalSessionControls } from './GoalSessionControls.js';
import { hasUnresolvedImmediateModelIntent, latestImmediateModelIntent, prepareModelEvidenceForRecoveredAttempt } from './modelChangeProtocol.js';
import { assertCredentialFreeRecoveryMetadata, sanitizeRecoveryMetadata, scrubDurableRecoveryMetadata } from './recoveryMetadata.js';
import {
    assertLiveRecoveryLease, assertRecoverableExactState, completedRecoveryResult,
    isRecoverableStatus, RECOVERY_LEASE_MS, stoppedReconciliationResult,
} from './recoveryOperationProtocol.js';
import { reconcileRecoveredTurn } from './reconcileRecoveredTurn.js';
import { sanitizeContainerInspection, sanitizeRepositoryInspection, verifyReconciliationTarget, verifyRecoveredContainer } from './reconciliationIdentity.js';
import { normalizeRecoveryRepositories } from './repositorySecurity.js';
import {
    assertProviderIdentity, controlExecutionIdentity, nextState, nowIso,
    persistedSnapshot, validateEpoch, validateIdentity,
} from './support.js';
import { fingerprintGoalWorktree } from './worktreeIdentity.js';
import { safeFailureDiagnostic } from './securityBoundary.js';
import { expireRecoveryLease } from './providerBarrierProtocol.js';
import { rebuildReconcileResult } from './providerResultBoundary.js';
import { RecoveryGuardResult, revalidateRecoveryInspection } from './recoveryRevalidation.js';

export type ReconcileGoalSessionResult = {
    outcome: 'alive' | 'resumed' | 'failed' | 'blocked';
    reason: string;
    state: GoalSessionState;
};

type PreparedRecovery = { state: GoalSessionState; fence: GoalSessionControlFence; container: GoalContainerInspection; repository: GoalRepositoryInspection };

/** Ownership takeover and cancellation-aware provider recovery operations. */
export abstract class GoalSessionRecoveryControls extends GoalSessionControls {
    async takeover(identity: GoalSessionIdentity, controllerEpoch: number): Promise<GoalSessionState> {
        validateIdentity(identity);
        validateEpoch(controllerEpoch);
        for (let attempt = 0; attempt < 4; attempt += 1) {
            let state = await this.requireState(identity);
            if (controllerEpoch <= state.controllerEpoch) {
                if (controllerEpoch === state.controllerEpoch) return state;
                throw new StaleGoalSessionFenceError();
            }
            const oldFence = { ...identity, controllerEpoch: state.controllerEpoch };
            if (state.status === 'cancelling') {
                return state.cancellationIntent
                    ? this.resumeClaimedCancellation(oldFence, state)
                    : this.cancel({
                        ...oldFence,
                        reason: state.failureReason ?? 'Settle cancellation before controller replacement',
                    });
            }
            if (state.status === 'terminated' || state.status === 'failed') {
                if (state.providerBarrierIntent?.phase === 'pending') {
                    return this.repairPendingProviderBarrier(oldFence, state);
                }
                return state;
            }
            state = await this.repairPendingProviderBarrier(oldFence, state);
            if (state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') continue;
            const generation = (state.providerOperationGeneration ?? 0) + 1;
            const operationId = `replacement-e${controllerEpoch}-g${generation}`;
            const staged = await this.ports.state.compareAndSet(state, nextState(state, {
                // Ownership changes in the same durable claim as invalidation.
                // Old-controller appends are fenced even if publication hangs.
                controllerEpoch,
                providerOperationGeneration: generation,
                providerBarrierIntent: {
                    generation, operationId, kind: 'replacement', phase: 'pending', claimedAt: nowIso(),
                },
            }));
            if (!staged) continue;
            await this.publishProviderOperationBarrier(staged, generation);
            const current = await this.requireControlledStateForBarrier({ ...identity, controllerEpoch });
            if (current.providerBarrierIntent?.operationId !== operationId) continue;
            const saved = await this.ports.state.compareAndSet(current, nextState(current, {
                providerBarrierIntent: { ...current.providerBarrierIntent, phase: 'published' },
            }));
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
            const operation = state.recoveryAttempt!;
            await this.publishProviderOperationBarrier(prepared.fence, operation.operationGeneration);
            await this.requireProviderGeneration(prepared.fence, operation.operationGeneration);
            const operationFence = this.providerOperationFence(
                prepared.fence, operation.operationGeneration, {
                    kind: 'reconcile', operationId: operation.operationToken,
                    leaseExpiresAt: operation.leaseExpiresAt,
                    executionId: recovery.execution.executionId, attemptId: recovery.execution.attemptId,
                },
            );
            result = await this.providerResult(() => this.providerFirstEffect(operationFence, () => this.startedProviderEffect(this.adapter.reconcile({
                goalId: identity.goalId,
                sessionId: identity.sessionId,
                ...recovery.execution,
                controllerEpoch,
                operationToken: state.recoveryAttempt!.operationToken,
                operationGeneration: state.recoveryAttempt!.operationGeneration,
                operationPhase: 'provider_in_doubt',
                operationLeaseExpiresAt: state.recoveryAttempt!.leaseExpiresAt,
                operationFence,
                persisted: persistedSnapshot(state),
                container: prepared.container,
                repository: prepared.repository,
            }))), value => rebuildReconcileResult(value, this.adapter.provider));
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

    private async prepareRecovery(identity: GoalSessionIdentity, controllerEpoch: number, repository: GoalRepositoryIdentity):
    Promise<PreparedRecovery | ReconcileGoalSessionResult> {
        let state = await this.requireState(identity);
        if (controllerEpoch < state.controllerEpoch) throw new StaleGoalSessionFenceError();
        if (state.status === 'cancelling') {
            const oldFence = { ...identity, controllerEpoch: state.controllerEpoch };
            const cancelled = state.cancellationIntent
                ? await this.resumeClaimedCancellation(oldFence, state)
                : await this.cancel({ ...oldFence, reason: state.failureReason ?? 'Resume cancellation before recovery takeover' });
            return {
                outcome: 'blocked', reason: 'Cancellation completed before reconciliation takeover', state: cancelled,
            };
        }
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
        const repositories = await normalizeRecoveryRepositories(state, repository);
        if (!repositories) return this.blockRecovery(fence, state,
            'Recovery repository does not contain a trustworthy credential-free identity');
        const { requested: requestedRepository, durable: durableRepository } = repositories;
        const scrubbedMetadata = state.recoveryMetadata === undefined
            ? undefined : scrubDurableRecoveryMetadata(state.recoveryMetadata, this.adapter.provider);
        const repositoryNeedsScrub = Boolean(state.activeTurn
            && JSON.stringify(state.activeTurn.repository) !== JSON.stringify(durableRepository));
        const metadataNeedsScrub = JSON.stringify(state.recoveryMetadata) !== JSON.stringify(scrubbedMetadata);
        if (repositoryNeedsScrub || metadataNeedsScrub) {
            state = await this.compareAndSetExact(state, {
                activeTurn: repositoryNeedsScrub
                    ? { ...state.activeTurn!, repository: durableRepository } : state.activeTurn,
                recoveryMetadata: scrubbedMetadata,
            }, 'A newer operation superseded durable security scrubbing');
        }
        const durableFingerprint = fingerprintGoalWorktree(durableRepository);
        if (fingerprintGoalWorktree(requestedRepository) !== durableFingerprint) return this.blockRecovery(fence, state,
            'Requested worktree does not match the active turn\'s authoritative repository identity');
        const container = sanitizeContainerInspection(await this.ports.recovery.inspectContainer({
            goalId: identity.goalId, sessionId: identity.sessionId,
        }));
        state = await this.revalidateInspectionState(state, fence);
        const rawRepositoryInspection = await this.ports.recovery.inspectRepository(durableRepository);
        state = await this.revalidateInspectionState(state, fence);
        const repositoryInspection = sanitizeRepositoryInspection(durableRepository, rawRepositoryInspection);
        const mismatch = verifyReconciliationTarget(durableRepository, repositoryInspection)
            ?? verifyRecoveredContainer(state, container, durableFingerprint);
        if (mismatch) return this.blockRecovery(fence, state, mismatch);
        return { state, fence, container, repository: repositoryInspection };
    }

    private async blockRecovery(fence: GoalSessionControlFence, state: GoalSessionState, reason: string):
    Promise<ReconcileGoalSessionResult> {
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

    private async handleRecoveryPromotionLoss(error: unknown, identity: GoalSessionIdentity, fence: GoalSessionControlFence):
    Promise<ReconcileGoalSessionResult> {
        if (!(error instanceof StaleGoalSessionFenceError)) throw error;
        const state = await this.requireState(identity);
        const cancelled = await this.guardReconciliationState(state, fence);
        if (cancelled) return cancelled;
        throw error;
    }

    private async persistRecoveryResult(fence: GoalSessionControlFence, state: GoalSessionState,
        execution: GoalExecutionIdentity, result: Awaited<ReturnType<typeof this.adapter.reconcile>>):
    Promise<ReconcileGoalSessionResult> {
        const snapshot = 'snapshot' in result ? result.snapshot : undefined;
        const reason = safeFailureDiagnostic(result.reason, 'Provider reconciliation completed safely');
        if (snapshot) {
            assertProviderIdentity(state, snapshot);
            assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata, this.adapter.provider);
        }
        const reconciled = reconcileRecoveredTurn(state, execution, result.outcome);
        if (result.outcome === 'failed') {
            const saved = await this.ports.terminal.commit(state, nextState(state, {
                status: 'failed', activeTurn: undefined, recoveryAttempt: undefined,
                resumeIntent: undefined, completedResume: undefined,
                completedRecovery: {
                    operationToken: state.recoveryAttempt!.operationToken,
                    controllerEpoch: fence.controllerEpoch, outcome: 'failed', reason,
                },
                failureReason: reason, initializationIntent: undefined, retryTurn: undefined,
                pendingAfterTurnPause: undefined, pendingModelChange: undefined,
                modelChangeIntent: undefined, modelChangeIntents: undefined,
                providerOperationGeneration: (state.providerOperationGeneration ?? 0) + 1,
            }), {
                scope: 'control', fence, execution,
                auditEvents: [{ type: 'reconciliation', outcome: 'failed', reason }],
                event: { type: 'completion', outcome: 'failed', error: reason },
            });
            if (!saved) throw new StaleGoalSessionFenceError('A newer operation superseded failed reconciliation');
            return { outcome: 'failed', reason, state: saved };
        }
        const preserveIntentModel = this.adapter.capabilities.modelChange === 'next_safe_boundary'
            ? hasUnresolvedImmediateModelIntent(state)
            : latestImmediateModelIntent(state)?.invocationEvidence !== undefined;
        const recoveredModelEvidence = result.outcome === 'resumed' ? prepareModelEvidenceForRecoveredAttempt(state, execution) : {};
        let saved: GoalSessionState;
        try {
            saved = await this.commitControlTransition({
                state,
                fence,
                changes: {
                    status: reconciled.status,
                    activeTurn: reconciled.activeTurn,
                    ...recoveredModelEvidence,
                    recoveryAttempt: undefined,
                    completedRecovery: {
                        operationToken: state.recoveryAttempt!.operationToken,
                        controllerEpoch: fence.controllerEpoch,
                        outcome: result.outcome,
                        reason,
                    },
                    failureReason: undefined,
                    providerSessionId: snapshot?.providerSessionId ?? state.providerSessionId,
                    recoveryMetadata: snapshot
                        ? sanitizeRecoveryMetadata(snapshot.recoveryMetadata, this.adapter.provider)
                        : state.recoveryMetadata === undefined
                            ? undefined : sanitizeRecoveryMetadata(state.recoveryMetadata, this.adapter.provider),
                    currentModel: preserveIntentModel ? state.currentModel : snapshot?.model ?? state.currentModel,
                },
                auditEvents: [{ type: 'reconciliation', outcome: result.outcome, reason }],
                transitionId: `recovery-result:${state.recoveryAttempt!.operationToken}`,
                execution,
            });
        } catch (error) {
            await this.expireRecoveryLeaseIfOwned(fence, state.recoveryAttempt!.operationToken);
            throw error;
        }
        const recovered = await this.resumeImmediateModelChangeIntent(fence, saved);
        return { outcome: result.outcome, reason, state: recovered };
    }

    private async guardReconciliationState(state: GoalSessionState, fence: GoalSessionControlFence):
    Promise<ReconcileGoalSessionResult | null> {
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

    private async claimRecoveryAttempt(state: GoalSessionState, controllerEpoch: number):
    Promise<{ state: GoalSessionState; execution: GoalExecutionIdentity } | null> {
        assertRecoverableExactState(state, controllerEpoch);
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
        const operationGeneration = (state.providerOperationGeneration ?? 0) + 1;
        const saved = await this.compareAndSetExact(state, {
            providerOperationGeneration: operationGeneration,
            recoveryAttemptId: attemptId,
            completedRecovery: undefined,
            recoveryAttempt: {
                operationToken: this.controlOperationId('recovery-provider', state),
                operationGeneration,
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

    private promoteRecoveryAttempt(state: GoalSessionState, execution: GoalExecutionIdentity, controllerEpoch: number):
    Promise<GoalSessionState> {
        assertRecoverableExactState(state, controllerEpoch);
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

    private async expireRecoveryLeaseIfOwned(fence: GoalSessionControlFence, operationToken: string): Promise<void> {
        await expireRecoveryLease({
            ports: this.ports, fence, operationToken,
            load: () => this.requireControlledStateForBarrier(fence),
            publish: generation => this.publishProviderOperationBarrier(fence, generation),
        });
    }

    private revalidatePreparedRecovery(prepared: PreparedRecovery): Promise<GoalSessionState> {
        return this.revalidateInspectionState(prepared.state, prepared.fence);
    }

    private async committedRecoveryResult(identity: GoalSessionIdentity, controllerEpoch: number):
    Promise<ReconcileGoalSessionResult | null> {
        const state = await this.requireState(identity);
        return completedRecoveryResult(state, controllerEpoch);
    }

    private async revalidateInspectionState(expected: GoalSessionState, fence: GoalSessionControlFence):
    Promise<GoalSessionState> {
        return revalidateRecoveryInspection({
            expected, fence,
            load: () => this.requireControlledState(fence),
            guard: state => this.guardReconciliationState(state, fence),
        });
    }

    private async requireLiveRecoveryLease(fence: GoalSessionControlFence, execution: GoalExecutionIdentity,
        operationToken: string): Promise<GoalSessionState> {
        const state = await this.requireControlledState(fence);
        assertLiveRecoveryLease(state, execution, operationToken);
        return state;
    }
}
