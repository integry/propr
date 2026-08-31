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
    compactImmediateModelIntents,
    hasUnresolvedImmediateModelIntent,
    immediateModelIntents,
    latestImmediateModelIntent,
    nextModelGeneration,
    replaceImmediateModelIntent,
} from './modelChangeProtocol.js';
import { nextState, persistedSnapshot } from './support.js';

const MODEL_APPLICATION_LEASE_MS = 30_000;

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
            const generation = nextModelGeneration(state);
            state = await this.commitControlTransition({
                state,
                fence: request,
                changes: {
                    requestedModel: request.model,
                    pendingModelChange: request.model,
                    modelChangeIntent: {
                        modelChangeId, model: request.model, requestedAt: new Date().toISOString(), generation,
                    },
                    modelChangeGeneration: generation,
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
                modelChangeIntents: compactImmediateModelIntents([...intents, intent]),
                modelChangeGeneration: generation,
            }, 'A newer model intent superseded this request');
        }
        const intentId = intent.modelChangeId;
        if (intent.phase === 'committed' && intent.acknowledgement) {
            return this.convergeCachedAcknowledgement(request, intentId);
        }
        return this.applyImmediateModelGeneration(request, intentId);
    }

    private async applyImmediateModelGeneration(
        fence: GoalSessionControlFence,
        requestedIntentId: string,
    ): Promise<GoalModelChangeAcknowledgement> {
        let state = await this.requireControlledState(fence);
        let intent = immediateModelIntents(state).find(value => value.modelChangeId === requestedIntentId);
        if (!intent) throw new StaleGoalSessionFenceError('The requested model generation was superseded');
        ({ state, intent } = await this.claimModelApplication(fence, state, intent));
        const acknowledgement = await this.adapter.requestModelChange(
            {
                ...fence,
                model: intent.model,
                modelChangeId: intent.modelChangeId,
                applicationGeneration: intent.generation ?? 0,
            },
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
        const durableIntent = immediateModelIntents(state)
            .find(value => value.modelChangeId === intent.modelChangeId);
        if (!durableIntent || durableIntent.applicationToken !== intent.applicationToken) {
            await this.reapplyLatestModel(fence, latest);
            throw new StaleGoalSessionFenceError('The model application lease was replaced before acknowledgement');
        }
        if (latest?.modelChangeId !== intent.modelChangeId) {
            await this.reapplyLatestModel(fence, latest);
            await this.markModelGenerationSuperseded(fence, intent.modelChangeId);
            throw new StaleGoalSessionFenceError('A newer model intent superseded this provider acknowledgement');
        }
        const committed = {
            ...intent,
            phase: 'committed' as const,
            acknowledgement,
            applicationToken: undefined,
            applicationControllerEpoch: undefined,
            leaseExpiresAt: undefined,
        };
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
        let target = intent;
        for (;;) {
            let state = await this.requireControlledState(fence);
            const durable = immediateModelIntents(state)
                .find(value => value.modelChangeId === target.modelChangeId);
            if (!durable) return;
            ({ state, intent: target } = await this.claimModelApplication(fence, state, durable));
            const acknowledgement = await this.adapter.requestModelChange(
                {
                    ...fence,
                    model: target.model,
                    modelChangeId: target.modelChangeId,
                    applicationGeneration: target.generation ?? 0,
                },
                persistedSnapshot(state),
            );
            this.validateImmediateModelAcknowledgement({ ...fence, model: target.model }, state, acknowledgement);
            state = await this.requireControlledState(fence);
            const latest = latestImmediateModelIntent(state);
            if (latest?.modelChangeId !== target.modelChangeId
                || latest.applicationToken !== target.applicationToken) {
                target = latest!;
                continue;
            }
            if (target.phase !== 'committed') {
                await this.finishImmediateModelGeneration(fence, target, acknowledgement);
            } else {
                await this.clearModelApplicationLease(fence, target.modelChangeId, target.applicationToken);
            }
            return;
        }
    }

    /** Repairs a provider side effect that completed after controller takeover. */
    private async reapplyLatestModelAtLiveFence(identity: GoalSessionControlFence): Promise<void> {
        const state = await this.requireState(identity);
        const intent = latestImmediateModelIntent(state);
        if (!intent || state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') return;
        const fence = { goalId: state.goalId, sessionId: state.sessionId, controllerEpoch: state.controllerEpoch };
        await this.reapplyLatestModel(fence, intent);
    }

    private async convergeCachedAcknowledgement(
        fence: GoalSessionControlFence,
        requestedIntentId: string,
    ): Promise<GoalModelChangeAcknowledgement> {
        for (;;) {
            const state = await this.requireControlledState(fence);
            const latest = latestImmediateModelIntent(state);
            if (!latest || latest.modelChangeId !== requestedIntentId || !latest.acknowledgement) {
                throw new StaleGoalSessionFenceError('A newer model intent superseded the cached acknowledgement');
            }
            const blockers = immediateModelIntents(state).filter(intent =>
                intent.modelChangeId !== latest.modelChangeId
                && intent.phase !== 'superseded'
                && intent.phase !== 'committed');
            const liveBlocker = blockers.find(intent => this.isLiveModelLease(intent, state.controllerEpoch));
            if (liveBlocker) {
                await new Promise<void>(resolve => setImmediate(resolve));
                continue;
            }
            await this.reapplyLatestModel(fence, latest);
            await this.markObsoleteModelGenerations(fence, latest.modelChangeId, true);
            const converged = await this.requireControlledState(fence);
            const durable = latestImmediateModelIntent(converged);
            if (durable?.modelChangeId === requestedIntentId && durable.acknowledgement
                && !immediateModelIntents(converged).some(intent =>
                    intent.modelChangeId !== requestedIntentId
                    && intent.phase !== 'committed'
                    && intent.phase !== 'superseded')) return durable.acknowledgement;
        }
    }

    private async claimModelApplication(
        fence: GoalSessionControlFence,
        initial: GoalSessionState,
        requested: GoalModelChangeIntent,
    ): Promise<{ state: GoalSessionState; intent: GoalModelChangeIntent }> {
        let state = initial;
        for (;;) {
            const current = immediateModelIntents(state)
                .find(value => value.modelChangeId === requested.modelChangeId);
            if (!current) throw new StaleGoalSessionFenceError('The model application generation disappeared');
            if (this.isLiveModelLease(current, state.controllerEpoch)) {
                await new Promise<void>(resolve => setImmediate(resolve));
                state = await this.requireControlledState(fence);
                continue;
            }
            const claimed: GoalModelChangeIntent = {
                ...current,
                phase: current.phase === 'committed' ? 'committed' : 'provider_in_doubt',
                applicationToken: `${current.modelChangeId}:e${state.controllerEpoch}:v${state.version}`,
                applicationControllerEpoch: state.controllerEpoch,
                leaseExpiresAt: new Date(Date.now() + MODEL_APPLICATION_LEASE_MS).toISOString(),
            };
            const intents = replaceImmediateModelIntent(state, claimed);
            try {
                const saved = await this.compareAndSetExact(state, {
                    modelChangeIntents: intents,
                    modelChangeIntent: intents.at(-1),
                }, 'A newer model operation superseded the provider-call lease');
                return { state: saved, intent: claimed };
            } catch (error) {
                if (!(error instanceof StaleGoalSessionFenceError)) throw error;
                state = await this.requireControlledState(fence);
            }
        }
    }

    private isLiveModelLease(intent: GoalModelChangeIntent, controllerEpoch: number): boolean {
        return Boolean(intent.applicationToken
            && intent.applicationControllerEpoch === controllerEpoch
            && intent.leaseExpiresAt
            && Date.parse(intent.leaseExpiresAt) > Date.now());
    }

    private async clearModelApplicationLease(
        fence: GoalSessionControlFence,
        modelChangeId: string,
        applicationToken: string | undefined,
    ): Promise<void> {
        for (;;) {
            const state = await this.requireControlledState(fence);
            const intent = immediateModelIntents(state).find(value => value.modelChangeId === modelChangeId);
            if (!intent || (applicationToken && intent.applicationToken !== applicationToken)) return;
            if (!intent.applicationToken) return;
            const cleared = {
                ...intent,
                applicationToken: undefined,
                applicationControllerEpoch: undefined,
                leaseExpiresAt: undefined,
            };
            const intents = replaceImmediateModelIntent(state, cleared);
            const saved = await this.ports.state.compareAndSet(state, nextState(state, {
                modelChangeIntents: intents,
                modelChangeIntent: intents.at(-1),
            }));
            if (saved) return;
        }
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
        const intents = compactImmediateModelIntents(immediateModelIntents(state).map(intent => {
            if (intent.modelChangeId === latestModelChangeId
                || intent.phase === 'committed' || intent.phase === 'superseded') return intent;
            changed = true;
            return { ...intent, phase: reconciled ? 'superseded' as const : 'superseded_in_doubt' as const };
        }));
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
