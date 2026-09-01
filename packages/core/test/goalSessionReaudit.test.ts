import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
    GoalBeginTurnRequest,
    GoalProviderCancelRequest,
    GoalProviderCapabilities,
    GoalProviderModelChangeRequest,
    GoalProviderOpenRequest,
    GoalProviderReconcileRequest,
    GoalProviderSessionSnapshot,
    GoalSessionAdapter,
    GoalSessionControlFence,
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
import { fingerprintGoalWorktree } from '../src/agents/goalSession/worktreeIdentity.js';

const identity = { goalId: 'reaudit-goal', sessionId: 'reaudit-session' };
const repository = {
    repository: 'integry/propr', worktreePath: '/tmp/reaudit-worktree', branch: 'reaudit-branch', headSha: 'reaudit-head',
};
const control = { ...identity, controllerEpoch: 1 };
const turnFence = { ...control, turnId: 'reaudit-turn' };

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

class ReauditAdapter implements GoalSessionAdapter {
    async publishOperationBarrier(): Promise<void> {}
    readonly provider = 'reaudit-provider';
    readonly capabilities: GoalProviderCapabilities;
    readonly modelCalls: GoalProviderModelChangeRequest[] = [];
    readonly turnCalls: GoalBeginTurnRequest[] = [];
    readonly turnModelEffects = new Set<string>();
    readonly cancelCalls: GoalProviderCancelRequest[] = [];
    readonly modelEffects = new Set<string>();
    readonly cancelEffects: Set<string>;
    openCalls = 0;
    stream: (request: GoalBeginTurnRequest) => AsyncIterable<GoalSessionEvent> = async function* () {
        yield { type: 'completion', outcome: 'succeeded' };
    };
    cancelGate: Promise<void> | undefined;
    cancelStarted: (() => void) | undefined;

    constructor(
        capabilities: GoalProviderCapabilities = {
            nativeSessionId: 'eager', steering: 'active_turn', pause: 'active_turn', modelChange: 'next_safe_boundary',
        },
        cancelEffects = new Set<string>(),
    ) {
        this.capabilities = capabilities;
        this.cancelEffects = cancelEffects;
    }

    async openSession(_request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot> {
        this.openCalls += 1;
        return { providerSessionId: 'reaudit-native', recoveryMetadata: { checkpoint: 'open' }, model: 'model-a' };
    }

    beginTurn(request: GoalBeginTurnRequest): AsyncIterable<GoalSessionEvent> {
        this.turnCalls.push(structuredClone(request));
        if (request.modelChange) this.turnModelEffects.add(request.modelChange.modelChangeId);
        return this.stream(request);
    }

    async resumeSession(
        _request: GoalSessionControlFence,
        snapshot: GoalProviderSessionSnapshot,
    ): Promise<GoalProviderSessionSnapshot> { return snapshot; }

    async requestModelChange(request: GoalProviderModelChangeRequest) {
        this.modelCalls.push(structuredClone(request));
        this.modelEffects.add(request.modelChangeId);
        return { requestedModel: request.model, appliesAt: 'immediate' as const, effectiveModel: request.model };
    }

    async cancel(request: GoalProviderCancelRequest): Promise<void> { await this.signalCancel(request); }

    async cancelPending(request: GoalProviderCancelRequest): Promise<void> { await this.signalCancel(request); }

    async reconcile(_request: GoalProviderReconcileRequest) {
        return { outcome: 'alive' as const, reason: 'alive' };
    }

    private async signalCancel(request: GoalProviderCancelRequest): Promise<void> {
        this.cancelCalls.push(structuredClone(request));
        this.cancelEffects.add(request.cancellationId);
        this.cancelStarted?.();
        if (this.cancelGate) await this.cancelGate;
    }
}

async function openRuntime(adapter: ReauditAdapter, persistence = new InMemoryGoalSessionPorts()) {
    const supervisor = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    return { persistence, supervisor };
}

function turnRequest(model = 'model-a') {
    return {
        ...turnFence,
        executionId: 'reaudit-execution',
        attemptId: 'reaudit-attempt',
        objective: 'exercise the audited race',
        repository,
        requestedModel: model,
    };
}

test('cancellation claim immediately fences FIFO acknowledgement and output through provider races and repeat cancel', async () => {
    const adapter = new ReauditAdapter({
        nativeSessionId: 'eager', steering: 'next_turn', pause: 'active_turn', modelChange: 'next_safe_boundary',
    });
    const streamStarted = deferred();
    const releaseStream = deferred();
    const cancelStarted = deferred();
    const releaseCancel = deferred();
    adapter.stream = async function* (request) {
        streamStarted.resolve();
        await releaseStream.promise;
        yield { type: 'message_acknowledged', messageId: request.correctiveMessages![0].messageId };
        yield { type: 'output', channel: 'stdout', data: 'must be fenced' };
        yield { type: 'completion', outcome: 'succeeded' };
    };
    adapter.cancelStarted = cancelStarted.resolve;
    adapter.cancelGate = releaseCancel.promise;
    const { persistence, supervisor } = await openRuntime(adapter);
    persistence.enqueueMessage({ ...identity, messageId: 'reaudit-message', body: 'correct this' });
    const running = supervisor.runTurn(turnRequest());
    await streamStarted.promise;

    const firstCancel = supervisor.cancel({ ...control, reason: 'cancel now' });
    await cancelStarted.promise;
    const cancelling = await persistence.load(identity);
    assert.equal(cancelling?.status, 'cancelling');
    assert.equal(cancelling?.activeTurn, undefined, 'the durable claim clears live attempt ownership before provider await');
    const oldExecution = { executionId: 'reaudit-execution', attemptId: 'reaudit-attempt' };
    assert.equal(await persistence.acknowledge(turnFence, oldExecution, 'reaudit-message'), 'stale_fence');
    assert.deepEqual(await persistence.append(turnFence, oldExecution, {
        type: 'output', channel: 'stdout', data: 'direct stale output',
    }), { accepted: false, reason: 'turn_not_active' });

    const repeatedCancel = supervisor.cancel({ ...control, reason: 'different retry text must not replace the claim' });
    for (let attempt = 0; attempt < 20 && adapter.cancelCalls.length < 2; attempt += 1) await Promise.resolve();
    assert.equal(adapter.cancelCalls.length, 2);
    assert.equal(new Set(adapter.cancelCalls.map(call => call.cancellationId)).size, 1);
    assert.equal(adapter.cancelEffects.size, 1, 'the stable provider key deduplicates the cancellation primitive');

    releaseStream.resolve();
    await assert.rejects(running, StaleGoalSessionFenceError);
    assert.deepEqual((await persistence.listPending(identity)).map(message => message.messageId), ['reaudit-message']);
    assert.equal((await persistence.replay(identity)).some(record =>
        record.event.type === 'message_acknowledged' || record.event.type === 'output'), false);

    releaseCancel.resolve();
    const [firstTerminal, repeatedTerminal] = await Promise.all([firstCancel, repeatedCancel]);
    assert.equal(firstTerminal.status, 'terminated');
    assert.equal(repeatedTerminal.status, 'terminated');
    assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'completion').length, 1);
});

test('process replacement open resumes bound and unbound cancelling claims without opening work', async t => {
    for (const binding of ['bound', 'unbound'] as const) {
        await t.test(binding, async () => {
            const capabilities: GoalProviderCapabilities = binding === 'bound'
                ? { nativeSessionId: 'eager', steering: 'active_turn', pause: 'active_turn', modelChange: 'next_safe_boundary' }
                : {
                    nativeSessionId: 'first_turn', firstTurnIdCrashPolicy: 'retry_deterministically',
                    steering: 'next_turn', pause: 'after_turn', modelChange: 'next_turn',
                };
            const effects = new Set<string>();
            const initial = new ReauditAdapter(capabilities, effects);
            const initialStarted = deferred();
            const releaseInitial = deferred();
            initial.cancelStarted = initialStarted.resolve;
            initial.cancelGate = releaseInitial.promise;
            const persistence = new InMemoryGoalSessionPorts();
            const firstSupervisor = new GoalSessionSupervisor(initial, persistence.asRuntimePorts());
            await firstSupervisor.openSession({ ...identity, provider: initial.provider, controllerEpoch: 1 });
            const originalCancel = firstSupervisor.cancel({ ...control, reason: `${binding} crash cancellation` });
            await initialStarted.promise;

            const replacement = new ReauditAdapter(capabilities, effects);
            const replacementStarted = deferred();
            const releaseReplacement = deferred();
            replacement.cancelStarted = replacementStarted.resolve;
            replacement.cancelGate = releaseReplacement.promise;
            const reopenedSupervisor = new GoalSessionSupervisor(replacement, persistence.asRuntimePorts());
            const reopening = reopenedSupervisor.openSession({ ...identity, provider: replacement.provider, controllerEpoch: 2 });
            await replacementStarted.promise;
            assert.equal(replacement.openCalls, 0, 'reopen must resume cancellation rather than open/resume provider work');
            assert.equal((await persistence.load(identity))?.activeTurn, undefined);
            assert.equal(effects.size, 1);
            assert.equal(initial.cancelCalls[0].cancellationId, replacement.cancelCalls[0].cancellationId);

            releaseInitial.resolve();
            assert.equal((await originalCancel).status, 'terminated');
            releaseReplacement.resolve();
            assert.equal((await reopening).status, 'terminated');
            assert.equal((await reopenedSupervisor.openSession({
                ...identity, provider: replacement.provider, controllerEpoch: 2,
            })).status, 'terminated');
            assert.equal(replacement.openCalls, 0);
            assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'completion').length, 1);
        });
    }
});

class TakeoverCompletionRacePorts extends InMemoryGoalSessionPorts {
    beforeTakeover: (() => Promise<void>) | undefined;

    override async compareAndSet(expected: GoalSessionState, next: Omit<GoalSessionState, 'version'>) {
        if (next.controllerEpoch > expected.controllerEpoch && this.beforeTakeover) {
            const hook = this.beforeTakeover;
            this.beforeTakeover = undefined;
            await hook();
        }
        return super.compareAndSet(expected, next);
    }
}

test('reopen converges when provider cancellation completes in the takeover CAS window', async () => {
    const adapter = new ReauditAdapter();
    const cancelStarted = deferred();
    const releaseCancel = deferred();
    adapter.cancelStarted = cancelStarted.resolve;
    adapter.cancelGate = releaseCancel.promise;
    const persistence = new TakeoverCompletionRacePorts();
    const initial = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
    await initial.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    const cancelling = initial.cancel({ ...control, reason: 'complete during takeover' });
    await cancelStarted.promise;
    const replacementAdapter = new ReauditAdapter();
    replacementAdapter.cancelStarted = releaseCancel.resolve;
    const replacement = new GoalSessionSupervisor(replacementAdapter, persistence.asRuntimePorts());
    const reopened = await replacement.openSession({ ...identity, provider: replacementAdapter.provider, controllerEpoch: 2 });
    assert.equal(reopened.status, 'terminated');
    assert.equal((await cancelling).status, 'terminated');
    assert.equal(replacementAdapter.openCalls, 0);
    assert.equal(replacementAdapter.cancelCalls.length, 1, 'replay uses the same durable cancellation identity');
    assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'completion').length, 1);
});

test('next-turn model application is crash-safe at pre-call, post-provider/pre-CAS, and post-CAS windows', async t => {
    const capabilities = {
        nativeSessionId: 'eager', steering: 'next_turn', pause: 'after_turn', modelChange: 'next_turn',
    } as const;
    const recoverInvocation = async (adapter: ReauditAdapter, persistence: InMemoryGoalSessionPorts) => {
        persistence.setContainerInspection(identity, { status: 'missing' });
        persistence.setRepositoryInspection(repository, {
            ...repository, exists: true, observedRepository: repository.repository,
            observedBranch: repository.branch, observedHeadSha: repository.headSha,
            resolvedWorktreePath: repository.worktreePath,
            observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
        });
        adapter.reconcile = async () => ({
            outcome: 'resumed' as const, reason: 'replay exact deferred invocation',
            snapshot: { providerSessionId: 'reaudit-native', recoveryMetadata: { checkpoint: 'recovered' }, model: 'model-a' },
        });
        const recovered = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
        const reconciled = await recovered.reconcile(identity, 2, repository);
        assert.equal(reconciled.outcome, 'resumed');
        return recovered.resumeTurn({ ...identity, controllerEpoch: 2 });
    };
    await t.test('pre-call', async () => {
        const adapter = new ReauditAdapter(capabilities);
        const persistence = new InMemoryGoalSessionPorts();
        const { supervisor } = await openRuntime(adapter, persistence);
        persistence.setTransitionFault('after_commit');
        await assert.rejects(supervisor.runTurn(turnRequest('model-b')), /after state\/audit transaction commit/);
        assert.equal(adapter.turnCalls.length, 0);
        const recovered = new GoalSessionSupervisor(adapter, persistence.asRuntimePorts());
        assert.equal((await recovered.runTurn(turnRequest('model-b'))).state.currentModel, 'model-b');
        assert.equal(adapter.turnModelEffects.size, 1);
    });

    await t.test('post-provider/pre-CAS', async () => {
        const adapter = new ReauditAdapter(capabilities);
        const { persistence, supervisor } = await openRuntime(adapter);
        await supervisor.requestModelChange({ ...control, model: 'model-b' });
        persistence.setTransitionFault('before_commit');
        await assert.rejects(supervisor.runTurn(turnRequest()), /before state\/audit transaction commit/);
        await recoverInvocation(adapter, persistence);
        assert.equal(adapter.turnCalls.length, 2);
        assert.equal(new Set(adapter.turnCalls.map(call => call.modelChange?.modelChangeId)).size, 1);
        assert.equal(adapter.turnModelEffects.size, 1);
        assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'model_changed').length, 1);
    });

    await t.test('post-CAS', async () => {
        const adapter = new ReauditAdapter(capabilities);
        const { persistence, supervisor } = await openRuntime(adapter);
        await supervisor.requestModelChange({ ...control, model: 'model-b' });
        persistence.setTransitionFault('after_commit');
        await assert.rejects(supervisor.runTurn(turnRequest()), /after state\/audit transaction commit/);
        const applied = await persistence.load(identity);
        assert.equal(applied?.currentModel, 'model-b');
        assert.equal(applied?.modelChangeIntent?.model, 'model-b', 'the applied claim remains until the turn is durably claimed');
        await recoverInvocation(adapter, persistence);
        assert.equal(adapter.turnCalls.length, 2);
        assert.equal(adapter.turnModelEffects.size, 1);
        assert.equal((await persistence.replay(identity)).filter(record => record.event.type === 'model_changed').length, 1);
    });
});

class TerminalRacePorts extends InMemoryGoalSessionPorts {
    beforeFirstTurnTerminal: (() => Promise<void>) | undefined;

    override async commit(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        operation: GoalTerminalCommit | GoalSessionControlTransition,
    ) {
        if ('scope' in operation && operation.scope === 'turn' && this.beforeFirstTurnTerminal) {
            const hook = this.beforeFirstTurnTerminal;
            this.beforeFirstTurnTerminal = undefined;
            await hook();
        }
        return super.commit(expected, next, operation);
    }
}

test('final-load to terminal-commit pause race retries exact attempt into canonical boundary and completion', async () => {
    const adapter = new ReauditAdapter({
        nativeSessionId: 'eager', steering: 'next_turn', pause: 'after_turn', modelChange: 'next_turn',
    });
    const persistence = new TerminalRacePorts();
    const { supervisor } = await openRuntime(adapter, persistence);
    persistence.beforeFirstTurnTerminal = async () => {
        await supervisor.requestPause({ ...control, reason: 'wins after final load' });
    };
    const result = await supervisor.runTurn(turnRequest());
    assert.equal(result.state.status, 'paused');
    const canonical = (await persistence.replay(identity)).filter(record =>
        record.event.type === 'pause_requested'
        || record.event.type === 'pause_boundary'
        || record.event.type === 'completion');
    assert.deepEqual(canonical.map(record => record.event.type), [
        'pause_requested', 'pause_boundary', 'completion',
    ]);
    assert.equal(canonical.filter(record => record.event.type === 'completion').length, 1);
    assert.equal((await supervisor.runTurn(turnRequest())).disposition, 'duplicate');
});

class CancelBeforeAuditPorts extends InMemoryGoalSessionPorts {
    beforeAudit: (() => Promise<void>) | undefined;

    override async commit(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        operation: GoalTerminalCommit | GoalSessionControlTransition,
    ) {
        if (!('scope' in operation) && this.beforeAudit) {
            const hook = this.beforeAudit;
            this.beforeAudit = undefined;
            await hook();
        }
        return super.commit(expected, next, operation);
    }
}

test('atomic model/pause audits never append after a same-epoch terminal cancellation', async t => {
    for (const operation of ['model', 'pause'] as const) {
        await t.test(operation, async () => {
            const adapter = new ReauditAdapter({
                nativeSessionId: 'eager', steering: 'next_turn', pause: 'after_turn', modelChange: 'next_turn',
            });
            const persistence = new CancelBeforeAuditPorts();
            const { supervisor } = await openRuntime(adapter, persistence);
            persistence.beforeAudit = async () => {
                await supervisor.cancel({ ...control, reason: 'terminal wins before audit transaction' });
            };
            const pending = operation === 'model'
                ? supervisor.requestModelChange({ ...control, model: 'model-b' })
                : supervisor.requestPause({ ...control, reason: 'too late' });
            await assert.rejects(pending, StaleGoalSessionFenceError);
            const events = await persistence.replay(identity);
            assert.deepEqual(events.map(record => record.event.type), ['completion']);
            assert.equal(events.some(record => record.event.type === 'model_change_acknowledged'
                || record.event.type === 'model_changed'
                || record.event.type === 'pause_boundary'), false);
        });
    }
});

test('atomic audit crash windows persist both state and event or neither before terminal ordering', async t => {
    for (const fault of ['before_commit', 'after_commit'] as const) {
        await t.test(fault, async () => {
            const adapter = new ReauditAdapter({
                nativeSessionId: 'eager', steering: 'next_turn', pause: 'after_turn', modelChange: 'next_turn',
            });
            const { persistence, supervisor } = await openRuntime(adapter);
            persistence.setTransitionFault(fault);
            await assert.rejects(supervisor.requestModelChange({ ...control, model: 'model-b' }), /state\/audit transaction commit/);
            const afterFault = await persistence.load(identity);
            const beforeCommit = fault === 'before_commit';
            assert.equal(afterFault?.pendingModelChange, beforeCommit ? undefined : 'model-b');
            assert.equal((await persistence.replay(identity)).some(record =>
                record.event.type === 'model_change_acknowledged'), !beforeCommit);
            await supervisor.requestModelChange({ ...control, model: 'model-b' });
            assert.equal((await persistence.replay(identity)).filter(record =>
                record.event.type === 'model_change_acknowledged').length, 1);
            await supervisor.cancel({ ...control, reason: 'finish after audit crash window' });
            const types = (await persistence.replay(identity)).map(record => record.event.type);
            assert.equal(types.at(-1), 'completion');
            assert.equal(types.slice(types.indexOf('completion') + 1).some(type =>
                type === 'model_change_acknowledged' || type === 'model_changed'
                || type === 'pause_boundary'), false);
        });
    }
});
