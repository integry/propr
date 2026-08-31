import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
    GoalBeginTurnRequest,
    GoalProviderModelChangeRequest,
    GoalProviderOpenRequest,
    GoalProviderReconcileRequest,
    GoalSessionAdapter,
    GoalSessionControlTransition,
    GoalSessionEvent,
    GoalSessionState,
    GoalTerminalCommit,
} from '../src/agents/goalSession/contract.js';
import {
    GoalSessionSupervisor,
    StaleGoalSessionFenceError,
} from '../src/agents/goalSession/GoalSessionSupervisor.js';
import { InMemoryGoalSessionPorts } from '../src/agents/goalSession/InMemoryGoalSessionPorts.js';
import { streamAuditTransitionId } from '../src/agents/goalSession/turnStreamProtocol.js';
import { fingerprintGoalWorktree } from '../src/agents/goalSession/worktreeIdentity.js';

const identity = { goalId: 'exact-head-goal', sessionId: 'exact-head-session' };
const control = { ...identity, controllerEpoch: 1 };
const fence = { ...control, turnId: 'exact-head-turn' };
const repository = {
    repository: 'integry/propr', worktreePath: '/tmp/exact-head', branch: 'reaudit', headSha: '20e53540',
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

type Effects = { model: string; calls: GoalProviderModelChangeRequest[] };

class ExactHeadAdapter implements GoalSessionAdapter {
    readonly provider = 'exact-head-provider';
    readonly capabilities = {
        nativeSessionId: 'eager' as const,
        steering: 'active_turn' as const,
        pause: 'active_turn' as const,
        modelChange: 'next_safe_boundary' as const,
    };
    stream: () => AsyncIterable<GoalSessionEvent> = async function* () {
        yield { type: 'completion', outcome: 'succeeded' };
    };
    modelGates = new Map<string, Promise<void>>();
    modelStarted = new Map<string, () => void>();
    modelFailures = new Set<string>();
    reconcileGate: Promise<void> | undefined;
    reconcileStarted: (() => void) | undefined;
    reconcileCalls = 0;
    reconcileFailure = false;
    cancelCalls = 0;

    constructor(readonly effects: Effects = { model: 'model-a', calls: [] }) {}

    async openSession(_request: GoalProviderOpenRequest) {
        return { providerSessionId: 'exact-native', recoveryMetadata: { checkpoint: 'open' }, model: this.effects.model };
    }

    beginTurn(_request: GoalBeginTurnRequest) { return this.stream(); }

    async resumeSession(_request: typeof control, snapshot: { providerSessionId: string; recoveryMetadata: unknown }) {
        return snapshot;
    }

    async requestModelChange(request: GoalProviderModelChangeRequest) {
        this.effects.calls.push(structuredClone(request));
        this.modelStarted.get(request.model)?.();
        const gate = this.modelGates.get(request.model);
        if (gate) await gate;
        this.effects.model = request.model;
        if (this.modelFailures.has(request.model)) throw new Error(`local failure after applying ${request.model}`);
        return { requestedModel: request.model, appliesAt: 'immediate' as const, effectiveModel: request.model };
    }

    async cancel() { this.cancelCalls += 1; }

    async reconcile(_request: GoalProviderReconcileRequest) {
        this.reconcileCalls += 1;
        this.reconcileStarted?.();
        if (this.reconcileGate) await this.reconcileGate;
        if (this.reconcileFailure) throw new Error('reconcile transport failed');
        return {
            outcome: 'resumed' as const,
            snapshot: { providerSessionId: 'exact-native', recoveryMetadata: { checkpoint: 'reconciled' }, model: this.effects.model },
            reason: 'resumed exact invocation',
        };
    }
}

async function opened(adapter = new ExactHeadAdapter(), ports = new InMemoryGoalSessionPorts()) {
    const supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    return { adapter, ports, supervisor };
}

function turnRequest() {
    return {
        ...fence,
        executionId: 'exact-execution',
        attemptId: 'exact-attempt',
        objective: 'exercise exact-head invariants',
        repository,
        requestedModel: 'model-a',
    };
}

test('stream transition identity is exact-attempt scoped and occurrence stable', async () => {
    const adapter = new ExactHeadAdapter();
    adapter.stream = async function* () {
        yield { type: 'model_changed', previousModel: 'model-a', model: 'model-b', providerEventOrdinal: 1 };
        yield { type: 'model_changed', previousModel: 'model-a', model: 'model-b', providerEventOrdinal: 1 };
        yield { type: 'model_changed', previousModel: 'model-b', model: 'model-c', providerEventOrdinal: 2 };
        yield { type: 'model_changed', previousModel: 'model-c', model: 'model-b', providerEventOrdinal: 3 };
        yield { type: 'completion', outcome: 'succeeded' };
    };
    const { ports, supervisor } = await opened(adapter);
    await supervisor.runTurn(turnRequest());
    const models = (await ports.replay(identity)).flatMap(record =>
        record.event.type === 'model_changed' ? [record.event.model] : []);
    assert.deepEqual(models, ['model-b', 'model-c', 'model-b']);

    const stale = await ports.load(identity);
    assert.ok(stale);
    const oldExecution = { executionId: 'old-execution', attemptId: 'old-attempt' };
    const event = { type: 'model_changed' as const, model: 'model-z', providerEventId: 'provider-event-z' };
    const oldId = streamAuditTransitionId(fence, oldExecution, event, 0);
    assert.notEqual(oldId, streamAuditTransitionId(fence, { ...oldExecution, attemptId: 'new-attempt' }, event, 0));
});

test('transition dedupe validates the live exact attempt before returning an old hit', async () => {
    const ports = new InMemoryGoalSessionPorts();
    const timestamp = new Date().toISOString();
    const oldExecution = { executionId: 'execution-one', attemptId: 'attempt-one' };
    const state = await ports.create({
        ...control,
        provider: 'exact-head-provider',
        providerSessionId: 'exact-native',
        recoveryMetadata: {},
        status: 'running',
        currentModel: 'model-a',
        completedTurnIds: [],
        activeTurn: {
            ...oldExecution, turnId: fence.turnId, executionEpoch: 1, objective: 'transition',
            requestedModel: 'model-a', repository, status: 'running',
        },
        createdAt: timestamp,
        updatedAt: timestamp,
    });
    assert.ok(state);
    const event = { type: 'model_changed' as const, model: 'model-b', providerEventOrdinal: 7 };
    const transition: GoalSessionControlTransition = {
        transitionId: streamAuditTransitionId(fence, oldExecution, event, 7),
        fence,
        turnScoped: true,
        execution: oldExecution,
        auditEvents: [event],
    };
    const next = { ...state, currentModel: 'model-b' };
    delete (next as Partial<GoalSessionState>).version;
    const committed = await ports.commit(state, next, transition);
    assert.ok(committed);
    assert.ok(await ports.commit(state, next, transition), 'exact duplicate redelivery dedupes');

    const newExecution = { executionId: 'execution-one', attemptId: 'attempt-two' };
    const replaced = await ports.compareAndSet(committed, {
        ...committed,
        activeTurn: committed.activeTurn ? { ...committed.activeTurn, ...newExecution } : undefined,
    });
    assert.ok(replaced);
    assert.equal(await ports.commit(state, next, transition), null, 'stale old-attempt hit must fail its live fence');

    const recoveredTransition = {
        ...transition,
        execution: newExecution,
        transitionId: streamAuditTransitionId(fence, newExecution, event, 7),
    };
    const recoveredNext = { ...replaced, currentModel: 'model-b' };
    delete (recoveredNext as Partial<GoalSessionState>).version;
    assert.ok(await ports.commit(replaced, recoveredNext, recoveredTransition),
        'a recovered fresh attempt may commit the same semantic event');
    assert.equal((await ports.replay(identity)).filter(record => record.event.type === 'model_changed').length, 2);
});

test('overlapping model generations converge after reverse completion and cached newest waits for repair', async () => {
    const adapter = new ExactHeadAdapter();
    const oldGate = deferred();
    const oldStarted = deferred();
    adapter.modelGates.set('model-b', oldGate.promise);
    adapter.modelStarted.set('model-b', oldStarted.resolve);
    const { ports, supervisor } = await opened(adapter);
    const old = supervisor.requestModelChange({ ...control, model: 'model-b' });
    await oldStarted.promise;
    await supervisor.requestModelChange({ ...control, model: 'model-c' });

    let repeatedSettled = false;
    const repeated = supervisor.requestModelChange({ ...control, model: 'model-c' })
        .then(value => { repeatedSettled = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(repeatedSettled, false);
    oldGate.resolve();
    await assert.rejects(old, StaleGoalSessionFenceError);
    assert.equal((await repeated).effectiveModel, 'model-c');
    assert.equal(adapter.effects.model, 'model-c');
    assert.equal((await ports.load(identity))?.currentModel, 'model-c');
    const changed = (await ports.replay(identity)).filter(record => record.event.type === 'model_changed');
    assert.deepEqual(changed.map(record => record.event.type === 'model_changed' ? record.event.model : ''), ['model-c']);
    assert.equal((await ports.replay(identity)).filter(record => record.event.type === 'model_change_acknowledged').length, 1);
    assert.equal(new Set(adapter.effects.calls.filter(call => call.model === 'model-c').map(call => call.modelChangeId)).size, 1);
});

test('three mixed-order model generations leave the provider and durable state on the newest intent', async () => {
    const adapter = new ExactHeadAdapter();
    const gates = [deferred(), deferred()];
    const starts = [deferred(), deferred()];
    adapter.modelGates.set('model-b', gates[0].promise);
    adapter.modelGates.set('model-c', gates[1].promise);
    adapter.modelStarted.set('model-b', starts[0].resolve);
    adapter.modelStarted.set('model-c', starts[1].resolve);
    const { ports, supervisor } = await opened(adapter);
    const first = supervisor.requestModelChange({ ...control, model: 'model-b' });
    await starts[0].promise;
    const second = supervisor.requestModelChange({ ...control, model: 'model-c' });
    await starts[1].promise;
    await supervisor.requestModelChange({ ...control, model: 'model-d' });
    gates[1].resolve();
    await assert.rejects(second, StaleGoalSessionFenceError);
    gates[0].resolve();
    await assert.rejects(first, StaleGoalSessionFenceError);
    assert.equal(adapter.effects.model, 'model-d');
    assert.equal((await ports.load(identity))?.currentModel, 'model-d');
    const changes = (await ports.replay(identity)).filter(record => record.event.type === 'model_changed');
    assert.deepEqual(changes.map(record => record.event.type === 'model_changed' ? record.event.model : ''), ['model-d']);
});

test('a stale model completion after process replacement repairs the newest durable generation', async () => {
    const effects: Effects = { model: 'model-a', calls: [] };
    const adapter = new ExactHeadAdapter(effects);
    const gate = deferred();
    const started = deferred();
    adapter.modelGates.set('model-b', gate.promise);
    adapter.modelStarted.set('model-b', started.resolve);
    const { ports, supervisor } = await opened(adapter);
    const stale = supervisor.requestModelChange({ ...control, model: 'model-b' });
    await started.promise;
    await supervisor.requestModelChange({ ...control, model: 'model-c' });

    const replacementAdapter = new ExactHeadAdapter(effects);
    const replacement = new GoalSessionSupervisor(replacementAdapter, ports.asRuntimePorts());
    const reopening = replacement.openSession({
        ...identity, provider: replacementAdapter.provider, controllerEpoch: 2,
    });
    gate.resolve();
    await assert.rejects(stale, StaleGoalSessionFenceError);
    assert.equal((await reopening).currentModel, 'model-c');
    assert.equal(effects.model, 'model-c');
    const acknowledgement = await replacement.requestModelChange({ ...identity, controllerEpoch: 2, model: 'model-c' });
    assert.equal(acknowledgement.effectiveModel, 'model-c');
    assert.equal((await ports.replay(identity)).filter(record => record.event.type === 'model_changed').length, 1);
});

test('reopen repairs a superseded provider-success/local-failure window before using cached newest state', async () => {
    const effects: Effects = { model: 'model-a', calls: [] };
    const adapter = new ExactHeadAdapter(effects);
    const gate = deferred();
    const started = deferred();
    adapter.modelGates.set('model-b', gate.promise);
    adapter.modelStarted.set('model-b', started.resolve);
    adapter.modelFailures.add('model-b');
    const { ports, supervisor } = await opened(adapter);
    const stale = supervisor.requestModelChange({ ...control, model: 'model-b' });
    await started.promise;
    await supervisor.requestModelChange({ ...control, model: 'model-c' });
    gate.resolve();
    await assert.rejects(stale, /local failure after applying model-b/);
    assert.equal(effects.model, 'model-b');

    const replacementAdapter = new ExactHeadAdapter(effects);
    const replacement = new GoalSessionSupervisor(replacementAdapter, ports.asRuntimePorts());
    const reopened = await replacement.openSession({
        ...identity, provider: replacementAdapter.provider, controllerEpoch: 2,
    });
    assert.equal(reopened.currentModel, 'model-c');
    assert.equal(effects.model, 'model-c');
    assert.equal((await ports.replay(identity)).filter(record => record.event.type === 'model_changed').length, 1);
    assert.equal(reopened.modelChangeIntents?.[0].phase, 'superseded');
});

class SnapshotGapPorts extends InMemoryGoalSessionPorts {
    snapshotPersisted: (() => void) | undefined;

    override async compareAndSet(expected: GoalSessionState, next: Omit<GoalSessionState, 'version'>) {
        const saved = await super.compareAndSet(expected, next);
        if (saved && expected.providerOpenAttemptId !== next.providerOpenAttemptId
            && next.controllerEpoch === 2) this.snapshotPersisted?.();
        return saved;
    }
}

test('reopen never plain-CASes snapshot model ahead of unresolved intent atomic audit', async () => {
    const effects: Effects = { model: 'model-a', calls: [] };
    const ports = new SnapshotGapPorts();
    const initial = await opened(new ExactHeadAdapter(effects), ports);
    ports.setTransitionFault('before_commit');
    await assert.rejects(initial.supervisor.requestModelChange({ ...control, model: 'model-b' }), /before state\/audit/);
    assert.equal((await ports.load(identity))?.currentModel, 'model-a');
    assert.equal(effects.model, 'model-b');

    const retryGate = deferred();
    const retryStarted = deferred();
    const replacementAdapter = new ExactHeadAdapter(effects);
    replacementAdapter.modelGates.set('model-b', retryGate.promise);
    replacementAdapter.modelStarted.set('model-b', retryStarted.resolve);
    const replacement = new GoalSessionSupervisor(replacementAdapter, ports.asRuntimePorts());
    const reopening = replacement.openSession({ ...identity, provider: replacementAdapter.provider, controllerEpoch: 2 });
    await retryStarted.promise;
    assert.equal((await ports.load(identity))?.currentModel, 'model-a');
    assert.equal((await ports.replay(identity)).filter(record => record.event.type === 'model_changed').length, 0);
    retryGate.resolve();
    const reopened = await reopening;
    assert.equal(reopened.currentModel, 'model-b');
    const changes = (await ports.replay(identity)).filter(record => record.event.type === 'model_changed');
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0].event, {
        type: 'model_changed', previousModel: 'model-a', model: 'model-b',
    });
    await replacement.openSession({ ...identity, provider: replacementAdapter.provider, controllerEpoch: 3 });
    assert.equal((await ports.replay(identity)).filter(record => record.event.type === 'model_changed').length, 1);
});

class RecoveryClaimHookPorts extends InMemoryGoalSessionPorts {
    afterClaim: (() => Promise<void>) | undefined;

    override async compareAndSet(expected: GoalSessionState, next: Omit<GoalSessionState, 'version'>) {
        const saved = await super.compareAndSet(expected, next);
        if (saved && next.recoveryAttempt?.phase === 'claimed' && this.afterClaim) {
            const hook = this.afterClaim;
            this.afterClaim = undefined;
            await hook();
        }
        return saved;
    }
}

async function recoverableRuntime(adapter: ExactHeadAdapter, ports: InMemoryGoalSessionPorts) {
    adapter.stream = async function* () { yield { type: 'pause_boundary', boundary: 'recoverable' }; };
    const runtime = await opened(adapter, ports);
    await runtime.supervisor.runTurn(turnRequest());
    ports.setRepositoryInspection(repository, {
        ...repository,
        exists: true,
        observedRepository: repository.repository,
        observedBranch: repository.branch,
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
        resolvedWorktreePath: repository.worktreePath,
    });
    ports.setContainerInspection(identity, {
        status: 'running',
        recoveryIdentity: {
            ...identity,
            executionEpoch: 1,
            turnId: fence.turnId,
            attemptId: 'exact-attempt',
            worktreeFingerprint: fingerprintGoalWorktree(repository),
        },
    });
    return runtime;
}

test('cancellation preempts a claimed recovery before any provider resume call', async () => {
    const adapter = new ExactHeadAdapter();
    const ports = new RecoveryClaimHookPorts();
    const { supervisor } = await recoverableRuntime(adapter, ports);
    ports.afterClaim = async () => {
        await supervisor.cancel({ ...control, reason: 'cancel before provider resume' });
    };
    const result = await supervisor.reconcile(identity, 1, repository);
    assert.equal(result.state.status, 'terminated');
    assert.equal(adapter.reconcileCalls, 0);
    assert.equal(adapter.cancelCalls, 1);
    assert.equal((await supervisor.reconcile(identity, 1, repository)).state.status, 'terminated');
});

test('cancellation waits behind an in-doubt reconciliation and no provider resume occurs after its claim', async () => {
    const adapter = new ExactHeadAdapter();
    const ports = new InMemoryGoalSessionPorts();
    const { supervisor } = await recoverableRuntime(adapter, ports);
    const started = deferred();
    const release = deferred();
    adapter.reconcileStarted = started.resolve;
    adapter.reconcileGate = release.promise;
    const reconciling = supervisor.reconcile(identity, 1, repository);
    await started.promise;
    let cancelSettled = false;
    const cancelling = supervisor.cancel({ ...control, reason: 'cancel during recovery' })
        .then(state => { cancelSettled = true; return state; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cancelSettled, false);
    assert.equal((await ports.load(identity))?.cancellationIntent, undefined);
    release.resolve();
    await reconciling;
    assert.equal((await cancelling).status, 'terminated');
    assert.equal(adapter.reconcileCalls, 1);
    assert.equal(adapter.cancelCalls, 1);
    assert.equal((await supervisor.reconcile(identity, 1, repository)).state.status, 'terminated');
    assert.equal(adapter.reconcileCalls, 1);
});

test('replacement cancellation recovers an old recovery lease without post-claim provider resume', async () => {
    const adapter = new ExactHeadAdapter();
    const ports = new InMemoryGoalSessionPorts();
    const { supervisor } = await recoverableRuntime(adapter, ports);
    const started = deferred();
    const release = deferred();
    adapter.reconcileStarted = started.resolve;
    adapter.reconcileGate = release.promise;
    const oldRecovery = supervisor.reconcile(identity, 1, repository);
    await started.promise;

    const replacement = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    await replacement.takeover(identity, 2);
    let cancellationClaimed = false;
    const cancellation = replacement.cancel({ ...identity, controllerEpoch: 2, reason: 'replacement cancel' })
        .then(state => { cancellationClaimed = true; return state; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cancellationClaimed, false);
    release.resolve();
    await assert.rejects(oldRecovery, StaleGoalSessionFenceError);
    assert.equal((await cancellation).status, 'terminated');
    assert.equal(adapter.reconcileCalls, 1);
    assert.equal(adapter.cancelCalls, 1);
    assert.equal((await replacement.reconcile(identity, 2, repository)).state.status, 'terminated');
});

test('same-controller cancellation can recover a completed failed reconciliation lease', async () => {
    const adapter = new ExactHeadAdapter();
    adapter.reconcileFailure = true;
    const ports = new InMemoryGoalSessionPorts();
    const { supervisor } = await recoverableRuntime(adapter, ports);
    await assert.rejects(supervisor.reconcile(identity, 1, repository), /reconcile transport failed/);
    assert.equal((await ports.load(identity))?.recoveryAttempt?.phase, 'provider_in_doubt');
    assert.equal((await supervisor.cancel({ ...control, reason: 'cancel failed recovery' })).status, 'terminated');
    assert.equal(adapter.reconcileCalls, 1);
    assert.equal(adapter.cancelCalls, 1);
});
