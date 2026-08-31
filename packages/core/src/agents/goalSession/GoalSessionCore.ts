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
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import {
    controlExecutionIdentity,
    nextState,
    validateControlFence,
} from './support.js';

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
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const candidate = this.mintAttemptId();
            if (candidate && candidate !== previousAttemptId) return candidate;
        }
        throw new GoalSessionContractError('Could not mint a fresh recovery attempt identity', 'RECOVERY_ATTEMPT_REUSED');
    }

    protected async requireState(identity: GoalSessionIdentity): Promise<GoalSessionState> {
        const state = await this.ports.state.load(identity);
        if (!state) throw new GoalSessionContractError('Goal session does not exist', 'SESSION_NOT_FOUND');
        return state;
    }

    /** Loads state for a session-scoped control operation, rejecting stale epochs. */
    protected async requireControlledState(fence: GoalSessionControlFence): Promise<GoalSessionState> {
        validateControlFence(fence);
        const state = await this.requireState(fence);
        if (state.controllerEpoch !== fence.controllerEpoch) throw new StaleGoalSessionFenceError();
        return state;
    }

    /** Loads state for a turn-scoped operation; the fence must own the active turn. */
    protected async requireActiveTurnState(fence: GoalSessionFence): Promise<GoalSessionState> {
        if (!fence.turnId?.trim()) throw new GoalSessionContractError('turnId must be non-empty', 'INVALID_TURN');
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
        const { outcome, error } = event;
        const state = await this.requireActiveAttemptState(fence, execution);
        const activeTurn = state.activeTurn;
        if (!activeTurn) throw new StaleGoalSessionFenceError('Turn fence no longer owns an active turn');
        const existing = state.completedTurns ?? [];
        const completedTurns = existing.some(turn => turn.turnId === fence.turnId)
            ? existing
            : [...existing, { turnId: fence.turnId, ...execution }];
        const recordsAfterTurnPause = outcome === 'succeeded'
            && state.status === 'pause_requested'
            && this.adapter.capabilities.pause === 'after_turn';
        const afterTurnPaused = outcome === 'succeeded'
            && (state.status === 'pause_requested' || state.status === 'paused')
            && this.adapter.capabilities.pause === 'after_turn';
        const next = nextState(state, {
            status: outcome === 'cancelled'
                ? 'terminated'
                : outcome === 'failed'
                    ? 'failed'
                    : afterTurnPaused ? 'paused' : 'idle',
            failureReason: outcome === 'failed' ? error ?? 'Provider reported turn failure' : undefined,
            activeTurn: afterTurnPaused
                ? undefined
                : { ...activeTurn, status: outcome === 'succeeded' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed' },
            completedTurnIds: state.completedTurnIds.includes(fence.turnId)
                ? state.completedTurnIds
                : [...state.completedTurnIds, fence.turnId],
            completedTurns,
        });
        const completion: GoalTerminalCommit = {
            scope: 'turn',
            fence,
            execution,
            auditEvents: recordsAfterTurnPause
                ? [{ type: 'pause_boundary', boundary: 'after_turn' }]
                : [],
            event,
        };
        const saved = await this.ports.terminal.commit(state, next, completion);
        if (!saved) throw new StaleGoalSessionFenceError('A newer operation completed or replaced this turn');
        return saved;
    }

    protected async commitControlCompletion(
        state: GoalSessionState,
        fence: GoalSessionControlFence,
        changes: Partial<GoalSessionState>,
        event: Extract<GoalSessionEvent, { type: 'completion' }>,
    ): Promise<GoalSessionState> {
        const execution = controlExecutionIdentity(state);
        const saved = await this.ports.terminal.commit(state, nextState(state, changes), {
            scope: 'control', fence, execution, auditEvents: [], event,
        });
        if (!saved) throw new StaleGoalSessionFenceError('A newer operation superseded terminal completion');
        return saved;
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
        const result = await this.ports.events.append(fence, execution, event);
        if (!result.accepted) throw new StaleGoalSessionFenceError(`Durable event sink rejected output: ${result.reason}`);
    }

    /** Turn-scoped append tolerant of losing ownership on an error/cleanup path. */
    protected async appendIfOwned(fence: GoalSessionFence, execution: GoalExecutionIdentity, event: GoalSessionEvent): Promise<void> {
        const result = await this.ports.events.append(fence, execution, event);
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
        const result = await this.ports.events.appendControl(fence, execution, event);
        if (!result.accepted) throw new StaleGoalSessionFenceError(`Durable control sink rejected event: ${result.reason}`);
    }
}
