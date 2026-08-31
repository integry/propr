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
    GoalSessionAdapter,
    GoalSessionControlFence,
    GoalSessionEvent,
    GoalSessionFence,
    GoalSessionState,
} from '../src/agents/goalSession/contract.js';
import {
    GoalSessionSupervisor,
    StaleGoalSessionFenceError,
} from '../src/agents/goalSession/GoalSessionSupervisor.js';
import { InMemoryGoalSessionPorts } from '../src/agents/goalSession/InMemoryGoalSessionPorts.js';
import { fingerprintGoalWorktree } from '../src/agents/goalSession/worktreeIdentity.js';

const identity = { goalId: 'owner-goal', sessionId: 'owner-session' };
const repository = {
    repository: 'integry/propr',
    worktreePath: '/tmp/owner-goal-worktree',
    branch: 'owner-branch',
    headSha: 'starting-head',
};
const fence: GoalSessionFence = { ...identity, controllerEpoch: 1, turnId: 'owner-turn' };

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

class AddendumAdapter implements GoalSessionAdapter {
    readonly provider = 'owner-test';
    readonly capabilities = {
        nativeSessionId: 'eager',
        steering: 'active_turn',
        pause: 'active_turn',
        modelChange: 'next_safe_boundary',
    } as const;
    turn: (request: GoalBeginTurnRequest) => AsyncIterable<GoalSessionEvent> = async function* () {
        yield { type: 'completion', outcome: 'succeeded' };
    };
    cancelTurn: (_request: GoalCancelRequest) => Promise<void> = async () => undefined;
    reconcileTurn: (_request: GoalProviderReconcileRequest) => Promise<GoalProviderReconcileResult>
        = async () => ({ outcome: 'alive', reason: 'alive' });
    reconcileRequests: GoalProviderReconcileRequest[] = [];

    async openSession(_request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot> {
        return { providerSessionId: 'owner-provider-session', recoveryMetadata: { checkpoint: 'opened' }, model: 'model-a' };
    }

    beginTurn(request: GoalBeginTurnRequest): AsyncIterable<GoalSessionEvent> {
        return this.turn(request);
    }

    async resumeSession(
        _request: GoalSessionControlFence,
        snapshot: GoalProviderSessionSnapshot,
    ): Promise<GoalProviderSessionSnapshot> {
        return snapshot;
    }

    async requestModelChange(request: GoalModelChangeRequest) {
        return { requestedModel: request.model, appliesAt: 'immediate' as const, effectiveModel: request.model };
    }

    cancel(request: GoalCancelRequest): Promise<void> {
        return this.cancelTurn(request);
    }

    async reconcile(request: GoalProviderReconcileRequest): Promise<GoalProviderReconcileResult> {
        this.reconcileRequests.push(structuredClone(request));
        return this.reconcileTurn(request);
    }
}

async function openRuntime(adapter: AddendumAdapter, ids?: string[]) {
    const persistence = new InMemoryGoalSessionPorts();
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), ids ? () => ids.shift()! : undefined);
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    return { persistence, supervisor };
}

async function replaceAttempt(persistence: InMemoryGoalSessionPorts): Promise<void> {
    const state = await persistence.load(identity);
    assert.ok(state?.activeTurn);
    const { version: _version, ...next } = state;
    const saved = await persistence.compareAndSet(state, {
        ...next,
        activeTurn: { ...state.activeTurn, attemptId: 'attempt-new' },
    });
    assert.ok(saved);
}

test('durable cancellation prevents a completion racing provider cancellation from resurrecting the session', async () => {
    const adapter = new AddendumAdapter();
    const turnStarted = deferred();
    const releaseCompletion = deferred();
    const cancelStarted = deferred();
    const releaseCancel = deferred();
    adapter.turn = async function* () {
        turnStarted.resolve();
        await releaseCompletion.promise;
        yield { type: 'completion', outcome: 'succeeded' };
    };
    adapter.cancelTurn = async () => {
        cancelStarted.resolve();
        await releaseCancel.promise;
    };
    const { persistence, supervisor } = await openRuntime(adapter);
    const running = supervisor.runTurn({
        ...fence,
        executionId: 'execution-cancel-race',
        attemptId: 'attempt-cancel-race',
        objective: 'race cancellation',
        repository,
        requestedModel: 'model-a',
    });
    await turnStarted.promise;
    const cancelling = supervisor.cancel({ ...fence, reason: 'owner cancelled' });
    await cancelStarted.promise;
    assert.equal((await persistence.load(identity))?.status, 'cancelling');

    releaseCompletion.resolve();
    await assert.rejects(running, StaleGoalSessionFenceError);
    assert.equal((await persistence.load(identity))?.status, 'cancelling');

    releaseCancel.resolve();
    const terminal = await cancelling;
    assert.equal(terminal.status, 'terminated');
    const completions = (await persistence.replay(identity)).filter(record => record.event.type === 'completion');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].event.type === 'completion' ? completions[0].event.outcome : '', 'cancelled');
});

test('stale same-turn stream attempts cannot mutate checkpoint, model, or pause state', async t => {
    const cases: Array<{
        name: string;
        event: GoalSessionEvent;
        verify: (state: GoalSessionState) => void;
    }> = [
        {
            name: 'checkpoint recovery metadata',
            event: { type: 'checkpoint', checkpointId: 'stale', recoveryMetadata: { checkpoint: 'stale' } },
            verify: state => assert.deepEqual(state.recoveryMetadata, { checkpoint: 'opened' }),
        },
        {
            name: 'current model',
            event: { type: 'model_changed', previousModel: 'model-a', model: 'stale-model' },
            verify: state => assert.equal(state.currentModel, 'model-a'),
        },
        {
            name: 'pause boundary',
            event: { type: 'pause_boundary', boundary: 'stale-boundary' },
            verify: state => {
                assert.equal(state.status, 'running');
                assert.equal(state.activeTurn?.status, 'running');
            },
        },
    ];

    for (const testCase of cases) {
        await t.test(testCase.name, async () => {
            const adapter = new AddendumAdapter();
            const turnStarted = deferred();
            const releaseEvent = deferred();
            adapter.turn = async function* () {
                turnStarted.resolve();
                await releaseEvent.promise;
                yield testCase.event;
            };
            const { persistence, supervisor } = await openRuntime(adapter);
            const running = supervisor.runTurn({
                ...fence,
                executionId: 'execution-shared',
                attemptId: 'attempt-old',
                objective: `stale ${testCase.name}`,
                repository,
                requestedModel: 'model-a',
            });
            await turnStarted.promise;
            await replaceAttempt(persistence);
            releaseEvent.resolve();
            await assert.rejects(running, StaleGoalSessionFenceError);

            const state = await persistence.load(identity);
            assert.ok(state);
            assert.equal(state.activeTurn?.attemptId, 'attempt-new');
            testCase.verify(state);
            assert.equal((await persistence.replay(identity)).some(record =>
                JSON.stringify(record.event) === JSON.stringify(testCase.event)), false);
        });
    }
});

async function seededRecovery(adapter: AddendumAdapter, ids: string[]) {
    const persistence = new InMemoryGoalSessionPorts();
    const timestamp = new Date().toISOString();
    await persistence.create({
        ...identity,
        provider: adapter.provider,
        providerSessionId: 'owner-provider-session',
        recoveryMetadata: { checkpoint: 'durable' },
        controllerEpoch: 1,
        status: 'running',
        currentModel: 'model-a',
        requestedModel: 'model-a',
        activeTurn: {
            executionId: 'execution-live',
            attemptId: 'attempt-live',
            turnId: fence.turnId,
            executionEpoch: 1,
            objective: 'recover live turn',
            requestedModel: 'model-a',
            repository,
            status: 'running',
        },
        completedTurnIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
    });
    persistence.setContainerInspection(identity, { status: 'missing', reason: 'container unavailable' });
    persistence.setRepositoryInspection(repository, {
        ...repository,
        exists: true,
        observedRepository: repository.repository,
        observedBranch: repository.branch,
        observedHeadSha: repository.headSha,
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
        resolvedWorktreePath: repository.worktreePath,
    });
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => ids.shift()!);
    return { persistence, supervisor };
}

test('alive reconciliation preserves the authoritative live attempt while its fresh claim is in flight and after success', async () => {
    const adapter = new AddendumAdapter();
    const reconcileStarted = deferred();
    const releaseReconcile = deferred();
    adapter.reconcileTurn = async () => {
        reconcileStarted.resolve();
        await releaseReconcile.promise;
        return { outcome: 'alive', reason: 'original container remains alive' };
    };
    const { persistence, supervisor } = await seededRecovery(adapter, ['recovery-alive']);
    const reconciling = supervisor.reconcile(identity, 2, repository);
    await reconcileStarted.promise;
    const inFlight = await persistence.load(identity);
    assert.equal(inFlight?.activeTurn?.attemptId, 'attempt-live');
    assert.equal(inFlight?.recoveryAttempt?.attemptId, 'recovery-alive');

    releaseReconcile.resolve();
    const result = await reconciling;
    assert.equal(result.outcome, 'alive');
    assert.equal(result.state.activeTurn?.attemptId, 'attempt-live');
    assert.equal(result.state.recoveryAttempt, undefined);
    assert.equal((await persistence.append({ ...fence, controllerEpoch: 2 }, {
        executionId: 'execution-live', attemptId: 'attempt-live',
    }, { type: 'output', channel: 'stdout', data: 'still authoritative' })).accepted, true);
});

test('a thrown reconciliation preserves live identity and a retry durably claims a fresh attempt', async () => {
    const adapter = new AddendumAdapter();
    let call = 0;
    adapter.reconcileTurn = async () => {
        call += 1;
        if (call === 1) throw new Error('reconcile transport failed');
        return { outcome: 'alive', reason: 'retry observed live container' };
    };
    const { persistence, supervisor } = await seededRecovery(adapter, ['recovery-thrown', 'recovery-retry']);
    await assert.rejects(supervisor.reconcile(identity, 2, repository), /reconcile transport failed/);
    const failedCall = await persistence.load(identity);
    assert.equal(failedCall?.activeTurn?.attemptId, 'attempt-live');
    assert.equal(failedCall?.recoveryAttempt?.attemptId, 'recovery-thrown');
    assert.equal((await persistence.append({ ...fence, controllerEpoch: 2 }, {
        executionId: 'execution-live', attemptId: 'attempt-live',
    }, { type: 'output', channel: 'stdout', data: 'live after thrown reconcile' })).accepted, true);

    const retried = await supervisor.reconcile(identity, 2, repository);
    assert.equal(retried.outcome, 'alive');
    assert.equal(retried.state.activeTurn?.attemptId, 'attempt-live');
    assert.deepEqual(adapter.reconcileRequests.map(request => request.attemptId), ['recovery-thrown', 'recovery-retry']);
});

test('blocked reconciliation does not claim or replace an attempt', async () => {
    const adapter = new AddendumAdapter();
    const { persistence, supervisor } = await seededRecovery(adapter, ['must-not-be-used']);
    persistence.setRepositoryInspection(repository, {
        ...repository,
        exists: true,
        observedRepository: 'foreign/repository',
        observedBranch: repository.branch,
        observedHeadSha: 'foreign-head',
        observedWorktreeFingerprint: fingerprintGoalWorktree({ ...repository, repository: 'foreign/repository' }),
    });
    const result = await supervisor.reconcile(identity, 2, repository);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.state.activeTurn?.attemptId, 'attempt-live');
    assert.equal((await persistence.load(identity))?.recoveryAttempt, undefined);
    assert.equal(adapter.reconcileRequests.length, 0);
});

test('replacement reconciliation changes attempt identity only after the adapter proves replacement', async () => {
    const adapter = new AddendumAdapter();
    const reconcileStarted = deferred();
    const releaseReconcile = deferred();
    adapter.reconcileTurn = async () => {
        reconcileStarted.resolve();
        await releaseReconcile.promise;
        return {
            outcome: 'resumed',
            reason: 'replacement enacted',
            snapshot: {
                providerSessionId: 'owner-provider-session',
                recoveryMetadata: { checkpoint: 'replacement' },
                model: 'model-a',
            },
        };
    };
    const { persistence, supervisor } = await seededRecovery(adapter, ['recovery-replacement']);
    const reconciling = supervisor.reconcile(identity, 2, repository);
    await reconcileStarted.promise;
    assert.equal((await persistence.load(identity))?.activeTurn?.attemptId, 'attempt-live');

    releaseReconcile.resolve();
    const result = await reconciling;
    assert.equal(result.outcome, 'resumed');
    assert.equal(result.state.status, 'paused');
    assert.equal(result.state.activeTurn?.attemptId, 'recovery-replacement');
    assert.equal(result.state.recoveryAttempt, undefined);
});
