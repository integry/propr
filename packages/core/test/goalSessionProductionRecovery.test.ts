import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import knex from 'knex';
import type {
    GoalBeginTurnRequest, GoalProviderCancelRequest, GoalProviderOpenRequest,
    GoalProviderSessionSnapshot, GoalSessionAdapter, GoalSessionEvent, GoalSessionState,
} from '../src/agents/goalSession/contract.js';
import { GoalSessionContractError, providerOpenInDoubtError } from '../src/agents/goalSession/errors.js';
import { AuthoritativeGoalSessionRuntimePorts } from '../src/agents/goalSession/AuthoritativeGoalSessionRuntimePorts.js';
import { GoalSessionSupervisor } from '../src/agents/goalSession/GoalSessionSupervisor.js';
import { issueGoalSupervisedOpenPlan } from '../src/agents/goalSession/goalSessionOpen.js';
import { startedProviderEffect } from '../src/agents/goalSession/providerEffectProtocol.js';
import {
    createSqliteGoalSessionRuntimePorts, SqliteGoalSessionControlDomain,
} from '../src/agents/goalSession/SqliteGoalSessionControlDomain.js';
import {
    createControlTables, createProductionSchema, createRuntimeExtensionTables, recovery,
} from './productionGoalSessionTestSupport.js';

const identity = { goalId: 'production-recovery-goal', sessionId: 'production-recovery-session' };

function openState(operationId = 'open-attempt'): Omit<GoalSessionState, 'version'> {
    const timestamp = new Date().toISOString();
    return {
        ...identity, provider: 'adapter', controllerEpoch: 1, status: 'initializing',
        completedTurnIds: [], providerOpenAttemptId: operationId,
        providerOpenOperationGeneration: 1, providerOperationGeneration: 1,
        createdAt: timestamp, updatedAt: timestamp,
    };
}

function openFence(operationId = 'open-attempt') {
    return {
        ...identity, controllerEpoch: 1, generation: 1,
        kind: 'open' as const, operationId,
    };
}

function runningTurnState(): Omit<GoalSessionState, 'version'> {
    const state = openState();
    return {
        ...state, status: 'running', providerSessionId: 'native-session', currentModel: 'model-a',
        activeTurn: {
            turnId: 'turn-one', executionId: 'execution-one', attemptId: 'attempt-one', executionEpoch: 1,
            objective: 'recover delivery', requestedModel: 'model-a',
            repository: { repository: 'integry/propr', worktreePath: '/tmp/worktree', branch: 'main' },
            status: 'running', providerOperationGeneration: 1,
        },
    };
}

test('production composition fails closed without the complete migrated control schema', () => {
    const database = new Database(':memory:');
    assert.throws(() => createSqliteGoalSessionRuntimePorts(database, recovery), (error: unknown) =>
        error instanceof GoalSessionContractError && error.code === 'AUTHORITATIVE_DOMAIN_MISSING');
    database.close();
});

test('provider-effect extension and exact #2018 control schema compose in both initialization orders', async t => {
    for (const ordering of ['control_first', 'runtime_first'] as const) {
        await t.test(ordering, async () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), `goal-schema-${ordering}-`));
            const filename = path.join(directory, 'control.sqlite');
            if (ordering === 'control_first') {
                const control = new Database(filename);
                createControlTables(control);
                control.close();
            }
            const client = knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true });
            const migration = await import('../src/db/migrations/20260902000000_extend_goal_control_provider_effects.js');
            await migration.up(client);
            await client.destroy();
            if (ordering === 'runtime_first') {
                const control = new Database(filename);
                createControlTables(control);
                control.close();
            }
            const database = new Database(filename);
            assert.doesNotThrow(() => new SqliteGoalSessionControlDomain(database));
            const eventColumns = (database.prepare('PRAGMA table_info(goal_events)').all() as Array<{ name: string }>).map(row => row.name);
            assert.deepEqual(eventColumns, [
                'id', 'goal_id', 'sequence', 'kind', 'event_type', 'payload_json',
                'idempotency_key', 'lease_epoch', 'created_at',
            ]);
            database.close();
            fs.rmSync(directory, { recursive: true, force: true });
        });
    }
});

test('production durable effects recover provider-success/local-persistence loss and replay settled outcomes', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-production-recovery-'));
    const filename = path.join(directory, 'control.sqlite');
    createProductionSchema(filename);
    let database = new Database(filename);
    let domain = new SqliteGoalSessionControlDomain(database);
    const created = await domain.create(runningTurnState());
    assert.ok(created);
    let resolveCompletion!: (value: { messageId: string }) => void;
    let callbackEntries = 0;
    let externalEffects = 0;
    const adopted = new Map<string, { messageId: string }>();
    const invoke = () => {
        callbackEntries += 1;
        let outcome = adopted.get('open-attempt');
        if (!outcome) {
            externalEffects += 1;
            outcome = { messageId: 'durable-message' };
            adopted.set('open-attempt', outcome);
        }
        return outcome;
    };
    const completion = new Promise<{ messageId: string }>(resolve => { resolveCompletion = resolve; });
    const recoveryFence = {
        ...identity, controllerEpoch: 1, generation: 1, kind: 'steer' as const,
        operationId: 'steer-message', turnId: 'turn-one', executionId: 'execution-one', attemptId: 'attempt-one',
    };
    const interrupted = domainAsGate(domain).start(recoveryFence, 'provider_primitive', () => {
        invoke();
        return startedProviderEffect(completion, () => undefined);
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    database.close();
    resolveCompletion(adopted.get('open-attempt')!);
    await assert.rejects(interrupted);

    database = new Database(filename);
    domain = new SqliteGoalSessionControlDomain(database);
    const recovered = await domainAsGate(domain).start(recoveryFence, 'provider_primitive', () =>
        startedProviderEffect(Promise.resolve(invoke()), () => undefined));
    assert.deepEqual(recovered, { messageId: 'durable-message' });
    let replayCallback = false;
    const replayed = await domainAsGate(domain).start(recoveryFence, 'provider_primitive', () => {
        replayCallback = true;
        return startedProviderEffect(Promise.resolve({ messageId: 'wrong' }), () => undefined);
    });
    assert.deepEqual(replayed, recovered);
    assert.deepEqual({ externalEffects, callbackEntries, replayCallback }, {
        externalEffects: 1, callbackEntries: 2, replayCallback: false,
    });
    database.close();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
});

test('runtime and database reject forged stages before effect and preserve all three nested identities', async () => {
    const database = new Database(':memory:');
    createProductionSchemaForMemory(database);
    const domain = new SqliteGoalSessionControlDomain(database);
    await domain.create(openState());
    await assert.rejects(domain.load({ goalId: 'foreign-goal', sessionId: identity.sessionId }), /different goal/);
    let effects = 0;
    await assert.rejects(domainAsGate(domain).start(openFence(), 'forged' as never, () => {
        effects += 1;
        return startedProviderEffect(Promise.resolve(), () => undefined);
    }), /three internal stages/);
    await assert.rejects((domain.claimProviderEffect as (f: ReturnType<typeof openFence>, s: string) => Promise<unknown>)(
        openFence(), 'forged',
    ), /three internal stages/);
    const gate = domainAsGate(domain);
    await gate.start(openFence(), 'container_spawn', () => {
        effects += 1;
        return startedProviderEffect(gate.start(openFence(), 'provider_primitive', () => {
            effects += 1;
            return startedProviderEffect(gate.start(openFence(), 'stream_first_next', () => {
                effects += 1;
                return startedProviderEffect(Promise.resolve('nested'), () => undefined);
            }), () => undefined);
        }), () => undefined);
    });
    assert.equal(effects, 3);
    database.close();
});

test('forged supervised plans start no provider work and response-loss reopen remains terminal', async () => {
    const database = new Database(':memory:');
    createProductionSchemaForMemory(database);
    let threadStarts = 0;
    const adapter = responseLossAdapter(() => { threadStarts += 1; });
    const runtime = createSqliteGoalSessionRuntimePorts(database, recovery);
    const first = new GoalSessionSupervisor(adapter, runtime, () => 'attempt-response-loss');
    const forged = {
        repository: { repository: 'integry/propr', worktreePath: '/tmp/worktree', branch: 'main' },
        requestedModel: 'gpt-5.6-sol', providerHomeTarget: '/home/node/.codex', credentialTargets: [],
    };
    await assert.rejects(first.openSession({
        ...identity, provider: 'codex', controllerEpoch: 1, supervisedOpen: forged,
    }), /not issued/);
    assert.equal(threadStarts, 0);

    const plan = issueGoalSupervisedOpenPlan(forged, {
        createTransport: async () => inertTransport(), cancelPending: async () => undefined,
        transferPending: () => undefined,
    });
    await assert.rejects(first.openSession({ ...identity, provider: 'codex', controllerEpoch: 1, supervisedOpen: plan }),
        (error: unknown) => error instanceof GoalSessionContractError && error.code === 'PROVIDER_OPEN_IN_DOUBT');
    assert.equal((await runtime.state.load(identity))?.status, 'failed');
    const replacement = new GoalSessionSupervisor(adapter, runtime, () => 'attempt-replacement');
    await assert.rejects(replacement.openSession({
        ...identity, provider: 'codex', controllerEpoch: 2, supervisedOpen: plan,
    }), /failed provider session cannot be resumed/);
    assert.equal(threadStarts, 1);
    database.close();
});

test('cancellation between eager spawn and provider primitive cancels exact pending ownership once', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-pending-open-'));
    const filename = path.join(directory, 'control.sqlite');
    createProductionSchema(filename);
    const firstDatabase = new Database(filename);
    const cancellingDatabase = new Database(filename);
    let providerOpens = 0;
    let providerPendingCancels = 0;
    let ownedCancels = 0;
    const adapter = responseLossAdapter(() => { providerOpens += 1; });
    adapter.openSession = async () => {
        providerOpens += 1;
        return { providerSessionId: 'must-not-open', recoveryMetadata: {}, model: 'gpt-5.6-sol' };
    };
    adapter.cancelPending = async () => { providerPendingCancels += 1; };
    const firstRuntime = createSqliteGoalSessionRuntimePorts(firstDatabase, recovery);
    const cancellingRuntime = createSqliteGoalSessionRuntimePorts(cancellingDatabase, recovery);
    const first = new GoalSessionSupervisor(adapter, firstRuntime, () => 'pending-open-attempt');
    const cancelling = new GoalSessionSupervisor(adapter, cancellingRuntime, () => 'cancel-attempt');
    let cancellation: GoalSessionState | undefined;
    const plan = issueGoalSupervisedOpenPlan({
        repository: { repository: 'integry/propr', worktreePath: '/tmp/worktree', branch: 'main' },
        requestedModel: 'gpt-5.6-sol', providerHomeTarget: '/home/node/.codex', credentialTargets: [],
    }, {
        createTransport: async () => {
            cancellation = await cancelling.cancel({ ...identity, controllerEpoch: 1, reason: 'cancel after spawn' });
            return inertTransport();
        },
        cancelPending: async () => { ownedCancels += 1; },
        transferPending: () => assert.fail('stale eager open cannot transfer ownership'),
    });
    await assert.rejects(first.openSession({
        ...identity, provider: 'codex', controllerEpoch: 1, supervisedOpen: plan,
    }));
    assert.equal(cancellation?.status, 'terminated');
    assert.deepEqual({ providerOpens, providerPendingCancels, ownedCancels }, {
        providerOpens: 0, providerPendingCancels: 1, ownedCancels: 1,
    });
    firstDatabase.close();
    cancellingDatabase.close();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
});

function domainAsGate(domain: SqliteGoalSessionControlDomain) {
    return new AuthoritativeGoalSessionRuntimePorts(domain, recovery);
}

function createProductionSchemaForMemory(database: Database.Database): void {
    createControlTables(database);
    createRuntimeExtensionTables(database);
}

function responseLossAdapter(onStart: () => void): GoalSessionAdapter {
    return {
        provider: 'codex', supportsDeterministicOpen: true,
        capabilities: { nativeSessionId: 'eager', steering: 'active_turn', pause: 'after_turn', modelChange: 'next_turn' },
        publishOperationBarrier: async () => undefined,
        openSession: async (_request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot> => {
            onStart();
            throw providerOpenInDoubtError();
        },
        beginTurn: async function* (_request: GoalBeginTurnRequest): AsyncIterable<GoalSessionEvent> {
            yield { type: 'completion', outcome: 'succeeded' };
        },
        resumeSession: async (_request, snapshot) => snapshot,
        requestModelChange: async request => ({ requestedModel: request.model, appliesAt: 'next_turn' }),
        cancel: async (_request: GoalProviderCancelRequest) => undefined,
        cancelPending: async () => undefined,
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
