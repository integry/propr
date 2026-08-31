import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
    GoalBeginTurnRequest,
    GoalProviderCancelRequest,
    GoalProviderCapabilities,
    GoalProviderModelChangeRequest,
    GoalProviderOpenRequest,
    GoalProviderReconcileRequest,
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

const identity = { goalId: 'final-reaudit-goal', sessionId: 'final-reaudit-session' };
const control = { ...identity, controllerEpoch: 1 };
const fence = { ...control, turnId: 'final-reaudit-turn' };
const repository = {
    repository: 'integry/propr', worktreePath: '/tmp/final-reaudit', branch: 'reaudit', headSha: '10cea2fc',
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

type SharedEffects = { modelIds: Set<string>; cancelIds: Set<string>; model: string };

class FinalReauditAdapter implements GoalSessionAdapter {
    readonly provider = 'final-reaudit-provider';
    readonly modelCalls: GoalProviderModelChangeRequest[] = [];
    readonly cancelCalls: GoalProviderCancelRequest[] = [];
    readonly capabilities: GoalProviderCapabilities;
    openCalls = 0;
    reconcileCalls = 0;
    pauseCalls = 0;
    pauseAcknowledgement = { appliesAt: 'next_safe_boundary' as const };
    pauseStarted: (() => void) | undefined;
    pauseGate: Promise<void> | undefined;
    cancelStarted: (() => void) | undefined;
    cancelGate: Promise<void> | undefined;
    stream: (request: GoalBeginTurnRequest) => AsyncIterable<GoalSessionEvent> = async function* () {
        yield { type: 'completion', outcome: 'succeeded' };
    };

    constructor(
        capabilities: GoalProviderCapabilities = {
            nativeSessionId: 'eager', steering: 'active_turn', pause: 'active_turn', modelChange: 'next_safe_boundary',
        },
        readonly effects: SharedEffects = { modelIds: new Set(), cancelIds: new Set(), model: 'model-a' },
    ) { this.capabilities = capabilities; }

    async openSession(_request: GoalProviderOpenRequest) {
        this.openCalls += 1;
        return { providerSessionId: 'final-native', recoveryMetadata: { checkpoint: 'open' }, model: this.effects.model };
    }

    beginTurn(request: GoalBeginTurnRequest): AsyncIterable<GoalSessionEvent> { return this.stream(request); }

    async resumeSession(_request: GoalSessionControlFence, snapshot: { providerSessionId: string; recoveryMetadata: unknown }) {
        return snapshot;
    }

    async requestPause() {
        this.pauseCalls += 1;
        this.pauseStarted?.();
        if (this.pauseGate) await this.pauseGate;
        return this.pauseAcknowledgement;
    }

    async requestModelChange(request: GoalProviderModelChangeRequest) {
        this.modelCalls.push(structuredClone(request));
        this.effects.modelIds.add(request.modelChangeId);
        this.effects.model = request.model;
        return { requestedModel: request.model, appliesAt: 'immediate' as const, effectiveModel: request.model };
    }

    async cancel(request: GoalProviderCancelRequest): Promise<void> { await this.signalCancel(request); }

    async cancelPending(request: GoalProviderCancelRequest): Promise<void> { await this.signalCancel(request); }

    async reconcile(_request: GoalProviderReconcileRequest) {
        this.reconcileCalls += 1;
        return { outcome: 'resumed' as const, snapshot: await this.openSession({} as GoalProviderOpenRequest), reason: 'resumed' };
    }

    private async signalCancel(request: GoalProviderCancelRequest): Promise<void> {
        this.cancelCalls.push(structuredClone(request));
        this.effects.cancelIds.add(request.cancellationId);
        this.cancelStarted?.();
        if (this.cancelGate) await this.cancelGate;
    }
}

async function openRuntime(adapter: FinalReauditAdapter, ports = new InMemoryGoalSessionPorts()) {
    const supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    return { ports, supervisor };
}

function turnRequest() {
    return {
        ...fence, executionId: 'final-execution', attemptId: 'final-attempt', objective: 'adversarial re-audit',
        repository, requestedModel: 'model-a',
    };
}

async function startHeldTurn(adapter: FinalReauditAdapter, supervisor: GoalSessionSupervisor) {
    const started = deferred();
    const release = deferred();
    adapter.stream = async function* () {
        started.resolve();
        await release.promise;
        yield { type: 'completion', outcome: 'succeeded' };
    };
    const running = supervisor.runTurn(turnRequest());
    await started.promise;
    return { release, running };
}

test('eager pause request and acknowledgement boundaries commit state plus audit atomically', async t => {
    for (const fault of ['before_commit', 'after_commit'] as const) {
        await t.test(`request ${fault}`, async () => {
            const adapter = new FinalReauditAdapter();
            const { ports, supervisor } = await openRuntime(adapter);
            const turn = await startHeldTurn(adapter, supervisor);
            ports.setTransitionFault(fault);
            await assert.rejects(supervisor.requestPause({ ...control, reason: 'pause' }), /transaction commit/);
            const committed = fault === 'after_commit';
            assert.equal((await ports.load(identity))?.status, committed ? 'pause_requested' : 'running');
            assert.equal((await ports.replay(identity)).filter(value => value.event.type === 'pause_requested').length,
                committed ? 1 : 0);
            await supervisor.requestPause({ ...control, reason: 'retry same pause' });
            assert.equal((await ports.replay(identity)).filter(value => value.event.type === 'pause_requested').length, 1);
            await supervisor.cancel({ ...control, reason: 'finish' });
            turn.release.resolve();
            await assert.rejects(turn.running, StaleGoalSessionFenceError);
        });
    }

    for (const fault of ['before_commit', 'after_commit'] as const) {
        await t.test(`boundary ${fault}`, async () => {
            const adapter = new FinalReauditAdapter();
            const { ports, supervisor } = await openRuntime(adapter);
            const turn = await startHeldTurn(adapter, supervisor);
            await supervisor.requestPause({ ...control });
            adapter.pauseAcknowledgement = {
                appliesAt: 'next_safe_boundary', boundaryReached: { boundary: 'provider-safe' },
            };
            ports.setTransitionFault(fault);
            await assert.rejects(supervisor.requestPause({ ...control }), /transaction commit/);
            if (fault === 'before_commit') await supervisor.requestPause({ ...control });
            const audits = (await ports.replay(identity)).filter(value =>
                value.event.type === 'pause_requested' || value.event.type === 'pause_boundary');
            assert.deepEqual(audits.map(value => value.event.type), ['pause_requested', 'pause_boundary']);
            assert.equal((await ports.load(identity))?.status, 'paused');
            await supervisor.cancel({ ...control, reason: 'finish' });
            turn.release.resolve();
            await assert.rejects(turn.running, StaleGoalSessionFenceError);
        });
    }
});

class BeforeTransitionPorts extends InMemoryGoalSessionPorts {
    beforeTransition: ((operation: GoalSessionControlTransition) => Promise<void>) | undefined;

    override async commit(
        expected: GoalSessionState,
        next: Omit<GoalSessionState, 'version'>,
        operation: GoalTerminalCommit | GoalSessionControlTransition,
    ) {
        if (!('scope' in operation) && this.beforeTransition) {
            const hook = this.beforeTransition;
            this.beforeTransition = undefined;
            await hook(operation);
        }
        return super.commit(expected, next, operation);
    }
}

test('eager pause and streamed model/pause transitions lose atomically to cancellation', async t => {
    for (const kind of ['eager_pause', 'model_changed', 'pause_boundary'] as const) {
        await t.test(kind, async () => {
            const adapter = new FinalReauditAdapter();
            const ports = new BeforeTransitionPorts();
            const { supervisor } = await openRuntime(adapter, ports);
            let pending: Promise<unknown>;
            let release: (() => void) | undefined;
            if (kind === 'eager_pause') {
                const held = await startHeldTurn(adapter, supervisor);
                release = held.release.resolve;
                void held.running.catch(() => undefined);
                pending = supervisor.requestPause({ ...control });
            } else {
                adapter.stream = async function* () {
                    yield kind === 'model_changed'
                        ? { type: 'model_changed', previousModel: 'model-a', model: 'model-b' }
                        : { type: 'pause_boundary', boundary: 'provider-safe' };
                };
                pending = supervisor.runTurn(turnRequest());
            }
            ports.beforeTransition = async operation => {
                if (operation.auditEvents.some(event => event.type === kind || kind === 'eager_pause')) {
                    await supervisor.cancel({ ...control, reason: 'cancellation wins' });
                }
            };
            await assert.rejects(pending, StaleGoalSessionFenceError);
            release?.();
            const events = await ports.replay(identity);
            assert.deepEqual(events.map(value => value.event.type), ['completion']);
            assert.equal((await ports.load(identity))?.status, 'terminated');
        });
    }
});

test('streamed model and pause events survive transition crash windows without split or duplicate audit', async t => {
    for (const eventType of ['model_changed', 'pause_boundary'] as const) {
        for (const fault of ['before_commit', 'after_commit'] as const) {
            await t.test(`${eventType} ${fault}`, async () => {
                const adapter = new FinalReauditAdapter();
                adapter.stream = async function* () {
                    yield eventType === 'model_changed'
                        ? { type: 'model_changed', previousModel: 'model-a', model: 'model-b' }
                        : { type: 'pause_boundary', boundary: 'provider-safe' };
                };
                const { ports, supervisor } = await openRuntime(adapter);
                ports.setTransitionFault(fault);
                await assert.rejects(supervisor.runTurn(turnRequest()), /transaction commit/);
                const events = await ports.replay(identity);
                assert.equal(events.filter(value => value.event.type === eventType).length,
                    fault === 'after_commit' ? 1 : 0);
                assert.equal(events.filter(value => value.event.type === 'completion').length, 1);
                assert.equal(events.slice(events.findIndex(value => value.event.type === 'completion') + 1)
                    .some(value => value.event.type === eventType), false);
            });
        }
    }
});

class CrashBeforeModelCallPorts extends InMemoryGoalSessionPorts {
    private crash = true;

    override async compareAndSet(expected: GoalSessionState, next: Omit<GoalSessionState, 'version'>) {
        const saved = await super.compareAndSet(expected, next);
        if (this.crash && expected.modelChangeIntent?.phase !== 'provider_in_doubt'
            && next.modelChangeIntent?.phase === 'provider_in_doubt') {
            this.crash = false;
            throw new Error('Injected crash after in-doubt phase before provider call');
        }
        return saved;
    }
}

test('next-safe-boundary model intent reuses one provider identity across every crash/reopen window', async t => {
    for (const fault of ['pre_call', 'pre_commit', 'post_commit'] as const) {
        await t.test(fault, async () => {
            const effects: SharedEffects = { modelIds: new Set(), cancelIds: new Set(), model: 'model-a' };
            const initialAdapter = new FinalReauditAdapter(undefined, effects);
            const ports = fault === 'pre_call' ? new CrashBeforeModelCallPorts() : new InMemoryGoalSessionPorts();
            const { supervisor } = await openRuntime(initialAdapter, ports);
            if (fault === 'pre_commit') ports.setTransitionFault('before_commit');
            if (fault === 'post_commit') ports.setTransitionFault('after_commit');
            await assert.rejects(supervisor.requestModelChange({ ...control, model: 'model-b' }), /Injected crash/);
            const intent = (await ports.load(identity))?.modelChangeIntent;
            assert.ok(intent);
            assert.equal(intent.phase, fault === 'post_commit' ? 'committed' : 'provider_in_doubt');

            const replacementAdapter = new FinalReauditAdapter(undefined, effects);
            const replacement = new GoalSessionSupervisor(replacementAdapter, ports.asRuntimePorts());
            const reopened = await replacement.openSession({
                ...identity, provider: replacementAdapter.provider, controllerEpoch: 2,
            });
            const calls = [...initialAdapter.modelCalls, ...replacementAdapter.modelCalls];
            assert.equal(new Set(calls.map(call => call.modelChangeId)).size, calls.length ? 1 : 0);
            assert.equal(effects.modelIds.size, 1);
            assert.equal(reopened.modelChangeIntent?.modelChangeId, intent.modelChangeId);
            assert.equal(reopened.modelChangeIntent?.phase, 'committed');
            assert.equal(reopened.currentModel, 'model-b');
            assert.equal((await ports.replay(identity)).filter(value =>
                value.event.type === 'model_change_acknowledged').length, 1);
            assert.equal(replacementAdapter.modelCalls.length, fault === 'post_commit' ? 0 : 1);
        });
    }
});

test('reconcile routes bound and unbound cancelling sessions only through stable cancellation recovery', async t => {
    for (const binding of ['bound', 'unbound'] as const) {
        await t.test(binding, async () => {
            const capabilities: GoalProviderCapabilities = binding === 'bound'
                ? { nativeSessionId: 'eager', steering: 'active_turn', pause: 'active_turn', modelChange: 'next_safe_boundary' }
                : {
                    nativeSessionId: 'first_turn', firstTurnIdCrashPolicy: 'retry_deterministically',
                    steering: 'next_turn', pause: 'after_turn', modelChange: 'next_turn',
                };
            const effects: SharedEffects = { modelIds: new Set(), cancelIds: new Set(), model: 'model-a' };
            const initialAdapter = new FinalReauditAdapter(capabilities, effects);
            const initialStarted = deferred();
            const initialRelease = deferred();
            initialAdapter.cancelStarted = initialStarted.resolve;
            initialAdapter.cancelGate = initialRelease.promise;
            const { ports, supervisor } = await openRuntime(initialAdapter);
            const cancelling = supervisor.cancel({ ...control, reason: 'crash during cancellation' });
            await initialStarted.promise;

            const replacementAdapter = new FinalReauditAdapter(capabilities, effects);
            const replacementStarted = deferred();
            const replacementRelease = deferred();
            replacementAdapter.cancelStarted = replacementStarted.resolve;
            replacementAdapter.cancelGate = replacementRelease.promise;
            const replacement = new GoalSessionSupervisor(replacementAdapter, ports.asRuntimePorts());
            const recovery = replacement.reconcile(identity, 2, repository);
            await replacementStarted.promise;
            assert.equal(replacementAdapter.reconcileCalls, 0);
            assert.equal(replacementAdapter.openCalls, 0);
            assert.equal(new Set([
                initialAdapter.cancelCalls[0].cancellationId,
                replacementAdapter.cancelCalls[0].cancellationId,
            ]).size, 1);
            initialRelease.resolve();
            await assert.rejects(cancelling, StaleGoalSessionFenceError);
            replacementRelease.resolve();
            assert.equal((await recovery).state.status, 'terminated');
            assert.equal((await replacement.reconcile(identity, 2, repository)).state.status, 'terminated');
            assert.equal(replacementAdapter.reconcileCalls, 0);
        });
    }
});

test('terminated and failed sessions never inspect/provider-reconcile or resurrect on repeat replacement', async t => {
    for (const terminal of ['terminated', 'failed'] as const) {
        await t.test(terminal, async () => {
            const adapter = new FinalReauditAdapter();
            const { ports, supervisor } = await openRuntime(adapter);
            if (terminal === 'terminated') await supervisor.cancel({ ...control, reason: 'terminal' });
            else {
                adapter.stream = async function* () { yield { type: 'completion', outcome: 'failed', error: 'failed' }; };
                await supervisor.runTurn(turnRequest());
            }
            const replacementAdapter = new FinalReauditAdapter();
            const replacement = new GoalSessionSupervisor(replacementAdapter, ports.asRuntimePorts());
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const result = await replacement.reconcile(identity, 2, repository);
                assert.equal(result.outcome, 'blocked');
                assert.equal(result.state.status, terminal);
            }
            assert.equal(replacementAdapter.reconcileCalls, 0);
            assert.equal(replacementAdapter.openCalls, 0);
        });
    }
});

class CancelCompletionRacePorts extends InMemoryGoalSessionPorts {
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

test('reconcile cannot invalidate cancellation completion racing its durable takeover claim', async () => {
    const adapter = new FinalReauditAdapter();
    const started = deferred();
    const release = deferred();
    adapter.cancelStarted = started.resolve;
    adapter.cancelGate = release.promise;
    const ports = new CancelCompletionRacePorts();
    const { supervisor } = await openRuntime(adapter, ports);
    const cancelling = supervisor.cancel({ ...control, reason: 'finish during reconcile takeover' });
    await started.promise;
    ports.beforeTakeover = async () => {
        release.resolve();
        assert.equal((await cancelling).status, 'terminated');
    };
    const replacementAdapter = new FinalReauditAdapter();
    const replacement = new GoalSessionSupervisor(replacementAdapter, ports.asRuntimePorts());
    const result = await replacement.reconcile(identity, 2, repository);
    assert.equal(result.state.status, 'terminated');
    assert.equal(replacementAdapter.reconcileCalls, 0);
    assert.equal(replacementAdapter.cancelCalls.length, 0);
});
