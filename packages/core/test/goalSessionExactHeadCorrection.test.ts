import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
    GoalBeginTurnRequest, GoalProviderCancelRequest, GoalProviderOpenContext, GoalProviderOpenRequest,
    GoalProviderSessionSnapshot, GoalSessionAdapter, GoalSessionEvent, GoalSessionState,
} from '../src/agents/goalSession/contract.js';
import { openSupervisedCodexAppServer } from '../src/agents/goalSession/CodexAppServerOpen.js';
import { decodeDurableGoalSessionState } from '../src/agents/goalSession/durableStateSecurity.js';
import { GoalSessionSupervisor } from '../src/agents/goalSession/GoalSessionSupervisor.js';
import { InMemoryGoalSessionPorts } from '../src/agents/goalSession/InMemoryGoalSessionPorts.js';
import { sanitizeNewRecoveryMetadata, sanitizeRecoveryMetadata } from '../src/agents/goalSession/recoveryMetadata.js';
import {
    rebuildIteratorResult, rebuildMessageAcknowledgement, rebuildModelAcknowledgement,
    rebuildPauseAcknowledgement, rebuildProviderSnapshot, rebuildReconcileResult,
    untrustedProviderResult,
} from '../src/agents/goalSession/providerResultBoundary.js';

const identity = { goalId: 'exact-correction-goal', sessionId: 'exact-correction-session' };
const repository = { repository: 'integry/propr', worktreePath: '/tmp/exact-correction', branch: 'correction' };

function durableState(): GoalSessionState {
    const timestamp = new Date().toISOString();
    return {
        ...identity, provider: 'codec-adapter', providerSessionId: 'native-session', recoveryMetadata: {},
        controllerEpoch: 1, status: 'idle', currentModel: 'model-a', completedTurnIds: [],
        version: 1, createdAt: timestamp, updatedAt: timestamp,
    };
}

test('strict durable decoding rejects every malformed known field, accessors, and ambiguous cancellation identity', () => {
    const base = durableState();
    const poisoned: unknown[] = [
        { ...base, goalId: 7 }, { ...base, sessionId: '' }, { ...base, provider: {} },
        { ...base, providerSessionId: 9 }, { ...base, recoveryMetadata: { command: 'provider --auth' } },
        { ...base, controllerEpoch: '1' }, { ...base, status: 'unknown' }, { ...base, currentModel: false },
        { ...base, requestedModel: [] }, { ...base, pendingModelChange: 1 }, { ...base, pendingAfterTurnPause: 'yes' },
        { ...base, completedTurnIds: ['turn-a', 'turn-a'] }, { ...base, version: 0 },
        { ...base, createdAt: 'yesterday' }, { ...base, failureReason: 'Bearer durable-secret' },
        { ...base, status: 'cancelling' },
        { ...base, providerOperationGeneration: 2, providerBarrierIntent: {
            generation: 2, operationId: 'cancel-2', kind: 'cancellation', phase: 'pending',
            claimedAt: base.createdAt, pendingCancellationId: 'different-cancel',
        }, cancellationIntent: { cancellationId: 'cancel-2', reason: 'cancel', claimedAt: base.createdAt } },
        { ...base, usageAccounting: { version: 1, lastWatermark: 2, occurrences: ['usage-a', 'usage-a'] } },
        { ...base, modelChangeIntents: [
            { modelChangeId: 'model-2', model: 'b', requestedAt: base.createdAt, generation: 2 },
            { modelChangeId: 'model-1', model: 'a', requestedAt: base.createdAt, generation: 1 },
        ] },
        { ...base, status: 'running' },
        { ...base, status: 'idle', activeTurn: {
            turnId: 'turn-live', executionId: 'execution-live', attemptId: 'attempt-live', executionEpoch: 1,
            objective: 'objective', requestedModel: 'model-a', repository, status: 'running',
        } },
        { ...base, status: 'terminated', activeTurn: {
            turnId: 'turn-live', executionId: 'execution-live', attemptId: 'attempt-live', executionEpoch: 1,
            objective: 'objective', requestedModel: 'model-a', repository, status: 'running',
        } },
        { ...base, recoveryAttemptId: 'recovery-attempt', providerOperationGeneration: 2,
            recoveryAttempt: {
                operationToken: 'recovery-token', operationGeneration: 2, executionId: 'execution-live',
                attemptId: 'recovery-attempt', controllerEpoch: 1, sessionStatus: 'idle',
                claimedAt: base.createdAt, leaseExpiresAt: base.createdAt, phase: 'claimed',
            },
            resumeIntent: {
                executionId: 'execution-live', attemptId: 'resume-attempt', operationId: 'resume-id',
                operationGeneration: 2, kind: 'after_turn', controllerEpoch: 1,
                claimedAt: base.createdAt, leaseExpiresAt: base.createdAt, phase: 'claimed',
            } },
        { ...base, modelChangeGeneration: 2, modelChangeIntents: [
            { modelChangeId: 'duplicate', model: 'a', requestedAt: base.createdAt, generation: 1 },
            { modelChangeId: 'duplicate', model: 'b', requestedAt: base.createdAt, generation: 2 },
        ], modelChangeIntent: { modelChangeId: 'duplicate', model: 'b', requestedAt: base.createdAt, generation: 2 } },
        { ...base, modelChangeGeneration: 1, modelChangeIntents: [
            { modelChangeId: 'model-one', model: 'b', requestedAt: base.createdAt, generation: 1 },
        ], modelChangeIntent: { modelChangeId: 'different-tail', model: 'b', requestedAt: base.createdAt, generation: 1 } },
        { ...base, modelChangeGeneration: 1, modelChangeIntents: [{
            modelChangeId: 'model-one', model: 'b', requestedAt: base.createdAt, generation: 1,
            phase: 'provider_in_doubt', applicationToken: 'token-one',
        }], modelChangeIntent: {
            modelChangeId: 'model-one', model: 'b', requestedAt: base.createdAt, generation: 1,
            phase: 'provider_in_doubt', applicationToken: 'token-one',
        } },
        { ...base, modelChangeGeneration: 1, modelChangeIntents: [{
            modelChangeId: 'model-one', model: 'b', requestedAt: base.createdAt, generation: 1,
            phase: 'committed', acknowledgement: {
                requestedModel: 'different-model', appliesAt: 'next_turn', effectiveModel: 'b',
            },
        }], modelChangeIntent: {
            modelChangeId: 'model-one', model: 'b', requestedAt: base.createdAt, generation: 1,
            phase: 'committed', acknowledgement: {
                requestedModel: 'different-model', appliesAt: 'next_turn', effectiveModel: 'b',
            },
        } },
        { ...base, completedTurnIds: ['turn-done'], completedTurns: [{
            turnId: 'turn-done', executionId: 'execution-old', attemptId: 'attempt-old',
        }], activeTurn: {
            turnId: 'turn-done', executionId: 'execution-new', attemptId: 'attempt-new', executionEpoch: 1,
            objective: 'objective', requestedModel: 'model-a', repository, status: 'completed',
        } },
        { ...base, activeTurn: {
            turnId: 'turn-a', executionId: 'execution-a', attemptId: 3, executionEpoch: 1,
            objective: 'objective', requestedModel: 'model-a', repository, status: 'running',
        } },
        { ...base, excessRuntimeField: 'must-not-cross' },
    ];
    for (const value of poisoned) assert.throws(() => decodeDurableGoalSessionState(value));

    let getterRead = false;
    const accessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessor, 'goalId', {
        enumerable: true,
        get() { getterRead = true; return identity.goalId; },
    });
    assert.throws(() => decodeDurableGoalSessionState(accessor));
    assert.equal(getterRead, false, 'decoder rejects accessor fields without evaluating them');
});

test('all resolved provider DTO boundaries rebuild hostile proxies as one generic error', async () => {
    const hostile = new Proxy({}, {
        ownKeys() { throw new Error('docker run npm install ../../secret tcp://host unix:///socket C:\\credential'); },
    });
    const boundaries: Array<(value: unknown) => unknown> = [
        value => rebuildProviderSnapshot(value, 'codec-adapter'),
        rebuildPauseAcknowledgement,
        rebuildMessageAcknowledgement,
        rebuildModelAcknowledgement,
        value => rebuildReconcileResult(value, 'codec-adapter'),
        rebuildIteratorResult,
    ];
    for (const rebuild of boundaries) {
        const error = await untrustedProviderResult(() => Promise.resolve(hostile), rebuild)
            .catch(value => value as Error);
        assert.equal(error.message, 'Provider operation failed safely');
        assert.equal((error as Error & { cause?: unknown }).cause, undefined);
        assert.doesNotMatch(JSON.stringify(error), /docker|npm|secret|tcp|unix|credential/i);
    }
});

test('provider recovery codecs are versioned, bounded, cross-provider closed, and usage-watermark stable', () => {
    const envelopes = [
        { provider: 'codex', protocolVersion: 'app-server-0.146.0', payload: { threadId: 'thread-a', initialized: true } },
        { provider: 'claude', protocolVersion: 'cli-2.1.220', payload: { sessionId: 'session-a' } },
        { provider: 'antigravity', protocolVersion: 'cli-1.1.13', payload: {
            conversationId: 'conversation-a', manifestVersion: 1, manifestChecksum: 'checksum-a',
        } },
    ] as const;
    for (const envelope of envelopes) {
        assert.deepEqual(sanitizeRecoveryMetadata({
            version: 2, ...envelope,
            usage: { components: [{ component: 'input_tokens', watermark: 4, occurrenceId: 'usage-4' }] },
        }, envelope.provider), {
            version: 2, ...envelope,
            usage: { components: [{ component: 'input_tokens', watermark: 4, occurrenceId: 'usage-4' }] },
        });
    }
    assert.deepEqual(sanitizeRecoveryMetadata({ version: 1, checkpoint: 'legacy-safe', offset: 0 }), {
        version: 1, checkpoint: 'legacy-safe', offset: 0,
    });
    assert.throws(() => sanitizeRecoveryMetadata({
        version: 2, ...envelopes[0], usage: { components: [] },
    }, 'claude'));
    assert.throws(() => sanitizeRecoveryMetadata({
        version: 2, provider: 'codex', protocolVersion: 'future',
        payload: { threadId: 'thread-a', initialized: true }, usage: { components: [] },
    }));
    assert.throws(() => sanitizeRecoveryMetadata({
        version: 2, ...envelopes[0], usage: { components: [
            { component: 'input_tokens', watermark: 1, occurrenceId: 'usage-1' },
            { component: 'input_tokens', watermark: 2, occurrenceId: 'usage-2' },
        ] },
    }));
    assert.throws(() => sanitizeRecoveryMetadata({ checkpoint: 'x'.repeat(33 * 1024) }));
    assert.throws(() => sanitizeNewRecoveryMetadata({}, 'codex'));
    assert.throws(() => sanitizeNewRecoveryMetadata({ version: 1, checkpoint: 'legacy-safe' }, 'claude'));
    assert.throws(() => sanitizeNewRecoveryMetadata({
        version: 2, ...envelopes[0], usage: { components: [] },
    }, 'codex'), /exact identity/);
});

class LineTransport {
    readonly writes: Array<Record<string, unknown>> = [];
    readonly output: AsyncIterable<string>;
    readonly completion = Promise.resolve({ exitCode: 0 });
    cancelled = false;
    private readonly lines: string[] = [];
    private readonly readers: Array<(result: IteratorResult<string>) => void> = [];

    constructor(private readonly listedSource?: string) {
        this.output = { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) };
    }

    async write(line: string): Promise<void> {
        const request = JSON.parse(line) as Record<string, unknown>;
        this.writes.push(request);
        const id = request.id;
        if (id === undefined) return;
        const method = request.method;
        if (method === 'initialize') this.push(JSON.stringify({ id, result: {
            userAgent: 'codex-cli/0.146.0', codexHome: '/home/node/.codex',
            platformFamily: 'unix', platformOs: 'linux',
        } }));
        else if (method === 'model/list') this.push(JSON.stringify({
            id, result: { data: [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol' }], nextCursor: null },
        }));
        else if (method === 'thread/list') this.push(JSON.stringify({ id, result: {
            data: this.listedSource ? [{
                id: 'codex-thread', sessionId: 'codex-session', cwd: '/workspace', source: this.listedSource,
            }] : [], nextCursor: null, backwardsCursor: null,
        } }));
        else if (method === 'thread/start') this.push(JSON.stringify({
            id, result: {
                thread: { id: 'codex-thread', sessionId: 'codex-session' },
                model: 'gpt-5.6-sol', cwd: '/workspace',
            },
        }));
        else if (method === 'thread/resume') this.push(JSON.stringify({
            id, result: {
                thread: { id: 'codex-thread', sessionId: 'codex-session' },
                model: 'gpt-5.6-sol', cwd: '/workspace',
            },
        }));
        else throw new Error(`Unexpected test protocol method ${String(method)}`);
    }

    closeInput(): void {}
    async cancel(): Promise<void> { this.cancelled = true; }

    private next(): Promise<IteratorResult<string>> {
        const line = this.lines.shift();
        if (line !== undefined) return Promise.resolve({ done: false, value: line });
        return new Promise(resolve => this.readers.push(resolve));
    }

    private push(line: string): void {
        const reader = this.readers.shift();
        if (reader) reader({ done: false, value: line });
        else this.lines.push(line);
    }
}

test('supervised Codex eager open uses stdio, exact gpt-5.6-sol, and starts no fake turn', async () => {
    const transport = new LineTransport();
    const context: GoalProviderOpenContext = {
        executionId: 'codex-execution', attemptId: 'codex-attempt', repository,
        requestedModel: 'gpt-5.6-sol', providerHomeTarget: '/home/node/.codex',
        credentialTargets: ['/home/node/.codex/auth.json'], deterministicOpenKey: 'durable-open-key', transport,
    };
    const snapshot = await openSupervisedCodexAppServer(context);
    assert.equal(snapshot.providerSessionId, 'codex-thread');
    assert.equal(snapshot.model, 'gpt-5.6-sol');
    assert.deepEqual(transport.writes.map(write => write.method), [
        'initialize', 'initialized', 'model/list', 'thread/list', 'thread/start',
    ]);
    assert.equal('params' in transport.writes[1], false);
    assert.deepEqual((transport.writes[0].params as Record<string, unknown>).capabilities, {
        experimentalApi: false, requestAttestation: false,
    });
    assert.equal(transport.writes.some(write => write.method === 'turn/start'), false);
    const start = transport.writes.find(write => write.method === 'thread/start');
    assert.equal((start?.params as Record<string, unknown>)?.model, 'gpt-5.6-sol');
    assert.equal((start?.params as Record<string, unknown>)?.cwd, '/workspace');
    assert.equal((start?.params as Record<string, unknown>)?.approvalPolicy, 'never');
    assert.equal((start?.params as Record<string, unknown>)?.sandbox, 'workspaceWrite');
    assert.match(String((start?.params as Record<string, unknown>)?.serviceName), /^propr-open-[a-f0-9]{64}$/);
    assert.equal('metadata' in (start?.params as Record<string, unknown>), false);
    assert.deepEqual(sanitizeRecoveryMetadata(snapshot.recoveryMetadata, 'codex'), snapshot.recoveryMetadata);
});

test('Codex response-loss adoption requires the exact durable service binding', async () => {
    const first = new LineTransport();
    const context: GoalProviderOpenContext = {
        executionId: 'codex-execution', attemptId: 'codex-attempt', repository,
        requestedModel: 'gpt-5.6-sol', providerHomeTarget: '/home/node/.codex',
        credentialTargets: [], deterministicOpenKey: 'durable-open-key', transport: first,
    };
    await openSupervisedCodexAppServer(context);
    const start = first.writes.find(write => write.method === 'thread/start');
    const binding = String((start?.params as Record<string, unknown>)?.serviceName);

    const adopted = new LineTransport(binding);
    const snapshot = await openSupervisedCodexAppServer({ ...context, transport: adopted });
    assert.equal(snapshot.providerSessionId, 'codex-thread');
    assert.equal(adopted.writes.some(write => write.method === 'thread/start'), false);
    assert.equal(adopted.writes.some(write => write.method === 'thread/resume'), true);

    const unrelated = new LineTransport('propr-open-'.concat('0'.repeat(64)));
    await assert.rejects(openSupervisedCodexAppServer({ ...context, transport: unrelated }),
        /Codex App Server open failed safely/);
    assert.equal(unrelated.writes.some(write => write.method === 'thread/start'), false);
    assert.equal(unrelated.cancelled, true);
});

test('hardened supervisor constructs eager-open transport only under its exact durable control claim', async () => {
    const ports = new InMemoryGoalSessionPorts();
    const adapter: GoalSessionAdapter = {
        provider: 'codex',
        capabilities: {
            nativeSessionId: 'eager', steering: 'active_turn', pause: 'after_turn', modelChange: 'next_turn',
        },
        supportsDeterministicOpen: true,
        publishOperationBarrier: async () => undefined,
        openSession: async request => {
            assert.ok(request.openContext);
            assert.equal('turnId' in request.openContext, false);
            return openSupervisedCodexAppServer(request.openContext);
        },
        beginTurn: async function* () { yield { type: 'completion', outcome: 'succeeded' }; },
        resumeSession: async (_request, snapshot) => snapshot,
        requestModelChange: async request => ({
            requestedModel: request.model, appliesAt: 'next_turn', effectiveModel: request.model,
        }),
        cancel: async () => undefined,
        reconcile: async () => ({ outcome: 'failed', reason: 'unused provider prose' }),
    };
    const supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    const transport = new LineTransport();
    let factoryCalled = false;
    const opened = await supervisor.openSession({
        ...identity, provider: 'codex', controllerEpoch: 1,
        supervisedOpen: {
            repository, requestedModel: 'gpt-5.6-sol', providerHomeTarget: '/home/node/.codex',
            credentialTargets: ['/home/node/.codex/auth.json'],
            createTransport: async claim => {
                factoryCalled = true;
                const durable = await ports.load(identity);
                assert.equal(durable?.providerOpenAttemptId, claim.attemptId);
                assert.equal(durable?.providerOperationGeneration, claim.operationGeneration);
                assert.equal(claim.operationFence.goalId, identity.goalId);
                assert.equal(claim.operationFence.sessionId, identity.sessionId);
                assert.equal(claim.operationFence.generation, claim.operationGeneration);
                assert.equal(claim.operationFence.operationId, claim.attemptId);
                assert.equal(claim.operationFence.kind, 'open');
                assert.equal(claim.operationFence.leaseExpiresAt, undefined);
                assert.equal('turnId' in claim, false);
                assert.match(claim.deterministicOpenKey, /^[A-Za-z0-9._:-]+$/);
                return transport;
            },
        },
    });
    assert.equal(factoryCalled, true);
    assert.equal(opened.status, 'idle');
    assert.equal(opened.providerSessionId, 'codex-thread');
    assert.equal(opened.currentModel, 'gpt-5.6-sol');
});

class UsageAdapter implements GoalSessionAdapter {
    readonly provider = 'usage-adapter';
    readonly capabilities = {
        nativeSessionId: 'eager' as const, steering: 'next_turn' as const,
        pause: 'after_turn' as const, modelChange: 'next_turn' as const,
    };
    events: GoalSessionEvent[] = [];
    async publishOperationBarrier(): Promise<void> {}
    async openSession(_request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot> {
        return { providerSessionId: 'usage-native', recoveryMetadata: {}, model: 'model-a' };
    }
    async *beginTurn(_request: GoalBeginTurnRequest): AsyncIterable<GoalSessionEvent> { yield* this.events; }
    async resumeSession(_request: never, snapshot: GoalProviderSessionSnapshot) { return snapshot; }
    async requestModelChange() { return { requestedModel: 'model-a', appliesAt: 'next_turn' as const }; }
    async cancel(_request: GoalProviderCancelRequest): Promise<void> {}
    async reconcile() { return { outcome: 'failed' as const, reason: 'unused' }; }
}

function turn(turnId: string) {
    return {
        ...identity, controllerEpoch: 1, turnId, executionId: `execution-${turnId}`, attemptId: `attempt-${turnId}`,
        objective: 'account usage exactly once', repository, requestedModel: 'model-a',
    };
}

test('usage occurrences dedupe across replay while cumulative watermarks advance monotonically', async () => {
    const ports = new InMemoryGoalSessionPorts();
    const adapter = new UsageAdapter();
    const supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    adapter.events = [
        { type: 'usage', occurrenceId: 'usage-0', semantics: 'delta', watermark: 0, inputTokens: 3 },
        { type: 'usage', occurrenceId: 'usage-0', semantics: 'delta', watermark: 0, inputTokens: 3 },
        { type: 'usage', occurrenceId: 'usage-2', semantics: 'cumulative', watermark: 2, inputTokens: 5 },
        { type: 'completion', outcome: 'succeeded' },
    ];
    await supervisor.runTurn(turn('one'));
    adapter.events = [
        { type: 'usage', occurrenceId: 'usage-2', semantics: 'cumulative', watermark: 2, inputTokens: 5 },
        { type: 'usage', occurrenceId: 'usage-3', semantics: 'cumulative', watermark: 3, inputTokens: 8 },
        { type: 'completion', outcome: 'succeeded' },
    ];
    await supervisor.runTurn(turn('two'));
    const state = await ports.load(identity);
    assert.deepEqual(state?.usageAccounting, {
        version: 1, lastWatermark: 3, occurrences: ['usage-0', 'usage-2', 'usage-3'],
    });
    assert.equal((await ports.replay(identity)).filter(record => record.event.type === 'usage').length, 3);
});

test('pending cancellation barrier is replayed with its exact identity before any reopen work', async () => {
    class ReplayAdapter extends UsageAdapter {
        failPublication = false;
        readonly publications: Array<{ generation: number; pendingCancellationId?: string }> = [];
        readonly cancellations: string[] = [];
        override async publishOperationBarrier(publication: { generation: number; pendingCancellationId?: string }) {
            this.publications.push(structuredClone(publication));
            if (this.failPublication) throw new Error('untrusted barrier details');
        }
        override async cancel(request: GoalProviderCancelRequest): Promise<void> {
            this.cancellations.push(request.cancellationId);
        }
    }
    const ports = new InMemoryGoalSessionPorts();
    const firstAdapter = new ReplayAdapter();
    const first = new GoalSessionSupervisor(firstAdapter, ports.asRuntimePorts());
    await first.openSession({ ...identity, provider: firstAdapter.provider, controllerEpoch: 1 });
    firstAdapter.failPublication = true;
    await assert.rejects(first.cancel({ ...identity, controllerEpoch: 1, reason: 'durable replay' }),
        /Provider barrier publication failed safely/);
    const pending = await ports.load(identity);
    assert.equal(pending?.providerBarrierIntent?.phase, 'pending');
    const cancellationId = pending?.cancellationIntent?.cancellationId;
    assert.ok(cancellationId);

    const replacementAdapter = new ReplayAdapter();
    const reopened = await new GoalSessionSupervisor(replacementAdapter, ports.asRuntimePorts()).openSession({
        ...identity, provider: replacementAdapter.provider, controllerEpoch: 2,
    });
    assert.equal(reopened.status, 'terminated');
    assert.deepEqual(replacementAdapter.cancellations, [cancellationId]);
    assert.ok(replacementAdapter.publications.some(publication =>
        publication.pendingCancellationId === cancellationId));
    assert.equal((await ports.replay(identity)).filter(record => record.event.type === 'completion').length, 1);
});

test('same-controller cancel retry repairs an exact pending terminal barrier', async () => {
    class TerminalRepairAdapter extends UsageAdapter {
        terminalPublicationFails = true;
        override async publishOperationBarrier(publication: { generation: number; pendingCancellationId?: string }) {
            if (this.terminalPublicationFails && publication.generation >= 3) {
                throw new Error('hostile terminal publication detail');
            }
        }
    }
    const ports = new InMemoryGoalSessionPorts();
    const adapter = new TerminalRepairAdapter();
    const supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    await assert.rejects(supervisor.cancel({ ...identity, controllerEpoch: 1, reason: 'repair terminal' }),
        /Provider barrier publication failed safely/);
    assert.equal((await ports.load(identity))?.status, 'terminated');
    assert.equal((await ports.load(identity))?.providerBarrierIntent?.phase, 'pending');
    adapter.terminalPublicationFails = false;
    const repaired = await supervisor.cancel({ ...identity, controllerEpoch: 1, reason: 'retry' });
    assert.equal(repaired.status, 'terminated');
    assert.equal(repaired.providerBarrierIntent?.phase, 'published');
    assert.equal((await ports.replay(identity)).filter(event => event.event.type === 'completion').length, 1);
});
