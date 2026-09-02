/* eslint-disable max-lines -- lifecycle controls and their shared identity fence form one contract */
import { randomUUID } from 'node:crypto';
import type {
    NativeGoalContainerRuntime,
    NativeGoalCorrectiveInput,
    NativeGoalEventIngestionResult,
    NativeGoalEventSink,
    NativeGoalModelState,
    NativeGoalProviderEvent,
    NativeGoalProviderFactory,
    NativeGoalProviderSession,
    NativeGoalSessionRecord,
    NativeGoalSessionStore,
    NativeGoalStatus,
    ResumeNativeGoalOptions,
    StartNativeGoalOptions,
} from './nativeGoalTypes.js';
import { validateAndNormalizeStart, worktreesEqual } from './nativeGoalValidation.js';
import { NativeGoalSessionError } from './nativeGoalErrors.js';

export { NativeGoalSessionError } from './nativeGoalErrors.js';

interface ActiveGoal {
    record: NativeGoalSessionRecord;
    provider: NativeGoalProviderSession;
    unsubscribe: () => void;
    tail: Promise<unknown>;
    pendingEvents: NativeGoalProviderEvent[];
    cancelling: boolean;
    pausePending: boolean;
}

/**
 * Supervises a provider-native goal without replacing the provider's own
 * continuation/session state machine.
 */
export class NativeGoalSessionSupervisor {
    private readonly active = new Map<string, ActiveGoal>();

    constructor(
        private readonly store: NativeGoalSessionStore,
        private readonly sink: NativeGoalEventSink,
        private readonly containers: NativeGoalContainerRuntime,
        private readonly providerFactory: NativeGoalProviderFactory,
    ) {}

    async start(options: StartNativeGoalOptions): Promise<NativeGoalSessionRecord> {
        const { worktree, writableMounts } = validateAndNormalizeStart(options);
        if (await this.store.get(options.goalId)) {
            throw new NativeGoalSessionError(`Goal '${options.goalId}' already has a native session; resume it instead`);
        }
        const worktreeOwner = await this.store.findByWorktree(worktree.hostPath);
        if (worktreeOwner && worktreeOwner.goalId !== options.goalId) {
            throw new NativeGoalSessionError(`Worktree '${worktree.hostPath}' belongs to goal '${worktreeOwner.goalId}'`);
        }
        for (const mount of writableMounts) {
            const owner = await this.store.findByWritableMount(mount.hostPath);
            if (owner && owner.goalId !== options.goalId) {
                throw new NativeGoalSessionError(`Writable state '${mount.hostPath}' belongs to goal '${owner.goalId}'`);
            }
        }

        const now = new Date().toISOString();
        const record: NativeGoalSessionRecord = {
            schemaVersion: 1,
            revision: 0,
            goalId: options.goalId,
            objective: options.objective.trim(),
            provider: this.providerFactory.provider,
            containerImage: options.image,
            status: 'starting',
            worktree,
            writableMounts,
            supervisorEpoch: randomUUID(),
            lastInputSequence: 0,
            model: {
                requestedModel: options.model,
                requestedReasoning: options.reasoning,
                acknowledged: false,
            },
            createdAt: now,
            updatedAt: now,
        };
        await this.store.create(record);

        try {
            const container = await this.containers.ensure({
                goalId: record.goalId,
                provider: record.provider,
                image: record.containerImage,
                worktree: record.worktree,
                writableMounts: record.writableMounts,
                environment: options.environment,
            });
            record.container = container;
            const provider = await this.providerFactory.connect(container, record);
            this.assertProvider(provider);
            const active = this.activate(record, provider);
            await this.enqueue(active, async () => {
                const state = await provider.start({
                    goalId: record.goalId,
                    objective: record.objective,
                    worktreePath: record.worktree.containerPath,
                    model: options.model,
                    reasoning: options.reasoning,
                    onSessionBound: async providerSessionId => {
                        await this.assertProviderSessionOwner(record.goalId, providerSessionId);
                        if (active.record.providerSessionId && active.record.providerSessionId !== providerSessionId) {
                            throw new NativeGoalSessionError('Provider changed session identity while starting a goal');
                        }
                        if (!active.record.providerSessionId) {
                            active.record = await this.persist(active.record, { providerSessionId });
                            await this.drainPendingEvents(active);
                        }
                    },
                });
                if (state.objective !== record.objective) {
                    throw new NativeGoalSessionError('Provider session goal does not match the ProPR goal');
                }
                await this.assertProviderSessionOwner(record.goalId, state.providerSessionId);
                active.record = await this.persist(active.record, {
                    providerSessionId: state.providerSessionId,
                    status: active.record.status === 'completed' ? 'completed' : this.mapProviderStatus(state.status),
                    model: {
                        ...active.record.model,
                        effectiveModel: state.effectiveModel,
                        effectiveReasoning: state.effectiveReasoning,
                        acknowledged: true,
                    },
                    container,
                    failure: undefined,
                });
                await this.drainPendingEvents(active);
            });
            return structuredClone(active.record);
        } catch (error) {
            await this.markFailed(options.goalId, error);
            await this.closeActive(options.goalId);
            throw error;
        }
    }

    /** Reconnects to the same provider thread and never replays the objective. */
    async resume(options: ResumeNativeGoalOptions): Promise<NativeGoalSessionRecord> {
        const stored = await this.requireRecord(options.goalId);
        if (options.objective !== undefined && options.objective.trim() !== stored.objective) {
            throw new NativeGoalSessionError(`Goal '${options.goalId}' objective does not match persisted state`);
        }
        if (options.worktree && !worktreesEqual(options.worktree, stored.worktree)) {
            throw new NativeGoalSessionError(`Goal '${options.goalId}' worktree does not match persisted state`);
        }
        if (!stored.providerSessionId) throw new NativeGoalSessionError(`Goal '${options.goalId}' has no provider session to resume`);
        if (stored.provider !== this.providerFactory.provider) {
            throw new NativeGoalSessionError(`Goal '${options.goalId}' is bound to provider '${stored.provider}'`);
        }
        if (stored.status === 'cancelled' || stored.status === 'completed') {
            throw new NativeGoalSessionError(`Goal '${options.goalId}' is already ${stored.status}`);
        }

        await this.closeActive(options.goalId);
        const epoch = randomUUID();
        const container = await this.containers.ensure({
            goalId: stored.goalId,
            provider: stored.provider,
            image: stored.containerImage,
            worktree: stored.worktree,
            writableMounts: stored.writableMounts,
        }, stored.container);
        stored.supervisorEpoch = epoch;
        stored.container = container;
        stored.status = stored.status === 'paused' ? 'paused' : 'resuming';
        stored.updatedAt = new Date().toISOString();
        const persisted = await this.store.save(stored, stored.revision);
        let provider: NativeGoalProviderSession;
        try {
            provider = await this.providerFactory.connect(container, persisted);
            this.assertProvider(provider);
        } catch (error) {
            await this.markFailed(options.goalId, error);
            throw error;
        }
        const active = this.activate(persisted, provider);

        try {
            await this.enqueue(active, async () => {
                const state = await provider.resume({
                    goalId: persisted.goalId,
                    objective: persisted.objective,
                    providerSessionId: persisted.providerSessionId!,
                    worktreePath: persisted.worktree.containerPath,
                    model: persisted.model.requestedModel,
                    reasoning: persisted.model.requestedReasoning,
                });
                if (state.providerSessionId !== persisted.providerSessionId) {
                    throw new NativeGoalSessionError('Provider resumed a different session');
                }
                if (state.objective !== persisted.objective) {
                    throw new NativeGoalSessionError('Provider session goal does not match the ProPR goal');
                }
                await this.assertProviderSessionOwner(persisted.goalId, state.providerSessionId);
                active.record = await this.persist(active.record, {
                    status: active.record.status === 'completed' ? 'completed' : this.mapProviderStatus(state.status),
                    model: {
                        ...active.record.model,
                        effectiveModel: state.effectiveModel,
                        effectiveReasoning: state.effectiveReasoning,
                        acknowledged: true,
                    },
                    failure: undefined,
                });
            });
            return structuredClone(active.record);
        } catch (error) {
            await this.markFailed(options.goalId, error);
            await this.closeActive(options.goalId);
            throw error;
        }
    }

    async steer(goalId: string, input: NativeGoalCorrectiveInput): Promise<NativeGoalSessionRecord> {
        if (!input.text.trim()) throw new NativeGoalSessionError('Corrective input must not be empty');
        const active = this.requireActive(goalId);
        return this.enqueue(active, async () => {
            if (active.record.status !== 'running') throw new NativeGoalSessionError(`Goal '${goalId}' is not running`);
            const expected = active.record.lastInputSequence + 1;
            if (input.sequence !== expected) {
                throw new NativeGoalSessionError(`Corrective input sequence must be ${expected}, got ${input.sequence}`);
            }
            await active.provider.steer({ ...input, text: input.text.trim() });
            active.record = await this.persist(active.record, { lastInputSequence: input.sequence });
            return structuredClone(active.record);
        });
    }

    async pause(goalId: string): Promise<NativeGoalSessionRecord> {
        const active = this.requireActive(goalId);
        if (active.record.status !== 'running') throw new NativeGoalSessionError(`Goal '${goalId}' is not running`);
        active.pausePending = true;
        return this.enqueue(active, async () => {
            try {
                if (active.record.status !== 'running') throw new NativeGoalSessionError(`Goal '${goalId}' is not running`);
                active.record = await this.persist(active.record, { status: 'pause_requested' });
                await active.provider.pauseAtSafeBoundary();
                if (active.cancelling) return structuredClone(active.record);
                active.record = await this.persist(active.record, { status: 'paused' });
                return structuredClone(active.record);
            } finally {
                active.pausePending = false;
            }
        });
    }

    async continue(goalId: string): Promise<NativeGoalSessionRecord> {
        const active = this.requireActive(goalId);
        return this.enqueue(active, async () => {
            if (active.record.status !== 'paused') throw new NativeGoalSessionError(`Goal '${goalId}' is not paused`);
            active.record = await this.persist(active.record, { status: 'resuming' });
            await active.provider.continue();
            active.record = await this.persist(active.record, { status: 'running' });
            return structuredClone(active.record);
        });
    }

    async cancel(goalId: string): Promise<NativeGoalSessionRecord> {
        const active = this.requireActive(goalId);
        if (active.record.status === 'completed' || active.record.status === 'cancelled') {
            return structuredClone(active.record);
        }
        if (active.pausePending) {
            active.cancelling = true;
            // Cancellation must not queue behind a safe-boundary wait.
            await active.provider.cancel();
            return this.enqueue(active, async () => {
                if (active.record.status === 'completed' || active.record.status === 'cancelled') return structuredClone(active.record);
                active.record = await this.persist(active.record, { status: 'cancelling' });
                active.record = await this.persist(active.record, { status: 'cancelled' });
                return structuredClone(active.record);
            });
        }
        return this.enqueue(active, async () => {
            if (active.record.status === 'completed' || active.record.status === 'cancelled') return structuredClone(active.record);
            active.record = await this.persist(active.record, { status: 'cancelling' });
            await active.provider.cancel();
            active.record = await this.persist(active.record, { status: 'cancelled' });
            return structuredClone(active.record);
        });
    }

    async requestModel(goalId: string, model?: string, reasoning?: string): Promise<NativeGoalSessionRecord> {
        if (!model && !reasoning) throw new NativeGoalSessionError('A model or reasoning change is required');
        const active = this.requireActive(goalId);
        return this.enqueue(active, async () => {
            const requested: NativeGoalModelState = {
                ...active.record.model,
                requestedModel: model ?? active.record.model.requestedModel,
                requestedReasoning: reasoning ?? active.record.model.requestedReasoning,
                acknowledged: false,
            };
            active.record = await this.persist(active.record, { model: requested });
            const acknowledged = await active.provider.requestModel(model, reasoning);
            active.record = await this.persist(active.record, {
                model: {
                    ...requested,
                    effectiveModel: acknowledged.effectiveModel,
                    effectiveReasoning: acknowledged.effectiveReasoning,
                    acknowledged: acknowledged.acknowledged,
                },
            });
            return structuredClone(active.record);
        });
    }

    get(goalId: string): Promise<NativeGoalSessionRecord | null> {
        return this.store.get(goalId);
    }

    /** Public for provider bridges and contract tests; all stale/cross-goal data fails closed. */
    async ingestProviderEvent(
        goalId: string,
        supervisorEpoch: string,
        event: NativeGoalProviderEvent,
    ): Promise<NativeGoalEventIngestionResult> {
        const record = await this.store.get(goalId);
        if (!record?.providerSessionId) return { accepted: false, reason: 'unbound_session' };
        if (record.supervisorEpoch !== supervisorEpoch) return { accepted: false, reason: 'stale_epoch' };
        if (record.providerSessionId !== event.providerSessionId) return { accepted: false, reason: 'cross_goal_session' };
        const owner = await this.store.findByProviderSession(record.provider, event.providerSessionId);
        if (!owner || owner.goalId !== goalId) return { accepted: false, reason: 'cross_goal_session' };
        return this.sink.append({
            ...event,
            goalId,
            provider: record.provider,
            supervisorEpoch,
        });
    }

    async flush(goalId: string): Promise<void> {
        const active = this.active.get(goalId);
        if (active) await active.tail;
    }

    async close(): Promise<void> {
        await Promise.all([...this.active.keys()].map(goalId => this.closeActive(goalId)));
    }

    private activate(record: NativeGoalSessionRecord, provider: NativeGoalProviderSession): ActiveGoal {
        const active: ActiveGoal = {
            record, provider, unsubscribe: () => undefined, tail: Promise.resolve(), pendingEvents: [],
            cancelling: false, pausePending: false,
        };
        const epoch = record.supervisorEpoch;
        active.unsubscribe = provider.onEvent(event => {
            if (!active.record.providerSessionId) {
                active.pendingEvents.push(event);
                return;
            }
            void this.enqueue(active, async () => {
                await this.ingestProviderEvent(record.goalId, epoch, event);
                if (event.kind === 'checkpoint' && this.isCompletedEvent(event)) {
                    active.record = await this.persist(active.record, { status: 'completed' });
                }
            });
        });
        this.active.set(record.goalId, active);
        return active;
    }

    private async drainPendingEvents(active: ActiveGoal): Promise<void> {
        const events = active.pendingEvents.splice(0);
        for (const event of events) {
            await this.ingestProviderEvent(active.record.goalId, active.record.supervisorEpoch, event);
            if (event.kind === 'checkpoint' && this.isCompletedEvent(event)) {
                active.record = await this.persist(active.record, { status: 'completed' });
            }
        }
    }

    private isCompletedEvent(event: NativeGoalProviderEvent): boolean {
        const payload = event.payload as { params?: { goal?: { status?: string } }; goal?: { status?: string } };
        return payload?.params?.goal?.status === 'complete' || payload?.goal?.status === 'complete';
    }

    private enqueue<T>(active: ActiveGoal, operation: () => Promise<T>): Promise<T> {
        const result = active.tail.then(operation, operation);
        active.tail = result.then(() => undefined, () => undefined);
        return result;
    }

    private async persist(
        current: NativeGoalSessionRecord,
        changes: Partial<Omit<NativeGoalSessionRecord, 'goalId' | 'revision' | 'schemaVersion'>>,
    ): Promise<NativeGoalSessionRecord> {
        const next = { ...current, ...changes, updatedAt: new Date().toISOString() };
        return this.store.save(next, current.revision);
    }

    private async markFailed(goalId: string, error: unknown): Promise<void> {
        const active = this.active.get(goalId);
        const record = active?.record ?? await this.store.get(goalId);
        if (!record) return;
        try {
            const saved = await this.persist(record, {
                status: 'failed', failure: error instanceof Error ? error.message : String(error),
            });
            if (active) active.record = saved;
        } catch { /* Preserve the original failure. */ }
    }

    private mapProviderStatus(status: string): NativeGoalStatus {
        if (status === 'paused' || status === 'blocked') return 'paused';
        if (status === 'complete') return 'completed';
        return 'running';
    }

    private async assertProviderSessionOwner(goalId: string, providerSessionId: string): Promise<void> {
        const owner = await this.store.findByProviderSession(this.providerFactory.provider, providerSessionId);
        if (owner && owner.goalId !== goalId) {
            throw new NativeGoalSessionError(`Provider session '${providerSessionId}' belongs to goal '${owner.goalId}'`);
        }
    }

    private assertProvider(provider: NativeGoalProviderSession): void {
        if (provider.provider !== this.providerFactory.provider) {
            throw new NativeGoalSessionError(`Provider factory returned '${provider.provider}' instead of '${this.providerFactory.provider}'`);
        }
    }

    private async requireRecord(goalId: string): Promise<NativeGoalSessionRecord> {
        const record = await this.store.get(goalId);
        if (!record) throw new NativeGoalSessionError(`Goal '${goalId}' has no native session`);
        return record;
    }

    private requireActive(goalId: string): ActiveGoal {
        const active = this.active.get(goalId);
        if (!active) throw new NativeGoalSessionError(`Goal '${goalId}' is not attached to this supervisor; resume it first`);
        return active;
    }

    private async closeActive(goalId: string): Promise<void> {
        const active = this.active.get(goalId);
        if (!active) return;
        this.active.delete(goalId);
        active.unsubscribe();
        await active.tail;
        await active.provider.close();
    }

}
