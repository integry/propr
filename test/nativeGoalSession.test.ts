import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    type NativeGoalContainer,
    type NativeGoalContainerRuntime,
    type NativeGoalContainerSpec,
    type NativeGoalCorrectiveInput,
    type NativeGoalModelState,
    type NativeGoalProviderEvent,
    type NativeGoalProviderFactory,
    type NativeGoalProviderResumeRequest,
    type NativeGoalProviderSession,
    type NativeGoalProviderStartRequest,
    type NativeGoalProviderState,
    type NativeGoalSessionRecord,
    type StartNativeGoalOptions,
} from '../packages/core/src/agents/goals/nativeGoalTypes.js';
import {
    InMemoryNativeGoalEventSink,
    InMemoryNativeGoalSessionStore,
    JsonFileNativeGoalSessionStore,
    JsonlNativeGoalEventSink,
} from '../packages/core/src/agents/goals/nativeGoalPersistence.js';
import { NativeGoalSessionSupervisor } from '../packages/core/src/agents/goals/NativeGoalSessionSupervisor.js';

class FakeContainers implements NativeGoalContainerRuntime {
    generation = 1;
    alive = true;
    readonly specs: NativeGoalContainerSpec[] = [];

    kill(): void { this.alive = false; }

    async ensure(spec: NativeGoalContainerSpec, previous?: NativeGoalContainer): Promise<NativeGoalContainer> {
        this.specs.push(structuredClone(spec));
        if (!this.alive) {
            this.generation += 1;
            this.alive = true;
        }
        return {
            id: `container-${this.generation}`,
            name: `goal-${spec.goalId}`,
            generation: `generation-${this.generation}`,
            replaced: Boolean(previous && this.generation > 1),
        };
    }
}

interface FakeProviderAuthority {
    sessions: Map<string, { objective: string; status: NativeGoalProviderState['status'] }>;
    starts: NativeGoalProviderStartRequest[];
    resumes: NativeGoalProviderResumeRequest[];
    steering: NativeGoalCorrectiveInput[];
    pauses: number;
    continuations: number;
    cancellations: number;
    connections: FakeProvider[];
}

class FakeProvider implements NativeGoalProviderSession {
    readonly provider = 'codex';
    private sessionId?: string;
    private readonly listeners = new Set<(event: NativeGoalProviderEvent) => void>();

    constructor(private readonly authority: FakeProviderAuthority) { authority.connections.push(this); }

    async start(request: NativeGoalProviderStartRequest): Promise<NativeGoalProviderState> {
        this.authority.starts.push({ ...request, onSessionBound: undefined });
        this.sessionId = `thread-${request.goalId}`;
        await request.onSessionBound?.(this.sessionId);
        this.authority.sessions.set(this.sessionId, { objective: request.objective, status: 'active' });
        this.emit('start-event', 'status', { method: 'turn/started' });
        return {
            providerSessionId: this.sessionId,
            objective: request.objective,
            status: 'active',
            effectiveModel: request.model ?? 'gpt-default',
            effectiveReasoning: request.reasoning ?? 'medium',
        };
    }

    async resume(request: NativeGoalProviderResumeRequest): Promise<NativeGoalProviderState> {
        this.authority.resumes.push(structuredClone(request));
        const session = this.authority.sessions.get(request.providerSessionId);
        if (!session) throw new Error('missing provider session');
        this.sessionId = request.providerSessionId;
        return {
            providerSessionId: request.providerSessionId,
            objective: session.objective,
            status: session.status,
            effectiveModel: 'gpt-persisted',
            effectiveReasoning: 'high',
        };
    }

    async steer(input: NativeGoalCorrectiveInput): Promise<void> {
        this.authority.steering.push(structuredClone(input));
    }
    async pauseAtSafeBoundary(): Promise<void> {
        this.authority.pauses += 1;
        this.current().status = 'paused';
    }
    async continue(): Promise<void> {
        this.authority.continuations += 1;
        this.current().status = 'active';
    }
    async cancel(): Promise<void> {
        this.authority.cancellations += 1;
        this.current().status = 'complete';
    }
    async requestModel(model?: string, reasoning?: string): Promise<NativeGoalModelState> {
        return {
            requestedModel: model,
            requestedReasoning: reasoning,
            effectiveModel: model ? `${model}-effective` : 'gpt-persisted',
            effectiveReasoning: reasoning ?? 'high',
            acknowledged: true,
        };
    }
    onEvent(listener: (event: NativeGoalProviderEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async close(): Promise<void> { this.listeners.clear(); }

    emit(providerEventId: string, kind: NativeGoalProviderEvent['kind'], payload: unknown): void {
        if (!this.sessionId) throw new Error('provider is not bound');
        const event = { providerEventId, providerSessionId: this.sessionId, kind, payload };
        for (const listener of this.listeners) listener(event);
    }

    private current(): { objective: string; status: NativeGoalProviderState['status'] } {
        const session = this.sessionId && this.authority.sessions.get(this.sessionId);
        if (!session) throw new Error('provider is not bound');
        return session;
    }
}

class FakeProviderFactory implements NativeGoalProviderFactory {
    readonly provider = 'codex';
    readonly authority: FakeProviderAuthority = {
        sessions: new Map(), starts: [], resumes: [], steering: [], pauses: 0,
        continuations: 0, cancellations: 0, connections: [],
    };
    async connect(_container: NativeGoalContainer, _record: NativeGoalSessionRecord): Promise<NativeGoalProviderSession> {
        return new FakeProvider(this.authority);
    }
}

function options(goalId = 'goal-2007', statePath = `/var/lib/propr/goals/${goalId}/codex`): StartNativeGoalOptions {
    return {
        goalId,
        objective: 'Ship a resumable native goal runtime',
        image: 'propr/agent:goal-test',
        worktree: {
            hostPath: `/repos/propr/worktrees/${goalId}`,
            containerPath: '/home/node/workspace',
            repository: 'integry/propr',
            branch: `2007/${goalId}`,
        },
        writableMounts: [
            { name: 'provider-state', hostPath: statePath, containerPath: '/home/node/.codex' },
            { name: 'logs', hostPath: `/var/log/propr/goals/${goalId}`, containerPath: '/var/log/propr-goal' },
        ],
        model: 'gpt-5.6-sol',
        reasoning: 'high',
    };
}

describe('native goal session contract', () => {
    test('starts one native goal and preserves provider identity and early ordered output', async () => {
        const store = new InMemoryNativeGoalSessionStore();
        const sink = new InMemoryNativeGoalEventSink();
        const factory = new FakeProviderFactory();
        const supervisor = new NativeGoalSessionSupervisor(store, sink, new FakeContainers(), factory);

        const record = await supervisor.start(options());

        assert.equal(record.providerSessionId, 'thread-goal-2007');
        assert.equal(record.status, 'running');
        assert.deepEqual(record.model, {
            requestedModel: 'gpt-5.6-sol', requestedReasoning: 'high',
            effectiveModel: 'gpt-5.6-sol', effectiveReasoning: 'high', acknowledged: true,
        });
        assert.equal(factory.authority.starts.length, 1);
        assert.equal(factory.authority.starts[0].objective, options().objective);
        await supervisor.flush(record.goalId);
        assert.equal(sink.events(record.goalId)[0].providerEventId, 'start-event');
    });

    test('fresh-process recovery replaces a killed container and resumes without starting a second goal', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-native-goal-'));
        try {
            const statePath = path.join(directory, 'sessions.json');
            const sink = new InMemoryNativeGoalEventSink();
            const factory = new FakeProviderFactory();
            const containers = new FakeContainers();
            const first = new NativeGoalSessionSupervisor(
                new JsonFileNativeGoalSessionStore(statePath), sink, containers, factory,
            );
            const started = await first.start(options());
            await first.close();
            containers.kill();

            // A new store and supervisor instance model a replacement ProPR process.
            const replacement = new NativeGoalSessionSupervisor(
                new JsonFileNativeGoalSessionStore(statePath), sink, containers, factory,
            );
            const resumed = await replacement.resume({
                goalId: started.goalId,
                objective: started.objective,
                worktree: started.worktree,
            });

            assert.equal(factory.authority.starts.length, 1);
            assert.equal(factory.authority.resumes.length, 1);
            assert.equal(factory.authority.resumes[0].providerSessionId, started.providerSessionId);
            assert.equal(resumed.providerSessionId, started.providerSessionId);
            assert.equal(resumed.container?.id, 'container-2');
            assert.equal(resumed.container?.replaced, true);
            assert.deepEqual(containers.specs[1].worktree, started.worktree);
            assert.deepEqual(containers.specs[1].writableMounts, started.writableMounts);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('serializes corrective input, pause/resume, model acknowledgement, and cancel', async () => {
        const store = new InMemoryNativeGoalSessionStore();
        const factory = new FakeProviderFactory();
        const supervisor = new NativeGoalSessionSupervisor(store, new InMemoryNativeGoalEventSink(), new FakeContainers(), factory);
        await supervisor.start(options());

        await supervisor.steer('goal-2007', { sequence: 1, text: 'Keep the public API small.' });
        await assert.rejects(
            supervisor.steer('goal-2007', { sequence: 3, text: 'This arrives out of order.' }),
            /sequence must be 2/,
        );
        await supervisor.steer('goal-2007', { sequence: 2, text: 'Add the recovery test.' });
        assert.deepEqual(factory.authority.steering.map(input => input.sequence), [1, 2]);

        assert.equal((await supervisor.pause('goal-2007')).status, 'paused');
        assert.equal((await supervisor.continue('goal-2007')).status, 'running');
        const changed = await supervisor.requestModel('goal-2007', 'gpt-next', 'xhigh');
        assert.deepEqual(changed.model, {
            requestedModel: 'gpt-next', requestedReasoning: 'xhigh',
            effectiveModel: 'gpt-next-effective', effectiveReasoning: 'xhigh', acknowledged: true,
        });
        assert.equal((await supervisor.cancel('goal-2007')).status, 'cancelled');
        assert.equal(factory.authority.pauses, 1);
        assert.equal(factory.authority.continuations, 1);
        assert.equal(factory.authority.cancellations, 1);
    });

    test('deduplicates provider identities and rejects stale and cross-goal output', async () => {
        const store = new InMemoryNativeGoalSessionStore();
        const sink = new InMemoryNativeGoalEventSink();
        const factory = new FakeProviderFactory();
        const supervisor = new NativeGoalSessionSupervisor(store, sink, new FakeContainers(), factory);
        const record = await supervisor.start(options());
        const event: NativeGoalProviderEvent = {
            providerEventId: 'event-1', providerSessionId: record.providerSessionId!, kind: 'tool', payload: { tool: 'shell' },
        };

        assert.equal((await supervisor.ingestProviderEvent(record.goalId, record.supervisorEpoch, event)).accepted, true);
        assert.deepEqual(await supervisor.ingestProviderEvent(record.goalId, record.supervisorEpoch, event), {
            accepted: false, reason: 'duplicate',
        });
        assert.deepEqual(await supervisor.ingestProviderEvent(record.goalId, 'old-epoch', event), {
            accepted: false, reason: 'stale_epoch',
        });
        assert.deepEqual(await supervisor.ingestProviderEvent(record.goalId, record.supervisorEpoch, {
            ...event, providerEventId: 'event-2', providerSessionId: 'thread-another-goal',
        }), { accepted: false, reason: 'cross_goal_session' });
        assert.deepEqual(sink.events(record.goalId).map(item => item.sequence), [1, 2]);
    });

    test('rejects cross-goal writable provider state reuse', async () => {
        const store = new InMemoryNativeGoalSessionStore();
        const supervisor = new NativeGoalSessionSupervisor(
            store, new InMemoryNativeGoalEventSink(), new FakeContainers(), new FakeProviderFactory(),
        );
        const sharedState = '/var/lib/propr/goals/shared/codex';
        await supervisor.start(options('goal-one', sharedState));
        await assert.rejects(supervisor.start(options('goal-two', sharedState)), /belongs to goal 'goal-one'/);
    });

    test('marks completion from the provider goal checkpoint', async () => {
        const store = new InMemoryNativeGoalSessionStore();
        const factory = new FakeProviderFactory();
        const supervisor = new NativeGoalSessionSupervisor(
            store, new InMemoryNativeGoalEventSink(), new FakeContainers(), factory,
        );
        await supervisor.start(options());
        factory.authority.connections[0].emit('goal-complete', 'checkpoint', {
            method: 'thread/goal/updated', params: { goal: { status: 'complete' } },
        });
        await supervisor.flush('goal-2007');
        assert.equal((await supervisor.get('goal-2007'))?.status, 'completed');
    });

    test('durable event sink preserves order and deduplicates after replacement', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-native-events-'));
        try {
            const eventPath = path.join(directory, 'events.jsonl');
            const candidate = {
                goalId: 'goal-2007', provider: 'codex', providerSessionId: 'thread-goal-2007',
                supervisorEpoch: 'epoch-1', providerEventId: 'provider-event-1',
                kind: 'assistant' as const, payload: { delta: 'done' },
            };
            const first = new JsonlNativeGoalEventSink(eventPath);
            const appended = await first.append(candidate);
            assert.equal(appended.accepted && appended.event.sequence, 1);

            const replacement = new JsonlNativeGoalEventSink(eventPath);
            assert.deepEqual(await replacement.append(candidate), { accepted: false, reason: 'duplicate' });
            const second = await replacement.append({ ...candidate, providerEventId: 'provider-event-2' });
            assert.equal(second.accepted && second.event.sequence, 2);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});
