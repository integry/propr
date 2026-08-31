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
    GoalSessionEvent,
    GoalSessionFence,
    GoalSteeringRequest,
} from '../src/agents/goalSession/contract.js';
import {
    GoalSessionSupervisor,
    StaleGoalSessionFenceError,
    UnsupportedGoalSessionTransitionError,
} from '../src/agents/goalSession/GoalSessionSupervisor.js';
import {
    GoalSessionScopeError,
    InMemoryGoalSessionPorts,
} from '../src/agents/goalSession/InMemoryGoalSessionPorts.js';

const identity = { goalId: 'goal-2007', sessionId: 'session-one' };
const repository = {
    repository: 'integry/propr',
    worktreePath: '/tmp/propr-goal-2007',
    branch: 'goal-branch',
    headSha: 'abc123',
};
const fence: GoalSessionFence = { ...identity, controllerEpoch: 1, turnId: 'turn-one' };

class FakeGoalAdapter implements GoalSessionAdapter {
    readonly provider = 'fake';
    openCalls = 0;
    beginCalls = 0;
    messageCalls: string[] = [];
    pauseCalls = 0;
    resumeCalls = 0;
    modelCalls: string[] = [];
    rejectedModel: string | undefined;
    cancelCalls = 0;
    events: GoalSessionEvent[] = [];
    reconcileResult: GoalProviderReconcileResult = { outcome: 'failed', reason: 'not configured' };
    openedWith: Array<GoalProviderSessionSnapshot | undefined> = [];
    turnStarted: (() => void) | undefined;
    holdTurn: Promise<void> | undefined;

    async openSession(request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot> {
        this.openCalls += 1;
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

    async resumeSession(_request: GoalSessionFence, snapshot: GoalProviderSessionSnapshot): Promise<GoalProviderSessionSnapshot> {
        this.resumeCalls += 1;
        return snapshot;
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
        return this.reconcileResult;
    }
}

async function openedRuntime(adapter = new FakeGoalAdapter()) {
    const persistence = new InMemoryGoalSessionPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    const state = await supervisor.openSession({ ...identity, provider: 'fake', controllerEpoch: 1 });
    return { adapter, persistence, supervisor, state };
}

test('starts a recoverable turn and replays ordered normalized output and usage', async () => {
    const adapter = new FakeGoalAdapter();
    adapter.events = [
        { type: 'output', channel: 'stdout', data: 'out\n' },
        { type: 'output', channel: 'stderr', data: 'warning\n' },
        { type: 'assistant', messageId: 'assistant-1', content: 'working' },
        { type: 'tool', toolCallId: 'tool-1', name: 'edit', phase: 'completed', data: { file: 'a.ts' } },
        { type: 'todo', todoId: 'todo-1', title: 'test', status: 'completed' },
        { type: 'usage', model: 'model-a', inputTokens: 12, outputTokens: 5 },
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
    const restartedSupervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());

    const resumed = await restartedSupervisor.openSession({ ...identity, provider: 'fake', controllerEpoch: 2 });

    assert.equal(resumed.controllerEpoch, 2);
    assert.equal(resumed.providerSessionId, 'provider-session-stable');
    assert.equal(adapter.openCalls, 2);
    assert.equal(adapter.openedWith[1]?.providerSessionId, 'provider-session-stable');
    assert.deepEqual(adapter.openedWith[1]?.recoveryMetadata, { checkpoint: 'created' });
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
    assert.equal(await supervisor.deliverMessage({ ...fence, messageId: 'message-one', body: '' }), 'acknowledged');
    assert.equal(await supervisor.deliverMessage({ ...fence, messageId: 'message-one', body: '' }), 'already_acknowledged');
    assert.equal(await supervisor.deliverMessage({ ...fence, messageId: 'message-two', body: '' }), 'acknowledged');
    assert.deepEqual(adapter.messageCalls, ['message-one', 'message-two']);
    releaseTurn();
    await run;
});

test('reports pause boundary, model effectiveness, resume, and terminal cancel separately', async () => {
    const adapter = new FakeGoalAdapter();
    let releaseTurn!: () => void;
    adapter.holdTurn = new Promise(resolve => { releaseTurn = resolve; });
    const started = new Promise<void>(resolve => { adapter.turnStarted = resolve; });
    adapter.events = [
        { type: 'pause_boundary', boundary: 'after_tool', checkpointId: 'cp-pause' },
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
    const resumed = await supervisor.resumeSession(fence);
    assert.equal(resumed.status, 'idle');
    assert.equal(resumed.providerSessionId, 'provider-session-stable');
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
        (error: unknown) => error instanceof UnsupportedGoalSessionTransitionError
            && error.code === 'UNSUPPORTED_MODEL_TRANSITION',
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
    persistence.setRepositoryInspection(repository, { ...repository, exists: true, observedHeadSha: 'def456', dirty: true });
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

test('persists an actionable failure when crash reconciliation cannot resume', async () => {
    const adapter = new FakeGoalAdapter();
    const { persistence, supervisor } = await openedRuntime(adapter);
    persistence.setContainerInspection(identity, { status: 'daemon_unavailable', reason: 'socket unavailable' });
    persistence.setRepositoryInspection(repository, { ...repository, exists: false, reason: 'worktree was removed' });
    adapter.reconcileResult = {
        outcome: 'failed',
        reason: 'Provider checkpoint exists, but the required worktree no longer exists',
    };

    const result = await supervisor.reconcile(identity, 2, repository);

    assert.equal(result.state.status, 'failed');
    assert.equal(result.state.failureReason, 'Provider checkpoint exists, but the required worktree no longer exists');
});

test('goal-scoped session state cannot be read or reused by another goal', async () => {
    const { persistence } = await openedRuntime();
    await assert.rejects(
        persistence.load({ goalId: 'different-goal', sessionId: identity.sessionId }),
        GoalSessionScopeError,
    );
});
