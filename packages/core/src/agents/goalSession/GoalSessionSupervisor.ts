import type {
    GoalProviderOpenContext, GoalSessionState,
} from './contract.js';
import { isDeepStrictEqual } from 'node:util';
import {
    GoalSessionContractError,
    StaleGoalSessionFenceError,
    UnsupportedGoalSessionTransitionError,
} from './errors.js';
import { createFirstTurnInitializationIntent, deterministicOpenKey, firstTurnIdentityFailure } from './firstTurnIdentity.js';
import { decodeDurableGoalSessionState } from './durableStateSecurity.js';
import { GoalSessionRecoveryControls } from './GoalSessionRecoveryControls.js';
import {
    compactImmediateModelIntents,
    hasUnresolvedImmediateModelIntent,
    immediateModelIntents,
    latestImmediateModelIntent,
} from './modelChangeProtocol.js';
import { assertCredentialFreeRecoveryMetadata, sanitizeRecoveryMetadata } from './recoveryMetadata.js';
import { safeFailureDiagnostic } from './securityBoundary.js';
import { rebuildProviderSnapshot } from './providerResultBoundary.js';
import { credentialFreeRepositoryIdentity } from './repositorySecurity.js';
import {
    durableCodexOpenKey, validateClaimedEagerOpenContext, validateSupervisedOpenPlan,
    type GoalSupervisedOpenClaim, type OpenGoalSessionRequest,
} from './goalSessionOpen.js';
import {
    assertProviderIdentity,
    nextState,
    nowIso,
    persistedSnapshot,
    validateEpoch,
    validateIdentity,
} from './support.js';

export type {
    GoalSupervisedOpenClaim, GoalSupervisedOpenPlan, OpenGoalSessionRequest,
} from './goalSessionOpen.js';

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
        if (request.supervisedOpen) await validateSupervisedOpenPlan(this.adapter, request.supervisedOpen);
        if (request.provider === 'codex' && this.adapter.capabilities.nativeSessionId === 'eager'
            && !request.supervisedOpen) throw new GoalSessionContractError(
            'Eager Codex open requires a post-claim supervised factory', 'OPEN_CONTEXT_MISSING',
        );
        request = {
            goalId: request.goalId, sessionId: request.sessionId, provider: request.provider,
            controllerEpoch: request.controllerEpoch, supervisedOpen: request.supervisedOpen,
        };

        const opened = await this.loadOrCreateForOpen(request);
        let state = opened.state;
        state = await this.scrubDurableSecurityState(state);
        state = await this.repairPendingProviderBarrier({
            goalId: request.goalId, sessionId: request.sessionId, controllerEpoch: state.controllerEpoch,
        }, state);
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
        if (request.controllerEpoch > state.controllerEpoch) state = await this.takeover(request, request.controllerEpoch);
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
        for (const intent of intents) {
            const historical = await this.ports.modelChanges.claim(state, intent.modelChangeId, intent.model);
            if (historical.model !== intent.model) {
                throw new GoalSessionContractError(
                    'Durable model history conflicts with retained session state', 'MODEL_OPERATION_CONFLICT',
                );
            }
            if ((intent.phase === 'committed' || intent.phase === 'superseded') && !intent.applicationToken) {
                await this.ports.modelChanges.settle(state, intent.modelChangeId, intent.acknowledgement ?? {
                    requestedModel: intent.model,
                    appliesAt: this.adapter.capabilities.modelChange === 'next_turn' ? 'next_turn' : 'next_safe_boundary',
                    effectiveModel: intent.phase === 'committed' ? intent.model : undefined,
                });
            }
        }
        const compacted = compactImmediateModelIntents(intents);
        if (compacted.length === intents.length) return state;
        return this.compareAndSetExact(state, {
            modelChangeIntents: compacted,
            modelChangeIntent: compacted.at(-1),
        }, 'A newer operation superseded model intent retention during reopen');
    }

    private async scrubDurableSecurityState(state: GoalSessionState): Promise<GoalSessionState> {
        // requireState/loadOrCreate already rebuilt every field.  Security
        // normalization is validation-only on reopen: corruption must leave no
        // mutation trace and cancellation identity is never synthesized.
        const decoded = decodeDurableGoalSessionState(state);
        if (decoded.activeTurn) {
            const repository = await credentialFreeRepositoryIdentity(decoded.activeTurn.repository);
            if (!isDeepStrictEqual(repository, decoded.activeTurn.repository)) {
                throw new GoalSessionContractError('Durable repository identity is not canonical', 'INVALID_DURABLE_STATE');
            }
        }
        if (decoded.failureReason !== undefined
            && safeFailureDiagnostic(decoded.failureReason, 'Provider operation failed safely') !== decoded.failureReason) {
            throw new GoalSessionContractError('Durable failure reason is unsafe', 'INVALID_DURABLE_STATE');
        }
        return decoded;
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
                    attemptId: this.mintFreshAttemptId(value.initializationIntent.attemptId),
                    deterministicOpenKey: value.initializationIntent.deterministicOpenKey,
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
        const operationGeneration = (state.providerOperationGeneration ?? 0) + 1;
        return this.compareAndSetExact(state, {
            initializationIntent: {
                attemptId,
                deterministicOpenKey: state.initializationIntent?.deterministicOpenKey ?? deterministicOpenKey(request),
                recordedAt: nowIso(),
            },
            providerOpenAttemptId: attemptId,
            providerOpenOperationGeneration: operationGeneration,
            providerOperationGeneration: operationGeneration,
        });
    }

    private recordProviderOpenAttempt(state: GoalSessionState): Promise<GoalSessionState> {
        const attemptId = state.providerOpenAttemptId
            ? this.mintFreshAttemptId(state.providerOpenAttemptId)
            : this.mintAttemptId();
        const operationGeneration = (state.providerOperationGeneration ?? 0) + 1;
        return this.compareAndSetExact(state, {
            providerOpenAttemptId: attemptId,
            providerOpenOperationGeneration: operationGeneration,
            providerOperationGeneration: operationGeneration,
        });
    }

    private async loadOrCreateForOpen(request: OpenGoalSessionRequest): Promise<{ state: GoalSessionState; created: boolean }> {
        const loaded = await this.ports.state.load(request);
        let state = loaded ? decodeDurableGoalSessionState(loaded) : null;
        let created = false;
        if (!state) {
            const timestamp = nowIso();
            const initializationIntent = this.adapter.capabilities.nativeSessionId === 'first_turn'
                ? createFirstTurnInitializationIntent(request, this.mintAttemptId())
                : undefined;
            const initial = await this.ports.state.create({
                goalId: request.goalId,
                sessionId: request.sessionId,
                provider: request.provider,
                controllerEpoch: request.controllerEpoch,
                status: 'initializing',
                completedTurnIds: [],
                initializationIntent,
                createdAt: timestamp,
                updatedAt: timestamp,
            });
            if (initial) { state = decodeDurableGoalSessionState(initial); created = true; }
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
            const providerOpenAttemptId = state.providerOpenAttemptId;
            const operationGeneration = state.providerOpenOperationGeneration
                ?? state.providerOperationGeneration ?? 0;
            await this.publishProviderOperationBarrier(request, operationGeneration);
            const operationFence = this.providerOperationFence(
                request, operationGeneration, { kind: 'open', operationId: providerOpenAttemptId },
            );
            const openContext = await this.resolveClaimedOpenContext(
                request, state, deterministicOpenKey, operationGeneration,
            );
            const authoritative = await this.requireProviderGeneration(request, operationGeneration);
            if (authoritative.providerOpenAttemptId !== providerOpenAttemptId) {
                throw new StaleGoalSessionFenceError('Provider open claim was durably replaced');
            }
            const effectiveOpenKey = deterministicOpenKey ?? openContext?.deterministicOpenKey;
            const snapshot = await this.providerResult(() => this.providerFirstEffect(operationFence, () => this.adapter.openSession({
                goalId: request.goalId,
                sessionId: request.sessionId,
                provider: request.provider,
                controllerEpoch: request.controllerEpoch,
                persisted,
                deterministicOpenKey: effectiveOpenKey,
                attemptId: providerOpenAttemptId,
                operationGeneration,
                operationFence,
                openContext: openContext ? {
                    ...openContext,
                    deterministicOpenKey: effectiveOpenKey,
                } : undefined,
            })), value => rebuildProviderSnapshot(value, this.adapter.provider));
            assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata, this.adapter.provider);
            assertProviderIdentity(state, snapshot);
            const preserveIntentModel = this.adapter.capabilities.modelChange === 'next_safe_boundary'
                ? hasUnresolvedImmediateModelIntent(state)
                : latestImmediateModelIntent(state)?.invocationEvidence !== undefined;
            const saved = await this.ports.state.compareAndSet(state, nextState(state, {
                providerSessionId: snapshot.providerSessionId,
                recoveryMetadata: sanitizeRecoveryMetadata(snapshot.recoveryMetadata, this.adapter.provider),
                currentModel: preserveIntentModel ? state.currentModel : snapshot.model ?? state.currentModel,
                status: state.status === 'initializing' ? 'idle' : state.status,
                initializationIntent: undefined,
                failureReason: undefined,
            }));
            if (!saved) throw new StaleGoalSessionFenceError('Session ownership changed while provider identity was being persisted');
            return saved;
        } catch (error) {
            if (error instanceof StaleGoalSessionFenceError || error instanceof GoalSessionContractError) throw error;
            await this.ports.state.compareAndSet(state, nextState(state, {
                status: 'failed',
                failureReason: safeFailureDiagnostic((error as Error).message, 'Unable to create or resume provider session safely'),
            }));
            throw error;
        }
    }

    private async resolveClaimedOpenContext(
        request: OpenGoalSessionRequest,
        state: GoalSessionState,
        deterministicKey: string | undefined,
        operationGeneration: number,
    ): Promise<GoalProviderOpenContext | undefined> {
        if (!request.supervisedOpen) return undefined;
        const openKey = deterministicKey ?? durableCodexOpenKey(state);
        if (!openKey || !state.providerOpenAttemptId) throw new GoalSessionContractError(
            'Supervised open claim is missing its durable identity', 'OPEN_ATTEMPT_MISSING',
        );
        const executionId = this.controlOperationId('open-execution', state);
        const claim: GoalSupervisedOpenClaim = {
            executionId,
            attemptId: state.providerOpenAttemptId,
            deterministicOpenKey: openKey,
            operationGeneration,
            operationFence: this.providerOperationFence(
                request, operationGeneration, {
                    kind: 'open', operationId: state.providerOpenAttemptId,
                    executionId, attemptId: state.providerOpenAttemptId,
                },
            ),
        };
        const authoritative = await this.requireProviderGeneration(request, operationGeneration);
        if (authoritative.providerOpenAttemptId !== claim.attemptId) {
            throw new StaleGoalSessionFenceError('Supervised provider transport claim was durably replaced');
        }
        const transport = await this.providerFirstEffect(
            claim.operationFence,
            () => request.supervisedOpen!.createTransport(Object.freeze({ ...claim })),
        );
        return validateClaimedEagerOpenContext(this.adapter, {
            ...claim,
            repository: request.supervisedOpen.repository,
            requestedModel: request.supervisedOpen.requestedModel,
            providerHomeTarget: request.supervisedOpen.providerHomeTarget,
            credentialTargets: [...request.supervisedOpen.credentialTargets],
            transport,
        });
    }
}

export { GoalSessionContractError, StaleGoalSessionFenceError, UnsupportedGoalSessionTransitionError } from './errors.js';
export { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
export { firstPendingCorrectiveMessage } from './support.js';
export type { RunGoalTurnRequest, RunGoalTurnResult } from './GoalTurnRunner.js';
