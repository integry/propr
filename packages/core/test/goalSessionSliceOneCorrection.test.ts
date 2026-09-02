import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
    GoalProviderOperationFence, GoalSessionAdapter, GoalSessionState,
} from '../src/agents/goalSession/contract.js';
import { GoalSessionSupervisor } from '../src/agents/goalSession/GoalSessionSupervisor.js';
import { SqliteGoalSessionRuntimePorts } from '../src/agents/goalSession/SqliteGoalSessionRuntimePorts.js';
import { controlOperationId } from '../src/agents/goalSession/controlOperationIdentity.js';
import { providerFirstEffectStream, startedProviderEffect } from '../src/agents/goalSession/providerEffectProtocol.js';

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
    const effectPorts = new SqliteGoalSessionRuntimePorts(filename, recovery);
    const controllerPorts = new SqliteGoalSessionRuntimePorts(filename, recovery);
    t.after(() => { effectPorts.close(); controllerPorts.close(); fs.rmSync(directory, { recursive: true, force: true }); });

    for (const kind of ['open', 'turn', 'steer', 'pause', 'resume', 'model', 'reconcile', 'cancel'] as const) {
        await t.test(kind, async () => {
            const { state, fence } = operationCase(kind, `session-${kind}`);
            await effectPorts.create(state);
            const current = (await controllerPorts.load(state))!;
            assert.ok(await controllerPorts.compareAndSet(current, invalidatedState(current, kind)));
            let effects = 0;
            await assert.rejects(effectPorts.start(fence, () => {
                effects += 1;
                return startedProviderEffect(Promise.resolve());
            }));
            assert.equal(effects, 0);
        });
    }
    assert.equal(effectPorts.providerEffectCount(), 0);
});

test('stream creation and first next remain effect-free after independent cancellation', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-one-stream-'));
    const filename = path.join(directory, 'runtime.sqlite');
    const effects = new SqliteGoalSessionRuntimePorts(filename, recovery);
    const controller = new SqliteGoalSessionRuntimePorts(filename, recovery);
    t.after(() => { effects.close(); controller.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const { state, fence } = operationCase('turn', 'stream-session');
    await effects.create(state);
    let created = 0, firstNext = 0;
    const stream = providerFirstEffectStream(effects, fence, () => {
        created += 1;
        return { [Symbol.asyncIterator]: () => ({ next: async () => {
            firstNext += 1;
            return { done: true, value: undefined };
        } }) };
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
    const effects = new SqliteGoalSessionRuntimePorts(filename, recovery);
    const controller = new SqliteGoalSessionRuntimePorts(filename, recovery);
    t.after(() => { effects.close(); controller.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const { state, fence } = operationCase('open', 'handle-session');
    await effects.create(state);
    await assert.rejects(effects.start(fence, (async () => startedProviderEffect(Promise.resolve())) as never),
        /synchronously return/);
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const pending = effects.start(fence, () => startedProviderEffect(completion));
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
