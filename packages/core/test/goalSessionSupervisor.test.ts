import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
    GoalBeginTurnRequest,
    GoalCancelRequest,
    GoalModelChangeRequest,
    GoalPauseRequest,
    GoalProviderOpenRequest,
    GoalProviderReconcileRequest,
    GoalProviderReconcileResult,
    GoalProviderSessionSnapshot,
    GoalSessionAdapter,
    GoalSessionControlFence,
    GoalSessionEvent,
    GoalSessionFence,
    GoalSteeringRequest,
} from '../src/agents/goalSession/contract.js';
import {
    GoalSessionContractError,
    GoalSessionSupervisor,
    StaleGoalSessionFenceError,
    UnsupportedGoalSessionTransitionError,
} from '../src/agents/goalSession/GoalSessionSupervisor.js';
import {
    GoalSessionScopeError,
    InMemoryGoalSessionPorts,
} from '../src/agents/goalSession/InMemoryGoalSessionPorts.js';
import { fingerprintGoalWorktree } from '../src/agents/goalSession/worktreeIdentity.js';

const identity = { goalId: 'goal-2007', sessionId: 'session-one' };
const repository = {
    repository: 'integry/propr',
    worktreePath: '/tmp/propr-goal-2007',
    branch: 'goal-branch',
    headSha: 'abc123',
};
const fence: GoalSessionFence = { ...identity, controllerEpoch: 1, turnId: 'turn-one' };

class FakeGoalAdapter implements GoalSessionAdapter {
    async publishOperationBarrier(): Promise<void> {}
    readonly provider = 'fake';
    readonly capabilities = {
        nativeSessionId: 'eager',
        steering: 'active_turn',
        pause: 'active_turn',
        modelChange: 'next_safe_boundary',
    } as const;
    openCalls = 0;
    beginCalls = 0;
    messageCalls: string[] = [];
    pauseCalls = 0;
    resumeCalls = 0;
    resumeTurnCalls = 0;
    resumeTurnAttempts: string[] = [];
    modelCalls: string[] = [];
    rejectedModel: string | undefined;
    cancelCalls = 0;
    events: GoalSessionEvent[] = [];
    resumeEvents: GoalSessionEvent[] = [];
    reconcileResult: GoalProviderReconcileResult = { outcome: 'failed', reason: 'not configured' };
    reconcileCalls = 0;
    reconcileRequests: GoalProviderReconcileRequest[] = [];
    openedWith: Array<GoalProviderSessionSnapshot | undefined> = [];
    openAttempts: string[] = [];
    turnStarted: (() => void) | undefined;
    holdTurn: Promise<void> | undefined;

    async openSession(request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot> {
        this.openCalls += 1;
        this.openAttempts.push(request.attemptId);
        this.openedWith.push(request.persisted);
        return request.persisted ?? {
            providerSessionId: 'provider-session-stable',
            recoveryMetadata: { checkpoint: 'created' },
            model: 'model-a',
        };
    }

    async *beginTurn(_request: GoalBeginTurnRequest): AsyncIterable<GoalSessionEvent> {
        this.beginCalls += 1;
        this.turnStarted?.();
        if (this.holdTurn) await this.holdTurn;
        for (const event of this.events) yield event;
    }

    async deliverMessage(request: GoalSteeringRequest): Promise<{ messageId: string }> {
        this.messageCalls.push(request.messageId);
        return { messageId: request.messageId };
    }

    async requestPause(_request: GoalPauseRequest): Promise<{ appliesAt: 'next_safe_boundary' }> {
        this.pauseCalls += 1;
        return { appliesAt: 'next_safe_boundary' };
    }

    async resumeSession(_request: GoalSessionControlFence, snapshot: GoalProviderSessionSnapshot): Promise<GoalProviderSessionSnapshot> {
        this.resumeCalls += 1;
        return snapshot;
    }

    async *resumeTurn(request: GoalSessionFence & { executionId: string; attemptId: string }): AsyncIterable<GoalSessionEvent> {
        this.resumeTurnCalls += 1;
        this.resumeTurnAttempts.push(request.attemptId);
        for (const event of this.resumeEvents) yield event;
    }

    async requestModelChange(request: GoalModelChangeRequest): Promise<{ requestedModel: string; appliesAt: 'immediate'; effectiveModel: string }> {
        this.modelCalls.push(request.model);
        if (request.model === this.rejectedModel) {
            throw new UnsupportedGoalSessionTransitionError(
                `Model transition to ${request.model} is unsupported by fake provider`,
                'UNSUPPORTED_MODEL_TRANSITION',
            );
        }
        return { requestedModel: request.model, appliesAt: 'immediate', effectiveModel: request.model };
    }

    async cancel(_request: GoalCancelRequest): Promise<void> {
        this.cancelCalls += 1;
    }

    async reconcile(_request: GoalProviderReconcileRequest): Promise<GoalProviderReconcileResult> {
        this.reconcileCalls += 1;
        this.reconcileRequests.push(structuredClone(_request));
        return this.reconcileResult;
    }
}

async function openedRuntime(adapter = new FakeGoalAdapter()) {
    const persistence = new InMemoryGoalSessionPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    const state = await supervisor.openSession({ ...identity, provider: 'fake', controllerEpoch: 1 });
    return { adapter, persistence, supervisor, state };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

test('starts a recoverable turn and replays ordered normalized output and usage', async () => {
    const adapter = new FakeGoalAdapter();
    adapter.events = [
        { type: 'output', channel: 'stdout', data: 'out\n' },
        { type: 'output', channel: 'stderr', data: 'warning\n' },
        { type: 'assistant', messageId: 'assistant-1', content: 'working' },
        { type: 'tool', toolCallId: 'tool-1', name: 'edit', phase: 'completed', data: { file: 'a.ts' } },
        { type: 'todo', todoId: 'todo-1', title: 'test', status: 'completed' },
        { type: 'usage', occurrenceId: 'usage-1', semantics: 'delta', watermark: 0, model: 'model-a', inputTokens: 12, outputTokens: 5 },
        { type: 'checkpoint', checkpointId: 'cp-1', recoveryMetadata: { checkpoint: 'cp-1' } },
        { type: 'completion', outcome: 'succeeded', summary: 'done' },
    ];
    const { persistence, supervisor } = await openedRuntime(adapter);

    const result = await supervisor.runTurn({
        ...fence,
        executionId: 'execution-stable',
        attemptId: 'attempt-unique',
        objective: 'Implement the goal',
        repository,
        requestedModel: 'model-a',
    });

    assert.equal(result.disposition, 'started');
    assert.equal(adapter.beginCalls, 1);
    assert.equal(result.state.status, 'idle');
    assert.deepEqual(result.state.recoveryMetadata, { checkpoint: 'cp-1' });
    const replay = await persistence.replay(identity);
    assert.deepEqual(replay.map(value => value.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(replay.slice(0, 2).map(value => value.event.type === 'output' ? value.event.channel : ''), ['stdout', 'stderr']);
    assert.ok(replay.every(value => value.executionId === 'execution-stable' && value.attemptId === 'attempt-unique'));
    assert.equal(replay[5].event.type, 'usage');
    const lateOutput = await persistence.append(fence, result.execution, {
        type: 'output', channel: 'stdout', data: 'too late',
    });
    assert.deepEqual(lateOutput, { accepted: false, reason: 'turn_not_active' });
});

test('opens a new controller epoch by resuming the same persisted provider session', async () => {
    const adapter = new FakeGoalAdapter();
    const { persistence } = await openedRuntime(adapter);
    const restartedSupervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => 'open-recovery-attempt');

    const resumed = await restartedSupervisor.openSession({ ...identity, provider: 'fake', controllerEpoch: 2 });

    assert.equal(resumed.controllerEpoch, 2);
    assert.equal(resumed.providerSessionId, 'provider-session-stable');
    assert.equal(adapter.openCalls, 2);
    assert.equal(adapter.openedWith[1]?.providerSessionId, 'provider-session-stable');
    assert.deepEqual(adapter.openedWith[1]?.recoveryMetadata, { checkpoint: 'created' });
    assert.equal(adapter.openAttempts[1], 'open-recovery-attempt');
    assert.notEqual(adapter.openAttempts[1], adapter.openAttempts[0]);
});

test('duplicate queue delivery cannot invoke a second provider turn', async () => {
    const adapter = new FakeGoalAdapter();
    let releaseTurn!: () => void;
    adapter.holdTurn = new Promise(resolve => { releaseTurn = resolve; });
    const started = new Promise<void>(resolve => { adapter.turnStarted = resolve; });
    adapter.events = [{ type: 'completion', outcome: 'succeeded' }];
    const { supervisor } = await openedRuntime(adapter);
    const request = {
        ...fence,
        executionId: 'execution-stable',
        objective: 'Only once',
        repository,
        requestedModel: 'model-a',
    };

    const first = supervisor.runTurn(request);
    await started;
    const duplicate = await supervisor.runTurn(request);
    assert.equal(duplicate.disposition, 'duplicate');
    assert.equal(adapter.beginCalls, 1);
    releaseTurn();
    await first;
    const redeliveredAfterCompletion = await supervisor.runTurn(request);
    assert.equal(redeliveredAfterCompletion.disposition, 'duplicate');
    assert.equal(adapter.beginCalls, 1);
});

test('a stale supervisor cannot append after controller takeover', async () => {
    const adapter = new FakeGoalAdapter();
    let releaseTurn!: () => void;
    adapter.holdTurn = new Promise(resolve => { releaseTurn = resolve; });
    const started = new Promise<void>(resolve => { adapter.turnStarted = resolve; });
    adapter.events = [{ type: 'output', channel: 'stdout', data: 'stale' }];
    const { persistence, supervisor } = await openedRuntime(adapter);
    const run = supervisor.runTurn({
        ...fence,
        executionId: 'execution-one',
        attemptId: 'attempt-one',
        objective: 'Old owner',
        repository,
        requestedModel: 'model-a',
    });
    await started;
    await supervisor.takeover(identity, 2);
    releaseTurn();

    await assert.rejects(run, StaleGoalSessionFenceError);
    assert.deepEqual(await persistence.replay(identity), []);
    const rejected = await persistence.append(fence, { executionId: 'execution-one', attemptId: 'attempt-one' }, {
        type: 'output', channel: 'stderr', data: 'also stale',
    });
    assert.deepEqual(rejected, { accepted: false, reason: 'stale_fence' });
});

test('delivers durable steering in order and acknowledges each ID once', async () => {
    const adapter = new FakeGoalAdapter();
    let releaseTurn!: () => void;
    adapter.holdTurn = new Promise(resolve => { releaseTurn = resolve; });
    const started = new Promise<void>(resolve => { adapter.turnStarted = resolve; });
    adapter.events = [{ type: 'completion', outcome: 'succeeded' }];
    const { persistence, supervisor } = await openedRuntime(adapter);
    const run = supervisor.runTurn({ ...fence, executionId: 'execution-one', objective: 'Steer me', repository, requestedModel: 'model-a' });
    await started;
    persistence.enqueueMessage({ ...identity, messageId: 'message-one', body: 'first' });
    persistence.enqueueMessage({ ...identity, messageId: 'message-two', body: 'second' });

    await assert.rejects(
        supervisor.deliverMessage({ ...fence, messageId: 'message-two', body: 'ignored caller copy' }),
        /out of order/,
    );
    assert.equal((await supervisor.deliverMessage({ ...fence, messageId: 'message-one', body: '' })).outcome, 'acknowledged');
    assert.equal((await supervisor.deliverMessage({ ...fence, messageId: 'message-one', body: '' })).outcome, 'acknowledged');
    assert.equal((await supervisor.deliverMessage({ ...fence, messageId: 'message-two', body: '' })).outcome, 'acknowledged');
    assert.deepEqual(adapter.messageCalls, ['message-one', 'message-two']);
    releaseTurn();
    await run;
});

test('reports pause boundary, model effectiveness, same-turn resume, and terminal cancel separately', async () => {
    const adapter = new FakeGoalAdapter();
    let releaseTurn!: () => void;
    adapter.holdTurn = new Promise(resolve => { releaseTurn = resolve; });
    const started = new Promise<void>(resolve => { adapter.turnStarted = resolve; });
    adapter.events = [
        { type: 'pause_boundary', boundary: 'after_tool', checkpointId: 'cp-pause', providerEventId: 'pause-after-tool-1' },
    ];
    adapter.resumeEvents = [
        { type: 'assistant', messageId: 'assistant-continued', content: 'resumed work' },
        { type: 'completion', outcome: 'succeeded', summary: 'done after resume' },
    ];
    const { persistence, supervisor } = await openedRuntime(adapter);
    const runningTurn = supervisor.runTurn({ ...fence, executionId: 'execution-one', objective: 'Pause', repository, requestedModel: 'model-a' });
    await started;
    const pauseAck = await supervisor.requestPause({ ...fence, reason: 'operator wants a checkpoint' });
    assert.deepEqual(pauseAck, { appliesAt: 'next_safe_boundary' });
    releaseTurn();
    const turn = await runningTurn;
    assert.equal(turn.state.status, 'paused');

    const modelAck = await supervisor.requestModelChange({ ...fence, model: 'model-b' });
    assert.deepEqual(modelAck, { requestedModel: 'model-b', appliesAt: 'immediate', effectiveModel: 'model-b' });
    // Resume continues the exact active turn to a single later completion.
    const resumed = await supervisor.resumeTurn(fence);
    assert.equal(resumed.disposition, 'started');
    assert.equal(resumed.state.status, 'idle');
    assert.equal(resumed.state.providerSessionId, 'provider-session-stable');
    assert.equal(adapter.resumeTurnCalls, 1);
    assert.equal(adapter.beginCalls, 1);
    const cancelled = await supervisor.cancel({ ...fence, reason: 'operator requested termination' });
    assert.equal(cancelled.status, 'terminated');
    assert.equal(adapter.resumeCalls, 1);
    assert.equal(adapter.pauseCalls, 1);
    assert.equal(adapter.cancelCalls, 1);
    const types = (await persistence.replay(identity)).map(value => value.event.type);
    assert.ok(types.includes('pause_boundary'));
    assert.ok(types.includes('model_change_acknowledged'));
    assert.ok(types.includes('model_changed'));
    assert.ok(types.includes('session_resumed'));
    assert.ok(types.includes('turn_resumed'));
    // Exactly one turn completion, then the terminal cancel completion.
    assert.equal(types.filter(type => type === 'completion').length, 2);
    assert.equal(types.at(-1), 'completion');
});

test('an unsupported model transition fails without replacing the provider session', async () => {
    const adapter = new FakeGoalAdapter();
    adapter.rejectedModel = 'model-unsupported';
    let releaseTurn!: () => void;
    adapter.holdTurn = new Promise(resolve => { releaseTurn = resolve; });
    const started = new Promise<void>(resolve => { adapter.turnStarted = resolve; });
    adapter.events = [{ type: 'completion', outcome: 'succeeded' }];
    const { persistence, supervisor } = await openedRuntime(adapter);
    const running = supervisor.runTurn({ ...fence, executionId: 'execution-one', objective: 'Model test', repository, requestedModel: 'model-a' });
    await started;

    await assert.rejects(
        supervisor.requestModelChange({ ...fence, model: 'model-unsupported' }),
        (error: unknown) => error instanceof GoalSessionContractError
            && !(error instanceof UnsupportedGoalSessionTransitionError)
            && error.code === 'PROVIDER_OPERATION_FAILED',
    );
    const unchanged = await persistence.load(identity);
    assert.equal(unchanged?.currentModel, 'model-a');
    assert.equal(unchanged?.providerSessionId, 'provider-session-stable');
    releaseTurn();
    await running;
});

test('reconciles a missing container from durable provider and worktree state', async () => {
    const adapter = new FakeGoalAdapter();
    const { persistence, supervisor } = await openedRuntime(adapter);
    persistence.setContainerInspection(identity, { status: 'missing', reason: 'daemon restarted' });
    persistence.setRepositoryInspection(repository, {
        ...repository,
        exists: true,
        observedBranch: 'goal-branch',
        observedHeadSha: 'abc123',
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
        dirty: true,
    });
    adapter.reconcileResult = {
        outcome: 'resumed',
        snapshot: {
            providerSessionId: 'provider-session-stable',
            recoveryMetadata: { checkpoint: 'recovered' },
            model: 'model-a',
        },
        reason: 'Provider resumed from checkpoint against the inspected worktree',
    };

    const result = await supervisor.reconcile(identity, 2, repository);
    assert.equal(result.outcome, 'resumed');
    assert.equal(result.state.controllerEpoch, 2);
    assert.deepEqual(result.state.recoveryMetadata, { checkpoint: 'recovered' });
    assert.equal((await persistence.replay(identity)).at(-1)?.event.type, 'reconciliation');
});

test('reconciliation accepts legitimate HEAD advancement and reports the current checkpoint separately', async () => {
    const adapter = new FakeGoalAdapter();
    const { persistence, supervisor } = await openedRuntime(adapter);
    const advancedCheckout = {
        ...repository,
        repository: 'https://github.com/integry/propr.git',
        headSha: 'def456',
    };
    persistence.setContainerInspection(identity, { status: 'missing', reason: 'worker restarted' });
    persistence.setRepositoryInspection(repository, {
        ...repository,
        exists: true,
        observedRepository: advancedCheckout.repository,
        observedBranch: repository.branch,
        observedHeadSha: advancedCheckout.headSha,
        observedWorktreeFingerprint: fingerprintGoalWorktree(advancedCheckout),
    });
    adapter.reconcileResult = { outcome: 'alive', reason: 'goal commit is still recoverable' };

    const result = await supervisor.reconcile(identity, 2, repository);

    assert.equal(result.outcome, 'alive');
    assert.equal(adapter.reconcileRequests[0]?.repository.observedHeadSha, 'def456');
    assert.equal(fingerprintGoalWorktree(repository), fingerprintGoalWorktree(advancedCheckout));
});

test('reconciliation rejects repository replacement at the same path even without an expected HEAD', async () => {
    const adapter = new FakeGoalAdapter();
    const { persistence, supervisor } = await openedRuntime(adapter);
    const headlessRepository = {
        repository: repository.repository,
        worktreePath: repository.worktreePath,
        branch: repository.branch,
    };
    const replacement = { ...headlessRepository, repository: 'https://github.com/foreign/replacement.git' };
    persistence.setContainerInspection(identity, { status: 'missing', reason: 'worker restarted' });
    persistence.setRepositoryInspection(headlessRepository, {
        ...headlessRepository,
        exists: true,
        observedRepository: replacement.repository,
        observedBranch: replacement.branch,
        observedHeadSha: 'replacement-head',
        observedWorktreeFingerprint: fingerprintGoalWorktree(replacement),
    });
    adapter.reconcileResult = { outcome: 'alive', reason: 'must not inspect a foreign checkout' };

    const result = await supervisor.reconcile(identity, 2, headlessRepository);

    assert.equal(result.outcome, 'blocked');
    assert.match(result.reason, /fingerprint mismatch/);
    assert.equal(adapter.reconcileCalls, 0);
});

test('blocks reconciliation when authoritative container metadata is unavailable', async () => {
    const adapter = new FakeGoalAdapter();
    const { persistence, supervisor } = await openedRuntime(adapter);
    persistence.setContainerInspection(identity, { status: 'daemon_unavailable', reason: 'socket unavailable' });
    persistence.setRepositoryInspection(repository, {
        ...repository,
        exists: true,
        observedBranch: 'goal-branch',
        observedHeadSha: 'abc123',
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
    });
    adapter.reconcileResult = {
        outcome: 'failed',
        reason: 'Provider checkpoint is corrupt and cannot be resumed',
    };

    const result = await supervisor.reconcile(identity, 2, repository);

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.state.status, 'idle');
    assert.equal(adapter.reconcileCalls, 0);
});

test('blocks reconciliation with an actionable result when the worktree does not match', async () => {
    const adapter = new FakeGoalAdapter();
    const { persistence, supervisor } = await openedRuntime(adapter);
    persistence.setContainerInspection(identity, { status: 'missing', reason: 'daemon restarted' });
    persistence.setRepositoryInspection(repository, {
        ...repository,
        exists: true,
        observedBranch: 'unexpected-branch',
        observedHeadSha: 'zzz999',
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
    });
    adapter.reconcileResult = { outcome: 'resumed', snapshot: {
        providerSessionId: 'provider-session-stable', recoveryMetadata: { checkpoint: 'recovered' },
    }, reason: 'should not be reached' };

    const result = await supervisor.reconcile(identity, 2, repository);

    assert.equal(result.outcome, 'blocked');
    assert.match(result.reason, /branch mismatch/);
    // No provider side effect ran, and the session was not marked failed/resumed.
    assert.equal(result.state.status, 'idle');
    const last = (await persistence.replay(identity)).at(-1);
    assert.equal(last?.event.type, 'reconciliation');
    assert.equal(last?.event.type === 'reconciliation' ? last.event.outcome : undefined, 'blocked');
});

test('resumes the exact paused turn on a replacement supervisor and completes once', async () => {
    const adapter = new FakeGoalAdapter();
    adapter.events = [
        { type: 'assistant', messageId: 'a1', content: 'step one' },
        { type: 'checkpoint', checkpointId: 'cp-1', recoveryMetadata: { checkpoint: 'cp-1' } },
        { type: 'pause_boundary', boundary: 'after_tool', checkpointId: 'cp-1', providerEventId: 'pause-after-tool-2' },
    ];
    adapter.resumeEvents = [
        { type: 'assistant', messageId: 'a2', content: 'step two' },
        { type: 'usage', occurrenceId: 'usage-resume-1', semantics: 'delta', watermark: 0, model: 'model-a', inputTokens: 3, outputTokens: 4 },
        { type: 'completion', outcome: 'succeeded', summary: 'finished after restart' },
    ];
    const { persistence, supervisor } = await openedRuntime(adapter);
    const first = await supervisor.runTurn({
        ...fence, executionId: 'execution-one', attemptId: 'attempt-one',
        objective: 'Long turn', repository, requestedModel: 'model-a',
    });
    assert.equal(first.disposition, 'started');
    assert.equal(first.state.status, 'paused');

    // Simulate a worker/container restart: a brand-new supervisor takes over.
    const replacement = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => 'attempt-recovery');
    await replacement.takeover(identity, 2);
    const resumeFence: GoalSessionControlFence = { ...identity, controllerEpoch: 2 };
    const resumed = await replacement.resumeTurn(resumeFence);

    assert.equal(resumed.disposition, 'started');
    assert.equal(resumed.state.status, 'idle');
    assert.equal(adapter.beginCalls, 1, 'the provider turn is invoked exactly once');
    assert.equal(adapter.resumeTurnCalls, 1);
    assert.equal(resumed.execution.executionId, 'execution-one');
    assert.equal(resumed.execution.attemptId, 'attempt-recovery');

    const replay = await persistence.replay(identity);
    const types = replay.map(event => event.event.type);
    assert.deepEqual(replay.map(event => event.sequence), replay.map((_, index) => index + 1));
    assert.equal(types.filter(type => type === 'completion').length, 1, 'the turn completes exactly once');
    const turnResumed = replay.find(event => event.event.type === 'turn_resumed');
    assert.equal(turnResumed?.event.type === 'turn_resumed' ? turnResumed.event.turnId : undefined, 'turn-one');
    assert.equal(types.at(-1), 'completion');
});

class DeterministicAdapter extends FakeGoalAdapter {
    readonly supportsDeterministicOpen = true;
    lastOpenKey: string | undefined;
    lastAttemptId: string | undefined;

    async openSession(request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot> {
        this.openCalls += 1;
        this.lastOpenKey = request.deterministicOpenKey;
        this.lastAttemptId = request.attemptId;
        this.openedWith.push(request.persisted);
        return request.persisted ?? {
            providerSessionId: 'provider-deterministic',
            recoveryMetadata: { checkpoint: 'created' },
            model: 'model-a',
        };
    }
}

test('recovers a crash before provider-identity persistence when the provider is deterministic', async () => {
    const persistence = new InMemoryGoalSessionPorts();
    const adapter = new DeterministicAdapter();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => 'attempt-fresh');
    const timestamp = new Date().toISOString();
    // A previous controller recorded initialization intent, then crashed before
    // persisting the provider session identity.
    await persistence.create({
        ...identity, provider: 'fake', controllerEpoch: 1, status: 'initializing',
        completedTurnIds: [],
        initializationIntent: { attemptId: 'attempt-x', deterministicOpenKey: 'key-x', recordedAt: timestamp },
        createdAt: timestamp, updatedAt: timestamp,
    });

    const recovered = await supervisor.openSession({ ...identity, provider: 'fake', controllerEpoch: 2 });

    assert.equal(recovered.status, 'idle');
    assert.equal(recovered.providerSessionId, 'provider-deterministic');
    assert.equal(recovered.initializationIntent, undefined);
    assert.equal(adapter.lastOpenKey, 'key-x');
    assert.equal(adapter.lastAttemptId, 'attempt-fresh');
    assert.notEqual(adapter.lastAttemptId, 'attempt-x');
});

test('fails an unrecoverable crash before provider-identity persistence when open is not deterministic', async () => {
    const persistence = new InMemoryGoalSessionPorts();
    const adapter = new FakeGoalAdapter();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    const timestamp = new Date().toISOString();
    await persistence.create({
        ...identity, provider: 'fake', controllerEpoch: 1, status: 'initializing',
        completedTurnIds: [], createdAt: timestamp, updatedAt: timestamp,
    });

    await assert.rejects(
        supervisor.openSession({ ...identity, provider: 'fake', controllerEpoch: 2 }),
        (error: unknown) => error instanceof GoalSessionContractError && error.code === 'INCOMPLETE_INITIALIZATION',
    );
});

class ThrowingBeginAdapter extends FakeGoalAdapter {
    beginTurn(): AsyncIterable<GoalSessionEvent> {
        this.beginCalls += 1;
        throw new Error('begin invocation exploded');
    }
}

class ThrowingResumeAdapter extends FakeGoalAdapter {
    resumeTurn(): AsyncIterable<GoalSessionEvent> {
        this.resumeTurnCalls += 1;
        throw new Error('resume invocation exploded');
    }
}

test('a synchronous begin-turn invocation failure fences the session as failed with one completion', async () => {
    const adapter = new ThrowingBeginAdapter();
    const { persistence, supervisor } = await openedRuntime(adapter);

    await assert.rejects(
        supervisor.runTurn({ ...fence, executionId: 'exec-b', attemptId: 'att-b', objective: 'boom', repository, requestedModel: 'model-a' }),
        /Provider operation failed safely/,
    );

    const state = await persistence.load(identity);
    assert.equal(state?.status, 'failed');
    assert.equal(state?.activeTurn?.status, 'failed');
    const completions = (await persistence.replay(identity)).filter(event => event.event.type === 'completion');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].event.type === 'completion' ? completions[0].event.outcome : '', 'failed');
});

test('a synchronous resume-turn invocation failure fences the session as failed with one completion', async () => {
    const adapter = new ThrowingResumeAdapter();
    let releaseTurn!: () => void;
    adapter.holdTurn = new Promise(resolve => { releaseTurn = resolve; });
    const started = new Promise<void>(resolve => { adapter.turnStarted = resolve; });
    adapter.events = [{
        type: 'pause_boundary', boundary: 'after_tool', checkpointId: 'cp-pause', providerEventId: 'pause-after-tool-3',
    }];
    const { persistence, supervisor } = await openedRuntime(adapter);
    const running = supervisor.runTurn({ ...fence, executionId: 'exec-r', attemptId: 'att-r', objective: 'pause then resume', repository, requestedModel: 'model-a' });
    await started;
    await supervisor.requestPause({ ...fence, reason: 'checkpoint' });
    releaseTurn();
    const paused = await running;
    assert.equal(paused.state.status, 'paused');

    await assert.rejects(supervisor.resumeTurn(fence), /Provider operation failed safely/);

    const state = await persistence.load(identity);
    assert.equal(state?.status, 'failed');
    assert.equal(state?.activeTurn?.status, 'failed');
    const completions = (await persistence.replay(identity)).filter(event => event.event.type === 'completion');
    assert.equal(completions.length, 1);
});

test('rejects a model change on a terminated session before calling the adapter', async () => {
    const adapter = new FakeGoalAdapter();
    adapter.events = [{ type: 'completion', outcome: 'succeeded' }];
    const { supervisor } = await openedRuntime(adapter);
    await supervisor.runTurn({ ...fence, executionId: 'exec-one', objective: 'run', repository, requestedModel: 'model-a' });
    await supervisor.cancel({ ...fence, reason: 'operator requested termination' });
    const callsBefore = adapter.modelCalls.length;

    await assert.rejects(
        supervisor.requestModelChange({ ...fence, model: 'model-b' }),
        (error: unknown) => error instanceof GoalSessionContractError && error.code === 'SESSION_NOT_CONTROLLABLE',
    );
    assert.equal(adapter.modelCalls.length, callsBefore, 'the adapter must not be called for a terminated session');
});

test('reconciles a running turn after container loss into a resumable turn a replacement continues once', async () => {
    const persistence = new InMemoryGoalSessionPorts();
    const adapter = new FakeGoalAdapter();
    adapter.resumeEvents = [
        { type: 'assistant', messageId: 'a2', content: 'continued after recovery' },
        { type: 'completion', outcome: 'succeeded', summary: 'finished after container loss' },
    ];
    const timestamp = new Date().toISOString();
    await persistence.create({
        ...identity, provider: 'fake', controllerEpoch: 1, status: 'running',
        providerSessionId: 'provider-session-stable',
        recoveryMetadata: { checkpoint: 'mid-turn' },
        currentModel: 'model-a', requestedModel: 'model-a',
        activeTurn: {
            executionId: 'execution-live', attemptId: 'attempt-live', turnId: 'turn-one', executionEpoch: 1,
            objective: 'long turn', requestedModel: 'model-a', repository, status: 'running',
        },
        completedTurnIds: [], createdAt: timestamp, updatedAt: timestamp,
    });
    persistence.setContainerInspection(identity, { status: 'missing', reason: 'container lost' });
    persistence.setRepositoryInspection(repository, {
        ...repository, exists: true, observedBranch: 'goal-branch', observedHeadSha: 'abc123',
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
    });
    adapter.reconcileResult = {
        outcome: 'resumed',
        snapshot: { providerSessionId: 'provider-session-stable', recoveryMetadata: { checkpoint: 'recovered' }, model: 'model-a' },
        reason: 'provider resumed from checkpoint',
    };

    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    const result = await supervisor.reconcile(identity, 2, repository);
    assert.equal(result.outcome, 'resumed');
    // The interrupted running turn is reconciled into an explicitly resumable
    // paused turn, never left idle where a new turn could overwrite it.
    assert.equal(result.state.status, 'paused');
    assert.equal(result.state.activeTurn?.status, 'paused');
    assert.equal(result.state.activeTurn?.executionId, 'execution-live');
    assert.notEqual(result.state.activeTurn?.attemptId, 'attempt-live');
    assert.equal(result.state.activeTurn?.attemptId, adapter.reconcileRequests[0].attemptId);

    const replacement = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => 'attempt-recovered');
    const resumed = await replacement.resumeTurn({ ...identity, controllerEpoch: 2 });
    assert.equal(resumed.disposition, 'started');
    assert.equal(resumed.state.status, 'idle');
    assert.equal(resumed.execution.executionId, 'execution-live');
    assert.equal(resumed.execution.attemptId, 'attempt-recovered');
    assert.notEqual(resumed.execution.attemptId, adapter.reconcileRequests[0].attemptId);
    assert.equal(adapter.resumeTurnCalls, 1);
    assert.equal(adapter.beginCalls, 0, 'no new turn was begun for the recovered execution');
    const completions = (await persistence.replay(identity)).filter(event => event.event.type === 'completion');
    assert.equal(completions.length, 1, 'the recovered turn completes exactly once');
});

test('blocks reconciliation when the worktree branch cannot actually be observed', async () => {
    const adapter = new FakeGoalAdapter();
    const { persistence, supervisor } = await openedRuntime(adapter);
    persistence.setContainerInspection(identity, { status: 'missing', reason: 'daemon restarted' });
    // The worktree exists but its git state could not be inspected.
    persistence.setRepositoryInspection(repository, {
        ...repository, exists: true, reason: 'git rev-parse failed: not a git repository',
    });
    adapter.reconcileResult = {
        outcome: 'resumed',
        snapshot: { providerSessionId: 'provider-session-stable', recoveryMetadata: { checkpoint: 'x' } },
        reason: 'should not be reached',
    };

    const result = await supervisor.reconcile(identity, 2, repository);
    assert.equal(result.outcome, 'blocked');
    assert.match(result.reason, /branch could not be observed/);
    assert.equal(result.state.status, 'idle');
});

test('redelivery of an older completed turn recovers its original execution identity', async () => {
    const adapter = new FakeGoalAdapter();
    adapter.events = [{ type: 'completion', outcome: 'succeeded' }];
    const { supervisor } = await openedRuntime(adapter);
    const firstReq = {
        ...fence, turnId: 'turn-one', executionId: 'exec-one', attemptId: 'attempt-one',
        objective: 'first', repository, requestedModel: 'model-a',
    };
    await supervisor.runTurn(firstReq);
    // A subsequent turn replaces activeTurn with a different execution identity.
    await supervisor.runTurn({
        ...fence, turnId: 'turn-two', executionId: 'exec-two', attemptId: 'attempt-two',
        objective: 'second', repository, requestedModel: 'model-a',
    });
    assert.equal(adapter.beginCalls, 2);

    const redelivered = await supervisor.runTurn(firstReq);
    assert.equal(redelivered.disposition, 'duplicate');
    assert.equal(redelivered.disposition === 'duplicate' && redelivered.reattached, true);
    assert.equal(redelivered.execution.executionId, 'exec-one');
    assert.equal(redelivered.execution.attemptId, 'attempt-one');
    assert.equal(adapter.beginCalls, 2, 'the older turn is not re-invoked on the provider');
});

test('goal-scoped session state cannot be read or reused by another goal', async () => {
    const { persistence } = await openedRuntime();
    await assert.rejects(
        persistence.load({ goalId: 'different-goal', sessionId: identity.sessionId }),
        GoalSessionScopeError,
    );
});

test('a delayed same-epoch model acknowledgement cannot overwrite a newer intent', async () => {
    const gate = deferred();
    const started = deferred();
    class RacingModelAdapter extends FakeGoalAdapter {
        override async requestModelChange(request: GoalModelChangeRequest) {
            this.modelCalls.push(request.model);
            if (request.model === 'model-old') {
                started.resolve();
                await gate.promise;
            }
            return { requestedModel: request.model, appliesAt: 'immediate' as const, effectiveModel: request.model };
        }
    }
    const adapter = new RacingModelAdapter();
    const { persistence, supervisor } = await openedRuntime(adapter);
    const oldRequest = supervisor.requestModelChange({ ...fence, model: 'model-old' });
    await started.promise;
    await supervisor.requestModelChange({ ...fence, model: 'model-new' });
    gate.resolve();
    await assert.rejects(oldRequest, StaleGoalSessionFenceError);

    const state = await persistence.load(identity);
    assert.equal(state?.requestedModel, 'model-new');
    assert.equal(state?.currentModel, 'model-new');
    const changedModels = (await persistence.replay(identity)).flatMap(record =>
        record.event.type === 'model_changed' ? [record.event.model] : []);
    assert.deepEqual(changedModels, ['model-new']);
});

test('each failed recovery retry durably advances to another fresh attempt', async () => {
    class RetryResumeAdapter extends FakeGoalAdapter {
        failResume = true;
        override async resumeSession(request: GoalSessionControlFence, snapshot: GoalProviderSessionSnapshot) {
            if (this.failResume) {
                this.failResume = false;
                throw new Error('recovery transport failed');
            }
            return super.resumeSession(request, snapshot);
        }
    }
    const adapter = new RetryResumeAdapter();
    adapter.events = [{ type: 'pause_boundary', boundary: 'checkpoint', providerEventId: 'pause-checkpoint-1' }];
    adapter.resumeEvents = [{ type: 'completion', outcome: 'succeeded' }];
    const persistence = new InMemoryGoalSessionPorts();
    const ids = ['provider-open-attempt', 'attempt-recovery-one', 'attempt-recovery-two'];
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => ids.shift()!);
    await supervisor.openSession({ ...identity, provider: 'fake', controllerEpoch: 1 });
    await supervisor.runTurn({
        ...fence, executionId: 'execution-retry', attemptId: 'attempt-crashed',
        objective: 'retry recovery', repository, requestedModel: 'model-a',
    });

    await assert.rejects(supervisor.resumeTurn(fence), /Provider operation failed safely/);
    assert.equal((await persistence.load(identity))?.activeTurn?.attemptId, 'attempt-recovery-one');
    assert.equal((await persistence.load(identity))?.status, 'paused');
    assert.deepEqual(await persistence.append(fence, {
        executionId: 'execution-retry', attemptId: 'attempt-crashed',
    }, { type: 'output', channel: 'stdout', data: 'late crashed output' }), {
        accepted: false, reason: 'turn_not_active',
    });
    const recovered = await supervisor.resumeTurn(fence);
    assert.equal(recovered.execution.attemptId, 'attempt-recovery-two');
    assert.deepEqual(adapter.resumeTurnAttempts, ['attempt-recovery-two']);
});

test('a delayed same-epoch resume cannot resurrect a terminal session', async () => {
    const gate = deferred();
    const started = deferred();
    class RacingResumeAdapter extends FakeGoalAdapter {
        override async resumeSession(_request: GoalSessionControlFence, snapshot: GoalProviderSessionSnapshot) {
            started.resolve();
            await gate.promise;
            return snapshot;
        }
    }
    const adapter = new RacingResumeAdapter();
    adapter.events = [{ type: 'pause_boundary', boundary: 'checkpoint', providerEventId: 'pause-checkpoint-2' }];
    const { persistence, supervisor } = await openedRuntime(adapter);
    await supervisor.runTurn({
        ...fence, executionId: 'execution-race', attemptId: 'attempt-crashed',
        objective: 'pause', repository, requestedModel: 'model-a',
    });
    const resume = supervisor.resumeTurn(fence);
    await started.promise;
    await supervisor.cancel({ ...fence, reason: 'terminal wins' });
    gate.resolve();
    await assert.rejects(resume, StaleGoalSessionFenceError);

    const state = await persistence.load(identity);
    assert.equal(state?.status, 'terminated');
    assert.equal(state?.activeTurn, undefined);
    const completions = (await persistence.replay(identity)).filter(record => record.event.type === 'completion');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].event.type === 'completion' ? completions[0].event.outcome : '', 'cancelled');
});

test('terminal transaction survives an ambiguous post-commit crash without duplicate completion', async () => {
    const adapter = new FakeGoalAdapter();
    adapter.events = [{ type: 'completion', outcome: 'succeeded' }];
    const { persistence, supervisor } = await openedRuntime(adapter);
    const request = {
        ...fence, executionId: 'execution-atomic', attemptId: 'attempt-atomic',
        objective: 'atomic completion', repository, requestedModel: 'model-a',
    };
    persistence.setTerminalFault('after_commit');
    await assert.rejects(supervisor.runTurn(request), /Injected crash after terminal transaction commit/);
    assert.equal((await persistence.load(identity))?.status, 'idle');
    assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'completion').length, 1);

    const restarted = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    const duplicate = await restarted.runTurn(request);
    assert.equal(duplicate.disposition, 'duplicate');
    assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'completion').length, 1);
});

test('a pre-commit crash leaves neither terminal state nor event and recovery completes atomically', async () => {
    const adapter = new FakeGoalAdapter();
    adapter.events = [{ type: 'completion', outcome: 'succeeded' }];
    adapter.resumeEvents = [{ type: 'completion', outcome: 'succeeded' }];
    const { persistence, supervisor } = await openedRuntime(adapter);
    persistence.setTerminalFault('before_commit_always');
    await assert.rejects(supervisor.runTurn({
        ...fence, executionId: 'execution-window', attemptId: 'attempt-crashed',
        objective: 'crash window', repository, requestedModel: 'model-a',
    }), /Injected crash before terminal transaction commit/);
    assert.equal((await persistence.load(identity))?.status, 'running');
    assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'completion').length, 0);

    persistence.setTerminalFault(undefined);
    persistence.setContainerInspection(identity, { status: 'missing', reason: 'worker crashed' });
    persistence.setRepositoryInspection(repository, {
        ...repository,
        exists: true,
        observedBranch: repository.branch,
        observedHeadSha: repository.headSha,
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
    });
    adapter.reconcileResult = {
        outcome: 'resumed',
        reason: 'checkpoint recovered',
        snapshot: { providerSessionId: 'provider-session-stable', recoveryMetadata: { checkpoint: 'recovered' } },
    };
    await supervisor.reconcile(identity, 2, repository);
    const restarted = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => 'attempt-recovered');
    const recovered = await restarted.resumeTurn({ ...identity, controllerEpoch: 2 });
    assert.equal(recovered.execution.attemptId, 'attempt-recovered');
    assert.equal((await persistence.load(identity))?.status, 'idle');
    assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'completion').length, 1);
});

test('reconciliation requires every authoritative container identity field', async () => {
    const expectedIdentity = {
        ...identity,
        executionEpoch: 1,
        turnId: fence.turnId,
        attemptId: 'attempt-live',
        worktreeFingerprint: fingerprintGoalWorktree(repository),
    };
    const variants: Array<[string, Partial<typeof expectedIdentity> | null, boolean]> = [
        ['exact identity', {}, true],
        ['missing metadata', null, false],
        ['foreign goal', { goalId: 'other-goal' }, false],
        ['stale epoch', { executionEpoch: 0 }, false],
        ['foreign turn', { turnId: 'other-turn' }, false],
        ['stale attempt', { attemptId: 'old-attempt' }, false],
        ['foreign worktree', { worktreeFingerprint: 'wrong-fingerprint' }, false],
    ];
    for (const [label, replacement, accepted] of variants) {
        const persistence = new InMemoryGoalSessionPorts();
        const adapter = new FakeGoalAdapter();
        const timestamp = new Date().toISOString();
        await persistence.create({
            ...identity,
            provider: 'fake', controllerEpoch: 1, status: 'running',
            providerSessionId: 'provider-session-stable', recoveryMetadata: { checkpoint: 'live' },
            activeTurn: {
                executionId: 'execution-live', attemptId: 'attempt-live', executionEpoch: 1,
                turnId: fence.turnId, objective: 'live', requestedModel: 'model-a', repository, status: 'running',
            },
            completedTurnIds: [], createdAt: timestamp, updatedAt: timestamp,
        });
        persistence.setContainerInspection(identity, {
            status: 'running',
            recoveryIdentity: replacement ? { ...expectedIdentity, ...replacement } : undefined,
        });
        persistence.setRepositoryInspection(repository, {
            ...repository,
            exists: true,
            observedBranch: repository.branch,
            observedHeadSha: repository.headSha,
            observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
        });
        adapter.reconcileResult = { outcome: 'alive', reason: 'identity accepted' };
        const result = await new GoalSessionSupervisor(adapter, persistence.asRuntimePorts())
            .reconcile(identity, 2, repository);
        assert.equal(result.outcome, accepted ? 'alive' : 'blocked', label);
        assert.equal(adapter.reconcileCalls, accepted ? 1 : 0, label);
    }
});
