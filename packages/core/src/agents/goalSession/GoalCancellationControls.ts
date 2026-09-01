import type {
    GoalCancelRequest, GoalPendingCancellationContext, GoalSessionControlFence, GoalSessionState,
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { GoalImmediateModelControls } from './GoalImmediateModelControls.js';
import { safeFailureDiagnostic } from './securityBoundary.js';
import { nextState, persistedSnapshot } from './support.js';

/** Durable two-phase provider invalidation and idempotent cancellation replay. */
export abstract class GoalCancellationControls extends GoalImmediateModelControls {
    async cancel(request: GoalCancelRequest): Promise<GoalSessionState> {
        const state = await this.claimCancellation(request);
        if (state.status === 'terminated' || state.status === 'failed') return state;
        return this.resumeClaimedCancellation(request, state);
    }

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
            reason: safeFailureDiagnostic(intent.reason, 'Operator cancelled the goal session'),
            cancellationId: intent.cancellationId,
            operationGeneration: state.providerOperationGeneration ?? 0,
            operationFence: this.providerOperationFence(
                fence, state.providerOperationGeneration ?? 0,
                { kind: 'cancel', operationId: intent.cancellationId },
            ),
        };
        let signalError: unknown;
        let completionWon = true;
        try {
            await this.publishProviderOperationBarrier(fence, request.operationGeneration, intent.cancellationId);
            const signal = this.providerEffect(() => intent.pendingContext
                ? this.adapter.cancelPending!(request, intent.pendingContext)
                : this.adapter.cancel(request, persistedSnapshot(state)));
            await boundedCancellation(signal);
        } catch (error) {
            signalError = error;
        }
        try {
            state = await this.commitControlCompletion(state, request, {
                status: 'terminated', activeTurn: undefined, initializationIntent: undefined,
                retryTurn: undefined, recoveryAttempt: undefined, completedRecovery: undefined,
                resumeIntent: undefined, completedResume: undefined,
                providerOperationGeneration: (state.providerOperationGeneration ?? 0) + 1,
                providerBarrierIntent: {
                    generation: (state.providerOperationGeneration ?? 0) + 1,
                    operationId: `${intent.cancellationId}:terminal`, kind: 'terminal', phase: 'pending',
                    claimedAt: new Date().toISOString(), pendingCancellationId: intent.cancellationId,
                },
                pendingAfterTurnPause: undefined, modelChangeIntent: undefined, modelChangeIntents: undefined,
            }, { type: 'completion', outcome: 'cancelled', error: intent.reason });
        } catch (error) {
            if (!(error instanceof StaleGoalSessionFenceError)) throw error;
            const current = await this.requireState(fence);
            if (current.status !== 'terminated'
                || current.cancellationIntent?.cancellationId !== intent.cancellationId) throw error;
            completionWon = false;
            state = await this.repairPendingProviderBarrier({
                ...fence, controllerEpoch: current.controllerEpoch,
            }, current);
        }
        await this.publishProviderOperationBarrier(
            fence, state.providerOperationGeneration ?? request.operationGeneration, intent.cancellationId,
        );
        state = await this.markBarrierPublished(fence, state);
        if (completionWon && signalError && !(signalError instanceof CancellationTimedOut)) throw signalError;
        return state;
    }

    protected async repairPendingProviderBarrier(
        fence: GoalSessionControlFence,
        state: GoalSessionState,
    ): Promise<GoalSessionState> {
        const barrier = state.providerBarrierIntent;
        if (!barrier || barrier.phase === 'published') return state;
        if (barrier.kind === 'cancellation') {
            return this.publishAndFinalizeCancellationBarrier({
                ...fence, reason: state.cancellationIntent?.reason ?? 'Resume durable cancellation',
            }, state);
        }
        await this.publishProviderOperationBarrier(fence, barrier.generation, barrier.pendingCancellationId);
        return this.markBarrierPublished(fence, await this.requireControlledStateForBarrier(fence));
    }

    private async claimCancellation(request: GoalCancelRequest): Promise<GoalSessionState> {
        for (;;) {
            let state = await this.requireControlledStateForBarrier(request);
            if (state.status === 'terminated' || state.status === 'failed') return state;
            if (state.providerBarrierIntent?.phase === 'pending') {
                if (state.providerBarrierIntent.kind !== 'cancellation' || !state.cancellationIntent) {
                    throw new GoalSessionContractError('A different provider invalidation is pending', 'PROVIDER_BARRIER_PENDING');
                }
                state = await this.publishAndFinalizeCancellationBarrier(request, state);
                return state;
            }
            if (state.status === 'cancelling' && state.cancellationIntent) return state;
            if (!state.providerSessionId && (!state.initializationIntent || !this.adapter.cancelPending)) {
                throw new GoalSessionContractError(
                    'A lazy-ID provider must implement pending cancellation before it can be cancelled safely',
                    'CAPABILITY_METHOD_MISSING',
                );
            }
            const pendingContext = this.pendingCancellationContext(state);
            const reason = safeFailureDiagnostic(request.reason, 'Operator cancelled the goal session');
            const cancellationId = this.controlOperationId('cancel', state);
            const generation = (state.providerOperationGeneration ?? 0) + 1;
            const claimed = await this.ports.state.compareAndSet(state, nextState(state, {
                providerOperationGeneration: generation,
                cancellationIntent: { cancellationId, reason, claimedAt: new Date().toISOString(), pendingContext },
                providerBarrierIntent: {
                    generation, operationId: cancellationId, kind: 'cancellation', phase: 'pending',
                    claimedAt: new Date().toISOString(), pendingCancellationId: cancellationId,
                },
            }));
            if (claimed) return this.publishAndFinalizeCancellationBarrier(request, claimed);
        }
    }

    private async publishAndFinalizeCancellationBarrier(
        request: GoalCancelRequest,
        state: GoalSessionState,
    ): Promise<GoalSessionState> {
        const barrier = state.providerBarrierIntent;
        const cancellation = state.cancellationIntent;
        if (!barrier || barrier.kind !== 'cancellation' || !cancellation) {
            throw new GoalSessionContractError('Cancellation barrier identity is missing', 'CANCELLATION_INTENT_MISSING');
        }
        await this.publishProviderOperationBarrier(request, barrier.generation, cancellation.cancellationId);
        const current = await this.requireControlledStateForBarrier(request);
        if (current.providerBarrierIntent?.operationId !== barrier.operationId
            || current.cancellationIntent?.cancellationId !== cancellation.cancellationId) {
            throw new StaleGoalSessionFenceError('Cancellation barrier was replaced during publication');
        }
        return this.compareAndSetExact(current, {
            status: 'cancelling', activeTurn: undefined, recoveryAttempt: undefined, completedRecovery: undefined,
            resumeIntent: undefined, completedResume: undefined,
            providerBarrierIntent: { ...barrier, phase: 'published' },
        }, 'A newer operation superseded cancellation publication');
    }

    private async markBarrierPublished(
        fence: GoalSessionControlFence,
        state: GoalSessionState,
    ): Promise<GoalSessionState> {
        const barrier = state.providerBarrierIntent;
        if (!barrier || barrier.phase === 'published') return state;
        const saved = await this.ports.state.compareAndSet(state, nextState(state, {
            providerBarrierIntent: { ...barrier, phase: 'published' },
        }));
        if (saved) return saved;
        const current = await this.requireControlledStateForBarrier(fence);
        if (current.providerBarrierIntent?.operationId === barrier.operationId
            && current.providerBarrierIntent.phase === 'published') return current;
        throw new StaleGoalSessionFenceError('Provider barrier publication lost its durable identity');
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
            initializationIntent: {
                attemptId: state.initializationIntent.attemptId,
                deterministicOpenKey: state.initializationIntent.deterministicOpenKey,
                recordedAt: state.initializationIntent.recordedAt,
            },
            activeTurn: state.activeTurn ? {
                turnId: state.activeTurn.turnId,
                executionId: state.activeTurn.executionId,
                attemptId: state.activeTurn.attemptId,
            } : undefined,
        };
    }
}

const CANCELLATION_TIMEOUT_MS = 1_000;
class CancellationTimedOut extends Error {}

async function boundedCancellation(signal: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CancellationTimedOut('Provider cancellation timed out')), CANCELLATION_TIMEOUT_MS);
    });
    try {
        await Promise.race([signal, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
        void signal.catch(() => undefined);
    }
}
