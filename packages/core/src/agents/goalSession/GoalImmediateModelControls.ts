import type {
    GoalModelChangeAcknowledgement,
    GoalModelChangeIntent,
    GoalModelChangeRequest,
    GoalSessionControlFence,
    GoalSessionEvent,
    GoalSessionState,
} from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { GoalTurnRunner } from './GoalTurnRunner.js';
import {
    hasUnresolvedImmediateModelIntent,
    immediateModelIntents,
    latestImmediateModelIntent,
    nextModelGeneration,
    replaceImmediateModelIntent,
} from './modelChangeProtocol.js';
import { trackProviderOperation, waitForProviderOperations } from './providerOperationCoordinator.js';
import { persistedSnapshot } from './support.js';

/** Durable generation and convergence protocol for provider model side effects. */
export abstract class GoalImmediateModelControls extends GoalTurnRunner {
    async requestModelChange(request: GoalModelChangeRequest): Promise<GoalModelChangeAcknowledgement> {
        let state = await this.requireControlledState(request);
        if (state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') {
            throw new GoalSessionContractError(`Cannot change model while the session is ${state.status}`, 'SESSION_NOT_CONTROLLABLE');
        }
        if (this.adapter.capabilities.modelChange === 'next_turn') {
            const acknowledgement = { requestedModel: request.model, appliesAt: 'next_turn' as const };
            if (state.pendingModelChange === request.model && state.modelChangeIntent?.model === request.model) {
                return acknowledgement;
            }
            const modelChangeId = this.controlOperationId('model', state);
            state = await this.commitControlTransition({
                state,
                fence: request,
                changes: {
                    requestedModel: request.model,
                    pendingModelChange: request.model,
                    modelChangeIntent: { modelChangeId, model: request.model, requestedAt: new Date().toISOString() },
                },
                auditEvents: [{ type: 'model_change_acknowledged', ...acknowledgement }],
                transitionId: `model-requested:${modelChangeId}`,
            });
            return acknowledgement;
        }
        return this.applyImmediateModelChange(request, state);
    }

    /** Resumes a durable next-safe-boundary intent after an ambiguous provider/local outcome. */
    protected async resumeImmediateModelChangeIntent(
        fence: GoalSessionControlFence,
        state: GoalSessionState,
    ): Promise<GoalSessionState> {
        const intent = latestImmediateModelIntent(state);
        if (this.adapter.capabilities.modelChange !== 'next_safe_boundary'
            || !intent || !hasUnresolvedImmediateModelIntent(state)) return state;
        await this.applyImmediateModelChange({ ...fence, model: intent.model }, state);
        return this.requireControlledState(fence);
    }

    private async applyImmediateModelChange(
        request: GoalModelChangeRequest,
        initial: GoalSessionState,
    ): Promise<GoalModelChangeAcknowledgement> {
        let state = initial;
        let intent = latestImmediateModelIntent(state);
        if (intent?.model !== request.model) intent = undefined;
        if (!intent) {
            const intents = immediateModelIntents(state);
            const generation = nextModelGeneration(state);
            intent = {
                modelChangeId: this.controlOperationId('model', state),
                model: request.model,
                requestedAt: new Date().toISOString(),
                generation,
                previousModel: state.currentModel,
                phase: 'pending',
            };
            state = await this.compareAndSetExact(state, {
                requestedModel: request.model,
                modelChangeIntent: intent,
                modelChangeIntents: [...intents, intent],
                modelChangeGeneration: generation,
            }, 'A newer model intent superseded this request');
        }
        const intentId = intent.modelChangeId;
        if (intent.phase === 'committed' && intent.acknowledgement) {
            await waitForProviderOperations(this.ports.state, request, 'model-change');
            await this.reapplyLatestModel(request, intent);
            await this.markObsoleteModelGenerations(request, intent.modelChangeId, true);
            return intent.acknowledgement;
        }
        return trackProviderOperation(this.ports.state, request, 'model-change',
            () => this.applyImmediateModelGeneration(request, intentId));
    }

    private async applyImmediateModelGeneration(
        fence: GoalSessionControlFence,
        requestedIntentId: string,
    ): Promise<GoalModelChangeAcknowledgement> {
        let state = await this.requireControlledState(fence);
        let intent = immediateModelIntents(state).find(value => value.modelChangeId === requestedIntentId);
        if (!intent) throw new StaleGoalSessionFenceError('The requested model generation was superseded');
        if (intent.phase !== 'provider_in_doubt') {
            const claimed = { ...intent, phase: 'provider_in_doubt' as const };
            const intents = replaceImmediateModelIntent(state, claimed);
            state = await this.compareAndSetExact(state, {
                modelChangeIntents: intents,
                modelChangeIntent: intents.at(-1),
            }, 'A newer model operation superseded the provider-call claim');
            intent = claimed;
        }
        const acknowledgement = await this.adapter.requestModelChange(
            { ...fence, model: intent.model, modelChangeId: intent.modelChangeId },
            persistedSnapshot(state),
        );
        this.validateImmediateModelAcknowledgement({ ...fence, model: intent.model }, state, acknowledgement);
        return this.finishImmediateModelGeneration(fence, intent, acknowledgement);
    }

    private async finishImmediateModelGeneration(
        fence: GoalSessionControlFence,
        intent: GoalModelChangeIntent,
        acknowledgement: GoalModelChangeAcknowledgement,
    ): Promise<GoalModelChangeAcknowledgement> {
        let state: GoalSessionState;
        try {
            state = await this.requireControlledState(fence);
        } catch (error) {
            if (error instanceof StaleGoalSessionFenceError) {
                await this.reapplyLatestModelAtLiveFence(fence);
            }
            throw error;
        }
        const latest = latestImmediateModelIntent(state);
        if (latest?.modelChangeId !== intent.modelChangeId) {
            await this.reapplyLatestModel(fence, latest);
            await this.markModelGenerationSuperseded(fence, intent.modelChangeId);
            throw new StaleGoalSessionFenceError('A newer model intent superseded this provider acknowledgement');
        }
        const committed = { ...intent, phase: 'committed' as const, acknowledgement };
        const intents = replaceImmediateModelIntent(state, committed);
        const auditEvents: Array<Exclude<GoalSessionEvent, { type: 'completion' }>> = [{
            type: 'model_change_acknowledged', requestedModel: intent.model, appliesAt: acknowledgement.appliesAt,
        }];
        if (acknowledgement.effectiveModel) {
            auditEvents.push({
                type: 'model_changed', previousModel: intent.previousModel ?? state.currentModel,
                model: acknowledgement.effectiveModel,
            });
        }
        await this.commitControlTransition({
            state,
            fence,
            changes: {
                currentModel: acknowledgement.effectiveModel ?? state.currentModel,
                modelChangeIntents: intents,
                modelChangeIntent: intents.at(-1),
            },
            auditEvents,
            transitionId: `model-applied:${intent.modelChangeId}`,
        });
        await this.markObsoleteModelGenerations(fence, intent.modelChangeId, false);
        return acknowledgement;
    }

    private async reapplyLatestModel(
        fence: GoalSessionControlFence,
        intent: GoalModelChangeIntent | undefined,
    ): Promise<void> {
        if (!intent) return;
        const state = await this.requireControlledState(fence);
        const acknowledgement = await this.adapter.requestModelChange(
            { ...fence, model: intent.model, modelChangeId: intent.modelChangeId },
            persistedSnapshot(state),
        );
        this.validateImmediateModelAcknowledgement({ ...fence, model: intent.model }, state, acknowledgement);
        if (intent.phase !== 'committed') await this.finishImmediateModelGeneration(fence, intent, acknowledgement);
    }

    /** Repairs a provider side effect that completed after controller takeover. */
    private async reapplyLatestModelAtLiveFence(identity: GoalSessionControlFence): Promise<void> {
        const state = await this.requireState(identity);
        const intent = latestImmediateModelIntent(state);
        if (!intent || state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') return;
        const fence = { goalId: state.goalId, sessionId: state.sessionId, controllerEpoch: state.controllerEpoch };
        const acknowledgement = await this.adapter.requestModelChange(
            { ...fence, model: intent.model, modelChangeId: intent.modelChangeId },
            persistedSnapshot(state),
        );
        this.validateImmediateModelAcknowledgement({ ...fence, model: intent.model }, state, acknowledgement);
    }

    private async markModelGenerationSuperseded(fence: GoalSessionControlFence, modelChangeId: string): Promise<void> {
        const state = await this.requireControlledState(fence);
        const intent = immediateModelIntents(state).find(value => value.modelChangeId === modelChangeId);
        if (!intent || intent.phase === 'superseded') return;
        const intents = replaceImmediateModelIntent(state, { ...intent, phase: 'superseded' });
        await this.compareAndSetExact(state, {
            modelChangeIntents: intents,
            modelChangeIntent: intents.at(-1),
        }, 'A newer operation superseded obsolete model cleanup');
    }

    private async markObsoleteModelGenerations(
        fence: GoalSessionControlFence,
        latestModelChangeId: string,
        reconciled: boolean,
    ): Promise<void> {
        const state = await this.requireControlledState(fence);
        let changed = false;
        const intents = immediateModelIntents(state).map(intent => {
            if (intent.modelChangeId === latestModelChangeId
                || intent.phase === 'committed' || intent.phase === 'superseded') return intent;
            changed = true;
            return { ...intent, phase: reconciled ? 'superseded' as const : 'superseded_in_doubt' as const };
        });
        if (!changed) return;
        await this.compareAndSetExact(state, {
            modelChangeIntents: intents,
            modelChangeIntent: intents.at(-1),
        }, 'A newer operation superseded obsolete model recovery');
    }

    private validateImmediateModelAcknowledgement(
        request: GoalModelChangeRequest,
        state: GoalSessionState,
        acknowledgement: GoalModelChangeAcknowledgement,
    ): void {
        if (acknowledgement.requestedModel !== request.model) {
            throw new GoalSessionContractError('Provider acknowledged a different requested model', 'MODEL_ACK_MISMATCH');
        }
        if (acknowledgement.appliesAt === 'next_turn') {
            throw new GoalSessionContractError('Provider deferred beyond its declared model boundary', 'CAPABILITY_ACK_MISMATCH');
        }
        if (acknowledgement.appliesAt === 'immediate'
            && (state.status === 'running' || state.status === 'pause_requested')) {
            throw new GoalSessionContractError('Provider applied a model change before an active-turn safe boundary', 'CAPABILITY_ACK_MISMATCH');
        }
    }
}
