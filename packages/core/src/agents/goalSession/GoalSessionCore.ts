import type {
    GoalExecutionIdentity,
    GoalSessionAdapter,
    GoalSessionControlFence,
    GoalSessionEvent,
    GoalSessionFence,
    GoalSessionIdentity,
    GoalSessionRuntimePorts,
    GoalSessionState,
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import {
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
    ) {}

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
        update: (state: GoalSessionState) => Partial<GoalSessionState>,
    ): Promise<GoalSessionState> {
        return this.compareAndSetLoop(() => this.requireActiveTurnState(fence), update);
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
