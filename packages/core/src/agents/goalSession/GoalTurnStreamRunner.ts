import type {
    GoalExecutionIdentity, GoalProviderCorrectiveMessage, GoalSessionEvent,
    GoalSessionFence, GoalSessionState,
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { GoalSessionCore } from './GoalSessionCore.js';
import { assertCredentialFreeRecoveryMetadata, sanitizeNewRecoveryMetadata } from './recoveryMetadata.js';
import { safeFailureDiagnostic, sanitizeGoalSessionEvent } from './securityBoundary.js';
import { immediateModelIntents } from './modelChangeProtocol.js';
import {
    assertFirstTurnIdentityEvent, assertSuppliedMessagesAcknowledged,
    isAtomicTurnAudit, streamAuditTransitionId,
} from './turnStreamProtocol.js';
import { rebuildIterator, rebuildIteratorResult } from './providerResultBoundary.js';

type TurnStreamOutcome = { state: GoalSessionState; completed: boolean; reachedPause: boolean };

interface TurnStreamOptions {
    fence: GoalSessionFence;
    execution: GoalExecutionIdentity;
    initial: GoalSessionState;
    nextTurnMessages: GoalProviderCorrectiveMessage[];
    openStream: () => AsyncIterable<GoalSessionEvent> | Promise<AsyncIterable<GoalSessionEvent>>;
}

interface TurnStreamProgress {
    state: GoalSessionState;
    completed: boolean;
    reachedPause: boolean;
    stop: boolean;
}

/** Exact-attempt stream consumption and atomic event/state persistence. */
export abstract class GoalTurnStreamRunner extends GoalSessionCore {
    protected async driveTurnStream(options: TurnStreamOptions): Promise<TurnStreamOutcome> {
        const { fence, execution } = options;
        let current = options.initial;
        const awaitingMessageIds = options.nextTurnMessages.map(message => message.messageId);
        let reachedPause = false;
        let completed = false;
        try {
            const stream = await options.openStream();
            const iterator = await this.providerResult(() => stream[Symbol.asyncIterator](), rebuildIterator);
            for (;;) {
                const next = await this.providerResult(() => iterator.next(), rebuildIteratorResult);
                if (next.done) break;
                const progress = await this.processTurnStreamEvent({
                    fence, execution, state: current, event: next.value,
                    awaitingMessageIds, completed,
                });
                current = progress.state;
                completed = progress.completed;
                reachedPause ||= progress.reachedPause;
                if (progress.stop) {
                    if (iterator.return) await this.providerEffect(() => iterator.return!());
                    break;
                }
            }
            if (!completed && !reachedPause) {
                const error = 'Provider stream ended without a completion or safe pause boundary';
                current = await this.commitTurnCompletion(fence, execution, { type: 'completion', outcome: 'failed', error });
                completed = true;
            }
            return { state: current, completed, reachedPause };
        } catch (error) {
            if (error instanceof StaleGoalSessionFenceError) throw error;
            // A persistence/transport crash is not a provider failure and must
            // leave the exact durable invocation recoverable.  Provider and
            // protocol failures have already been rebuilt as contract errors.
            if (!(error instanceof GoalSessionContractError)) throw error;
            const message = safeFailureDiagnostic((error as Error).message, 'Provider turn failed safely');
            await this.finishTurnIfOwned(fence, execution, message);
            // Adapter creation, iterator.next/return, and provider event decoding
            // were rebuilt at their exact boundaries above.  Anything else was
            // raised by trusted runtime persistence and must retain its internal
            // contract/crash identity.
            throw error;
        }
    }

    private async processTurnStreamEvent(options: {
        fence: GoalSessionFence;
        execution: GoalExecutionIdentity;
        state: GoalSessionState;
        event: GoalSessionEvent;
        awaitingMessageIds: string[];
        completed: boolean;
    }): Promise<TurnStreamProgress> {
        const { fence, execution, event, awaitingMessageIds } = options;
        const settlesModelEvidence = needsNextTurnModelEvidence(
            options.state, event, this.adapter.capabilities.modelChange,
        );
        let state = await this.settleNextTurnModelEvidence(fence, execution, options.state, event);
        if (settlesModelEvidence) return unchangedStreamProgress(state, options.completed);
        if (options.completed) {
            throw new GoalSessionContractError('Provider emitted an event after turn completion', 'EVENT_AFTER_COMPLETION');
        }
        assertFirstTurnIdentityEvent(state, event, this.adapter.capabilities.nativeSessionId);
        if (event.type === 'message_acknowledged') {
            await this.acknowledgeNextTurnMessage(fence, execution, event.messageId, awaitingMessageIds);
            return unchangedStreamProgress(state, false);
        }
        assertSuppliedMessagesAcknowledged(event, awaitingMessageIds);
        if (event.type === 'completion' && this.adapter.capabilities.pause === 'after_turn') {
            state = await this.requireActiveAttemptState(fence, execution);
        }
        state = await this.applyTurnEvent({ fence, current: state, execution, event });
        if (event.type !== 'completion' && !isAtomicTurnAudit(event)) await this.append(fence, execution, event);
        const completed = event.type === 'completion';
        const reachedPause = event.type === 'pause_boundary' || (completed && state.status === 'paused');
        return {
            state, completed, reachedPause,
            stop: stopsAtActivePause(event, this.adapter.capabilities.pause),
        };
    }

    private async acknowledgeNextTurnMessage(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        messageId: string,
        awaitingMessageIds: string[],
    ): Promise<void> {
        const expected = awaitingMessageIds[0];
        if (expected !== messageId) {
            throw new GoalSessionContractError(
                `Provider acknowledged corrective message "${messageId}" while "${expected ?? 'none'}" was next`,
                'MESSAGE_ACK_OUT_OF_ORDER',
            );
        }
        sanitizeGoalSessionEvent({ type: 'message_acknowledged', messageId });
        const result = await this.ports.messages.acknowledgeWithEvent(fence, execution, messageId);
        if (result === 'stale_fence') throw new StaleGoalSessionFenceError();
        if (result === 'not_found') throw new GoalSessionContractError(
            'Corrective message disappeared before acknowledgement', 'MESSAGE_NOT_FOUND',
        );
        awaitingMessageIds.shift();
    }

    private async settleNextTurnModelEvidence(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        state: GoalSessionState,
        event: GoalSessionEvent,
    ): Promise<GoalSessionState> {
        if (this.adapter.capabilities.modelChange !== 'next_turn' || !state.activeTurn?.modelChange) return state;
        const invocation = state.activeTurn.modelChange;
        const durableIntent = immediateModelIntents(state).find(intent =>
            intent.modelChangeId === invocation.modelChangeId && intent.generation === invocation.generation);
        if (durableIntent?.invocationEvidence) return state;
        const occurrenceId = invocationEvidenceOccurrence(event);
        if (!occurrenceId) return state;
        if (!durableIntent) throw new GoalSessionContractError(
            'Deferred model intent disappeared before invocation evidence', 'MODEL_EVIDENCE_MISSING',
        );
        if (event.type !== 'model_changed' || event.model !== durableIntent.model) {
            throw new GoalSessionContractError(
                'Provider effective model does not match the deferred model intent', 'MODEL_ACK_MISMATCH',
            );
        }
        const acknowledgement = {
            outcome: 'acknowledged' as const,
            requestedModel: durableIntent.model,
            appliesAt: 'next_turn' as const,
            effectiveModel: durableIntent.model,
        };
        const settled = {
            ...durableIntent,
            phase: 'committed' as const,
            acknowledgement,
            invocationEvidence: {
                ...execution,
                modelChangeId: durableIntent.modelChangeId,
                generation: durableIntent.generation!,
                occurrenceId,
                requestedModel: durableIntent.model,
                effectiveModel: event.model,
                acceptedAt: new Date().toISOString(),
            },
        };
        const saved = await this.commitTurnTransition({
            state, fence, execution,
            update: value => ({
                currentModel: settled.model,
                pendingModelChange: value.modelChangeIntent?.modelChangeId === settled.modelChangeId
                    ? undefined : value.pendingModelChange,
                modelChangeIntent: value.modelChangeIntent?.modelChangeId === settled.modelChangeId
                    ? settled : value.modelChangeIntent,
                modelChangeIntents: immediateModelIntents(value).map(intent =>
                    intent.modelChangeId === settled.modelChangeId ? settled : intent),
            }),
            auditEvents: [{
                type: 'model_changed', previousModel: invocation.previousModel,
                model: settled.model, providerEventId: occurrenceId,
            }],
            transitionId: `model-invocation:${settled.modelChangeId}:${execution.executionId}:${execution.attemptId}:${occurrenceId}`,
        });
        await this.ports.modelChanges.settle(fence, settled.modelChangeId, acknowledgement);
        return saved;
    }

    private async applyTurnEvent(options: {
        fence: GoalSessionFence; current: GoalSessionState;
        execution: GoalExecutionIdentity; event: GoalSessionEvent;
    }): Promise<GoalSessionState> {
        const { fence, current, execution, event } = options;
        if (event.type === 'checkpoint') return this.persistCheckpoint(fence, current, execution, event);
        if (event.type === 'usage') return this.persistUsage(fence, current, execution, event);
        if (event.type === 'model_changed') return this.commitTurnTransition({
            state: current, fence, execution,
            update: value => ({
                currentModel: event.model,
                pendingModelChange: value.pendingModelChange === event.model ? undefined : value.pendingModelChange,
            }),
            auditEvents: [event], transitionId: streamAuditTransitionId(fence, execution, event),
        });
        if (event.type === 'pause_boundary') return this.commitTurnTransition({
            state: current, fence, execution,
            update: value => ({
                status: 'paused',
                activeTurn: value.activeTurn ? { ...value.activeTurn, status: 'paused' } : value.activeTurn,
            }),
            auditEvents: [event], transitionId: streamAuditTransitionId(fence, execution, event),
        });
        if (event.type === 'completion') return this.commitTurnCompletion(fence, execution, event);
        return current;
    }

    private persistUsage(
        fence: GoalSessionFence,
        state: GoalSessionState,
        execution: GoalExecutionIdentity,
        event: Extract<GoalSessionEvent, { type: 'usage' }>,
    ): Promise<GoalSessionState> {
        const accounting = state.usageAccounting ?? { version: 1 as const, lastWatermark: -1, occurrences: [] };
        if (accounting.occurrences.includes(event.occurrenceId) || event.watermark <= accounting.lastWatermark) {
            return Promise.resolve(state);
        }
        if (event.semantics === 'delta' && event.watermark !== accounting.lastWatermark + 1) {
            throw new GoalSessionContractError('Provider delta usage skipped a durable watermark', 'USAGE_WATERMARK_GAP');
        }
        return this.commitTurnTransition({
            state, fence, execution,
            update: value => {
                const current = value.usageAccounting ?? { version: 1 as const, lastWatermark: -1, occurrences: [] };
                if (current.occurrences.includes(event.occurrenceId) || event.watermark <= current.lastWatermark) return {};
                return {
                    usageAccounting: {
                        version: 1 as const,
                        lastWatermark: event.watermark,
                        occurrences: [...current.occurrences, event.occurrenceId].slice(-256),
                    },
                };
            },
            auditEvents: [event],
            transitionId: `usage:${execution.executionId}:${execution.attemptId}:${event.occurrenceId}:${event.watermark}`,
        });
    }

    private persistCheckpoint(
        fence: GoalSessionFence,
        state: GoalSessionState,
        execution: GoalExecutionIdentity,
        event: Extract<GoalSessionEvent, { type: 'checkpoint' }>,
    ): Promise<GoalSessionState> {
        if (event.providerSessionId && state.providerSessionId && event.providerSessionId !== state.providerSessionId) {
            throw new GoalSessionContractError('Checkpoint attempted to replace the provider session identity', 'PROVIDER_SESSION_CHANGED');
        }
        assertCredentialFreeRecoveryMetadata(event.recoveryMetadata, this.adapter.provider);
        return this.updateActiveTurnState(fence, execution, value => ({
            ...value,
            providerSessionId: event.providerSessionId ?? value.providerSessionId,
            recoveryMetadata: sanitizeNewRecoveryMetadata(event.recoveryMetadata, this.adapter.provider),
            initializationIntent: event.providerSessionId ? undefined : value.initializationIntent,
            currentModel: event.providerSessionId && !value.providerSessionId
                ? value.activeTurn?.requestedModel ?? value.currentModel : value.currentModel,
            pendingModelChange: event.providerSessionId && !value.providerSessionId
                && value.pendingModelChange === value.activeTurn?.requestedModel
                ? undefined : value.pendingModelChange,
        }));
    }

    private async finishTurnIfOwned(
        fence: GoalSessionFence,
        execution: GoalExecutionIdentity,
        error: string,
    ): Promise<GoalSessionState> {
        try {
            return await this.commitTurnCompletion(fence, execution, { type: 'completion', outcome: 'failed', error });
        } catch {
            return this.requireState(fence);
        }
    }
}

function stopsAtActivePause(event: GoalSessionEvent, pause: 'active_turn' | 'after_turn'): boolean {
    return event.type === 'pause_boundary' && pause === 'active_turn';
}

function invocationEvidenceOccurrence(event: GoalSessionEvent): string | undefined {
    return event.type === 'model_changed'
        ? event.providerEventId ?? (event.providerEventOrdinal === undefined ? undefined : `ordinal-${event.providerEventOrdinal}`)
        : undefined;
}

function needsNextTurnModelEvidence(
    state: GoalSessionState,
    event: GoalSessionEvent,
    capability: 'next_safe_boundary' | 'next_turn',
): boolean {
    if (event.type !== 'model_changed' || capability !== 'next_turn' || !state.activeTurn?.modelChange) return false;
    const invocation = state.activeTurn.modelChange;
    return !immediateModelIntents(state).find(intent =>
        intent.modelChangeId === invocation.modelChangeId)?.invocationEvidence;
}

function unchangedStreamProgress(state: GoalSessionState, completed: boolean): TurnStreamProgress {
    return { state, completed, reachedPause: false, stop: false };
}
