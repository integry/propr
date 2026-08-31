import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
    GoalBeginTurnRequest,
    GoalProviderModelChangeRequest,
    GoalProviderOpenRequest,
    GoalProviderReconcileRequest,
    GoalSessionAdapter,
    GoalSessionControlTransition,
    GoalSessionEvent,
    GoalSessionRuntimePorts,
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
import { SqliteGoalSessionTestPorts } from './SqliteGoalSessionTestPorts.js';

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

function sqlitePersistence(): { filename: string; cleanup: () => void } {
    const directory = mkdtempSync(join(tmpdir(), 'goal-session-cross-process-'));
    return { filename: join(directory, 'goal-session.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
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

async function opened(
    adapter = new ExactHeadAdapter(),
    ports: { asRuntimePorts(): GoalSessionRuntimePorts } = new InMemoryGoalSessionPorts(),
) {
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
    const oldId = streamAuditTransitionId(fence, oldExecution, event);
    assert.notEqual(oldId, streamAuditTransitionId(fence, { ...oldExecution, attemptId: 'new-attempt' }, event));
});

test('provider event IDs have deterministic precedence and never mix mutable payload or local ordinal', () => {
    const execution = { executionId: 'stable-execution', attemptId: 'stable-attempt' };
    const first = {
        type: 'model_changed' as const,
        previousModel: 'model-a',
        model: 'model-b',
        providerEventId: 'provider-occurrence',
        providerEventOrdinal: 1,
    };
    const replay = {
        ...first,
        previousModel: 'mutated-predecessor',
        model: 'mutated-payload',
        providerEventOrdinal: 999,
    };
    assert.equal(streamAuditTransitionId(fence, execution, first),
        streamAuditTransitionId(fence, execution, replay));
    assert.throws(() => streamAuditTransitionId(fence, execution, {
        type: 'pause_boundary', boundary: 'missing-identity',
    }), /stable providerEventId or providerEventOrdinal/);
    assert.throws(() => streamAuditTransitionId(fence, execution, {
        type: 'model_changed', model: 'model-b', providerEventId: '   ', providerEventOrdinal: 1,
    }), /providerEventId must be non-empty/);
});

test('missing streamed occurrence identity fails closed before model state or audit mutation', async () => {
    const adapter = new ExactHeadAdapter();
    adapter.stream = async function* () { yield { type: 'model_changed', model: 'model-b' }; };
    const { ports, supervisor } = await opened(adapter);
    await assert.rejects(supervisor.runTurn(turnRequest()), /stable providerEventId or providerEventOrdinal/);
    const state = await ports.load(identity);
    assert.equal(state?.currentModel, 'model-a');
    assert.equal(state?.status, 'failed');
    const events = await ports.replay(identity);
    assert.equal(events.filter(record => record.event.type === 'model_changed').length, 0);
    assert.equal(events.filter(record => record.event.type === 'completion').length, 1);
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
        transitionId: streamAuditTransitionId(fence, oldExecution, event),
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
        transitionId: streamAuditTransitionId(fence, newExecution, event),
    };
    const recoveredNext = { ...replaced, currentModel: 'model-b' };
    delete (recoveredNext as Partial<GoalSessionState>).version;
    assert.ok(await ports.commit(replaced, recoveredNext, recoveredTransition),
        'a recovered fresh attempt may commit the same semantic event');
    assert.equal((await ports.replay(identity)).filter(record => record.event.type === 'model_changed').length, 2);
});

test('exact streamed occurrence redelivery dedupes after SQLite-backed process reopen', async t => {
    const persistence = sqlitePersistence();
    const first = new SqliteGoalSessionTestPorts(persistence.filename);
    const timestamp = new Date().toISOString();
    const execution = { executionId: 'sqlite-execution', attemptId: 'sqlite-attempt' };
    const state = await first.create({
        ...control,
        provider: 'exact-head-provider',
        providerSessionId: 'exact-native',
        recoveryMetadata: {},
        status: 'running',
        currentModel: 'model-a',
        completedTurnIds: [],
        activeTurn: {
            ...execution, turnId: fence.turnId, executionEpoch: 1, objective: 'sqlite replay',
            requestedModel: 'model-a', repository, status: 'running',
        },
        createdAt: timestamp,
        updatedAt: timestamp,
    });
    assert.ok(state);
    const event = { type: 'model_changed' as const, model: 'model-b', providerEventId: 'sqlite-occurrence' };
    const transition: GoalSessionControlTransition = {
        transitionId: streamAuditTransitionId(fence, execution, event),
        fence, turnScoped: true, execution, auditEvents: [event],
    };
    const next = { ...state, currentModel: 'model-b' };
    delete (next as Partial<GoalSessionState>).version;
    assert.ok(await first.commit(state, next, transition));
    first.close();
    const reopened = new SqliteGoalSessionTestPorts(persistence.filename);
    t.after(() => { reopened.close(); persistence.cleanup(); });
    assert.ok(await reopened.commit(state, next, transition));
    assert.equal((await reopened.replay(identity)).filter(record => record.event.type === 'model_changed').length, 1);
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
    const acknowledgements = (await ports.replay(identity))
        .filter(record => record.event.type === 'model_change_acknowledged');
    assert.equal(acknowledgements.length, 2, 'each retained model intent has exactly one canonical acknowledgement');
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

test('cached newest model waits across separate SQLite ports sharing only durable persistence', async t => {
    const persistence = sqlitePersistence();
    const firstPorts = new SqliteGoalSessionTestPorts(persistence.filename);
    const secondPorts = new SqliteGoalSessionTestPorts(persistence.filename);
    t.after(() => { firstPorts.close(); secondPorts.close(); persistence.cleanup(); });
    const effects: Effects = { model: 'model-a', calls: [] };
    const firstAdapter = new ExactHeadAdapter(effects);
    const oldGate = deferred();
    const oldStarted = deferred();
    firstAdapter.modelGates.set('model-b', oldGate.promise);
    firstAdapter.modelStarted.set('model-b', oldStarted.resolve);
    const { supervisor } = await opened(firstAdapter, firstPorts);
    const stale = supervisor.requestModelChange({ ...control, model: 'model-b' });
    await oldStarted.promise;
    await supervisor.requestModelChange({ ...control, model: 'model-c' });

    const replacement = new GoalSessionSupervisor(new ExactHeadAdapter(effects), secondPorts.asRuntimePorts());
    let cachedSettled = false;
    const cached = replacement.requestModelChange({ ...control, model: 'model-c' })
        .then(value => { cachedSettled = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cachedSettled, false);
    oldGate.resolve();
    await assert.rejects(stale, StaleGoalSessionFenceError);
    assert.equal((await cached).effectiveModel, 'model-c');
    assert.equal(effects.model, 'model-c');
    assert.equal((await secondPorts.replay(identity)).filter(event => event.event.type === 'model_changed').length, 1);
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

test('expired stale model lease leaves recovery evidence and cached newest repairs it cross-process', async t => {
    const persistence = sqlitePersistence();
    const firstPorts = new SqliteGoalSessionTestPorts(persistence.filename);
    const effects: Effects = { model: 'model-a', calls: [] };
    const adapter = new ExactHeadAdapter(effects);
    const gate = deferred();
    const started = deferred();
    adapter.modelGates.set('model-b', gate.promise);
    adapter.modelStarted.set('model-b', started.resolve);
    adapter.modelFailures.add('model-b');
    const { supervisor } = await opened(adapter, firstPorts);
    const stale = supervisor.requestModelChange({ ...control, model: 'model-b' });
    await started.promise;
    await supervisor.requestModelChange({ ...control, model: 'model-c' });
    gate.resolve();
    await assert.rejects(stale, /local failure after applying model-b/);
    assert.equal(effects.model, 'model-b');

    const evidence = await firstPorts.load(identity);
    assert.ok(evidence?.modelChangeIntents?.[0].applicationToken);
    const staleIntent = evidence.modelChangeIntents[0];
    const expiredIntents = evidence.modelChangeIntents.map(intent =>
        intent.modelChangeId === staleIntent.modelChangeId
            ? { ...intent, leaseExpiresAt: new Date(0).toISOString() }
            : intent);
    assert.ok(await firstPorts.compareAndSet(evidence, {
        ...evidence,
        modelChangeIntents: expiredIntents,
        modelChangeIntent: expiredIntents.at(-1),
    }));
    const replacementPorts = new SqliteGoalSessionTestPorts(persistence.filename);
    t.after(() => { firstPorts.close(); replacementPorts.close(); persistence.cleanup(); });
    const replacement = new GoalSessionSupervisor(
        new ExactHeadAdapter(effects), replacementPorts.asRuntimePorts(),
    );
    assert.equal((await replacement.requestModelChange({ ...control, model: 'model-c' })).effectiveModel, 'model-c');
    assert.equal(effects.model, 'model-c');
    assert.equal((await replacementPorts.load(identity))?.modelChangeIntents?.[0].phase, 'superseded');
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
    adapter.stream = async function* () {
        yield { type: 'pause_boundary', boundary: 'recoverable', providerEventId: 'recoverable-boundary' };
    };
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

test('cancellation durably preempts an in-doubt reconciliation without waiting for its provider call', async () => {
    const adapter = new ExactHeadAdapter();
    const ports = new InMemoryGoalSessionPorts();
    const { supervisor } = await recoverableRuntime(adapter, ports);
    const started = deferred();
    const release = deferred();
    adapter.reconcileStarted = started.resolve;
    adapter.reconcileGate = release.promise;
    const reconciling = supervisor.reconcile(identity, 1, repository);
    await started.promise;
    const cancelled = await supervisor.cancel({ ...control, reason: 'cancel during recovery' });
    assert.equal(cancelled.status, 'terminated');
    assert.ok((await ports.load(identity))?.cancellationIntent);
    release.resolve();
    await assert.rejects(reconciling, StaleGoalSessionFenceError);
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
    const cancellation = await replacement.cancel({
        ...identity, controllerEpoch: 2, reason: 'replacement cancel',
    });
    assert.equal(cancellation.status, 'terminated');
    release.resolve();
    await assert.rejects(oldRecovery, StaleGoalSessionFenceError);
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

class DurableGapPorts extends SqliteGoalSessionTestPorts {
    readonly reached = deferred();
    readonly release = deferred();

    constructor(
        filename: string,
        private readonly gap: 'container' | 'repository' | 'claimed' | 'provider_in_doubt',
    ) { super(filename); }

    override async inspectContainer(value: typeof identity) {
        const inspection = await super.inspectContainer(value);
        if (this.gap === 'container') {
            this.reached.resolve();
            await this.release.promise;
        }
        return inspection;
    }

    override async inspectRepository(value: typeof repository) {
        const inspection = await super.inspectRepository(value);
        if (this.gap === 'repository') {
            this.reached.resolve();
            await this.release.promise;
        }
        return inspection;
    }

    override async compareAndSet(expected: GoalSessionState, next: Omit<GoalSessionState, 'version'>) {
        const saved = await super.compareAndSet(expected, next);
        if (saved && next.recoveryAttempt?.phase === this.gap) {
            this.reached.resolve();
            await this.release.promise;
        }
        return saved;
    }
}

async function recoverableSqliteRuntime(adapter: ExactHeadAdapter, ports: SqliteGoalSessionTestPorts) {
    adapter.stream = async function* () {
        yield { type: 'pause_boundary', boundary: 'recoverable', providerEventId: 'recoverable-boundary' };
    };
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

class RecoveryCommitGapPorts extends SqliteGoalSessionTestPorts {
    readonly reached = deferred();
    readonly release = deferred();

    override async commit(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        operation: GoalTerminalCommit | GoalSessionControlTransition,
    ) {
        if (!('scope' in operation)
            && operation.auditEvents.some(event => event.type === 'reconciliation')) {
            this.reached.resolve();
            await this.release.promise;
        }
        return super.commit(expected, next, operation);
    }
}

test('separate-process cancellation fences every inspection and recovery-promotion gap', async t => {
    for (const gap of ['container', 'repository', 'claimed', 'provider_in_doubt'] as const) {
        await t.test(gap, async subtest => {
            const persistence = sqlitePersistence();
            const seedPorts = new SqliteGoalSessionTestPorts(persistence.filename);
            const adapter = new ExactHeadAdapter();
            await recoverableSqliteRuntime(adapter, seedPorts);
            const recoveryPorts = new DurableGapPorts(persistence.filename, gap);
            const cancellationPorts = new SqliteGoalSessionTestPorts(persistence.filename);
            subtest.after(() => {
                seedPorts.close(); recoveryPorts.close(); cancellationPorts.close(); persistence.cleanup();
            });
            const recovering = new GoalSessionSupervisor(adapter, recoveryPorts.asRuntimePorts());
            const cancelling = new GoalSessionSupervisor(adapter, cancellationPorts.asRuntimePorts());
            const recovery = recovering.reconcile(identity, 1, repository);
            await recoveryPorts.reached.promise;
            assert.equal((await cancelling.cancel({ ...control, reason: `cancel at ${gap}` })).status, 'terminated');
            recoveryPorts.release.resolve();
            if (gap === 'provider_in_doubt') await assert.rejects(recovery, StaleGoalSessionFenceError);
            else assert.equal((await recovery).state.status, 'terminated');
            assert.equal(adapter.reconcileCalls, 0);
            assert.equal((await cancellationPorts.replay(identity)).at(-1)?.event.type, 'completion');
        });
    }
});

test('SQLite-backed replacement cancellation never waits for a hung provider recovery call', async t => {
    const persistence = sqlitePersistence();
    const seedPorts = new SqliteGoalSessionTestPorts(persistence.filename);
    const recoveryPorts = new SqliteGoalSessionTestPorts(persistence.filename);
    const cancellationPorts = new SqliteGoalSessionTestPorts(persistence.filename);
    t.after(() => { seedPorts.close(); recoveryPorts.close(); cancellationPorts.close(); persistence.cleanup(); });
    const adapter = new ExactHeadAdapter();
    await recoverableSqliteRuntime(adapter, seedPorts);
    const started = deferred();
    const release = deferred();
    adapter.reconcileStarted = started.resolve;
    adapter.reconcileGate = release.promise;
    const recovering = new GoalSessionSupervisor(adapter, recoveryPorts.asRuntimePorts());
    const cancelling = new GoalSessionSupervisor(adapter, cancellationPorts.asRuntimePorts());
    const recovery = recovering.reconcile(identity, 1, repository);
    await started.promise;
    assert.equal((await cancelling.cancel({ ...control, reason: 'cancel hung cross-process recovery' })).status, 'terminated');
    assert.equal(adapter.cancelCalls, 1);
    release.resolve();
    await assert.rejects(recovery, StaleGoalSessionFenceError);
    assert.equal((await cancellationPorts.load(identity))?.status, 'terminated');
});

test('atomic recovery result and audit replay exactly once across pre/post-commit crashes', async t => {
    for (const fault of ['before_commit', 'after_commit'] as const) {
        await t.test(fault, async subtest => {
            const persistence = sqlitePersistence();
            const firstPorts = new SqliteGoalSessionTestPorts(persistence.filename);
            const adapter = new ExactHeadAdapter();
            const { supervisor } = await recoverableSqliteRuntime(adapter, firstPorts);
            firstPorts.setTransitionFault(fault);
            await assert.rejects(supervisor.reconcile(identity, 1, repository), /Injected crash/);
            const replacementPorts = new SqliteGoalSessionTestPorts(persistence.filename);
            subtest.after(() => { firstPorts.close(); replacementPorts.close(); persistence.cleanup(); });
            const replacementAdapter = new ExactHeadAdapter(adapter.effects);
            const replacement = new GoalSessionSupervisor(replacementAdapter, replacementPorts.asRuntimePorts());
            const recovered = await replacement.reconcile(identity, 1, repository);
            assert.equal(recovered.outcome, 'resumed');
            const audits = (await replacementPorts.replay(identity))
                .filter(record => record.event.type === 'reconciliation');
            assert.equal(audits.length, 1);
            assert.equal(adapter.reconcileCalls + replacementAdapter.reconcileCalls,
                fault === 'before_commit' ? 2 : 1);
        });
    }
});

test('cancellation at the recovery state-to-audit gap wins one atomic terminal ordering', async t => {
    const persistence = sqlitePersistence();
    const seedPorts = new SqliteGoalSessionTestPorts(persistence.filename);
    const adapter = new ExactHeadAdapter();
    await recoverableSqliteRuntime(adapter, seedPorts);
    const recoveryPorts = new RecoveryCommitGapPorts(persistence.filename);
    const cancellationPorts = new SqliteGoalSessionTestPorts(persistence.filename);
    t.after(() => { seedPorts.close(); recoveryPorts.close(); cancellationPorts.close(); persistence.cleanup(); });
    const recovering = new GoalSessionSupervisor(adapter, recoveryPorts.asRuntimePorts());
    const cancelling = new GoalSessionSupervisor(adapter, cancellationPorts.asRuntimePorts());
    const recovery = recovering.reconcile(identity, 1, repository);
    await recoveryPorts.reached.promise;
    assert.equal((await cancelling.cancel({ ...control, reason: 'cancel before recovery transaction' })).status, 'terminated');
    recoveryPorts.release.resolve();
    await assert.rejects(recovery, StaleGoalSessionFenceError);
    const events = await cancellationPorts.replay(identity);
    assert.equal(events.filter(record => record.event.type === 'reconciliation').length, 0);
    assert.equal(events.at(-1)?.event.type, 'completion');
});

test('an expired preparing lease is reclaimed through SQLite and the crashed owner stays fenced', async t => {
    const persistence = sqlitePersistence();
    const seedPorts = new SqliteGoalSessionTestPorts(persistence.filename);
    const oldAdapter = new ExactHeadAdapter();
    await recoverableSqliteRuntime(oldAdapter, seedPorts);
    const crashedPorts = new DurableGapPorts(persistence.filename, 'claimed');
    const crashed = new GoalSessionSupervisor(oldAdapter, crashedPorts.asRuntimePorts());
    const oldRecovery = crashed.reconcile(identity, 1, repository);
    await crashedPorts.reached.promise;

    const replacementPorts = new SqliteGoalSessionTestPorts(persistence.filename);
    t.after(() => {
        seedPorts.close(); crashedPorts.close(); replacementPorts.close(); persistence.cleanup();
    });
    const claimed = await replacementPorts.load(identity);
    assert.ok(claimed?.recoveryAttempt);
    const expired = await replacementPorts.compareAndSet(claimed, {
        ...claimed,
        recoveryAttempt: { ...claimed.recoveryAttempt, leaseExpiresAt: new Date(0).toISOString() },
    });
    assert.ok(expired);
    const replacementAdapter = new ExactHeadAdapter(oldAdapter.effects);
    const replacement = new GoalSessionSupervisor(replacementAdapter, replacementPorts.asRuntimePorts());
    assert.equal((await replacement.reconcile(identity, 1, repository)).outcome, 'resumed');
    crashedPorts.release.resolve();
    await assert.rejects(oldRecovery, StaleGoalSessionFenceError);
    assert.equal(oldAdapter.reconcileCalls, 0);
    assert.equal(replacementAdapter.reconcileCalls, 1);
});
