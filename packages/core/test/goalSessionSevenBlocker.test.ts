import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
    GoalBeginTurnRequest, GoalProviderModelChangeRequest, GoalProviderReconcileRequest,
    GoalProviderResumeRequest, GoalProviderSessionSnapshot, GoalSessionAdapter,
    GoalSessionControlFence, GoalSessionEvent, GoalSessionState,
} from '../src/agents/goalSession/contract.js';
import { GoalContainerSupervisor } from '../src/agents/goalSession/GoalContainerSupervisor.js';
import { GoalSessionSupervisor } from '../src/agents/goalSession/GoalSessionSupervisor.js';
import { InMemoryGoalSessionPorts } from '../src/agents/goalSession/InMemoryGoalSessionPorts.js';
import { MODEL_CHANGE_SETTLED_RETRY_HORIZON } from '../src/agents/goalSession/modelChangeProtocol.js';
import { fingerprintGoalWorktree } from '../src/agents/goalSession/worktreeIdentity.js';
import { SqliteGoalSessionTestPorts } from './SqliteGoalSessionTestPorts.js';

const identity = { goalId: 'seven-blocker-goal', sessionId: 'seven-blocker-session' };
const control = { ...identity, controllerEpoch: 1 };
const repository = {
    repository: 'integry/propr', worktreePath: '/tmp/seven-blocker-worktree', branch: 'follow-up',
};

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

class MatrixAdapter implements GoalSessionAdapter {
    readonly provider = 'matrix';
    readonly capabilities = {
        nativeSessionId: 'eager' as const, steering: 'active_turn' as const,
        pause: 'active_turn' as const, modelChange: 'next_safe_boundary' as const,
    };
    reconcileRequests: GoalProviderReconcileRequest[] = [];
    resumeRequests: GoalProviderResumeRequest[] = [];
    modelRequests: GoalProviderModelChangeRequest[] = [];
    reconcileOutcome: 'failed' | 'resumed' | 'alive' = 'resumed';
    resumeGate?: Promise<void>;

    async openSession(): Promise<GoalProviderSessionSnapshot> {
        return { providerSessionId: 'matrix-native', recoveryMetadata: {}, model: 'model-0' };
    }
    async *beginTurn(_request: GoalBeginTurnRequest): AsyncIterable<GoalSessionEvent> {
        yield { type: 'completion', outcome: 'succeeded' };
    }
    async *resumeTurn(): AsyncIterable<GoalSessionEvent> {
        yield { type: 'completion', outcome: 'succeeded' };
    }
    async deliverMessage(request: { messageId: string }) { return { messageId: request.messageId }; }
    async resumeSession(request: GoalProviderResumeRequest, snapshot: GoalProviderSessionSnapshot) {
        this.resumeRequests.push(structuredClone(request));
        await this.resumeGate;
        return snapshot;
    }
    async requestModelChange(request: GoalProviderModelChangeRequest) {
        this.modelRequests.push(structuredClone(request));
        return { requestedModel: request.model, appliesAt: 'immediate' as const, effectiveModel: request.model };
    }
    async requestPause() { return { appliesAt: 'next_safe_boundary' as const }; }
    async cancel() {}
    async reconcile(request: GoalProviderReconcileRequest) {
        this.reconcileRequests.push(structuredClone(request));
        return this.reconcileOutcome === 'failed'
            ? { outcome: 'failed' as const, reason: 'authoritative recovery failure' }
            : this.reconcileOutcome === 'alive'
                ? { outcome: 'alive' as const, reason: 'still alive' }
                : { outcome: 'resumed' as const, reason: 'replaced', snapshot: {
                    providerSessionId: 'matrix-native', recoveryMetadata: {}, model: 'model-0',
                } };
    }
}

function runningState(overrides: Partial<GoalSessionState> = {}): Omit<GoalSessionState, 'version'> {
    const timestamp = new Date().toISOString();
    return {
        ...identity, provider: 'matrix', providerSessionId: 'matrix-native', recoveryMetadata: {},
        controllerEpoch: 1, status: 'running', currentModel: 'model-0', completedTurnIds: [],
        activeTurn: {
            turnId: 'turn-1', executionId: 'execution-1', attemptId: 'attempt-1', executionEpoch: 1,
            objective: 'adversarial matrix', requestedModel: 'model-0', repository, status: 'running',
        },
        createdAt: timestamp, updatedAt: timestamp, ...overrides,
    };
}

function configureRecovery(ports: SqliteGoalSessionTestPorts | InMemoryGoalSessionPorts): void {
    ports.setContainerInspection(identity, { status: 'missing' });
    ports.setRepositoryInspection(repository, {
        ...repository, exists: true, observedRepository: repository.repository,
        observedBranch: repository.branch, resolvedWorktreePath: repository.worktreePath,
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
    });
}

test('failed reconciliation atomically terminates every obligation and never repairs a pending model', async () => {
    const ports = new InMemoryGoalSessionPorts();
    const adapter = new MatrixAdapter();
    adapter.reconcileOutcome = 'failed';
    await ports.create(runningState({
        modelChangeGeneration: 1,
        modelChangeIntents: [{
            modelChangeId: 'pending-model', model: 'model-1', requestedAt: new Date().toISOString(),
            generation: 1, phase: 'provider_in_doubt', applicationToken: 'model-lease',
            applicationControllerEpoch: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }],
    }));
    configureRecovery(ports);
    const result = await new GoalSessionSupervisor(adapter, ports.asRuntimePorts()).reconcile(identity, 1, repository);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.state.status, 'failed');
    assert.equal(result.state.activeTurn, undefined);
    assert.equal(result.state.modelChangeIntents, undefined);
    assert.equal(adapter.modelRequests.length, 0);
    assert.deepEqual((await ports.replay(identity)).map(record => record.event.type), ['reconciliation', 'completion']);
    await assert.rejects(new GoalSessionSupervisor(adapter, ports.asRuntimePorts())
        .requestModelChange({ ...control, model: 'model-2', operationId: 'after-failure' }), /failed/);
});

test('two SQLite supervisors share one exclusive active resume lease and cancellation fences the late result', async () => {
    const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'resume-matrix-')), 'state.sqlite');
    const firstPorts = new SqliteGoalSessionTestPorts(filename);
    const secondPorts = new SqliteGoalSessionTestPorts(filename);
    await firstPorts.create(runningState({
        status: 'paused', activeTurn: { ...runningState().activeTurn!, status: 'paused' },
    }));
    const gate = deferred();
    const firstAdapter = new MatrixAdapter();
    firstAdapter.resumeGate = gate.promise;
    const secondAdapter = new MatrixAdapter();
    const first = new GoalSessionSupervisor(firstAdapter, firstPorts.asRuntimePorts(), () => 'resume-attempt-1');
    const second = new GoalSessionSupervisor(secondAdapter, secondPorts.asRuntimePorts(), () => 'resume-attempt-2');
    const pending = first.resumeTurn(control);
    while (firstAdapter.resumeRequests.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
    const request = firstAdapter.resumeRequests[0];
    assert.equal(request.operationPhase, 'provider_in_doubt');
    assert.ok(request.operationGeneration > 0);
    await assert.rejects(second.resumeTurn(control), /durable resume lease/);
    assert.equal(secondAdapter.resumeRequests.length, 0);
    await second.cancel({ ...control, reason: 'cancel across resume boundary' });
    gate.resolve();
    await assert.rejects(pending, /preempted|stale|fence/i);
    assert.equal((await secondPorts.load(identity))?.status, 'terminated');
    firstPorts.close(); secondPorts.close();
});

test('caller model operation IDs retry retained entries and report a retired ID without provider work', async () => {
    const ports = new InMemoryGoalSessionPorts();
    const adapter = new MatrixAdapter();
    await ports.create(runningState({ status: 'idle', activeTurn: undefined }));
    const supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    for (let index = 0; index < MODEL_CHANGE_SETTLED_RETRY_HORIZON + 8; index += 1) {
        await supervisor.requestModelChange({ ...control, model: `model-${index + 1}`, operationId: `operation-${index + 1}` });
    }
    const state = await ports.load(identity);
    assert.equal(state?.modelChangeIntents?.length, MODEL_CHANGE_SETTLED_RETRY_HORIZON);
    const before = adapter.modelRequests.length;
    const oldestRetired = await supervisor.requestModelChange({ ...control, model: 'model-1', operationId: 'operation-1' });
    assert.equal(oldestRetired.outcome, 'outside_retry_horizon');
    assert.equal(adapter.modelRequests.length, before);
    const retained = await supervisor.requestModelChange({
        ...control, model: 'model-9', operationId: 'operation-9',
    });
    assert.equal(retained.requestedModel, 'model-9');
    assert.equal(adapter.modelRequests.length, before);
    assert.ok(Buffer.byteLength(JSON.stringify(await ports.load(identity))) < 100_000);
});

test('SQLite corrective-message consumption and acknowledgement event commit exactly once', async () => {
    const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'message-matrix-')), 'state.sqlite');
    const ports = new SqliteGoalSessionTestPorts(filename);
    await ports.create(runningState());
    ports.enqueueMessage({ ...identity, messageId: 'message-1', sequence: 1, body: 'correct it', createdAt: new Date().toISOString() });
    const adapter = new MatrixAdapter();
    const supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    const outcome = await supervisor.deliverMessage({ ...control, turnId: 'turn-1', messageId: 'message-1', body: 'ignored poison' });
    assert.equal(outcome.acknowledgement, 'acknowledged');
    assert.equal((await ports.listPending(identity)).length, 0);
    assert.equal((await ports.replay(identity)).filter(record => record.event.type === 'message_acknowledged').length, 1);
    const repeated = await supervisor.deliverMessage({ ...control, turnId: 'turn-1', messageId: 'message-1', body: 'repeat' });
    assert.equal(repeated.acknowledgement, 'already_acknowledged');
    assert.equal((await ports.replay(identity)).filter(record => record.event.type === 'message_acknowledged').length, 1);
    ports.close();
});

test('credential poison is rejected before provider/state/event boundaries and sensitive allowlisted mounts still fail', async () => {
    const ports = new InMemoryGoalSessionPorts();
    const adapter = new MatrixAdapter();
    const supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    const secret = 'ghp_1234567890SECRET';
    await assert.rejects(supervisor.runTurn({
        ...control, turnId: 'poison-turn', executionId: 'poison-execution', objective: 'poison',
        repository: { ...repository, repository: `https://${secret}@github.com/integry/propr.git` },
        requestedModel: 'model-0',
    }), /trustworthy Git repository/);
    assert.equal(adapter.reconcileRequests.length, 0);
    assert.doesNotMatch(JSON.stringify(await ports.load(identity)), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(await ports.replay(identity)), new RegExp(secret));

    const events = ports.asRuntimePorts().events;
    const container = new GoalContainerSupervisor('/tmp/seven-blocker-containers', events, undefined, {
        environmentKeys: [], worktreePaths: ['/etc'], providerHomeTargets: ['/opt/provider'], credentialMounts: [],
    });
    await assert.rejects(container.start({
        ...control, turnId: 'mount-turn', executionId: 'mount-execution', attemptId: 'mount-attempt',
        image: 'unused', command: ['true'], worktreePath: '/etc', worktreeFingerprint: 'fingerprint',
        providerHomeTarget: '/opt/provider',
    }), /sensitive host root or descendant/);
});
