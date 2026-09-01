import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
    GoalBeginTurnRequest,
    GoalCancelRequest,
    GoalModelChangeRequest,
    GoalProviderOpenRequest,
    GoalPendingCancellationContext,
    GoalProviderReconcileRequest,
    GoalProviderReconcileResult,
    GoalProviderSessionSnapshot,
    GoalProviderTurnContext,
    GoalSessionAdapter,
    GoalSessionControlFence,
    GoalSessionEvent,
    GoalSessionIdentity,
    GoalSessionState,
    GoalTerminalCommit,
} from '../src/agents/goalSession/contract.js';
import {
    EAGER_ACTIVE_TURN_PROVIDER_CAPABILITIES,
    FIRST_TURN_BOUNDARY_PROVIDER_CAPABILITIES,
    GoalSessionContractError,
    GoalSessionSupervisor,
    StaleGoalSessionFenceError,
} from '../src/agents/goalSession/index.js';
import { InMemoryGoalSessionPorts } from '../src/agents/goalSession/InMemoryGoalSessionPorts.js';
import { fingerprintGoalWorktree } from '../src/agents/goalSession/worktreeIdentity.js';

const identity = { goalId: 'goal-capabilities', sessionId: 'session-capabilities' };
const repository = {
    repository: 'integry/propr',
    worktreePath: '/tmp/propr-goal-capabilities',
    branch: 'goal-capability-branch',
    headSha: 'abc123',
};
const firstFence = { ...identity, controllerEpoch: 1, turnId: 'turn-one' };

class FirstTurnBoundaryAdapter implements GoalSessionAdapter {
    async publishOperationBarrier(): Promise<void> {}
    readonly provider = 'boundary-fake';
    readonly capabilities = FIRST_TURN_BOUNDARY_PROVIDER_CAPABILITIES;
    openCalls = 0;
    pauseCalls = 0;
    steeringCalls = 0;
    resumeTurnCalls = 0;
    resumeSessionCalls = 0;
    modelCalls: string[] = [];
    actions: string[] = [];
    contexts: GoalProviderTurnContext[] = [];
    requests: GoalBeginTurnRequest[] = [];
    turnStarted: (() => void) | undefined;
    holdTurn: Promise<void> | undefined;
    emitIdentity = true;
    acknowledgeMessages = true;
    reconcileResult: GoalProviderReconcileResult = { outcome: 'failed', reason: 'not used by capability tests' };
    reconcileRequests: GoalProviderReconcileRequest[] = [];
    pendingCancelContexts: GoalPendingCancellationContext[] = [];
    pendingCancelStarted: (() => void) | undefined;
    holdPendingCancel: Promise<void> | undefined;

    async openSession(request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot> {
        this.openCalls += 1;
        if (!request.persisted) throw new Error('A bound first-turn session must resume from its persisted native ID');
        return request.persisted;
    }

    async *beginTurn(
        request: GoalBeginTurnRequest,
        context: GoalProviderTurnContext,
    ): AsyncIterable<GoalSessionEvent> {
        this.actions.push(`begin:${request.turnId}`);
        this.requests.push(structuredClone(request));
        this.contexts.push(structuredClone(context));
        if (context.binding === 'pending' && this.emitIdentity) {
            yield {
                type: 'checkpoint',
                checkpointId: 'first-init',
                providerSessionId: 'native-first-turn-id',
                recoveryMetadata: { conversation: 'native-first-turn-id' },
            };
        }
        if (request.modelChange) {
            yield {
                type: 'model_changed', model: request.requestedModel,
                providerEventId: `model-${request.modelChange.modelChangeId}-${request.modelChange.generation}`,
            };
        }
        this.turnStarted?.();
        if (this.holdTurn) await this.holdTurn;
        if (this.acknowledgeMessages) {
            for (const message of request.correctiveMessages ?? []) {
                yield { type: 'message_acknowledged', messageId: message.messageId };
            }
        }
        yield { type: 'output', channel: 'stdout', data: `completed ${request.turnId}\n` };
        yield { type: 'completion', outcome: 'succeeded' };
    }

    async deliverMessage(): Promise<{ messageId: string }> {
        this.steeringCalls += 1;
        throw new Error('next-turn steering must not use an active-turn channel');
    }

    async requestPause(): Promise<{ appliesAt: 'after_turn' }> {
        this.pauseCalls += 1;
        throw new Error('after-turn pause must not interrupt the provider invocation');
    }

    async *resumeTurn(): AsyncIterable<GoalSessionEvent> {
        this.resumeTurnCalls += 1;
        throw new Error('after-turn providers cannot resume the completed invocation');
    }

    async resumeSession(
        _request: GoalSessionControlFence,
        snapshot: GoalProviderSessionSnapshot,
    ): Promise<GoalProviderSessionSnapshot> {
        this.resumeSessionCalls += 1;
        return snapshot;
    }

    async requestModelChange(
        request: GoalModelChangeRequest,
    ): Promise<{ requestedModel: string; appliesAt: 'immediate'; effectiveModel: string }> {
        this.actions.push(`model:${request.model}`);
        this.modelCalls.push(request.model);
        return { requestedModel: request.model, appliesAt: 'immediate', effectiveModel: request.model };
    }

    async cancel(_request: GoalCancelRequest): Promise<void> {}

    async cancelPending(
        _request: GoalCancelRequest,
        pending: GoalPendingCancellationContext,
    ): Promise<void> {
        this.pendingCancelContexts.push(structuredClone(pending));
        this.pendingCancelStarted?.();
        if (this.holdPendingCancel) await this.holdPendingCancel;
    }

    async reconcile(request: GoalProviderReconcileRequest): Promise<GoalProviderReconcileResult> {
        this.reconcileRequests.push(structuredClone(request));
        return this.reconcileResult;
    }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

class GatedCompletionLoadPorts extends InMemoryGoalSessionPorts {
    private nextRunningLoad: {
        loaded: ReturnType<typeof deferred>;
        release: ReturnType<typeof deferred>;
    } | undefined;

    gateNextRunningLoad(): { loaded: Promise<void>; release: () => void } {
        const gate = { loaded: deferred(), release: deferred() };
        this.nextRunningLoad = gate;
        return { loaded: gate.loaded.promise, release: gate.release.resolve };
    }

    override async load(request: GoalSessionIdentity): Promise<GoalSessionState | null> {
        const state = await super.load(request);
        const gate = this.nextRunningLoad;
        if (gate && state?.status === 'running') {
            this.nextRunningLoad = undefined;
            gate.loaded.resolve();
            await gate.release.promise;
        }
        return state;
    }
}

class GatedLazyOpenPorts extends InMemoryGoalSessionPorts {
    private openGate: { blocked: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;

    gateNextLazyOpen(): { blocked: Promise<void>; release: () => void } {
        const gate = { blocked: deferred(), release: deferred() };
        this.openGate = gate;
        return { blocked: gate.blocked.promise, release: gate.release.resolve };
    }

    override async compareAndSet(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
    ): Promise<GoalSessionState | null> {
        const gate = this.openGate;
        if (gate && expected.status === 'initializing' && next.status === 'idle' && !expected.providerSessionId) {
            this.openGate = undefined;
            gate.blocked.resolve();
            await gate.release.promise;
        }
        return super.compareAndSet(expected, next);
    }
}

class ContractIdempotencyPorts extends InMemoryGoalSessionPorts {
    readonly terminalCommitKeys: string[] = [];

    override async commit(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        completion: GoalTerminalCommit,
    ): Promise<GoalSessionState | null> {
        this.terminalCommitKeys.push(JSON.stringify([
            completion.scope,
            completion.fence.goalId,
            completion.fence.sessionId,
            completion.fence.controllerEpoch,
            completion.scope === 'turn' ? completion.fence.turnId : null,
            completion.execution.executionId,
            completion.execution.attemptId,
        ]));
        return super.commit(expected, next, completion);
    }
}

test('capability fixtures describe eager-active and lazy-boundary providers without overlap', () => {
    assert.deepEqual(EAGER_ACTIVE_TURN_PROVIDER_CAPABILITIES, {
        nativeSessionId: 'eager',
        steering: 'active_turn',
        pause: 'active_turn',
        modelChange: 'next_safe_boundary',
    });
    assert.deepEqual(FIRST_TURN_BOUNDARY_PROVIDER_CAPABILITIES, {
        nativeSessionId: 'first_turn',
        firstTurnIdCrashPolicy: 'fail',
        steering: 'next_turn',
        pause: 'after_turn',
        modelChange: 'next_turn',
    });
});

test('lazy-ID cancellation while open reaches one durable terminal outcome without a native ID', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    const persistence = new InMemoryGoalSessionPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    const opened = await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    assert.equal(opened.providerSessionId, undefined);

    const cancelled = await supervisor.cancel({ ...identity, controllerEpoch: 1, reason: 'cancel before first turn' });
    assert.equal(cancelled.status, 'terminated');
    assert.equal(cancelled.activeTurn, undefined);
    assert.equal(cancelled.initializationIntent, undefined);
    assert.equal(adapter.pendingCancelContexts.length, 1);
    assert.equal(adapter.pendingCancelContexts[0]?.activeTurn, undefined);
    assert.equal(adapter.pendingCancelContexts[0]?.initializationIntent.deterministicOpenKey,
        opened.initializationIntent?.deterministicOpenKey);

    const repeated = await supervisor.cancel({ ...identity, controllerEpoch: 1, reason: 'repeat cancellation' });
    assert.equal(repeated.status, 'terminated');
    assert.equal(adapter.pendingCancelContexts.length, 1, 'repeat cancel does not signal a terminal session again');
    const completions = (await persistence.replay(identity)).filter(record => record.event.type === 'completion');
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.event.type === 'completion' ? completions[0].event.outcome : '', 'cancelled');
});

test('lazy-ID cancellation wins while open is persisting its pending boundary', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    const persistence = new GatedLazyOpenPorts();
    const gate = persistence.gateNextLazyOpen();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    const opening = supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    await gate.blocked;

    const terminal = await supervisor.cancel({ ...identity, controllerEpoch: 1, reason: 'cancel during lazy open' });
    assert.equal(terminal.status, 'terminated');
    assert.equal(terminal.activeTurn, undefined);
    assert.equal(adapter.pendingCancelContexts.length, 1);
    gate.release();
    await assert.rejects(opening, StaleGoalSessionFenceError);
    assert.equal((await persistence.load(identity))?.status, 'terminated');
    assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'completion').length, 1);
});

test('lazy-ID cancellation fences provider completion before the first checkpoint', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    adapter.emitIdentity = false;
    const turnStarted = deferred();
    const releaseTurn = deferred();
    const cancelStarted = deferred();
    const releaseCancel = deferred();
    adapter.turnStarted = turnStarted.resolve;
    adapter.holdTurn = releaseTurn.promise;
    adapter.pendingCancelStarted = cancelStarted.resolve;
    adapter.holdPendingCancel = releaseCancel.promise;
    const persistence = new InMemoryGoalSessionPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    const running = supervisor.runTurn({
        ...firstFence,
        executionId: 'execution-cancel-before-id',
        attemptId: 'attempt-cancel-before-id',
        objective: 'cancel the provider before it binds a native ID',
        repository,
        requestedModel: 'model-a',
    });
    await turnStarted.promise;

    const cancelling = supervisor.cancel({ ...identity, controllerEpoch: 1, reason: 'cancel pending provider' });
    await cancelStarted.promise;
    assert.equal((await persistence.load(identity))?.status, 'cancelling');
    assert.deepEqual(adapter.pendingCancelContexts[0]?.activeTurn, {
        turnId: firstFence.turnId,
        executionId: 'execution-cancel-before-id',
        attemptId: 'attempt-cancel-before-id',
    });
    releaseTurn.resolve();
    await assert.rejects(running);
    assert.equal((await persistence.load(identity))?.status, 'cancelling');

    releaseCancel.resolve();
    const terminal = await cancelling;
    assert.equal(terminal.status, 'terminated');
    assert.equal(terminal.activeTurn, undefined);
    assert.equal(terminal.providerSessionId, undefined);
    const completions = (await persistence.replay(identity)).filter(record => record.event.type === 'completion');
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.event.type === 'completion' ? completions[0].event.outcome : '', 'cancelled');
});

test('a restarted lazy-ID controller finishes a cancellation claimed before a crash', async () => {
    const firstAdapter = new FirstTurnBoundaryAdapter();
    const persistence = new InMemoryGoalSessionPorts();
    const initial = new GoalSessionSupervisor(firstAdapter, persistence.asRuntimePorts());
    const opened = await initial.openSession({ ...identity, provider: firstAdapter.provider, controllerEpoch: 1 });
    const { version: _version, ...withoutVersion } = opened;
    const claimed = await persistence.compareAndSet(opened, {
        ...withoutVersion,
        status: 'cancelling',
        providerOperationGeneration: 1,
        cancellationIntent: {
            cancellationId: 'crashed-cancellation', reason: 'resume cancellation after crash',
            claimedAt: new Date().toISOString(),
            pendingContext: { initializationIntent: opened.initializationIntent! },
        },
        providerBarrierIntent: {
            generation: 1, operationId: 'crashed-cancellation', kind: 'cancellation', phase: 'published',
            claimedAt: new Date().toISOString(), pendingCancellationId: 'crashed-cancellation',
        },
        updatedAt: new Date().toISOString(),
    });
    assert.equal(claimed?.status, 'cancelling');

    const replacementAdapter = new FirstTurnBoundaryAdapter();
    const replacement = new GoalSessionSupervisor(replacementAdapter, persistence.asRuntimePorts());
    const terminal = await replacement.cancel({ ...identity, controllerEpoch: 1, reason: 'resume cancellation after crash' });
    assert.equal(terminal.status, 'terminated');
    assert.equal(terminal.activeTurn, undefined);
    assert.equal(replacementAdapter.pendingCancelContexts.length, 1);
    assert.equal((await replacement.cancel({ ...identity, controllerEpoch: 1, reason: 'idempotent retry' })).status, 'terminated');
    assert.equal(replacementAdapter.pendingCancelContexts.length, 1);
    assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'completion').length, 1);
});

test('first-turn identity, FIFO next-turn ack, and after-turn pause/resume stay boundary-safe', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    const persistence = new InMemoryGoalSessionPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    const opened = await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    assert.equal(opened.status, 'idle');
    assert.equal(opened.providerSessionId, undefined, 'no placeholder provider ID is invented');
    assert.ok(opened.initializationIntent?.deterministicOpenKey);
    assert.equal(adapter.openCalls, 0, 'the native ID is not eagerly opened');

    persistence.enqueueMessage({ ...identity, messageId: 'message-one', body: 'first correction' });
    persistence.enqueueMessage({ ...identity, messageId: 'message-two', body: 'second correction' });
    let releaseTurn!: () => void;
    adapter.holdTurn = new Promise(resolve => { releaseTurn = resolve; });
    const started = new Promise<void>(resolve => { adapter.turnStarted = resolve; });
    const running = supervisor.runTurn({
        ...firstFence,
        executionId: 'execution-one',
        attemptId: 'attempt-one',
        objective: 'Run a discrete provider turn',
        repository,
        requestedModel: 'model-a',
    });
    await started;

    const steering = await supervisor.deliverMessage({ ...firstFence, messageId: 'message-one', body: 'ignored copy' });
    assert.deepEqual(steering, {
        outcome: 'unsupported_same_turn', messageId: 'message-one', supportedBoundary: 'next_turn',
    });
    const pause = await supervisor.requestPause({ ...firstFence, reason: 'pause after this invocation' });
    assert.deepEqual(pause, { appliesAt: 'after_turn' });
    assert.equal(adapter.pauseCalls, 0, 'pause never maps to an interrupt/terminal provider call');
    releaseTurn();

    const finished = await running;
    assert.equal(finished.state.status, 'paused');
    assert.equal(finished.state.activeTurn, undefined, 'there is no active provider turn at an after-turn pause');
    assert.equal(finished.state.providerSessionId, 'native-first-turn-id');
    assert.equal(finished.state.initializationIntent, undefined);
    assert.equal(adapter.contexts[0]?.binding, 'pending');
    assert.deepEqual(adapter.requests[0]?.correctiveMessages?.map(message => message.messageId), ['message-one', 'message-two']);
    assert.deepEqual((await persistence.listPending(identity)).map(message => message.messageId), []);
    assert.equal(adapter.steeringCalls, 0);

    assert.deepEqual(await supervisor.resumeTurn(firstFence), {
        disposition: 'unsupported_same_turn', supportedBoundary: 'after_turn',
    });
    assert.equal(adapter.resumeTurnCalls, 0);
    await assert.rejects(
        supervisor.runTurn({
            ...firstFence, turnId: 'turn-two', executionId: 'execution-two', objective: 'must stay paused',
            repository, requestedModel: 'model-a',
        }),
        (error: unknown) => error instanceof GoalSessionContractError && error.code === 'SESSION_NOT_IDLE',
    );

    await supervisor.requestModelChange({ ...identity, controllerEpoch: 1, model: 'model-b' });
    assert.deepEqual(adapter.modelCalls, [], 'next-turn model changes are not applied mid-boundary');
    const resumed = await supervisor.resumeSession({ ...identity, controllerEpoch: 1 });
    assert.equal(resumed.status, 'idle');
    assert.equal(resumed.providerSessionId, 'native-first-turn-id');

    adapter.holdTurn = undefined;
    adapter.turnStarted = undefined;
    const second = await supervisor.runTurn({
        ...firstFence,
        turnId: 'turn-two',
        executionId: 'execution-two',
        objective: 'Start only after boundary resume',
        repository,
        requestedModel: 'model-b',
    });
    assert.equal(second.state.status, 'idle');
    assert.deepEqual(adapter.modelCalls, []);
    assert.deepEqual(adapter.actions.slice(-1), ['begin:turn-two']);
    assert.equal(adapter.contexts[1]?.binding, 'bound');
    assert.equal(adapter.contexts[1]?.binding === 'bound'
        ? adapter.contexts[1].snapshot.providerSessionId
        : undefined, 'native-first-turn-id');

    const acknowledgedIds = (await persistence.replay(identity))
        .filter(record => record.event.type === 'message_acknowledged')
        .map(record => record.event.type === 'message_acknowledged' ? record.event.messageId : '');
    assert.deepEqual(acknowledgedIds, ['message-one', 'message-two']);
});

test('after-turn completion honors a pause acknowledged after its pre-completion state read', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    const persistence = new GatedCompletionLoadPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });

    const providerRelease = deferred();
    const providerStarted = deferred();
    adapter.holdTurn = providerRelease.promise;
    adapter.turnStarted = providerStarted.resolve;
    const running = supervisor.runTurn({
        ...firstFence,
        executionId: 'execution-pause-race',
        attemptId: 'attempt-pause-race',
        objective: 'complete concurrently with an after-turn pause',
        repository,
        requestedModel: 'model-a',
    });
    await providerStarted.promise;

    const completionLoad = persistence.gateNextRunningLoad();
    providerRelease.resolve();
    await completionLoad.loaded;
    assert.deepEqual(await supervisor.requestPause({ ...firstFence, reason: 'pause at completion' }), {
        appliesAt: 'after_turn',
    });
    assert.equal((await persistence.load(identity))?.status, 'pause_requested');
    completionLoad.release();

    const finished = await running;
    assert.equal(finished.state.status, 'paused');
    assert.equal(finished.state.activeTurn, undefined);
    assert.equal((await persistence.load(identity))?.status, 'paused');
    const terminalEvents = (await persistence.replay(identity)).filter(record =>
        record.turnId === firstFence.turnId
        && (record.event.type === 'pause_boundary' || record.event.type === 'completion'));
    assert.deepEqual(terminalEvents.map(record => record.event.type), ['pause_boundary', 'completion']);
    assert.equal(terminalEvents[0]?.event.type === 'pause_boundary'
        ? terminalEvents[0].event.boundary : '', 'after_turn');
});

test('late after-turn pause state and canonical audit boundary survive an ambiguous commit crash exactly once', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    const persistence = new GatedCompletionLoadPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    const providerRelease = deferred();
    const providerStarted = deferred();
    adapter.holdTurn = providerRelease.promise;
    adapter.turnStarted = providerStarted.resolve;
    const request = {
        ...firstFence,
        executionId: 'execution-pause-crash',
        attemptId: 'attempt-pause-crash',
        objective: 'commit late pause and completion atomically',
        repository,
        requestedModel: 'model-a',
    };
    const running = supervisor.runTurn(request);
    await providerStarted.promise;

    const completionLoad = persistence.gateNextRunningLoad();
    providerRelease.resolve();
    await completionLoad.loaded;
    await supervisor.requestPause({ ...firstFence, reason: 'pause in terminal crash window' });
    persistence.setTerminalFault('after_commit');
    completionLoad.release();
    await assert.rejects(running, /Injected crash after terminal transaction commit/);

    const saved = await persistence.load(identity);
    assert.equal(saved?.status, 'paused');
    assert.equal(saved?.activeTurn, undefined);
    const terminalEvents = (await persistence.replay(identity)).filter(record =>
        record.turnId === firstFence.turnId
        && (record.event.type === 'pause_boundary' || record.event.type === 'completion'));
    assert.deepEqual(terminalEvents.map(record => record.event.type), ['pause_boundary', 'completion']);

    const restarted = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    assert.equal((await restarted.runTurn(request)).disposition, 'duplicate');
    const replayed = (await persistence.replay(identity)).filter(record =>
        record.turnId === firstFence.turnId
        && (record.event.type === 'pause_boundary' || record.event.type === 'completion'));
    assert.deepEqual(replayed.map(record => record.event.type), ['pause_boundary', 'completion']);
});

test('late after-turn pause boundary replays atomically after a pre-commit crash', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    const persistence = new GatedCompletionLoadPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    const providerRelease = deferred();
    const providerStarted = deferred();
    adapter.holdTurn = providerRelease.promise;
    adapter.turnStarted = providerStarted.resolve;
    const request = {
        ...firstFence,
        executionId: 'execution-pause-precommit',
        attemptId: 'attempt-pause-precommit',
        objective: 'recover the atomic late-pause terminal transaction',
        repository,
        requestedModel: 'model-a',
    };
    const running = supervisor.runTurn(request);
    await providerStarted.promise;
    await supervisor.requestPause({ ...firstFence, reason: 'pause before terminal commit' });
    persistence.setTerminalFault('before_commit_always');
    providerRelease.resolve();
    await assert.rejects(running, /Injected crash before terminal transaction commit/);

    const preCommit = await persistence.load(identity);
    assert.equal(preCommit?.status, 'pause_requested');
    assert.equal(preCommit?.pendingAfterTurnPause, true);
    assert.deepEqual((await persistence.replay(identity)).filter(record =>
        record.turnId === firstFence.turnId
        && (record.event.type === 'pause_boundary' || record.event.type === 'completion')), []);

    persistence.setTerminalFault(undefined);
    persistence.setContainerInspection(identity, { status: 'missing', reason: 'worker crashed before terminal commit' });
    persistence.setRepositoryInspection(repository, {
        ...repository,
        exists: true,
        observedBranch: repository.branch,
        observedHeadSha: repository.headSha,
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
    });
    adapter.reconcileResult = {
        outcome: 'resumed',
        snapshot: {
            providerSessionId: 'native-first-turn-id',
            recoveryMetadata: { conversation: 'native-first-turn-id', checkpoint: 'terminal-retry' },
            model: 'model-a',
        },
        reason: 'retry the discrete invocation from its durable checkpoint',
    };
    adapter.holdTurn = undefined;
    adapter.turnStarted = undefined;
    const restarted = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    const reconciled = await restarted.reconcile(identity, 2, repository);
    assert.equal(reconciled.state.status, 'paused');
    assert.equal(reconciled.state.pendingAfterTurnPause, true);
    const recovered = await restarted.resumeTurn({ ...identity, controllerEpoch: 2 });
    assert.equal(recovered.disposition, 'started');
    assert.equal(recovered.state.status, 'paused');
    assert.equal(recovered.state.activeTurn, undefined);
    assert.equal(recovered.state.pendingAfterTurnPause, undefined);
    const replayed = (await persistence.replay(identity)).filter(record =>
        record.turnId === firstFence.turnId
        && (record.event.type === 'pause_boundary' || record.event.type === 'completion'));
    assert.deepEqual(replayed.map(record => record.event.type), ['pause_boundary', 'completion']);
    assert.equal(replayed[0]?.event.type === 'pause_boundary' ? replayed[0].event.boundary : '', 'after_turn');
    assert.equal(replayed[0]?.attemptId, recovered.execution.attemptId);
    assert.equal(replayed[1]?.attemptId, recovered.execution.attemptId);
});

test('first-turn providers reject authoritative output before a real native ID is bound', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    adapter.emitIdentity = false;
    const persistence = new InMemoryGoalSessionPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });

    await assert.rejects(
        supervisor.runTurn({
            ...firstFence,
            executionId: 'execution-unbound',
            objective: 'Never accept fake identity output',
            repository,
            requestedModel: 'model-a',
        }),
        (error: unknown) => error instanceof GoalSessionContractError && error.code === 'FIRST_TURN_ID_NOT_BOUND',
    );
    const replay = await persistence.replay(identity);
    assert.equal(replay.some(record => record.event.type === 'output'), false);
    assert.equal((await persistence.load(identity))?.providerSessionId, undefined);
});

test('reopen cleans an already-terminal first-turn failure without a new epoch completion', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    adapter.emitIdentity = false;
    const persistence = new ContractIdempotencyPorts();
    const initial = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await initial.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });

    await assert.rejects(initial.runTurn({
        ...firstFence,
        executionId: 'execution-terminal-failure',
        attemptId: 'attempt-terminal-failure',
        objective: 'fail ordinarily before native identity binding',
        repository,
        requestedModel: 'model-a',
    }), (error: unknown) => error instanceof GoalSessionContractError && error.code === 'FIRST_TURN_ID_NOT_BOUND');
    const terminal = await persistence.load(identity);
    assert.equal(terminal?.status, 'failed');
    assert.equal(terminal?.activeTurn?.status, 'failed');
    assert.equal(persistence.terminalCommitKeys.length, 1);

    const replacement = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await assert.rejects(
        replacement.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 2 }),
        (error: unknown) => error instanceof GoalSessionContractError && error.code === 'FIRST_TURN_ID_NOT_BOUND',
    );

    const cleaned = await persistence.load(identity);
    assert.equal(cleaned?.controllerEpoch, 1, 'terminal cleanup cannot transfer controller ownership');
    assert.equal(cleaned?.status, 'failed');
    assert.equal(cleaned?.activeTurn, undefined);
    assert.equal(cleaned?.initializationIntent, undefined);
    assert.equal(persistence.terminalCommitKeys.length, 1, 'the exact contract key is never retried under epoch two');
    assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'completion').length, 1);
});

test('fail policy durably fails and clears an unbound first turn after crash and reopen', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    const persistence = new InMemoryGoalSessionPorts();
    const initial = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => 'initialization-attempt');
    const opened = await initial.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    const { version: _version, ...persisted } = opened;
    const crashed = await persistence.compareAndSet(opened, {
        ...persisted,
        status: 'running',
        activeTurn: {
            turnId: firstFence.turnId,
            executionId: 'execution-crashed',
            attemptId: 'attempt-crashed',
            executionEpoch: 1,
            objective: 'crash before native identity checkpoint',
            requestedModel: 'model-a',
            repository,
            status: 'running',
        },
    });
    assert.ok(crashed);

    const replacement = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await assert.rejects(
        replacement.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 2 }),
        (error: unknown) => error instanceof GoalSessionContractError && error.code === 'FIRST_TURN_ID_NOT_BOUND',
    );
    const failed = await persistence.load(identity);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.activeTurn, undefined);
    assert.equal(failed?.initializationIntent, undefined);
    assert.match(failed?.failureReason ?? '', /before binding its native session ID/);
    const completions = (await persistence.replay(identity)).filter(record => record.event.type === 'completion');
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.event.type === 'completion' ? completions[0].event.outcome : '', 'failed');

    const terminalVersion = failed?.version;
    await assert.rejects(
        replacement.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 2 }),
        (error: unknown) => error instanceof GoalSessionContractError && error.code === 'FIRST_TURN_ID_NOT_BOUND',
    );
    assert.equal((await persistence.load(identity))?.version, terminalVersion, 'repeated opens do not mutate terminal state');
    assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'completion').length, 1);
});

test('first-turn binding consumes its deferred requested model without reapplying it on turn two', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    const persistence = new InMemoryGoalSessionPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    await supervisor.requestModelChange({ ...identity, controllerEpoch: 1, model: 'model-b' });

    const first = await supervisor.runTurn({
        ...firstFence,
        executionId: 'execution-model-one',
        objective: 'apply deferred model in the first invocation',
        repository,
        requestedModel: 'model-a',
    });
    assert.equal(first.state.currentModel, 'model-b');
    assert.equal(first.state.pendingModelChange, undefined);
    assert.deepEqual(adapter.modelCalls, [], 'the first invocation receives its model directly');

    await supervisor.runTurn({
        ...firstFence,
        turnId: 'turn-two',
        executionId: 'execution-model-two',
        objective: 'do not redundantly reapply the first-turn model',
        repository,
        requestedModel: 'model-b',
    });
    assert.deepEqual(adapter.modelCalls, []);
    assert.deepEqual(adapter.requests.map(request => request.requestedModel), ['model-b', 'model-b']);
});

test('successful completion without acknowledging supplied messages is a protocol violation', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    adapter.acknowledgeMessages = false;
    const persistence = new InMemoryGoalSessionPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    persistence.enqueueMessage({ ...identity, messageId: 'message-unacknowledged', body: 'must be accepted' });

    await assert.rejects(
        supervisor.runTurn({
            ...firstFence,
            executionId: 'execution-unacknowledged',
            objective: 'provider must acknowledge supplied messages',
            repository,
            requestedModel: 'model-a',
        }),
        (error: unknown) => error instanceof GoalSessionContractError && error.code === 'MESSAGE_ACK_MISSING',
    );
    assert.equal((await persistence.load(identity))?.status, 'failed');
    assert.deepEqual((await persistence.listPending(identity)).map(message => message.messageId), ['message-unacknowledged']);
    const completion = (await persistence.replay(identity)).find(record => record.event.type === 'completion');
    assert.equal(completion?.event.type === 'completion' ? completion.event.outcome : '', 'failed');
});

test('deterministic first-turn retry mints a fresh attempt instead of reusing the crashed invocation', async () => {
    class RetryingFirstTurnAdapter extends FirstTurnBoundaryAdapter {
        override readonly capabilities = {
            ...FIRST_TURN_BOUNDARY_PROVIDER_CAPABILITIES,
            firstTurnIdCrashPolicy: 'retry_deterministically',
        } as const;
    }
    const adapter = new RetryingFirstTurnAdapter();
    adapter.emitIdentity = false;
    const persistence = new InMemoryGoalSessionPorts();
    const initial = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => 'initialization-attempt');
    await initial.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    await assert.rejects(initial.runTurn({
        ...firstFence,
        executionId: 'execution-retry',
        attemptId: 'crashed-attempt',
        objective: 'first invocation crashes',
        repository,
        requestedModel: 'model-a',
    }), /native session ID/);

    const ids = ['recovered-initialization-attempt', 'fresh-provider-attempt'];
    const replacement = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => ids.shift()!);
    const reopened = await replacement.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 2 });
    assert.equal(reopened.status, 'idle');
    assert.equal(reopened.activeTurn, undefined);
    assert.equal(reopened.retryTurn?.crashedAttemptId, 'crashed-attempt');
    assert.equal(reopened.initializationIntent?.attemptId, 'recovered-initialization-attempt');
    adapter.emitIdentity = true;
    const recovered = await replacement.runTurn({
        ...firstFence,
        controllerEpoch: 2,
        executionId: 'execution-retry',
        attemptId: 'crashed-attempt',
        objective: 'retry the same logical turn',
        repository,
        requestedModel: 'model-a',
    });

    assert.equal(recovered.execution.executionId, 'execution-retry');
    assert.equal(recovered.execution.attemptId, 'fresh-provider-attempt');
    assert.notEqual(recovered.execution.attemptId, 'crashed-attempt');
    assert.equal(adapter.requests.at(-1)?.attemptId, 'fresh-provider-attempt');
});

test('first-turn after-turn profile reconciles a post-ID container loss through a fresh fenced invocation', async () => {
    const adapter = new FirstTurnBoundaryAdapter();
    const persistence = new InMemoryGoalSessionPorts();
    const initial = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await initial.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    const bound = await initial.runTurn({
        ...firstFence,
        executionId: 'execution-binding-turn',
        attemptId: 'attempt-binding-turn',
        objective: 'bind the native session before the later crash',
        repository,
        requestedModel: 'model-a',
    });
    const { version: _version, ...persisted } = bound.state;
    const crashed = await persistence.compareAndSet(bound.state, {
        ...persisted,
        status: 'running',
        activeTurn: {
            turnId: 'turn-crashed-after-binding',
            executionId: 'execution-crashed-after-binding',
            attemptId: 'attempt-crashed-after-binding',
            executionEpoch: 1,
            objective: 'continue the bound session after container loss',
            requestedModel: 'model-a',
            repository,
            status: 'running',
        },
    });
    assert.ok(crashed);
    persistence.setContainerInspection(identity, { status: 'missing', reason: 'container was lost' });
    persistence.setRepositoryInspection(repository, {
        ...repository,
        exists: true,
        observedBranch: repository.branch,
        observedHeadSha: repository.headSha,
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
    });
    adapter.reconcileResult = {
        outcome: 'resumed',
        snapshot: {
            providerSessionId: 'native-first-turn-id',
            recoveryMetadata: { conversation: 'native-first-turn-id', checkpoint: 'reconciled' },
            model: 'model-a',
        },
        reason: 'the bound provider session is recoverable',
    };
    const attemptIds = ['attempt-reconciliation', 'attempt-continuation'];
    const replacement = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => attemptIds.shift()!);

    const reconciled = await replacement.reconcile(identity, 2, repository);
    assert.equal(reconciled.state.status, 'paused');
    assert.equal(reconciled.state.activeTurn?.status, 'paused');
    assert.equal(reconciled.state.activeTurn?.attemptId, 'attempt-reconciliation');
    assert.equal(adapter.reconcileRequests[0]?.attemptId, 'attempt-reconciliation');

    await replacement.requestModelChange({ ...identity, controllerEpoch: 2, model: 'model-recovered' });
    assert.equal((await persistence.load(identity))?.pendingModelChange, 'model-recovered');

    const continuationStarted = deferred();
    const continuationRelease = deferred();
    adapter.turnStarted = continuationStarted.resolve;
    adapter.holdTurn = continuationRelease.promise;
    const continuation = replacement.resumeTurn({ ...identity, controllerEpoch: 2 });
    await continuationStarted.promise;
    assert.equal((await persistence.load(identity))?.activeTurn?.attemptId, 'attempt-continuation');
    const staleAppend = await persistence.append(
        { ...identity, controllerEpoch: 2, turnId: 'turn-crashed-after-binding' },
        { executionId: 'execution-crashed-after-binding', attemptId: 'attempt-reconciliation' },
        { type: 'output', channel: 'stdout', data: 'late output from reconciliation attempt' },
    );
    assert.deepEqual(staleAppend, { accepted: false, reason: 'turn_not_active' });
    continuationRelease.resolve();
    const continued = await continuation;
    assert.equal(continued.disposition, 'started');
    assert.equal(continued.state.status, 'idle');
    assert.equal(continued.execution.executionId, 'execution-crashed-after-binding');
    assert.equal(continued.execution.attemptId, 'attempt-continuation');
    assert.notEqual(continued.execution.attemptId, adapter.reconcileRequests[0]?.attemptId);
    assert.equal(adapter.resumeTurnCalls, 0, 'crash retry uses a fresh discrete invocation, not operator same-turn resume');
    assert.equal(adapter.requests.at(-1)?.turnId, 'turn-crashed-after-binding');
    assert.equal(adapter.requests.at(-1)?.attemptId, 'attempt-continuation');
    assert.equal(adapter.requests.at(-1)?.requestedModel, 'model-recovered');
    assert.equal(adapter.actions.at(-1), 'begin:turn-crashed-after-binding');
    assert.equal(adapter.requests.at(-1)?.modelChange?.modelChangeId,
        (await persistence.load(identity))?.modelChangeIntents?.find(intent => intent.model === 'model-recovered')?.modelChangeId);
    assert.deepEqual(adapter.modelCalls, [], 'next-turn intent is supplied at the actual invocation, not through a side call');
    assert.equal(adapter.contexts.at(-1)?.binding, 'bound');
    assert.equal((await persistence.load(identity))?.currentModel, 'model-recovered');
    assert.equal((await persistence.load(identity))?.pendingModelChange, undefined);

    const recoveredCompletions = (await persistence.replay(identity)).filter(record =>
        record.turnId === 'turn-crashed-after-binding' && record.event.type === 'completion');
    assert.equal(recoveredCompletions.length, 1);
    assert.equal(recoveredCompletions[0]?.attemptId, 'attempt-continuation');
    const recoveredModelAcknowledgements = (await persistence.replay(identity)).filter(record =>
        record.event.type === 'model_change_acknowledged'
        && record.event.requestedModel === 'model-recovered');
    assert.equal(recoveredModelAcknowledgements.length, 1);
});
