import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import knex from 'knex';
import type {
    GoalProviderOpenRequest, GoalProviderSessionSnapshot, GoalSessionAdapter, GoalSessionState,
} from '../src/agents/goalSession/contract.js';
import { AuthoritativeGoalSessionRuntimePorts } from '../src/agents/goalSession/AuthoritativeGoalSessionRuntimePorts.js';
import { GoalSessionContractError, GoalSessionScopeError } from '../src/agents/goalSession/errors.js';
import { GoalSessionSupervisor } from '../src/agents/goalSession/GoalSessionSupervisor.js';
import { GoalContainerSupervisor } from '../src/agents/goalSession/GoalContainerSupervisor.js';
import { issueGoalSupervisedOpenPlan } from '../src/agents/goalSession/goalSessionOpen.js';
import { startedProviderEffect } from '../src/agents/goalSession/providerEffectProtocol.js';
import { rebuildMessageAcknowledgement, rebuildProviderSnapshot } from '../src/agents/goalSession/providerResultBoundary.js';
import {
    createSqliteGoalSessionRuntimePorts, SqliteGoalSessionControlDomain,
} from '../src/agents/goalSession/SqliteGoalSessionControlDomain.js';
import { createProductionSchema, recovery, seedAuthoritativeGoal } from './productionGoalSessionTestSupport.js';

const identity = { goalId: 'production-goal', sessionId: 'production-session' };

function initialState(overrides: Partial<Omit<GoalSessionState, 'version'>> = {}): Omit<GoalSessionState, 'version'> {
    const now = new Date().toISOString();
    return {
        ...identity, provider: 'adapter', controllerEpoch: 1, status: 'initializing',
        completedTurnIds: [], providerOpenAttemptId: 'open-attempt',
        providerOpenOperationGeneration: 1, providerOperationGeneration: 1,
        createdAt: now, updatedAt: now, ...overrides,
    };
}

function runningState(): Omit<GoalSessionState, 'version'> {
    return initialState({
        status: 'running', providerSessionId: 'provider-session', currentModel: 'model-a',
        activeTurn: {
            turnId: 'turn-one', executionId: 'execution-one', attemptId: 'attempt-one', executionEpoch: 1,
            objective: 'exercise production fencing', requestedModel: 'model-a',
            repository: { repository: 'integry/propr', worktreePath: '/tmp/worktree', branch: 'main' },
            status: 'running', providerOperationGeneration: 1,
        },
    });
}

function openFence(operationId = 'open-attempt') {
    return { ...identity, controllerEpoch: 1, generation: 1, kind: 'open' as const, operationId };
}

function steerFence() {
    return {
        ...identity, controllerEpoch: 1, generation: 1, kind: 'steer' as const,
        operationId: 'message-one', turnId: 'turn-one', executionId: 'execution-one', attemptId: 'attempt-one',
    };
}

test('actual #2018 and provider migrations compose in both orders, reopen, and rollback/up', async t => {
    const foundation = await import('../src/db/migrations/20260831000000_create_goal_control_plane.js');
    const replay = await import('../src/db/migrations/20260901000000_add_durable_goal_replay.js');
    const runtime = await import('../src/db/migrations/20260902000000_extend_goal_control_provider_effects.js');
    for (const ordering of ['control-first', 'runtime-first'] as const) await t.test(ordering, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-real-migrations-'));
        const filename = path.join(directory, 'control.sqlite');
        const client = knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true });
        try {
            if (ordering === 'runtime-first') await runtime.up(client);
            await foundation.up(client);
            await replay.up(client);
            if (ordering === 'control-first') await runtime.up(client);
            await runtime.down(client);
            await runtime.up(client);
        } finally { await client.destroy(); }
        const first = new Database(filename);
        seedAuthoritativeGoal(first, { goalId: identity.goalId, agent: 'adapter' });
        assert.doesNotThrow(() => new SqliteGoalSessionControlDomain(first));
        first.close();
        const reopened = new Database(filename);
        assert.doesNotThrow(() => new SqliteGoalSessionControlDomain(reopened));
        assert.equal(reopened.prepare("SELECT 1 FROM sqlite_master WHERE name = 'goal_session_runtime_owners'").get(), undefined);
        reopened.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
});

test('goal_provider_sessions is the sole global owner and missing/wrong owners fail closed', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-global-owner-'));
    const filename = path.join(directory, 'control.sqlite');
    await createProductionSchema(filename);
    const database = new Database(filename);
    seedAuthoritativeGoal(database, { goalId: identity.goalId, agent: 'adapter' });
    seedAuthoritativeGoal(database, { goalId: 'other-goal', agent: 'adapter' });
    const domain = new SqliteGoalSessionControlDomain(database);
    assert.ok(await domain.create(initialState()));
    await assert.rejects(domain.load({ goalId: 'other-goal', sessionId: identity.sessionId }), GoalSessionScopeError);
    await assert.rejects(domain.load({ goalId: identity.goalId, sessionId: 'missing-session' }), GoalSessionScopeError);
    await assert.rejects(domain.replay({ goalId: 'other-goal', sessionId: identity.sessionId }), GoalSessionScopeError);
    await assert.rejects(domain.claim({ goalId: 'other-goal', sessionId: identity.sessionId }, 'model-op', 'model-b'), GoalSessionScopeError);
    await assert.rejects(domain.create(initialState({ goalId: 'other-goal' })), GoalSessionScopeError);
    assert.deepEqual(database.prepare('SELECT session_id, goal_id FROM goal_provider_sessions').all(), [
        { session_id: identity.sessionId, goal_id: identity.goalId },
    ]);
    database.close();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
});

test('two production supervisors recover and cancel one exact-label pending-open container', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-pending-open-owner-'));
    const filename = path.join(directory, 'control.sqlite');
    const statePath = path.join(directory, 'container.state');
    const logPath = path.join(directory, 'docker.log');
    const dockerPath = path.join(import.meta.dirname, 'fixtures', 'fake-pending-open-docker.mjs');
    await createProductionSchema(filename);
    const firstDatabase = new Database(filename);
    seedAuthoritativeGoal(firstDatabase, { goalId: identity.goalId, agent: 'adapter' });
    const firstRuntime = createSqliteGoalSessionRuntimePorts(firstDatabase, recovery);
    assert.ok(await firstRuntime.state.create(initialState()));
    const secondDatabase = new Database(filename);
    const secondRuntime = createSqliteGoalSessionRuntimePorts(secondDatabase, recovery);
    const first = new GoalContainerSupervisor(directory, firstRuntime.events, undefined, { dockerPath });
    const second = new GoalContainerSupervisor(directory, secondRuntime.events, undefined, { dockerPath });
    const pendingIdentity = {
        ...identity, attemptId: 'open-attempt', deterministicOpenKey: 'durable-open-key',
    };
    fs.writeFileSync(statePath, 'pending-container');
    fs.writeFileSync(logPath, '');
    const previous = {
        state: process.env.GOAL_PENDING_OPEN_STATE,
        log: process.env.GOAL_PENDING_OPEN_LOG,
        labels: process.env.GOAL_PENDING_OPEN_LABELS,
    };
    process.env.GOAL_PENDING_OPEN_STATE = statePath;
    process.env.GOAL_PENDING_OPEN_LOG = logPath;
    process.env.GOAL_PENDING_OPEN_LABELS = JSON.stringify({
        'propr.goal.id': identity.goalId,
        'propr.goal.session': identity.sessionId,
        'propr.goal.scope': 'open',
        'propr.goal.attempt': pendingIdentity.attemptId,
        'propr.goal.open-key': pendingIdentity.deterministicOpenKey,
    });
    try {
        await Promise.all([
            first.cancelPendingOpenAttempt(pendingIdentity),
            second.cancelPendingOpenAttempt(pendingIdentity),
        ]);
    } finally {
        restoreEnvironment('GOAL_PENDING_OPEN_STATE', previous.state);
        restoreEnvironment('GOAL_PENDING_OPEN_LOG', previous.log);
        restoreEnvironment('GOAL_PENDING_OPEN_LABELS', previous.labels);
    }
    assert.equal(fs.existsSync(statePath), false);
    const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.ok(calls.some(call => call[0] === 'rm' && call[2] === 'pending-container'));
    assert.ok(calls.filter(call => call[0] === 'ps').every(call => call.includes('label=propr.goal.scope=open')));
    firstDatabase.close(); secondDatabase.close();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
});

test('token-fenced production effects admit one non-open callback and replay only settled DTOs', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-effect-token-'));
    const filename = path.join(directory, 'control.sqlite');
    await createProductionSchema(filename);
    const firstDatabase = new Database(filename);
    seedAuthoritativeGoal(firstDatabase, { goalId: identity.goalId, agent: 'adapter' });
    const firstDomain = new SqliteGoalSessionControlDomain(firstDatabase);
    assert.ok(await firstDomain.create(runningState()));
    const secondDatabase = new Database(filename);
    const first = new AuthoritativeGoalSessionRuntimePorts(firstDomain, recovery);
    const duplicate = new AuthoritativeGoalSessionRuntimePorts(new SqliteGoalSessionControlDomain(secondDatabase), recovery);
    let resolve!: (value: { messageId: string }) => void;
    const completion = new Promise<{ messageId: string }>(done => { resolve = done; });
    let callbacks = 0;
    const delivery = first.start(steerFence(), 'provider_primitive', () => {
        callbacks += 1;
        return startedProviderEffect(completion, () => undefined);
    }, rebuildMessageAcknowledgement);
    await new Promise<void>(done => setImmediate(done));
    await assert.rejects(duplicate.start(steerFence(), 'provider_primitive', () => {
        callbacks += 1;
        return startedProviderEffect(Promise.resolve({ messageId: 'wrong' }), () => undefined);
    }, rebuildMessageAcknowledgement), providerDoubt);
    resolve({ messageId: 'message-one' });
    assert.deepEqual(await delivery, { messageId: 'message-one' });
    let replayedCallback = false;
    assert.deepEqual(await duplicate.start(steerFence(), 'provider_primitive', () => {
        replayedCallback = true;
        return startedProviderEffect(Promise.resolve({ messageId: 'wrong' }), () => undefined);
    }, rebuildMessageAcknowledgement), { messageId: 'message-one' });
    assert.deepEqual({ callbacks, replayedCallback }, { callbacks: 1, replayedCallback: false });
    firstDatabase.close(); secondDatabase.close();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
});

test('every internal effect stage is independently fenced across two SQLite connections', async t => {
    for (const stage of ['provider_primitive', 'stream_first_next', 'container_spawn'] as const) await t.test(stage, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-effect-stage-'));
        const filename = path.join(directory, 'control.sqlite');
        await createProductionSchema(filename);
        const database = new Database(filename);
        seedAuthoritativeGoal(database, { goalId: identity.goalId, agent: 'adapter' });
        const domain = new SqliteGoalSessionControlDomain(database);
        assert.ok(await domain.create(initialState()));
        const peerDatabase = new Database(filename);
        const gate = new AuthoritativeGoalSessionRuntimePorts(domain, recovery);
        const peer = new AuthoritativeGoalSessionRuntimePorts(new SqliteGoalSessionControlDomain(peerDatabase), recovery);
        let callbacks = 0;
        const first = await gate.start(openFence(), stage, () => {
            callbacks += 1;
            return startedProviderEffect(Promise.resolve({ messageId: stage }), () => undefined);
        }, rebuildMessageAcknowledgement);
        assert.equal(first.messageId, stage);
        if (stage === 'container_spawn') {
            await assert.rejects(peer.start(openFence(), stage, () => {
                callbacks += 1;
                return startedProviderEffect(Promise.resolve({ messageId: 'duplicate' }), () => undefined);
            }, rebuildMessageAcknowledgement), providerDoubt);
        } else {
            assert.deepEqual(await peer.start(openFence(), stage, () => {
                callbacks += 1;
                return startedProviderEffect(Promise.resolve({ messageId: 'duplicate' }), () => undefined);
            }, rebuildMessageAcknowledgement), first);
        }
        assert.equal(callbacks, 1);
        database.close(); peerDatabase.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
});

test('hostile and lossy provider values poison the exact token before settlement', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-hostile-result-'));
    const filename = path.join(directory, 'control.sqlite');
    await createProductionSchema(filename);
    const database = new Database(filename);
    seedAuthoritativeGoal(database, { goalId: identity.goalId, agent: 'adapter' });
    const domain = new SqliteGoalSessionControlDomain(database);
    assert.ok(await domain.create(initialState()));
    const gate = new AuthoritativeGoalSessionRuntimePorts(domain, recovery);
    let toJsonCalls = 0;
    const hostile = {
        providerSessionId: 'provider-session', recoveryMetadata: {},
        toJSON() { toJsonCalls += 1; return { providerSessionId: 'clean', recoveryMetadata: {} }; },
    };
    let callbacks = 0;
    await assert.rejects(gate.start(openFence(), 'provider_primitive', () => {
        callbacks += 1;
        return startedProviderEffect(Promise.resolve(hostile), () => undefined);
    }, value => rebuildProviderSnapshot(value, 'adapter')), /invalid session snapshot/);
    await assert.rejects(gate.start(openFence(), 'provider_primitive', () => {
        callbacks += 1;
        return startedProviderEffect(Promise.resolve({ providerSessionId: 'other', recoveryMetadata: {} }), () => undefined);
    }, value => rebuildProviderSnapshot(value, 'adapter')), providerDoubt);
    assert.deepEqual({ callbacks, toJsonCalls }, { callbacks: 1, toJsonCalls: 0 });
    assert.equal((database.prepare('SELECT status FROM goal_session_runtime_provider_effects').get() as { status: string }).status, 'poisoned');
    database.close();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
});

test('closed fences, 255-byte IDs, allocator replay, and message state obey #2018', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-boundaries-'));
    const filename = path.join(directory, 'control.sqlite');
    await createProductionSchema(filename);
    const database = new Database(filename);
    seedAuthoritativeGoal(database, { goalId: identity.goalId, agent: 'adapter' });
    const domain = new SqliteGoalSessionControlDomain(database);
    assert.ok(await domain.create(runningState()));
    const beforeEffects = database.prepare('SELECT COUNT(*) AS count FROM goal_session_runtime_provider_effects').get() as { count: number };
    await assert.rejects(domain.claimProviderEffect({ ...steerFence(), kind: 'future' } as never, 'provider_primitive'));
    await assert.rejects(domain.claimProviderEffect({ ...steerFence(), excess: true } as never, 'provider_primitive'));
    await assert.rejects(domain.claimProviderEffect(steerFence(), 'future' as never));
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM goal_session_runtime_provider_effects').get() as { count: number }).count, beforeEffects.count);

    const state = await domain.load(identity);
    assert.ok(state?.activeTurn);
    const appended = await domain.append(
        { ...identity, controllerEpoch: 1, turnId: 'turn-one' },
        { executionId: 'execution-one', attemptId: 'attempt-one' },
        { type: 'output', channel: 'stdout', data: 'hello' },
    );
    assert.equal(appended.accepted, true);
    const eventRow = database.prepare('SELECT sequence, kind, event_type FROM goal_events').get() as Record<string, unknown>;
    assert.deepEqual(eventRow, { sequence: 1, kind: 'domain', event_type: 'goal_session.output' });
    assert.equal((database.prepare('SELECT high_watermark FROM goal_event_state WHERE goal_id = ?').get(identity.goalId) as { high_watermark: number }).high_watermark, 1);
    database.prepare(`INSERT INTO goal_events
        (goal_id, sequence, kind, event_type, payload_json, idempotency_key, lease_epoch, created_at,
            schema_version, payload_bytes)
        VALUES (?, 2, 'domain', 'unrelated.event', NULL, 'unrelated-null', 1, ?, 1, 0)`)
        .run(identity.goalId, new Date().toISOString());
    database.prepare('UPDATE goal_event_state SET high_watermark = 2 WHERE goal_id = ?').run(identity.goalId);
    assert.equal((await domain.replay(identity)).length, 1);

    database.prepare(`INSERT INTO goal_messages
        (message_id, goal_id, sequence, queue_ordinal, body, state, delivery_attempts, retry_count,
            idempotency_key, created_at)
        VALUES ('message-one', ?, 1, 1, 'corrective', 'queued', 0, 0, 'message-key', ?)`)
        .run(identity.goalId, new Date().toISOString());
    assert.equal(await domain.acknowledgeWithEvent(
        { ...identity, controllerEpoch: 1, turnId: 'turn-one' },
        { executionId: 'execution-one', attemptId: 'attempt-one' }, 'message-one',
    ), 'acknowledged');
    const message = database.prepare(`SELECT state, delivered_at, acknowledged_at
        FROM goal_messages WHERE message_id = 'message-one'`).get() as Record<string, unknown>;
    assert.equal(message.state, 'acknowledged');
    assert.equal(typeof message.delivered_at, 'string');
    assert.equal(typeof message.acknowledged_at, 'string');

    const longGoal = `g${'a'.repeat(254)}`;
    const longSession = `s${'b'.repeat(254)}`;
    seedAuthoritativeGoal(database, { goalId: longGoal, agent: 'adapter' });
    assert.ok(await domain.create(initialState({ goalId: longGoal, sessionId: longSession })));
    await assert.rejects(domain.create(initialState({
        goalId: `g${'a'.repeat(255)}`, sessionId: `s${'b'.repeat(255)}`,
    })), GoalSessionScopeError);
    database.close();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
});

test('settled successful open survives state-CAS crash with one total thread/start', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-open-settled-'));
    const filename = path.join(directory, 'control.sqlite');
    await createProductionSchema(filename);
    const database = new Database(filename);
    seedAuthoritativeGoal(database, { goalId: identity.goalId, agent: 'codex', model: 'gpt-5.6-sol' });
    const runtime = createSqliteGoalSessionRuntimePorts(database, recovery);
    let starts = 0;
    const adapter = codexAdapter(() => { starts += 1; });
    const plan = issueGoalSupervisedOpenPlan({
        repository: { repository: 'integry/propr', worktreePath: '/tmp/worktree', branch: 'main' },
        requestedModel: 'gpt-5.6-sol', providerHomeTarget: '/home/node/.codex', credentialTargets: [],
    }, {
        createTransport: async () => inertTransport(), cancelPending: async () => undefined,
        transferPending: () => undefined,
    });
    const originalCompareAndSet = runtime.state.compareAndSet.bind(runtime.state);
    let crash = true;
    runtime.state.compareAndSet = async (expected, next) => {
        if (crash && next.providerSessionId) { crash = false; return null; }
        return originalCompareAndSet(expected, next);
    };
    const first = new GoalSessionSupervisor(adapter, runtime, () => 'open-attempt');
    await assert.rejects(first.openSession({ ...identity, provider: 'codex', controllerEpoch: 1, supervisedOpen: plan }));
    const replacement = new GoalSessionSupervisor(adapter, runtime, () => 'replacement-attempt');
    const reopened = await replacement.openSession({ ...identity, provider: 'codex', controllerEpoch: 1, supervisedOpen: plan });
    assert.equal(reopened.providerSessionId, 'codex-thread');
    assert.equal(starts, 1, 'thread/start is replayed from the exact settled operation');
    database.close();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
});

function providerDoubt(error: unknown): boolean {
    return error instanceof GoalSessionContractError && error.code === 'PROVIDER_EFFECT_IN_DOUBT';
}

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function codexAdapter(onStart: () => void): GoalSessionAdapter {
    return {
        provider: 'codex', supportsDeterministicOpen: true,
        capabilities: { nativeSessionId: 'eager', steering: 'active_turn', pause: 'after_turn', modelChange: 'next_turn' },
        publishOperationBarrier: async () => undefined,
        openSession: async (request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot> => {
            onStart();
            return {
                providerSessionId: 'codex-thread', model: 'gpt-5.6-sol', recoveryMetadata: {
                    version: 2, provider: 'codex', protocolVersion: 'app-server-0.146.0', payload: {
                        threadId: 'codex-thread', sessionId: 'codex-session', initialized: true,
                        openKey: request.deterministicOpenKey!, repository: 'integry/propr', model: 'gpt-5.6-sol',
                        providerHomeIdentity: '/home/node/.codex', cliVersion: '0.146.0',
                    }, usage: { components: [] },
                },
            };
        },
        beginTurn: async function* () {}, resumeSession: async (_request, snapshot) => snapshot,
        requestModelChange: async request => ({ requestedModel: request.model, appliesAt: 'next_turn' }),
        cancel: async () => undefined, cancelPending: async () => undefined,
        reconcile: async () => ({ outcome: 'failed', reason: 'unused' }),
    };
}

function inertTransport() {
    return {
        output: { async *[Symbol.asyncIterator]() {} }, write: async () => undefined,
        closeInput: () => undefined, cancel: async () => undefined,
        completion: Promise.resolve({ exitCode: 0 }),
    };
}
