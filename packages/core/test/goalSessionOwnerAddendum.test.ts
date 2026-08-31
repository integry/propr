import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
    GoalBeginTurnRequest,
    GoalCancelRequest,
    GoalModelChangeRequest,
    GoalProviderOpenRequest,
    GoalProviderReconcileRequest,
    GoalProviderReconcileResult,
    GoalProviderCapabilities,
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
    readonly capabilities: GoalProviderCapabilities = {
        nativeSessionId: 'eager',
        steering: 'active_turn',
        pause: 'active_turn',
        modelChange: 'next_safe_boundary',
    } as const;
    turn: (request: GoalBeginTurnRequest) => AsyncIterable<GoalSessionEvent> = async function* () {
        yield { type: 'completion', outcome: 'succeeded' };
    };
    resumedTurn: () => AsyncIterable<GoalSessionEvent> = async function* () {
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

    resumeTurn(): AsyncIterable<GoalSessionEvent> {
        return this.resumedTurn();
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
    assert.equal(terminal.activeTurn, undefined);
    const completions = (await persistence.replay(identity)).filter(record => record.event.type === 'completion');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].event.type === 'completion' ? completions[0].event.outcome : '', 'cancelled');
});

test('actual stale streams cannot mutate checkpoint, model, or pause after recovery starts a fresh attempt', async t => {
    const cases: Array<{
        name: string;
        event: GoalSessionEvent;
        verify: (state: GoalSessionState) => void;
    }> = [
        {
            name: 'checkpoint recovery metadata',
            event: { type: 'checkpoint', checkpointId: 'stale', recoveryMetadata: { checkpoint: 'stale' } },
            verify: state => assert.deepEqual(state.recoveryMetadata, { checkpoint: 'recovered' }),
        },
        {
            name: 'current model',
            event: { type: 'model_changed', previousModel: 'model-a', model: 'stale-model' },
            verify: state => assert.equal(state.currentModel, 'model-recovered'),
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
            const oldTurnStarted = deferred();
            const releaseOldEvent = deferred();
            const currentTurnStarted = deferred();
            const releaseCurrentTurn = deferred();
            adapter.turn = async function* () {
                oldTurnStarted.resolve();
                await releaseOldEvent.promise;
                yield testCase.event;
            };
            adapter.resumedTurn = async function* () {
                currentTurnStarted.resolve();
                await releaseCurrentTurn.promise;
                yield { type: 'completion', outcome: 'succeeded' };
            };
            adapter.reconcileTurn = async () => ({
                outcome: 'resumed',
                reason: 'fresh recovery attempt enacted',
                snapshot: {
                    providerSessionId: 'owner-provider-session',
                    recoveryMetadata: { checkpoint: 'recovered' },
                    model: 'model-recovered',
                },
            });
            const { persistence, supervisor } = await openRuntime(adapter);
            const running = supervisor.runTurn({
                ...fence,
                executionId: 'execution-shared',
                attemptId: 'attempt-old',
                objective: `stale ${testCase.name}`,
                repository,
                requestedModel: 'model-a',
            });
            await oldTurnStarted.promise;
            persistence.setContainerInspection(identity, { status: 'missing', reason: 'old invocation disappeared' });
            persistence.setRepositoryInspection(repository, {
                ...repository,
                exists: true,
                observedRepository: repository.repository,
                observedBranch: repository.branch,
                observedHeadSha: repository.headSha,
                observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
                resolvedWorktreePath: repository.worktreePath,
            });
            const recovered = await supervisor.reconcile(identity, 1, repository);
            assert.equal(recovered.outcome, 'resumed');
            const resumed = supervisor.resumeTurn({ ...identity, controllerEpoch: 1 });
            await currentTurnStarted.promise;
            const currentAttempt = (await persistence.load(identity))?.activeTurn?.attemptId;
            assert.ok(currentAttempt);
            assert.notEqual(currentAttempt, 'attempt-old');

            releaseOldEvent.resolve();
            await assert.rejects(running, StaleGoalSessionFenceError);

            const state = await persistence.load(identity);
            assert.ok(state);
            assert.equal(state.activeTurn?.attemptId, currentAttempt);
            testCase.verify(state);
            assert.equal((await persistence.replay(identity)).some(record =>
                JSON.stringify(record.event) === JSON.stringify(testCase.event)), false);
            releaseCurrentTurn.resolve();
            await resumed;
        });
    }
});

test('an old recovery attempt cannot consume or emit corrective-message acknowledgement', async () => {
    class NextTurnMessageAdapter extends AddendumAdapter {
        override readonly capabilities: GoalProviderCapabilities = {
            nativeSessionId: 'eager',
            steering: 'next_turn',
            pause: 'active_turn',
            modelChange: 'next_safe_boundary',
        };
    }
    const adapter = new NextTurnMessageAdapter();
    const turnStarted = deferred();
    const releaseOldAcknowledgement = deferred();
    adapter.turn = async function* (request) {
        turnStarted.resolve();
        await releaseOldAcknowledgement.promise;
        yield { type: 'message_acknowledged', messageId: request.correctiveMessages![0].messageId };
        yield { type: 'completion', outcome: 'succeeded' };
    };
    adapter.reconcileTurn = async () => ({
        outcome: 'resumed',
        reason: 'replacement attempt owns the recovered invocation',
        snapshot: {
            providerSessionId: 'owner-provider-session',
            recoveryMetadata: { checkpoint: 'message-recovery' },
            model: 'model-a',
        },
    });
    const { persistence, supervisor } = await openRuntime(adapter, ['attempt-open', 'attempt-recovery']);
    persistence.enqueueMessage({ ...identity, messageId: 'message-one', body: 'first correction' });
    persistence.enqueueMessage({ ...identity, messageId: 'message-two', body: 'second correction' });
    const running = supervisor.runTurn({
        ...fence,
        executionId: 'execution-message-recovery',
        attemptId: 'attempt-old-message',
        objective: 'recover before the old acknowledgement arrives',
        repository,
        requestedModel: 'model-a',
    });
    await turnStarted.promise;
    persistence.setContainerInspection(identity, { status: 'missing', reason: 'old message attempt disappeared' });
    persistence.setRepositoryInspection(repository, {
        ...repository,
        exists: true,
        observedRepository: repository.repository,
        observedBranch: repository.branch,
        observedHeadSha: repository.headSha,
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
        resolvedWorktreePath: repository.worktreePath,
    });
    const recovered = await supervisor.reconcile(identity, 1, repository);
    const currentExecution = {
        executionId: recovered.state.activeTurn!.executionId,
        attemptId: recovered.state.activeTurn!.attemptId,
    };
    assert.equal(currentExecution.attemptId, 'attempt-recovery');

    releaseOldAcknowledgement.resolve();
    await assert.rejects(running, StaleGoalSessionFenceError);
    assert.deepEqual((await persistence.listPending(identity)).map(message => message.messageId), [
        'message-one', 'message-two',
    ]);
    assert.equal((await persistence.replay(identity)).some(record =>
        record.event.type === 'message_acknowledged' && record.attemptId === 'attempt-old-message'), false);

    assert.equal(await persistence.acknowledge(fence, currentExecution, 'message-one'), 'acknowledged');
    assert.equal(await persistence.acknowledge(fence, currentExecution, 'message-one'), 'already_acknowledged');
    const appended = await persistence.append(fence, currentExecution, {
        type: 'message_acknowledged', messageId: 'message-one',
    });
    assert.equal(appended.accepted, true);
    assert.deepEqual((await persistence.listPending(identity)).map(message => message.messageId), ['message-two']);
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

class PromotionCrashPorts extends InMemoryGoalSessionPorts {
    private crashPromotion = true;

    override async compareAndSet(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
    ): Promise<GoalSessionState | null> {
        if (this.crashPromotion && expected.recoveryAttempt
            && next.recoveryAttempt === undefined
            && next.activeTurn?.attemptId === expected.recoveryAttempt.attemptId) {
            this.crashPromotion = false;
            throw new Error('Injected crash before replacement promotion');
        }
        return super.compareAndSet(expected, next);
    }
}

async function seededRecoveryWithPorts(adapter: AddendumAdapter, ids: string[], persistence: InMemoryGoalSessionPorts) {
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
            executionId: 'execution-live', attemptId: 'attempt-live', turnId: fence.turnId,
            executionEpoch: 1, objective: 'recover live turn', requestedModel: 'model-a',
            repository, status: 'running',
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
    return {
        persistence,
        supervisor: new GoalSessionSupervisor(adapter, persistence.asRuntimePorts(), () => ids.shift()!),
    };
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
    assert.equal((await persistence.append({ ...fence, controllerEpoch: 2 }, {
        executionId: 'execution-live', attemptId: 'attempt-live',
    }, { type: 'output', channel: 'stdout', data: 'live after blocked reconcile' })).accepted, true);
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
    assert.deepEqual(await persistence.append({ ...fence, controllerEpoch: 2 }, {
        executionId: 'execution-live', attemptId: 'attempt-live',
    }, { type: 'output', channel: 'stdout', data: 'stale after replacement' }), {
        accepted: false, reason: 'turn_not_active',
    });
    assert.equal((await persistence.append({ ...fence, controllerEpoch: 2 }, {
        executionId: 'execution-live', attemptId: 'recovery-replacement',
    }, { type: 'output', channel: 'stdout', data: 'replacement output' })).accepted, true);
});

test('a crash before replacement promotion preserves old authority and retry promotes only its fresh attempt', async () => {
    const adapter = new AddendumAdapter();
    adapter.reconcileTurn = async request => ({
        outcome: 'resumed',
        reason: `replacement ${request.attemptId} enacted`,
        snapshot: {
            providerSessionId: 'owner-provider-session',
            recoveryMetadata: { checkpoint: request.attemptId },
            model: 'model-a',
        },
    });
    const persistence = new PromotionCrashPorts();
    const seeded = await seededRecoveryWithPorts(
        adapter,
        ['recovery-before-crash', 'recovery-after-crash'],
        persistence,
    );

    await assert.rejects(seeded.supervisor.reconcile(identity, 2, repository), /before replacement promotion/);
    const crashed = await persistence.load(identity);
    assert.equal(crashed?.activeTurn?.attemptId, 'attempt-live');
    assert.equal(crashed?.recoveryAttempt?.attemptId, 'recovery-before-crash');
    assert.equal((await persistence.append({ ...fence, controllerEpoch: 2 }, {
        executionId: 'execution-live', attemptId: 'attempt-live',
    }, { type: 'output', channel: 'stdout', data: 'old output in crash window' })).accepted, true);
    assert.deepEqual(await persistence.append({ ...fence, controllerEpoch: 2 }, {
        executionId: 'execution-live', attemptId: 'recovery-before-crash',
    }, { type: 'output', channel: 'stdout', data: 'uncommitted replacement output' }), {
        accepted: false, reason: 'turn_not_active',
    });

    const retried = await seeded.supervisor.reconcile(identity, 2, repository);
    assert.equal(retried.outcome, 'resumed');
    assert.equal(retried.state.activeTurn?.attemptId, 'recovery-after-crash');
    assert.deepEqual(adapter.reconcileRequests.map(request => request.attemptId), [
        'recovery-before-crash', 'recovery-after-crash',
    ]);
    assert.deepEqual(await persistence.append({ ...fence, controllerEpoch: 2 }, {
        executionId: 'execution-live', attemptId: 'attempt-live',
    }, { type: 'output', channel: 'stdout', data: 'old output after promotion' }), {
        accepted: false, reason: 'turn_not_active',
    });
    assert.equal((await persistence.append({ ...fence, controllerEpoch: 2 }, {
        executionId: 'execution-live', attemptId: 'recovery-after-crash',
    }, { type: 'output', channel: 'stdout', data: 'retry replacement output' })).accepted, true);
});

test('recovered after-turn retry preserves a concurrent newer model intent and applies it on retry', async () => {
    class BoundaryAdapter extends AddendumAdapter {
        override readonly capabilities = {
            nativeSessionId: 'eager',
            steering: 'next_turn',
            pause: 'after_turn',
            modelChange: 'next_turn',
        } as const;
        readonly modelRequests: string[] = [];
        modelStarted: (() => void) | undefined;
        holdModel: Promise<void> | undefined;

        override async requestModelChange(request: GoalModelChangeRequest) {
            this.modelRequests.push(request.model);
            this.modelStarted?.();
            if (this.holdModel) await this.holdModel;
            return { requestedModel: request.model, appliesAt: 'immediate' as const, effectiveModel: request.model };
        }
    }
    const adapter = new BoundaryAdapter();
    const persistence = new InMemoryGoalSessionPorts();
    const timestamp = new Date().toISOString();
    await persistence.create({
        ...identity,
        provider: adapter.provider,
        providerSessionId: 'owner-provider-session',
        recoveryMetadata: { checkpoint: 'reconciled' },
        controllerEpoch: 1,
        status: 'paused',
        currentModel: 'model-a',
        requestedModel: 'model-a',
        recoveryAttemptId: 'attempt-reconciled',
        activeTurn: {
            executionId: 'execution-model-recovery', attemptId: 'attempt-reconciled', turnId: fence.turnId,
            executionEpoch: 1, objective: 'continue with latest model', requestedModel: 'model-a',
            repository, status: 'paused',
        },
        completedTurnIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
    });
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await supervisor.requestModelChange({ ...identity, controllerEpoch: 1, model: 'model-old' });
    const modelStarted = deferred();
    const releaseOldModel = deferred();
    adapter.modelStarted = modelStarted.resolve;
    adapter.holdModel = releaseOldModel.promise;
    const staleResume = supervisor.resumeTurn({ ...identity, controllerEpoch: 1 });
    await modelStarted.promise;

    await supervisor.requestModelChange({ ...identity, controllerEpoch: 1, model: 'model-new' });
    releaseOldModel.resolve();
    await assert.rejects(staleResume, StaleGoalSessionFenceError);
    const newerIntent = await persistence.load(identity);
    assert.equal(newerIntent?.status, 'paused');
    assert.equal(newerIntent?.currentModel, 'model-a');
    assert.equal(newerIntent?.pendingModelChange, 'model-new');

    adapter.modelStarted = undefined;
    adapter.holdModel = undefined;
    const recovered = await supervisor.resumeTurn({ ...identity, controllerEpoch: 1 });
    assert.equal(recovered.disposition, 'started');
    assert.equal(recovered.state.status, 'idle');
    assert.equal(recovered.state.currentModel, 'model-new');
    assert.equal(recovered.state.pendingModelChange, undefined);
    assert.deepEqual(adapter.modelRequests, ['model-old', 'model-new']);
    const replay = await persistence.replay(identity);
    const acknowledgements = replay.filter(record => record.event.type === 'model_change_acknowledged');
    assert.deepEqual(acknowledgements.map(record =>
        record.event.type === 'model_change_acknowledged' ? record.event.requestedModel : ''), [
        'model-old', 'model-new',
    ]);
    assert.deepEqual(replay.filter(record => record.event.type === 'model_changed').map(record =>
        record.event.type === 'model_changed' ? record.event.model : ''), ['model-new']);
});
