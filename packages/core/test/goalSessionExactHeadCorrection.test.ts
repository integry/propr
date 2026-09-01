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
import { sanitizeRecoveryMetadata } from '../src/agents/goalSession/recoveryMetadata.js';

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
});

class LineTransport {
    readonly writes: Array<Record<string, unknown>> = [];
    readonly output: AsyncIterable<string>;
    readonly completion = Promise.resolve({ exitCode: 0 });
    cancelled = false;
    private readonly lines: string[] = [];
    private readonly readers: Array<(result: IteratorResult<string>) => void> = [];

    constructor() {
        this.output = { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) };
    }

    async write(line: string): Promise<void> {
        const request = JSON.parse(line) as Record<string, unknown>;
        this.writes.push(request);
        const id = request.id;
        if (id === undefined) return;
        const method = request.method;
        if (method === 'thread/list') this.push(JSON.stringify({ id, result: { data: [] } }));
        else if (method === 'thread/start') this.push(JSON.stringify({
            id, result: { thread: { id: 'codex-thread', sessionId: 'codex-session' } },
        }));
        else this.push(JSON.stringify({ id, result: {} }));
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
        credentialTargets: ['/home/node/.codex/auth.json'], transport,
    };
    const snapshot = await openSupervisedCodexAppServer(context);
    assert.equal(snapshot.providerSessionId, 'codex-thread');
    assert.equal(snapshot.model, 'gpt-5.6-sol');
    assert.deepEqual(transport.writes.map(write => write.method), [
        'initialize', 'initialized', 'thread/list', 'thread/start',
    ]);
    assert.equal(transport.writes.some(write => write.method === 'turn/start'), false);
    const start = transport.writes.find(write => write.method === 'thread/start');
    assert.deepEqual(start?.params, {
        model: 'gpt-5.6-sol', cwd: repository.worktreePath, approvalPolicy: 'never',
        sandbox: 'workspaceWrite', serviceName: 'propr_goal_codex-execution',
    });
    assert.deepEqual(sanitizeRecoveryMetadata(snapshot.recoveryMetadata, 'codex'), snapshot.recoveryMetadata);
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
