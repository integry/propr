import { randomUUID } from 'node:crypto';
import type {
    GoalExecutionIdentity,
    GoalSessionAdapter,
    GoalSessionControlFence,
    GoalSessionEvent,
    GoalSessionFence,
    GoalSessionIdentity,
    GoalSessionRuntimePorts,
    GoalSessionState,
    GoalTerminalCommit,
    GoalResumeKind,
    GoalResumeIntent,
    GoalProviderResumeRequest, GoalProviderOperationFence, GoalProviderEffectStage, GoalStartedProviderEffect,
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { assertSafeProviderIdentifier, safeProviderException, sanitizeGoalSessionEvent } from './securityBoundary.js';
import { decodeDurableGoalSessionState } from './durableStateSecurity.js';
import { boundedProviderBoundary, expireResumeLease } from './providerBarrierProtocol.js';
import { untrustedProviderResult } from './providerResultBoundary.js';
import {
    controlExecutionIdentity,
    nextState,
    validateControlFence,
} from './support.js';
import { completesAtAfterTurnPause, needsAfterTurnPauseAudit } from './turnCompletionProtocol.js';
import { controlOperationId, mintFreshAttemptId } from './controlOperationIdentity.js';
import {
    createProviderOperationFence, createProviderResumeRequest, providerFirstEffectStream,
    rollbackStartedProviderPrimitive, startedProviderEffect,
} from './providerEffectProtocol.js';
import { assertGoalProviderEffectStage } from './providerOperationBoundary.js';

/**
 * Low-level, fenced state and event primitives shared by every high-level goal
 * session operation. It deliberately separates two fencing scopes:
 *
 *  - control scope: goal/session/epoch only, used for pause, resume, model
 *    change, cancel and reconciliation, and for the audit events they emit even
 *    when no turn is active; and
 *  - turn scope: control scope plus the exact active turn, used for turn output.
 */
export abstract class GoalSessionCore {
    constructor(
        protected readonly adapter: GoalSessionAdapter,
        protected readonly ports: GoalSessionRuntimePorts,
        private readonly createAttemptId: () => string = randomUUID,
    ) {}

    protected mintAttemptId(): string {
        return this.createAttemptId();
    }

    protected mintFreshAttemptId(previousAttemptId: string): string {
        return mintFreshAttemptId(previousAttemptId, () => this.mintAttemptId());
    }

    /** Stable, non-secret identity for a control operation claimed at one state version. */
    protected controlOperationId(kind: string, state: GoalSessionState): string {
        return controlOperationId(kind, state);
    }

    protected async claimResumeOperation(
        fence: GoalSessionControlFence,
        state: GoalSessionState,
        options: { kind: GoalResumeKind; execution: GoalExecutionIdentity; turnId?: string },
    ): Promise<GoalSessionState> {
        const { kind, execution, turnId } = options;
        const previous = state.resumeIntent;
        if (previous && previous.phase !== 'settled'
            && Date.parse(previous.leaseExpiresAt) > Date.now()) {
            throw new GoalSessionContractError('Another process owns the durable resume lease', 'RESUME_IN_PROGRESS');
        }
        const generation = (state.providerOperationGeneration ?? 0) + 1;
        const intent: GoalResumeIntent = {
            ...execution,
            operationId: previous?.kind === kind ? previous.operationId : this.controlOperationId(`resume-${kind}`, state),
            operationGeneration: generation,
            kind, controllerEpoch: fence.controllerEpoch, turnId,
            claimedAt: new Date().toISOString(),
            leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
            phase: 'claimed',
        };
        return this.compareAndSetExact(state, {
            providerOperationGeneration: generation,
            resumeIntent: intent,
            completedResume: undefined,
        }, 'A newer operation claimed the resume lease');
    }

    protected async promoteResumeOperation(fence: GoalSessionControlFence, state: GoalSessionState): Promise<GoalSessionState> {
        const intent = state.resumeIntent;
        if (!intent || intent.phase !== 'claimed') throw new StaleGoalSessionFenceError('Resume lease is not claimable');
        return this.compareAndSetExact(state, {
            resumeIntent: { ...intent, phase: 'provider_in_doubt' },
        }, 'Cancellation or replacement fenced resume before the provider call');
    }

    protected async requireLiveResumeOperation(
        fence: GoalSessionControlFence,
        operationId: string,
        operationGeneration: number,
    ): Promise<GoalSessionState> {
        const state = await this.requireControlledState(fence);
        const intent = state.resumeIntent;
        if (!intent || intent.operationId !== operationId
            || intent.operationGeneration !== operationGeneration
            || state.providerOperationGeneration !== operationGeneration
            || intent.phase !== 'provider_in_doubt'
            || Date.parse(intent.leaseExpiresAt) <= Date.now()
            || state.status !== 'paused') {
            throw new StaleGoalSessionFenceError('Resume provider operation was durably preempted or expired');
        }
        return state;
    }

    protected providerResumeRequest(fence: GoalSessionControlFence, intent: GoalResumeIntent): GoalProviderResumeRequest {
        return createProviderResumeRequest(fence, intent);
    }

    protected providerOperationFence(
        identity: GoalSessionControlFence,
        generation: number,
        operation: Pick<GoalProviderOperationFence, 'kind' | 'operationId' | 'leaseExpiresAt'>
            & Partial<Pick<GoalProviderOperationFence, 'turnId' | 'executionId' | 'attemptId'>>,
    ): GoalProviderOperationFence {
        return createProviderOperationFence(identity, generation, operation);
    }

    protected async publishProviderOperationBarrier(
        identity: GoalSessionIdentity,
        generation: number,
        pendingCancellationId?: string,
    ): Promise<void> {
        try {
            await boundedProviderBoundary(this.adapter.publishOperationBarrier({
                goalId: identity.goalId,
                sessionId: identity.sessionId,
                generation,
                publishedAt: new Date().toISOString(),
                pendingCancellationId,
            }));
        } catch (error) {
            throw safeProviderException(error, 'Provider barrier publication failed safely');
        }
    }

    protected async providerEffect<T>(effect: () => T | Promise<T>): Promise<T> {
        try { return await effect(); }
        catch (error) { throw safeProviderException(error); }
    }

    /** Starts the primitive while the authoritative state row is transaction-locked. */
    protected providerFirstEffect<T>(fence: GoalProviderOperationFence, effect: () => GoalStartedProviderEffect<T>,
        stage: GoalProviderEffectStage = 'provider_primitive'): Promise<T> {
        assertGoalProviderEffectStage(stage); return this.ports.providerFirstEffects.start(fence, stage, effect);
    }

    protected startedProviderEffect<T>(completion: Promise<T>, rollbackOrCancel: () => void | Promise<void>): GoalStartedProviderEffect<T> {
        return startedProviderEffect(completion, rollbackOrCancel);
    }

    protected rollbackProviderPrimitive(fence: GoalProviderOperationFence, state: GoalSessionState): Promise<void> {
        return rollbackStartedProviderPrimitive(this.adapter, fence, state);
    }

    protected providerFirstEffectStream<T>(fence: GoalProviderOperationFence,
        create: () => AsyncIterable<T>): AsyncIterable<T> {
        return providerFirstEffectStream(this.ports.providerFirstEffects, fence, create);
    }

    protected async providerResult<T, R>(
        effect: () => T | Promise<T>,
        rebuild: (value: Awaited<T>) => R,
    ): Promise<R> {
        return untrustedProviderResult(effect, rebuild);
    }

    protected turnProviderOperationFence(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        generation: number,
    ): GoalProviderOperationFence {
        return this.providerOperationFence(
            fence, generation,
            {
                kind: 'turn', operationId: `${fence.turnId}:${execution.executionId}:${execution.attemptId}`,
                turnId: fence.turnId, executionId: execution.executionId, attemptId: execution.attemptId,
            },
        );
    }

    protected async expireResumeOperation(
        fence: GoalSessionControlFence,
        operationId: string,
        operationGeneration: number,
    ): Promise<void> {
        try {
            await expireResumeLease({
                ports: this.ports, fence, operationId, operationGeneration,
                load: () => this.requireControlledStateForBarrier(fence),
                publish: (state, generation) => this.publishProviderOperationBarrier(state, generation),
            });
        } catch (error) {
            if (!(error instanceof StaleGoalSessionFenceError)) throw error;
        }
    }

    protected async requireState(identity: GoalSessionIdentity): Promise<GoalSessionState> {
        const state = await this.ports.state.load(identity);
        if (!state) throw new GoalSessionContractError('Goal session does not exist', 'SESSION_NOT_FOUND');
        return decodeDurableGoalSessionState(state);
    }

    /** Loads state for a session-scoped control operation, rejecting stale epochs. */
    protected async requireControlledState(fence: GoalSessionControlFence): Promise<GoalSessionState> {
        const state = await this.requireControlledStateForBarrier(fence);
        if (state.providerBarrierIntent?.phase === 'pending') {
            throw new StaleGoalSessionFenceError('A durable provider invalidation fenced this operation');
        }
        return state;
    }

    /** Cancellation/reopen repair is the only path allowed to observe a pending barrier. */
    protected async requireControlledStateForBarrier(fence: GoalSessionControlFence): Promise<GoalSessionState> {
        validateControlFence(fence);
        const state = await this.requireState(fence);
        if (state.controllerEpoch !== fence.controllerEpoch) throw new StaleGoalSessionFenceError();
        return state;
    }

    /** Loads state for a turn-scoped operation; the fence must own the active turn. */
    protected async requireActiveTurnState(fence: GoalSessionFence): Promise<GoalSessionState> {
        assertSafeProviderIdentifier(fence.turnId);
        const state = await this.requireControlledState(fence);
        if (!state.activeTurn || state.activeTurn.turnId !== fence.turnId) {
            throw new StaleGoalSessionFenceError('Turn fence does not own the active session turn');
        }
        if (['completed', 'cancelled', 'failed'].includes(state.activeTurn.status)
            || ['cancelling', 'terminated', 'failed'].includes(state.status)) {
            throw new StaleGoalSessionFenceError('Turn fence no longer owns a live session turn');
        }
        return state;
    }

    /** Loads the exact provider invocation, not merely the logical turn. */
    protected async requireActiveAttemptState(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
    ): Promise<GoalSessionState> {
        const state = await this.requireActiveTurnState(fence);
        if (state.activeTurn?.executionId !== execution.executionId
            || state.activeTurn.attemptId !== execution.attemptId) {
            throw new StaleGoalSessionFenceError('A newer recovery attempt owns this turn');
        }
        return state;
    }

    protected async requireProviderGeneration(
        fence: GoalSessionControlFence,
        generation: number,
    ): Promise<GoalSessionState> {
        const state = await this.requireControlledState(fence);
        if ((state.providerOperationGeneration ?? 0) !== generation) {
            throw new StaleGoalSessionFenceError('Provider operation generation was durably invalidated');
        }
        return state;
    }

    protected async requireTurnProviderGeneration(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        generation: number,
    ): Promise<GoalSessionState> {
        const state = await this.requireActiveAttemptState(fence, execution);
        if ((state.providerOperationGeneration ?? 0) !== generation
            || (state.activeTurn?.providerOperationGeneration ?? 0) !== generation) {
            throw new StaleGoalSessionFenceError('Turn provider operation generation was durably invalidated');
        }
        return state;
    }

    protected async updateControlledState(
        fence: GoalSessionControlFence,
        update: (state: GoalSessionState) => Partial<GoalSessionState>,
    ): Promise<GoalSessionState> {
        return this.compareAndSetLoop(() => this.requireControlledState(fence), update);
    }

    protected async updateActiveTurnState(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        update: (state: GoalSessionState) => Partial<GoalSessionState>,
    ): Promise<GoalSessionState> {
        return this.compareAndSetLoop(() => this.requireActiveAttemptState(fence, execution), update);
    }

    /** One-shot CAS for an operation that must not retry over a newer intent. */
    protected async compareAndSetExact(
        expected: GoalSessionState,
        changes: Partial<GoalSessionState>,
        message = 'A newer same-epoch operation superseded this update',
    ): Promise<GoalSessionState> {
        const saved = await this.ports.state.compareAndSet(expected, nextState(expected, changes));
        if (!saved) throw new StaleGoalSessionFenceError(message);
        return saved;
    }

    protected async commitTurnCompletion(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        event: Extract<GoalSessionEvent, { type: 'completion' }>,
    ): Promise<GoalSessionState> {
        const { outcome } = event;
        // A pause request can win after the final exact-attempt load but before
        // the terminal transaction. Reload and retry under the same attempt so
        // the transaction canonically records pause_boundary then completion.
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const state = await this.requireActiveAttemptState(fence, execution);
            const activeTurn = state.activeTurn;
            if (!activeTurn) throw new StaleGoalSessionFenceError('Turn fence no longer owns an active turn');
            const existing = state.completedTurns ?? [];
            const completedTurns = existing.some(turn => turn.turnId === fence.turnId)
                ? existing
                : [...existing, { turnId: fence.turnId, ...execution }];
            const afterTurnPaused = completesAtAfterTurnPause(state, outcome, this.adapter.capabilities.pause);
            const recordsAfterTurnPause = needsAfterTurnPauseAudit(state, outcome, this.adapter.capabilities.pause);
            const next = nextState(state, {
                status: outcome === 'cancelled'
                    ? 'terminated'
                    : outcome === 'failed'
                        ? 'failed'
                        : afterTurnPaused ? 'paused' : 'idle',
                failureReason: outcome === 'failed' ? 'Provider reported turn failure safely' : undefined,
                activeTurn: afterTurnPaused
                    ? undefined
                    : { ...activeTurn, status: outcome === 'succeeded' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed' },
                completedTurnIds: state.completedTurnIds.includes(fence.turnId)
                    ? state.completedTurnIds
                    : [...state.completedTurnIds, fence.turnId],
                completedTurns,
                pendingAfterTurnPause: undefined,
                resumeIntent: undefined,
            });
            const completion: GoalTerminalCommit = {
                scope: 'turn',
                fence,
                execution,
                auditEvents: recordsAfterTurnPause
                    ? [{ type: 'pause_boundary', boundary: 'after_turn' }]
                    : [],
                event: sanitizeGoalSessionEvent(event) as Extract<GoalSessionEvent, { type: 'completion' }>,
            };
            const saved = await this.ports.terminal.commit(state, next, completion);
            if (saved) return saved;
        }
        throw new StaleGoalSessionFenceError('A newer operation completed or replaced this turn');
    }

    protected async commitControlCompletion(
        state: GoalSessionState,
        fence: GoalSessionControlFence,
        changes: Partial<GoalSessionState>,
        event: Extract<GoalSessionEvent, { type: 'completion' }>,
    ): Promise<GoalSessionState> {
        const execution = controlExecutionIdentity(state);
        const saved = await this.ports.terminal.commit(state, nextState(state, changes), {
            scope: 'control', fence, execution, auditEvents: [],
            event: sanitizeGoalSessionEvent(event) as Extract<GoalSessionEvent, { type: 'completion' }>,
        });
        if (!saved) throw new StaleGoalSessionFenceError('A newer operation superseded terminal completion');
        return saved;
    }

    /** Commits a nonterminal control state change and its audit events atomically. */
    protected async commitControlTransition(
        options: {
            state: GoalSessionState;
            fence: GoalSessionControlFence;
            changes: Partial<GoalSessionState>;
            auditEvents: ReadonlyArray<Exclude<GoalSessionEvent, { type: 'completion' }>>;
            transitionId: string;
            execution?: GoalExecutionIdentity;
        },
    ): Promise<GoalSessionState> {
        const { state, fence, changes, auditEvents, transitionId } = options;
        const execution = options.execution ?? controlExecutionIdentity(state);
        const saved = await this.ports.transitions.commit(state, nextState(state, changes), {
            transitionId,
            fence,
            execution,
            auditEvents: auditEvents.map(event => sanitizeGoalSessionEvent(event)) as typeof auditEvents,
        });
        if (!saved) throw new StaleGoalSessionFenceError('A newer operation superseded the state/audit transaction');
        return saved;
    }

    /** Commits a live-turn state change and provider-stream audit under one exact-attempt fence. */
    protected async commitTurnTransition(
        options: {
            state: GoalSessionState;
            fence: GoalSessionFence;
            execution: GoalExecutionIdentity;
            update: (state: GoalSessionState) => Partial<GoalSessionState>;
            auditEvents: ReadonlyArray<Exclude<GoalSessionEvent, { type: 'completion' }>>;
            transitionId: string;
        },
    ): Promise<GoalSessionState> {
        const { fence, execution, update, auditEvents, transitionId } = options;
        let state = options.state;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const saved = await this.ports.transitions.commit(state, nextState(state, update(state)), {
                transitionId,
                fence,
                execution,
                auditEvents: auditEvents.map(event => sanitizeGoalSessionEvent(event)) as typeof auditEvents,
                turnScoped: true,
            });
            if (saved) return saved;
            state = await this.requireActiveAttemptState(fence, execution);
        }
        throw new StaleGoalSessionFenceError('A newer operation repeatedly superseded the turn state/audit transaction');
    }

    private async compareAndSetLoop(
        load: () => Promise<GoalSessionState>,
        update: (state: GoalSessionState) => Partial<GoalSessionState>,
    ): Promise<GoalSessionState> {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const state = await load();
            const saved = await this.ports.state.compareAndSet(state, nextState(state, update(state)));
            if (saved) return saved;
        }
        throw new StaleGoalSessionFenceError('Could not persist a fenced session update');
    }

    /** Turn-scoped append; a rejection means this controller no longer owns the turn. */
    protected async append(fence: GoalSessionFence, execution: GoalExecutionIdentity, event: GoalSessionEvent): Promise<void> {
        const result = await this.ports.events.append(fence, execution, sanitizeGoalSessionEvent(event));
        if (!result.accepted) throw new StaleGoalSessionFenceError(`Durable event sink rejected output: ${result.reason}`);
    }

    /** Turn-scoped append tolerant of losing ownership on an error/cleanup path. */
    protected async appendIfOwned(fence: GoalSessionFence, execution: GoalExecutionIdentity, event: GoalSessionEvent): Promise<void> {
        const result = await this.ports.events.append(fence, execution, sanitizeGoalSessionEvent(event));
        if (!result.accepted && result.reason !== 'stale_fence') {
            throw new GoalSessionContractError(`Durable event sink rejected output: ${result.reason}`, 'EVENT_REJECTED');
        }
    }

    /** Session-scoped control/audit append that does not require an active turn. */
    protected async appendControl(
        fence: GoalSessionControlFence,
        execution: GoalExecutionIdentity,
        event: GoalSessionEvent,
    ): Promise<void> {
        const result = await this.ports.events.appendControl(fence, execution, sanitizeGoalSessionEvent(event));
        if (!result.accepted) throw new StaleGoalSessionFenceError(`Durable control sink rejected event: ${result.reason}`);
    }
}
