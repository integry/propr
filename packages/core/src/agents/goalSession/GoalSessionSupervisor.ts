import type { GoalSessionIdentity, GoalSessionState } from './contract.js';
import {
    GoalSessionContractError,
    StaleGoalSessionFenceError,
    UnsupportedGoalSessionTransitionError,
} from './errors.js';
import { createFirstTurnInitializationIntent, deterministicOpenKey, firstTurnIdentityFailure } from './firstTurnIdentity.js';
import { GoalSessionRecoveryControls } from './GoalSessionRecoveryControls.js';
import {
    compactImmediateModelIntents,
    hasUnresolvedImmediateModelIntent,
    immediateModelIntents,
} from './modelChangeProtocol.js';
import { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
import {
    assertProviderIdentity,
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

export type { ReconcileGoalSessionResult } from './GoalSessionRecoveryControls.js';

/**
 * Coordinates durable goal turns. The class has no dependency on API routes or
 * queue implementations; callers inject the goal persistence/event/message ports.
 * Turn execution lives in {@link GoalTurnRunner}; this layer owns session open,
 * crash recovery, and the session-scoped control operations.
 */
export class GoalSessionSupervisor extends GoalSessionRecoveryControls {
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
            if (state.cancellationIntent) return state;
            throw new GoalSessionContractError('A terminated provider session cannot be resumed', 'SESSION_TERMINATED');
        }
        if (state.status === 'failed' && this.adapter.capabilities.nativeSessionId === 'eager') {
            throw new GoalSessionContractError('A failed provider session cannot be resumed', 'SESSION_TERMINATED');
        }
        if (state.status === 'cancelling') {
            if (!state.cancellationIntent) {
                return this.cancel({
                    goalId: request.goalId,
                    sessionId: request.sessionId,
                    controllerEpoch: state.controllerEpoch,
                    reason: state.failureReason ?? 'Resume pending cancellation after process replacement',
                });
            }
            return this.resumeClaimedCancellation({
                goalId: request.goalId,
                sessionId: request.sessionId,
                controllerEpoch: state.controllerEpoch,
            }, state);
        }
        state = await this.compactModelIntentRetention(state);

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

        state = await this.callProviderOpen(request, state, deterministicOpenKey);
        return this.resumeImmediateModelChangeIntent(request, state);
    }

    private async compactModelIntentRetention(state: GoalSessionState): Promise<GoalSessionState> {
        const intents = immediateModelIntents(state);
        const compacted = compactImmediateModelIntents(intents);
        if (compacted.length === intents.length) return state;
        return this.compareAndSetExact(state, {
            modelChangeIntents: compacted,
            modelChangeIntent: compacted.at(-1),
        }, 'A newer operation superseded model intent retention during reopen');
    }

    private canRecoverIncompleteInit(state: GoalSessionState): boolean {
        return this.adapter.supportsDeterministicOpen === true && state.initializationIntent !== undefined;
    }

    private async openFirstTurnIdentitySession(
        request: OpenGoalSessionRequest,
        state: GoalSessionState,
    ): Promise<GoalSessionState> {
        const policy = this.adapter.capabilities.nativeSessionId === 'first_turn'
            ? this.adapter.capabilities.firstTurnIdCrashPolicy
            : 'fail';
        if (policy === 'fail' && await this.cleanAlreadyTerminalFirstTurn(state)) throw firstTurnIdentityFailure(policy);
        if (!state.initializationIntent) {
            throw new GoalSessionContractError(
                'A first-turn provider has no durable initialization intent; refusing to start a different native session',
                'INCOMPLETE_INITIALIZATION',
            );
        }
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
            if (policy === 'fail' && state.activeTurn) {
                const turn = state.activeTurn;
                const completedTurns = state.completedTurns?.some(value => value.turnId === turn.turnId)
                    ? state.completedTurns
                    : [...(state.completedTurns ?? []), {
                        turnId: turn.turnId, executionId: turn.executionId, attemptId: turn.attemptId,
                    }];
                const failure = firstTurnIdentityFailure(policy);
                const saved = await this.ports.terminal.commit(state, nextState(state, {
                    status: 'failed', activeTurn: undefined, initializationIntent: undefined, retryTurn: undefined,
                    completedTurnIds: state.completedTurnIds.includes(turn.turnId)
                        ? state.completedTurnIds : [...state.completedTurnIds, turn.turnId],
                    completedTurns, failureReason: failure.message,
                }), {
                    scope: 'turn', fence: { ...request, turnId: turn.turnId },
                    execution: { executionId: turn.executionId, attemptId: turn.attemptId },
                    auditEvents: [],
                    event: { type: 'completion', outcome: 'failed', error: failure.message },
                });
                if (!saved) throw new StaleGoalSessionFenceError('A newer operation superseded first-turn crash failure');
                if (saved.activeTurn) {
                    await this.compareAndSetExact(saved, {
                        status: 'failed', activeTurn: undefined, initializationIntent: undefined,
                        retryTurn: undefined, failureReason: failure.message,
                    });
                }
                throw failure;
            }
            throw firstTurnIdentityFailure(policy);
        }
        if (state.status === 'idle') return state;
        return this.compareAndSetExact(state, { status: 'idle', failureReason: undefined },
            'A newer operation superseded lazy provider initialization');
    }

    private async cleanAlreadyTerminalFirstTurn(state: GoalSessionState): Promise<boolean> {
        if (state.status !== 'failed') return false;
        if (!state.activeTurn) return true;
        if (state.activeTurn.status !== 'failed') return false;
        await this.compareAndSetExact(state, {
            activeTurn: undefined,
            initializationIntent: undefined,
            retryTurn: undefined,
        }, 'A newer operation superseded terminal first-turn cleanup');
        return true;
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
                ? createFirstTurnInitializationIntent(request, this.mintAttemptId())
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
            const preserveIntentModel = this.adapter.capabilities.modelChange === 'next_safe_boundary'
                && hasUnresolvedImmediateModelIntent(state);
            const saved = await this.ports.state.compareAndSet(state, nextState(state, {
                providerSessionId: snapshot.providerSessionId,
                recoveryMetadata: snapshot.recoveryMetadata,
                currentModel: preserveIntentModel ? state.currentModel : snapshot.model ?? state.currentModel,
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

export {
    GoalSessionContractError,
    StaleGoalSessionFenceError,
    UnsupportedGoalSessionTransitionError,
} from './errors.js';
export { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
export { firstPendingCorrectiveMessage } from './support.js';
export type { RunGoalTurnRequest, RunGoalTurnResult } from './GoalTurnRunner.js';
