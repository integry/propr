import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import type {
    GoalProviderOperationFence, GoalSessionAdapter, GoalSessionState,
} from '../src/agents/goalSession/contract.js';
import { GoalSessionSupervisor } from '../src/agents/goalSession/GoalSessionSupervisor.js';
import { AuthoritativeGoalSessionRuntimePorts } from '../src/agents/goalSession/AuthoritativeGoalSessionRuntimePorts.js';
import { controlOperationId } from '../src/agents/goalSession/controlOperationIdentity.js';
import {
    assertStartedProviderEffect, providerFirstEffectStream, startedProviderEffect,
} from '../src/agents/goalSession/providerEffectProtocol.js';
import { SqliteGoalSessionTestPorts } from './SqliteGoalSessionTestPorts.js';

const repository = { repository: 'integry/propr', worktreePath: '/tmp/slice-one', branch: 'slice-one' };
const recovery = {
    async inspectContainer() { return { status: 'missing' as const }; },
    async inspectRepository() { return { ...repository, exists: false }; },
};

function baseState(sessionId: string): Omit<GoalSessionState, 'version'> {
    const now = new Date().toISOString();
    return {
        goalId: 'slice-one-goal', sessionId, provider: 'slice-provider',
        providerSessionId: 'native-session', recoveryMetadata: {}, controllerEpoch: 1,
        status: 'idle', currentModel: 'model-a', completedTurnIds: [],
        providerOperationGeneration: 1, createdAt: now, updatedAt: now,
    };
}

function liveTurn(sessionId: string, status: 'running' | 'pause_requested' = 'running') {
    const state = baseState(sessionId);
    return {
        ...state, status,
        activeTurn: {
            turnId: 'turn-live', executionId: 'execution-live', attemptId: 'attempt-live',
            executionEpoch: 1, objective: 'slice one', requestedModel: 'model-a', repository,
            providerOperationGeneration: 1, status,
        },
    } satisfies Omit<GoalSessionState, 'version'>;
}

function operationCase(kind: GoalProviderOperationFence['kind'], sessionId: string): {
    state: Omit<GoalSessionState, 'version'>;
    fence: GoalProviderOperationFence;
} {
    const identity = { goalId: 'slice-one-goal', sessionId, controllerEpoch: 1, generation: 1, kind };
    const future = new Date(Date.now() + 60_000).toISOString();
    if (kind === 'open') {
        const state = { ...baseState(sessionId), status: 'initializing' as const,
            providerSessionId: undefined, recoveryMetadata: undefined,
            providerOpenAttemptId: 'open-attempt', providerOpenOperationGeneration: 1 };
        return { state, fence: { ...identity, operationId: 'open-attempt' } };
    }
    if (kind === 'turn' || kind === 'steer') {
        const state = liveTurn(sessionId);
        return { state, fence: { ...identity,
            operationId: kind === 'turn' ? 'turn-live:execution-live:attempt-live' : 'message-live',
            turnId: 'turn-live', executionId: 'execution-live', attemptId: 'attempt-live' } };
    }
    if (kind === 'pause') {
        const state = liveTurn(sessionId, 'pause_requested');
        return { state, fence: { ...identity, operationId: controlOperationId('pause', { ...state, version: 1 }),
            turnId: 'turn-live', executionId: 'execution-live', attemptId: 'attempt-live' } };
    }
    if (kind === 'resume') {
        const state = { ...baseState(sessionId), status: 'paused' as const, resumeIntent: {
            executionId: 'execution-live', attemptId: 'resume-attempt', operationId: 'resume-live',
            operationGeneration: 1, kind: 'after_turn' as const, controllerEpoch: 1,
            claimedAt: new Date().toISOString(), leaseExpiresAt: future, phase: 'provider_in_doubt' as const,
        } };
        return { state, fence: { ...identity, operationId: 'resume-live', leaseExpiresAt: future,
            executionId: 'execution-live', attemptId: 'resume-attempt' } };
    }
    if (kind === 'reconcile') {
        const state = { ...baseState(sessionId), recoveryAttemptId: 'recovery-attempt', recoveryAttempt: {
            operationToken: 'reconcile-live', operationGeneration: 1, executionId: 'execution-live',
            attemptId: 'recovery-attempt', controllerEpoch: 1, sessionStatus: 'idle' as const,
            claimedAt: new Date().toISOString(), leaseExpiresAt: future, phase: 'provider_in_doubt' as const,
        } };
        return { state, fence: { ...identity, operationId: 'reconcile-live', leaseExpiresAt: future,
            executionId: 'execution-live', attemptId: 'recovery-attempt' } };
    }
    if (kind === 'model') {
        const intent = {
            modelChangeId: 'model-change', model: 'model-b', requestedAt: new Date().toISOString(),
            generation: 1, phase: 'provider_in_doubt' as const, applicationToken: 'application-token',
            applicationControllerEpoch: 1, leaseExpiresAt: future,
        };
        const state = { ...baseState(sessionId), modelChangeGeneration: 1,
            modelChangeIntent: intent, modelChangeIntents: [intent] };
        return { state, fence: { ...identity, operationId: 'model-change:application-token', leaseExpiresAt: future } };
    }
    const cancellationIntent = {
        cancellationId: 'cancel-live', reason: 'cancel', claimedAt: new Date().toISOString(),
    };
    const state = { ...baseState(sessionId), status: 'cancelling' as const, cancellationIntent,
        providerBarrierIntent: { generation: 1, operationId: 'cancel-live', kind: 'cancellation' as const,
            phase: 'published' as const, claimedAt: cancellationIntent.claimedAt, pendingCancellationId: 'cancel-live' } };
    return { state, fence: { ...identity, operationId: 'cancel-live' } };
}

function invalidatedState(
    state: GoalSessionState,
    kind: GoalProviderOperationFence['kind'],
): Omit<GoalSessionState, 'version'> {
    const { version: _version, ...current } = state;
    if (kind === 'open' || kind === 'cancel') return { ...current, controllerEpoch: 2 };
    const claimedAt = new Date().toISOString();
    return {
        ...current, status: 'cancelling', activeTurn: undefined, providerOperationGeneration: 2,
        retryTurn: undefined, recoveryAttemptId: undefined, recoveryAttempt: undefined,
        resumeIntent: undefined, completedResume: undefined, pendingAfterTurnPause: undefined,
        modelChangeIntent: undefined, modelChangeIntents: undefined,
        cancellationIntent: { cancellationId: `cancel-${kind}`, reason: 'cancel', claimedAt },
        providerBarrierIntent: {
            generation: 2, operationId: `cancel-${kind}`, kind: 'cancellation', phase: 'pending',
            claimedAt, pendingCancellationId: `cancel-${kind}`,
        },
    };
}

test('production SQLite cancellation/takeover races leave every stale primitive effect-free', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-one-runtime-'));
    const filename = path.join(directory, 'runtime.sqlite');
    const effectPorts = new SqliteGoalSessionTestPorts(filename);
    const controllerPorts = new SqliteGoalSessionTestPorts(filename);
    const effectGate = effectPorts.asRuntimePorts().providerFirstEffects;
    t.after(() => { effectPorts.close(); controllerPorts.close(); fs.rmSync(directory, { recursive: true, force: true }); });

    for (const kind of ['open', 'turn', 'steer', 'pause', 'resume', 'model', 'reconcile', 'cancel'] as const) {
        await t.test(kind, async () => {
            const { state, fence } = operationCase(kind, `session-${kind}`);
            await effectPorts.create(state);
            const current = (await controllerPorts.load(state))!;
            assert.ok(await controllerPorts.compareAndSet(current, invalidatedState(current, kind)));
            let effects = 0;
            await assert.rejects(effectGate.start(fence, 'provider_primitive', () => {
                effects += 1;
                return startedProviderEffect(Promise.resolve(), () => undefined);
            }));
            assert.equal(effects, 0);
        });
    }
    assert.equal(effectPorts.providerEffectCount(), 0);
});

test('stream creation and first next remain effect-free after independent cancellation', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-one-stream-'));
    const filename = path.join(directory, 'runtime.sqlite');
    const effects = new SqliteGoalSessionTestPorts(filename);
    const controller = new SqliteGoalSessionTestPorts(filename);
    t.after(() => { effects.close(); controller.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const { state, fence } = operationCase('turn', 'stream-session');
    await effects.create(state);
    let created = 0, firstNext = 0;
    const stream = providerFirstEffectStream(effects.asRuntimePorts().providerFirstEffects, fence, () => {
        created += 1;
        return { [Symbol.asyncIterator]: () => ({
            next: async () => {
                firstNext += 1;
                return { done: true, value: undefined };
            },
            return: async () => ({ done: true, value: undefined }),
        }) };
    });
    const current = (await controller.load(state))!;
    const claimedAt = new Date().toISOString();
    assert.ok(await controller.compareAndSet(current, {
        ...state, controllerEpoch: 1, status: 'cancelling', activeTurn: undefined,
        providerOperationGeneration: 2,
        cancellationIntent: { cancellationId: 'stream-cancel', reason: 'cancel', claimedAt },
        providerBarrierIntent: {
            generation: 2, operationId: 'stream-cancel', kind: 'cancellation', phase: 'pending',
            claimedAt, pendingCancellationId: 'stream-cancel',
        },
    }));
    await assert.rejects(stream[Symbol.asyncIterator]().next());
    assert.deepEqual({ created, firstNext, durableEffects: effects.providerEffectCount() },
        { created: 0, firstNext: 0, durableEffects: 0 });
});

test('SQLite commits after synchronous start, rejects async callback escape, and awaits completion outside', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-one-handle-'));
    const filename = path.join(directory, 'runtime.sqlite');
    const effects = new SqliteGoalSessionTestPorts(filename);
    const controller = new SqliteGoalSessionTestPorts(filename);
    const effectGate = effects.asRuntimePorts().providerFirstEffects;
    t.after(() => { effects.close(); controller.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const { state, fence } = operationCase('open', 'handle-session');
    await effects.create(state);
    await assert.rejects(effectGate.start(fence, 'provider_primitive', (async () => startedProviderEffect(
        Promise.resolve(), () => undefined,
    )) as never),
        /synchronously return/);
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const pending = effectGate.start(fence, 'container_spawn', () => startedProviderEffect(completion, () => undefined));
    const current = (await controller.load(state))!;
    assert.ok(await controller.compareAndSet(current, { ...state, controllerEpoch: 2 }),
        'the authoritative transaction commits before completion is awaited');
    finish();
    await pending;
});

class IdentityAdapter implements GoalSessionAdapter {
    readonly provider = 'slice-provider';
    readonly capabilities = { nativeSessionId: 'eager', steering: 'next_turn', pause: 'after_turn', modelChange: 'next_turn' } as const;
    calls = 0;
    async publishOperationBarrier() {}
    async openSession() { this.calls += 1; return { providerSessionId: 'native-session', recoveryMetadata: {} }; }
    async *beginTurn() { this.calls += 1; yield { type: 'completion' as const, outcome: 'succeeded' as const }; }
    async resumeSession(_request: never, snapshot: never) { return snapshot; }
    async requestModelChange(request: { model: string }) { return { requestedModel: request.model, appliesAt: 'next_turn' as const }; }
    async cancel() {}
    async reconcile() { return { outcome: 'failed' as const, reason: 'unused' }; }
}

test('adversarial caller turn/execution/attempt IDs leave zero state, event, or provider mutation', async () => {
    const adapter = new IdentityAdapter();
    const memory = (await import('../src/agents/goalSession/InMemoryGoalSessionPorts.js')).InMemoryGoalSessionPorts;
    const ports = new memory();
    const supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    const identity = { goalId: 'caller-id-goal', sessionId: 'caller-id-session', controllerEpoch: 1 };
    await supervisor.openSession({ ...identity, provider: adapter.provider });
    const before = await ports.load(identity), events = await ports.replay(identity), calls = adapter.calls;
    const poison = ['../escape', 'contains space', 'github_pat_secret', 'ghp_secret', 'sk-secret', 'AKIASECRET', `x${'a'.repeat(256)}`];
    for (const value of poison) {
        for (const field of ['turnId', 'executionId', 'attemptId'] as const) {
            const request = { ...identity, turnId: 'safe-turn', executionId: 'safe-execution', attemptId: 'safe-attempt',
                objective: 'safe', repository, requestedModel: 'model-a', [field]: value };
            await assert.rejects(supervisor.runTurn(request));
        }
    }
    assert.deepEqual(await ports.load(identity), before);
    assert.deepEqual(await ports.replay(identity), events);
    assert.equal(adapter.calls, calls);
});

test('authoritative composition is mandatory and owns no standalone schema', () => {
    assert.throws(
        () => new AuthoritativeGoalSessionRuntimePorts(undefined as never, recovery),
        /authoritative transaction domain/,
    );
});

test('exact #2018 control event/message tables coexist in both initialization orders', async t => {
    const eventColumns = ['id', 'goal_id', 'sequence', 'kind', 'event_type', 'payload_json',
        'idempotency_key', 'lease_epoch', 'created_at'];
    const messageColumns = ['message_id', 'goal_id', 'sequence', 'body', 'predefined_kind', 'state',
        'delivered_at', 'acknowledged_at', 'delivery_attempts', 'last_error', 'idempotency_key', 'created_at'];
    for (const ordering of ['control_first', 'runtime_first'] as const) {
        await t.test(ordering, () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-one-schema-'));
            const filename = path.join(directory, 'runtime.sqlite');
            let runtime: SqliteGoalSessionTestPorts | undefined;
            let database: Database.Database | undefined;
            try {
                if (ordering === 'runtime_first') runtime = new SqliteGoalSessionTestPorts(filename);
                database = new Database(filename);
                createExactControlTables(database);
                if (ordering === 'control_first') runtime = new SqliteGoalSessionTestPorts(filename);
                assert.deepEqual(tableColumns(database, 'goal_events'), eventColumns);
                assert.deepEqual(tableColumns(database, 'goal_messages'), messageColumns);
                assert.ok(tableColumns(database, 'goal_session_runtime_events').includes('payload'));
                assert.ok(tableColumns(database, 'goal_session_runtime_messages').includes('payload'));
            } finally {
                database?.close();
                runtime?.close();
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
    }
});

test('global session ownership rejects every foreign-goal runtime surface across connections', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-one-owner-'));
    const filename = path.join(directory, 'runtime.sqlite');
    const owner = new SqliteGoalSessionTestPorts(filename);
    const foreign = new SqliteGoalSessionTestPorts(filename);
    t.after(() => { owner.close(); foreign.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const created = (await owner.create(baseState('globally-owned-session')))!
    const alien = { goalId: 'foreign-goal', sessionId: created.sessionId };
    const alienState = { ...baseState(created.sessionId), goalId: alien.goalId };
    await assert.rejects(foreign.create(alienState), /different goal/);
    await assert.rejects(foreign.load(alien), /different goal/);
    await assert.rejects(foreign.replay(alien), /different goal/);
    await assert.rejects(foreign.listPending(alien), /different goal/);
    await assert.rejects(foreign.claim(alien, 'foreign-model-op', 'model-b'), /different goal/);
    await assert.rejects(foreign.commit(
        { ...created, goalId: alien.goalId },
        alienState,
        {
            scope: 'control', fence: { ...alien, controllerEpoch: 1 },
            execution: { executionId: 'foreign-execution', attemptId: 'foreign-attempt' },
            auditEvents: [], event: { type: 'completion', outcome: 'failed', error: 'foreign' },
        },
    ), /different goal/);
    const gate = foreign.asRuntimePorts().providerFirstEffects;
    await assert.rejects(gate.start({
        ...alien, controllerEpoch: 1, generation: 1, kind: 'open', operationId: 'foreign-open',
    }, 'provider_primitive', () => startedProviderEffect(Promise.resolve(), () => undefined)), /different goal/);
});

test('each claimed stage starts once and distinct inner stages remain legitimate', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-one-stages-'));
    const filename = path.join(directory, 'runtime.sqlite');
    const first = new SqliteGoalSessionTestPorts(filename);
    const duplicate = new SqliteGoalSessionTestPorts(filename);
    t.after(() => { first.close(); duplicate.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const { state, fence } = operationCase('open', 'stage-session');
    await first.create(state);
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    let providerStarts = 0, duplicateStarts = 0, containerStarts = 0;
    const provider = first.asRuntimePorts().providerFirstEffects.start(fence, 'provider_primitive', () => {
        providerStarts += 1;
        return startedProviderEffect(completion, () => undefined);
    });
    await assert.rejects(duplicate.asRuntimePorts().providerFirstEffects.start(
        fence, 'provider_primitive', () => {
            duplicateStarts += 1;
            return startedProviderEffect(Promise.resolve(), () => undefined);
        },
    ), /in doubt/);
    await duplicate.asRuntimePorts().providerFirstEffects.start(fence, 'container_spawn', () => {
        containerStarts += 1;
        return startedProviderEffect(Promise.resolve(), () => undefined);
    });
    assert.deepEqual({ providerStarts, duplicateStarts, containerStarts }, {
        providerStarts: 1, duplicateStarts: 0, containerStarts: 1,
    });
    finish();
    await provider;
});

test('post-start receipt/commit failures clean up and permanently fence retry', async t => {
    for (const fault of ['receipt_write', 'commit'] as const) {
        await t.test(fault, async () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-one-failure-'));
            const filename = path.join(directory, 'runtime.sqlite');
            const effects = new SqliteGoalSessionTestPorts(filename);
            const retry = new SqliteGoalSessionTestPorts(filename);
            try {
                const { state, fence } = operationCase('open', `failure-${fault}`);
                await effects.create(state);
                effects.setProviderFault(fault);
                let starts = 0, cleanups = 0;
                await assert.rejects(effects.asRuntimePorts().providerFirstEffects.start(
                    fence, 'provider_primitive', () => {
                        starts += 1;
                        return startedProviderEffect(Promise.resolve(), () => { cleanups += 1; });
                    },
                ), /failure/);
                await assert.rejects(retry.asRuntimePorts().providerFirstEffects.start(
                    fence, 'provider_primitive', () => {
                        starts += 1;
                        return startedProviderEffect(Promise.resolve(), () => { cleanups += 1; });
                    },
                ), /in doubt/);
                assert.deepEqual({ starts, cleanups }, { starts: 1, cleanups: 1 });
            } finally {
                effects.close(); retry.close(); fs.rmSync(directory, { recursive: true, force: true });
            }
        });
    }
});

test('cleanup failure and synchronous throw remain durable in-doubt without reentry', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-one-cleanup-'));
    const filename = path.join(directory, 'runtime.sqlite');
    const ports = new SqliteGoalSessionTestPorts(filename);
    const peer = new SqliteGoalSessionTestPorts(filename);
    t.after(() => { ports.close(); peer.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const firstCase = operationCase('open', 'cleanup-failure');
    await ports.create(firstCase.state);
    ports.setProviderFault('commit');
    let starts = 0, reentrantStarts = 0;
    const gate = ports.asRuntimePorts().providerFirstEffects;
    await assert.rejects(gate.start(firstCase.fence, 'provider_primitive', () => {
        starts += 1;
        return startedProviderEffect(Promise.resolve(), async () => {
            await assert.rejects(peer.asRuntimePorts().providerFirstEffects.start(
                firstCase.fence, 'provider_primitive', () => {
                    reentrantStarts += 1;
                    return startedProviderEffect(Promise.resolve(), () => undefined);
                },
            ), /in doubt/);
            throw new Error('cancel failed');
        });
    }), /cleanup failed/);
    await assert.rejects(gate.start(firstCase.fence, 'provider_primitive', () => {
        starts += 1;
        return startedProviderEffect(Promise.resolve(), () => undefined);
    }), /in doubt/);

    const thrownCase = operationCase('open', 'sync-throw');
    await ports.create(thrownCase.state);
    let synchronousEntries = 0;
    await assert.rejects(gate.start(thrownCase.fence, 'provider_primitive', () => {
        synchronousEntries += 1;
        throw new Error('synchronous start failure');
    }), /synchronous start failure/);
    await assert.rejects(gate.start(thrownCase.fence, 'provider_primitive', () => {
        synchronousEntries += 1;
        return startedProviderEffect(Promise.resolve(), () => undefined);
    }), /in doubt/);
    assert.deepEqual({ starts, reentrantStarts, synchronousEntries }, {
        starts: 1, reentrantStarts: 0, synchronousEntries: 1,
    });
});

test('handle validation failure invokes safe cleanup and cannot retry the started stage', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-one-invalid-handle-'));
    const filename = path.join(directory, 'runtime.sqlite');
    const ports = new SqliteGoalSessionTestPorts(filename);
    const peer = new SqliteGoalSessionTestPorts(filename);
    t.after(() => { ports.close(); peer.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const { state, fence } = operationCase('open', 'invalid-handle');
    await ports.create(state);
    let starts = 0, cleanups = 0;
    const malformed = Object.freeze(Object.assign(Object.create(null), {
        completion: Promise.resolve(),
        cleanup: Object.freeze({ kind: 'rollback_or_cancel', run: () => { cleanups += 1; } }),
    }));
    await assert.rejects(ports.asRuntimePorts().providerFirstEffects.start(
        fence, 'provider_primitive', () => { starts += 1; return malformed; },
    ), /started-effect handle/);
    await assert.rejects(peer.asRuntimePorts().providerFirstEffects.start(
        fence, 'provider_primitive', () => {
            starts += 1;
            return startedProviderEffect(Promise.resolve(), () => undefined);
        },
    ), /in doubt/);
    assert.deepEqual({ starts, cleanups }, { starts: 1, cleanups: 1 });
});

test('started handles reject thenables, accessors, cross-realm promises, and forgery without assimilation', () => {
    let assimilations = 0, getterReads = 0;
    const lazyThenable = { then() { assimilations += 1; } };
    const accessor = Object.create(null);
    Object.defineProperty(accessor, 'completion', {
        get() { getterReads += 1; throw new Error('getter must not run'); },
    });
    Object.defineProperty(accessor, 'cleanup', { value: Object.freeze({
        kind: 'rollback_or_cancel', run: () => undefined,
    }) });
    const callableThen = Object.freeze({
        completion: Promise.resolve(), cleanup: Object.freeze({ kind: 'rollback_or_cancel', run: () => undefined }),
        then() { assimilations += 1; },
    });
    const crossRealm = vm.runInNewContext('Promise.resolve(1)') as Promise<number>;
    const unbranded = Object.freeze(Object.assign(Object.create(null), {
        completion: Promise.resolve(), cleanup: Object.freeze({ kind: 'rollback_or_cancel', run: () => undefined }),
    }));
    for (const hostile of [
        Object.freeze(Object.assign(Object.create(null), {
            completion: lazyThenable, cleanup: Object.freeze({ kind: 'rollback_or_cancel', run: () => undefined }),
        })),
        accessor,
        callableThen,
        unbranded,
    ]) assert.throws(() => assertStartedProviderEffect(hostile), /started-effect handle/);
    assert.throws(() => startedProviderEffect(crossRealm, () => undefined), /native completion/);
    assert.deepEqual({ assimilations, getterReads }, { assimilations: 0, getterReads: 0 });
    const exact = startedProviderEffect(Promise.resolve(1), () => undefined);
    assert.ok(Object.isFrozen(exact));
    assert.equal('then' in exact, false);
    assert.doesNotThrow(() => assertStartedProviderEffect(exact));
});

function createExactControlTables(database: Database.Database): void {
    database.exec(`
        CREATE TABLE goal_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, sequence INTEGER NOT NULL,
            kind TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT, idempotency_key TEXT NOT NULL,
            lease_epoch INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX goal_events_goal_sequence_idx ON goal_events(goal_id, sequence);
        CREATE UNIQUE INDEX goal_events_goal_idempotency_idx ON goal_events(goal_id, idempotency_key);
        CREATE TABLE goal_messages (
            message_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL,
            predefined_kind TEXT, state TEXT NOT NULL DEFAULT 'queued', delivered_at TEXT, acknowledged_at TEXT,
            delivery_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, idempotency_key TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX goal_messages_goal_sequence_idx ON goal_messages(goal_id, sequence);
        CREATE UNIQUE INDEX goal_messages_goal_idempotency_idx ON goal_messages(goal_id, idempotency_key);
    `);
}

function tableColumns(database: Database.Database, table: string): string[] {
    return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
}
