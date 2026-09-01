import type { GoalModelChangeAcknowledgement, GoalModelChangeIntent, GoalModelChangeRequest, GoalSessionControlFence, GoalSessionEvent, GoalSessionState } from './contract.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { GoalTurnRunner } from './GoalTurnRunner.js';
import { compactImmediateModelIntents, assertModelControllable, hasUnresolvedImmediateModelIntent, immediateModelIntents, isLiveModelLease, latestImmediateModelIntent, nextModelGeneration, obsoleteModelIntents, replaceImmediateModelIntent, requestedImmediateModelIntent, validateImmediateModelAcknowledgement } from './modelChangeProtocol.js';
import { resolveModelChangeHistory } from './modelChangeHistory.js';
import { nextState, persistedSnapshot } from './support.js';
import { assertSafeProviderIdentifier } from './securityBoundary.js';
import { rebuildModelAcknowledgement } from './providerResultBoundary.js';
import { claimModelApplicationIntent } from './modelApplicationLease.js';

/** Durable generation and convergence protocol for provider model side effects. */
export abstract class GoalImmediateModelControls extends GoalTurnRunner {
    async requestModelChange(request: GoalModelChangeRequest): Promise<GoalModelChangeAcknowledgement> {
        assertSafeProviderIdentifier(request.model);
        let state = await this.requireControlledState(request);
        if (state.status === 'cancelling' || state.status === 'terminated' || state.status === 'failed') {
            throw new GoalSessionContractError(`Cannot change model while the session is ${state.status}`, 'SESSION_NOT_CONTROLLABLE');
        }
        const sameModelIntent = immediateModelIntents(state).findLast(intent => intent.model === request.model);
        const operationId = request.operationId ?? sameModelIntent?.modelChangeId ?? this.controlOperationId('model', state);
        // Validate before the exact-history claim so a rejected identity cannot
        // allocate order or leave any durable/provider trace.
        assertSafeProviderIdentifier(operationId);
        const retainedIntent = immediateModelIntents(state).some(intent => intent.modelChangeId === operationId);
        const appliesAt = this.adapter.capabilities.modelChange === 'next_turn' ? 'next_turn' : 'next_safe_boundary';
        const historical = await resolveModelChangeHistory(
            this.ports.modelChanges, request, { operationId, appliesAt, retainedIntent },
        );
        if (historical) return historical;
        const exactRequest = { ...request, operationId };
        if (this.adapter.capabilities.modelChange === 'next_turn') {
            const acknowledgement = { requestedModel: request.model, appliesAt: 'next_turn' as const };
            if (state.pendingModelChange === request.model
                && state.modelChangeIntent?.model === request.model
                && state.modelChangeIntent.modelChangeId === operationId) {
                return acknowledgement;
            }
            const modelChangeId = operationId;
            const generation = nextModelGeneration(state);
            const intent: GoalModelChangeIntent = {
                modelChangeId, model: request.model, requestedAt: new Date().toISOString(), generation,
                previousModel: state.currentModel, phase: 'pending',
            };
            const superseded = immediateModelIntents(state).map(previous =>
                previous.phase === 'pending' ? {
                    ...previous,
                    phase: 'superseded' as const,
                    acknowledgement: previous.acknowledgement ?? {
                        requestedModel: previous.model, appliesAt: 'next_turn' as const,
                    },
                } : previous);
            const intents = compactImmediateModelIntents([...superseded, intent]);
            state = await this.commitControlTransition({
                state,
                fence: request,
                changes: {
                    requestedModel: request.model,
                    pendingModelChange: request.model,
                    modelChangeIntent: intent,
                    modelChangeIntents: intents,
                    modelChangeGeneration: generation,
                },
                auditEvents: [{ type: 'model_change_acknowledged', ...acknowledgement }],
                transitionId: `model-requested:${modelChangeId}`,
            });
            for (const previous of superseded) {
                if (previous.phase === 'superseded' && previous.acknowledgement) {
                    await this.ports.modelChanges.settle(request, previous.modelChangeId, previous.acknowledgement);
                }
            }
            return acknowledgement;
        }
        const acknowledgement = await this.applyImmediateModelChange(exactRequest, state);
        await this.ports.modelChanges.settle(request, operationId, acknowledgement);
        return acknowledgement;
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
        const resolved = requestedImmediateModelIntent(state, request);
        let { intent } = resolved;
        if (intent && intent.modelChangeId !== latestImmediateModelIntent(state)?.modelChangeId
            && (intent.phase === 'committed' || intent.phase === 'superseded')) {
            return intent.acknowledgement ?? {
                requestedModel: intent.model, appliesAt: 'next_safe_boundary',
            };
        }
        if (!intent) {
            const intents = immediateModelIntents(state);
            const generation = nextModelGeneration(state);
            intent = {
                modelChangeId: request.operationId ?? this.controlOperationId('model', state),
                model: request.model,
                requestedAt: new Date().toISOString(),
                generation,
                previousModel: state.currentModel,
                phase: 'pending',
            };
            const retained = compactImmediateModelIntents([...intents, intent]);
            state = await this.compareAndSetExact(state, {
                requestedModel: request.model,
                modelChangeIntent: intent,
                modelChangeIntents: retained,
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
        assertModelControllable(state);
        let intent = immediateModelIntents(state).find(value => value.modelChangeId === requestedIntentId);
        if (!intent) throw new StaleGoalSessionFenceError('The requested model generation was superseded');
        assertSafeProviderIdentifier(intent.model);
        assertSafeProviderIdentifier(intent.modelChangeId);
        ({ state, intent } = await this.claimModelApplication(fence, state, intent));
        const operationGeneration = state.providerOperationGeneration ?? 0;
        await this.publishProviderOperationBarrier(fence, operationGeneration);
        await this.requireProviderGeneration(fence, operationGeneration);
        const operationFence = this.modelOperationFence(fence, operationGeneration, intent);
        const acknowledgement = await this.providerResult(() => this.providerFirstEffect(operationFence, () => this.adapter.requestModelChange(
            {
                goalId: fence.goalId, sessionId: fence.sessionId, controllerEpoch: fence.controllerEpoch,
                model: intent.model,
                modelChangeId: intent.modelChangeId,
                applicationGeneration: intent.generation ?? 0,
                operationGeneration,
                operationFence,
            },
            persistedSnapshot(state),
        )), rebuildModelAcknowledgement);
        validateImmediateModelAcknowledgement({ ...fence, model: intent.model }, state, acknowledgement);
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
        assertModelControllable(state);
        const latest = latestImmediateModelIntent(state);
        const durableIntent = immediateModelIntents(state)
            .find(value => value.modelChangeId === intent.modelChangeId);
        if (!durableIntent || durableIntent.applicationToken !== intent.applicationToken) {
            await this.reapplyLatestModel(fence, latest);
            throw new StaleGoalSessionFenceError('The model application lease was replaced before acknowledgement');
        }
        if (latest?.modelChangeId !== intent.modelChangeId) {
            await this.reapplyLatestModel(fence, latest);
            await this.markModelGenerationSuperseded(fence, intent.modelChangeId, acknowledgement);
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
        await this.ports.modelChanges.settle(fence, intent.modelChangeId, acknowledgement);
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
            assertModelControllable(state);
            const durable = immediateModelIntents(state)
                .find(value => value.modelChangeId === target.modelChangeId);
            if (!durable) return;
            assertSafeProviderIdentifier(durable.model);
            assertSafeProviderIdentifier(durable.modelChangeId);
            ({ state, intent: target } = await this.claimModelApplication(fence, state, durable));
            const operationGeneration = state.providerOperationGeneration ?? 0;
            await this.publishProviderOperationBarrier(fence, operationGeneration);
            await this.requireProviderGeneration(fence, operationGeneration);
            const operationFence = this.modelOperationFence(fence, operationGeneration, target);
            const acknowledgement = await this.providerResult(() => this.providerFirstEffect(operationFence, () => this.adapter.requestModelChange(
                {
                    goalId: fence.goalId, sessionId: fence.sessionId, controllerEpoch: fence.controllerEpoch,
                    model: target.model,
                    modelChangeId: target.modelChangeId,
                    applicationGeneration: target.generation ?? 0,
                    operationGeneration,
                    operationFence,
                },
                persistedSnapshot(state),
            )), rebuildModelAcknowledgement);
            validateImmediateModelAcknowledgement({ ...fence, model: target.model }, state, acknowledgement);
            state = await this.requireControlledState(fence);
            assertModelControllable(state);
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
        const state = await this.requireState(identity), intent = latestImmediateModelIntent(state);
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
            const liveBlocker = blockers.find(intent => isLiveModelLease(intent, state.controllerEpoch));
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
            if (isLiveModelLease(current, state.controllerEpoch)) {
                await new Promise<void>(resolve => setImmediate(resolve));
                state = await this.requireControlledState(fence);
                assertModelControllable(state);
                continue;
            }
            const claimed = claimModelApplicationIntent(current, state);
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

    private async markModelGenerationSuperseded(
        fence: GoalSessionControlFence,
        modelChangeId: string,
        acknowledgement: GoalModelChangeAcknowledgement,
    ): Promise<void> {
        const state = await this.requireControlledState(fence);
        const intent = immediateModelIntents(state).find(value => value.modelChangeId === modelChangeId);
        if (!intent || intent.phase === 'superseded') return;
        const intents = replaceImmediateModelIntent(state, {
            ...intent, phase: 'superseded', acknowledgement,
            applicationToken: undefined, applicationControllerEpoch: undefined, leaseExpiresAt: undefined,
        });
        await this.commitControlTransition({
            state, fence,
            changes: {
                modelChangeIntents: intents, modelChangeIntent: intents.at(-1),
            },
            auditEvents: [{
                type: 'model_change_acknowledged', requestedModel: intent.model,
                appliesAt: acknowledgement.appliesAt,
            }],
            transitionId: `model-superseded:${modelChangeId}`,
        });
        await this.ports.modelChanges.settle(fence, modelChangeId, acknowledgement);
    }

    private async markObsoleteModelGenerations(
        fence: GoalSessionControlFence,
        latestModelChangeId: string,
        reconciled: boolean,
    ): Promise<void> {
        const state = await this.requireControlledState(fence);
        const { changed, intents } = obsoleteModelIntents(state, latestModelChangeId, reconciled);
        if (!changed) return;
        await this.compareAndSetExact(state, {
            modelChangeIntents: intents,
            modelChangeIntent: intents.at(-1),
        }, 'A newer operation superseded obsolete model recovery');
    }

    private modelOperationFence(
        fence: GoalSessionControlFence,
        generation: number,
        intent: GoalModelChangeIntent,
    ) {
        return this.providerOperationFence(
            fence, generation, {
                kind: 'model', operationId: `${intent.modelChangeId}:${intent.applicationToken ?? 'unclaimed'}`,
                leaseExpiresAt: intent.leaseExpiresAt,
            },
        );
    }
}
