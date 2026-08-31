import { randomUUID } from 'node:crypto';
import type {
    GoalBeginTurnRequest,
    GoalExecutionIdentity,
    GoalSessionControlFence,
    GoalSessionEvent,
    GoalSessionFence,
    GoalSessionState,
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { GoalSessionCore } from './GoalSessionCore.js';
import { assertCredentialFreeRecoveryMetadata } from './recoveryMetadata.js';
import {
    assertProviderIdentity,
    nextState,
    persistedSnapshot,
    validateControlFence,
} from './support.js';

export interface RunGoalTurnRequest extends Omit<GoalBeginTurnRequest, 'executionId' | 'attemptId'> {
    executionId: string;
    attemptId?: string;
}

export type RunGoalTurnResult =
    | { disposition: 'started'; state: GoalSessionState; execution: GoalExecutionIdentity }
    /**
     * A redelivery observed durable state; it neither ran the provider nor
     * claimed completion itself. `reattached` is only true when the original
     * execution/attempt identity of that turn was recovered; a truthful `false`
     * is returned with a fresh fallback identity when it cannot be recovered.
     */
    | { disposition: 'duplicate'; reattached: boolean; state: GoalSessionState; execution: GoalExecutionIdentity };

type TurnStreamOutcome = { state: GoalSessionState; completed: boolean; reachedPause: boolean };

/** Turn lifecycle: one provider invocation per fenced logical turn, plus same-turn resume. */
export abstract class GoalTurnRunner extends GoalSessionCore {
    async runTurn(request: RunGoalTurnRequest): Promise<RunGoalTurnResult> {
        validateControlFence(request);
        if (!request.turnId.trim() || !request.executionId.trim()) {
            throw new GoalSessionContractError('turnId and executionId must be non-empty', 'INVALID_TURN');
        }
        const execution: GoalExecutionIdentity = { executionId: request.executionId, attemptId: request.attemptId ?? randomUUID() };
        let state = await this.requireControlledState(request);

        const duplicate = this.duplicateResult(state, request.turnId, execution);
        if (duplicate) return duplicate;
        if (state.status !== 'idle') {
            throw new GoalSessionContractError(`Cannot begin a turn while session is ${state.status}`, 'SESSION_NOT_IDLE');
        }

        const activeTurn = {
            ...execution,
            turnId: request.turnId,
            objective: request.objective,
            requestedModel: request.requestedModel,
            repository: request.repository,
            status: 'running' as const,
        };
        const claimed = await this.ports.state.compareAndSet(state, nextState(state, {
            activeTurn,
            requestedModel: request.requestedModel,
            status: 'running',
        }));
        if (!claimed) {
            state = await this.requireControlledState(request);
            const redelivery = this.duplicateResult(state, request.turnId, execution);
            if (redelivery) return redelivery;
            throw new StaleGoalSessionFenceError('Another delivery claimed the session turn');
        }

        const adapterRequest: GoalBeginTurnRequest = { ...request, ...execution };
        const outcome = await this.driveTurnStream(request, execution, claimed,
            () => this.adapter.beginTurn(adapterRequest, persistedSnapshot(claimed)));
        return { disposition: 'started', state: outcome.state, execution };
    }

    /**
     * Continues the exact active turn after a pause (optionally across a
     * container/supervisor restart). It refreshes the provider snapshot, streams
     * further ordered events through the same turn fence, and completes once.
     */
    async resumeTurn(fence: GoalSessionControlFence): Promise<RunGoalTurnResult> {
        let state = await this.requireControlledState(fence);
        if (state.status !== 'paused' || !state.activeTurn || state.activeTurn.status !== 'paused') {
            throw new GoalSessionContractError(`Cannot resume a turn while the session is ${state.status}`, 'SESSION_NOT_PAUSED');
        }
        const execution: GoalExecutionIdentity = { executionId: state.activeTurn.executionId, attemptId: state.activeTurn.attemptId };
        const turnFence: GoalSessionFence = { ...fence, turnId: state.activeTurn.turnId };

        const snapshot = await this.adapter.resumeSession(fence, persistedSnapshot(state));
        assertCredentialFreeRecoveryMetadata(snapshot.recoveryMetadata);
        assertProviderIdentity(state, snapshot);
        state = await this.updateControlledState(fence, value => ({
            ...value,
            providerSessionId: snapshot.providerSessionId,
            recoveryMetadata: snapshot.recoveryMetadata,
            currentModel: snapshot.model ?? value.currentModel,
            status: 'running',
            activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'running' } : value.activeTurn,
        }));
        await this.appendControl(fence, execution, { type: 'session_resumed' });
        await this.append(turnFence, execution, { type: 'turn_resumed', turnId: turnFence.turnId });

        const outcome = await this.driveTurnStream(turnFence, execution, state,
            () => this.adapter.resumeTurn(turnFence, persistedSnapshot(state)));
        return { disposition: 'started', state: outcome.state, execution };
    }

    private duplicateResult(
        state: GoalSessionState,
        turnId: string,
        fallback: GoalExecutionIdentity,
    ): RunGoalTurnResult | undefined {
        // The turn is still the active turn: reattach to its real identity.
        if (state.activeTurn?.turnId === turnId) {
            const execution = { executionId: state.activeTurn.executionId, attemptId: state.activeTurn.attemptId };
            return { disposition: 'duplicate', reattached: true, state, execution };
        }
        if (!state.completedTurnIds.includes(turnId)) return undefined;
        // An older turn that a later turn has since replaced: recover its durably
        // recorded execution identity so the redelivery is honestly reattached.
        const recorded = state.completedTurns?.find(turn => turn.turnId === turnId);
        if (recorded) {
            return {
                disposition: 'duplicate',
                reattached: true,
                state,
                execution: { executionId: recorded.executionId, attemptId: recorded.attemptId },
            };
        }
        // The original identity was not recorded (e.g. legacy state): do not claim
        // a reattachment we cannot back with the real attempt identity.
        return { disposition: 'duplicate', reattached: false, state, execution: fallback };
    }

    private async driveTurnStream(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        initial: GoalSessionState,
        openStream: () => AsyncIterable<GoalSessionEvent>,
    ): Promise<TurnStreamOutcome> {
        let current = initial;
        let reachedPause = false;
        let completed = false;
        try {
            // Invoke the provider inside the fenced try so a synchronous/early
            // invocation failure is normalized into failed state plus one
            // completion event, never leaving the session stranded as running.
            const stream = openStream();
            for await (const event of stream) {
                if (completed) {
                    throw new GoalSessionContractError('Provider emitted an event after turn completion', 'EVENT_AFTER_COMPLETION');
                }
                current = await this.applyTurnEvent(fence, current, event);
                if (event.type === 'pause_boundary') reachedPause = true;
                if (event.type === 'completion') completed = true;
                await this.append(fence, execution, event);
            }
            if (!completed && !reachedPause) {
                const error = 'Provider stream ended without a completion or safe pause boundary';
                current = await this.finishTurn(fence, 'failed', error);
                await this.append(fence, execution, { type: 'completion', outcome: 'failed', error });
                completed = true;
            }
            return { state: current, completed, reachedPause };
        } catch (error) {
            if (error instanceof StaleGoalSessionFenceError) throw error;
            const message = `Provider turn failed: ${(error as Error).message}`;
            current = await this.finishTurnIfOwned(fence, message);
            await this.appendIfOwned(fence, execution, { type: 'completion', outcome: 'failed', error: message });
            throw error;
        }
    }

    private async applyTurnEvent(
        fence: GoalSessionFence,
        current: GoalSessionState,
        event: GoalSessionEvent,
    ): Promise<GoalSessionState> {
        if (event.type === 'checkpoint') return this.persistCheckpoint(fence, current, event);
        if (event.type === 'model_changed') {
            return this.updateActiveTurnState(fence, value => ({ ...value, currentModel: event.model }));
        }
        if (event.type === 'pause_boundary') {
            return this.updateActiveTurnState(fence, value => ({
                ...value,
                status: 'paused',
                activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'paused' } : value.activeTurn,
            }));
        }
        if (event.type === 'completion') return this.finishTurn(fence, event.outcome, event.error);
        return current;
    }

    private async persistCheckpoint(
        fence: GoalSessionFence,
        state: GoalSessionState,
        event: Extract<GoalSessionEvent, { type: 'checkpoint' }>,
    ): Promise<GoalSessionState> {
        if (event.providerSessionId && event.providerSessionId !== state.providerSessionId) {
            throw new GoalSessionContractError('Checkpoint attempted to replace the provider session identity', 'PROVIDER_SESSION_CHANGED');
        }
        assertCredentialFreeRecoveryMetadata(event.recoveryMetadata);
        return this.updateActiveTurnState(fence, value => ({ ...value, recoveryMetadata: event.recoveryMetadata }));
    }

    protected async finishTurn(
        fence: GoalSessionFence,
        outcome: 'succeeded' | 'failed' | 'cancelled',
        error?: string,
    ): Promise<GoalSessionState> {
        return this.updateActiveTurnState(fence, state => ({
            ...state,
            status: outcome === 'cancelled' ? 'terminated' : outcome === 'failed' ? 'failed' : 'idle',
            failureReason: outcome === 'failed' ? error ?? 'Provider reported turn failure' : undefined,
            activeTurn: state.activeTurn ? {
                ...state.activeTurn,
                status: outcome === 'succeeded' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed',
            } : state.activeTurn,
            completedTurnIds: state.completedTurnIds.includes(fence.turnId)
                ? state.completedTurnIds
                : [...state.completedTurnIds, fence.turnId],
            completedTurns: this.recordCompletedTurn(state, fence.turnId),
        }));
    }

    /** Appends the finishing turn's real execution identity, once, for later recovery. */
    private recordCompletedTurn(state: GoalSessionState, turnId: string): GoalSessionState['completedTurns'] {
        const existing = state.completedTurns ?? [];
        if (!state.activeTurn || state.activeTurn.turnId !== turnId || existing.some(turn => turn.turnId === turnId)) {
            return existing.length ? existing : undefined;
        }
        return [...existing, { turnId, executionId: state.activeTurn.executionId, attemptId: state.activeTurn.attemptId }];
    }

    private async finishTurnIfOwned(fence: GoalSessionFence, error: string): Promise<GoalSessionState> {
        try { return await this.finishTurn(fence, 'failed', error); }
        catch (cause) {
            if (cause instanceof StaleGoalSessionFenceError) throw cause;
            return this.requireState(fence);
        }
    }
}
