import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
    GoalBeginTurnRequest,
    GoalCancelRequest,
    GoalModelChangeRequest,
    GoalProviderOpenRequest,
    GoalProviderReconcileRequest,
    GoalProviderReconcileResult,
    GoalProviderSessionSnapshot,
    GoalProviderTurnContext,
    GoalSessionAdapter,
    GoalSessionControlFence,
    GoalSessionEvent,
} from '../src/agents/goalSession/contract.js';
import {
    EAGER_ACTIVE_TURN_PROVIDER_CAPABILITIES,
    FIRST_TURN_BOUNDARY_PROVIDER_CAPABILITIES,
    GoalSessionContractError,
    GoalSessionSupervisor,
} from '../src/agents/goalSession/index.js';
import { InMemoryGoalSessionPorts } from '../src/agents/goalSession/InMemoryGoalSessionPorts.js';

const identity = { goalId: 'goal-capabilities', sessionId: 'session-capabilities' };
const repository = {
    repository: 'integry/propr',
    worktreePath: '/tmp/propr-goal-capabilities',
    branch: 'goal-capability-branch',
    headSha: 'abc123',
};
const firstFence = { ...identity, controllerEpoch: 1, turnId: 'turn-one' };

class FirstTurnBoundaryAdapter implements GoalSessionAdapter {
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
        this.turnStarted?.();
        if (this.holdTurn) await this.holdTurn;
        for (const message of request.correctiveMessages ?? []) {
            yield { type: 'message_acknowledged', messageId: message.messageId };
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

    async reconcile(_request: GoalProviderReconcileRequest): Promise<GoalProviderReconcileResult> {
        return { outcome: 'failed', reason: 'not used by capability tests' };
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
    assert.deepEqual(adapter.modelCalls, ['model-b']);
    assert.deepEqual(adapter.actions.slice(-2), ['model:model-b', 'begin:turn-two']);
    assert.equal(adapter.contexts[1]?.binding, 'bound');
    assert.equal(adapter.contexts[1]?.binding === 'bound'
        ? adapter.contexts[1].snapshot.providerSessionId
        : undefined, 'native-first-turn-id');

    const acknowledgedIds = (await persistence.replay(identity))
        .filter(record => record.event.type === 'message_acknowledged')
        .map(record => record.event.type === 'message_acknowledged' ? record.event.messageId : '');
    assert.deepEqual(acknowledgedIds, ['message-one', 'message-two']);
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
