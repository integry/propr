import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type {
    GoalBeginTurnRequest, GoalProviderBarrierPublication, GoalProviderModelChangeRequest, GoalProviderOpenRequest,
    GoalProviderSessionSnapshot, GoalSessionAdapter, GoalSessionEvent,
} from '../src/agents/goalSession/contract.js';
import { GoalSessionSupervisor } from '../src/agents/goalSession/GoalSessionSupervisor.js';
import { GoalSessionContractError } from '../src/agents/goalSession/errors.js';
import { InMemoryGoalSessionPorts } from '../src/agents/goalSession/InMemoryGoalSessionPorts.js';
import { sanitizeRecoveryMetadata } from '../src/agents/goalSession/recoveryMetadata.js';
import { sanitizeGoalSessionEvent } from '../src/agents/goalSession/securityBoundary.js';
import { isSensitiveHostSourcePath } from '../src/agents/goalSession/worktreeIdentity.js';
import { SqliteGoalSessionTestPorts } from './SqliteGoalSessionTestPorts.js';

const identity = { goalId: 'foundation-audit-goal', sessionId: 'foundation-audit-session' };

class IdentityAuditAdapter implements GoalSessionAdapter {
    readonly provider = 'identity-audit';
    readonly capabilities: GoalSessionAdapter['capabilities'];
    readonly traces: string[] = [];
    openedPersisted?: GoalProviderOpenRequest['persisted'];

    constructor(modelChange: 'next_safe_boundary' | 'next_turn') {
        this.capabilities = {
            nativeSessionId: 'eager', steering: 'next_turn', pause: 'after_turn', modelChange,
        };
    }

    async publishOperationBarrier(_publication: GoalProviderBarrierPublication): Promise<void> {}
    async openSession(request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot> {
        this.openedPersisted = request.persisted;
        return { providerSessionId: 'identity-audit-native', recoveryMetadata: {}, model: 'model-0' };
    }
    async *beginTurn(_request: GoalBeginTurnRequest): AsyncIterable<GoalSessionEvent> {
        yield { type: 'completion', outcome: 'succeeded' };
    }
    async resumeSession(_request: never, snapshot: GoalProviderSessionSnapshot) { return snapshot; }
    async requestModelChange(request: GoalProviderModelChangeRequest) {
        this.traces.push(request.modelChangeId);
        return { requestedModel: request.model, appliesAt: 'next_safe_boundary' as const, effectiveModel: request.model };
    }
    async cancel() {}
    async reconcile(): Promise<{ outcome: 'failed'; reason: string }> { return { outcome: 'failed', reason: 'not used' }; }
}

test('event and recovery codecs reject traversal, endpoints, commands, extras, and invalid numbers', () => {
    for (const file of [
        '.', '..', '../secret', 'src/../secret', '/etc/passwd', 'C:\\secret', '\\\\server\\share',
        'file:///tmp/a', 'docker://engine', 'src/a.ts;docker ps', 'src//a.ts', `src/${'a'.repeat(1025)}`,
    ]) {
        assert.throws(() => sanitizeGoalSessionEvent({
            type: 'tool', toolCallId: 'tool-1', name: 'read', phase: 'completed', data: { file },
        }));
    }
    assert.deepEqual(sanitizeGoalSessionEvent({
        type: 'tool', toolCallId: 'tool-1', name: 'read', phase: 'completed', data: { file: 'src/a.ts', line: 0 },
    }), { type: 'tool', toolCallId: 'tool-1', name: 'read', phase: 'completed', data: { file: 'src/a.ts', line: 0 } });
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
        assert.throws(() => sanitizeGoalSessionEvent({ type: 'usage', occurrenceId: 'usage-invalid', semantics: 'delta', watermark: 0, inputTokens: invalid }));
        assert.throws(() => sanitizeRecoveryMetadata({ offset: invalid }));
    }
    for (const poisoned of [
        { checkpoint: '../escape' }, { checkpoint: 'file:///tmp/a' }, { offset: -1 },
        { command: 'docker ps' }, { checkpoint: 'ok', nested: { token: 'not-forwarded' } },
    ]) assert.throws(() => sanitizeRecoveryMetadata(poisoned));
});

test('both model capability profiles reject unsafe caller IDs before history or provider traces', async () => {
    for (const profile of ['next_safe_boundary', 'next_turn'] as const) {
        const adapter = new IdentityAuditAdapter(profile);
        const ports = new InMemoryGoalSessionPorts();
        const supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
        await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
        const beforeState = await ports.load(identity);
        const beforeEvents = await ports.replay(identity);
        for (const operationId of [
            '../operation', '/tmp/operation', 'C:\\operation', '\\\\server\\operation',
            'file:///tmp/operation', 'docker://engine', 'operation;docker ps', `x${'a'.repeat(256)}`,
        ]) {
            await assert.rejects(supervisor.requestModelChange({
                ...identity, controllerEpoch: 1, model: 'model-safe', operationId,
            }));
        }
        await assert.rejects(supervisor.requestModelChange({
            ...identity, controllerEpoch: 1, model: '../model', operationId: 'safe-operation',
        }));
        assert.deepEqual(await ports.load(identity), beforeState);
        assert.deepEqual(await ports.replay(identity), beforeEvents);
        assert.deepEqual(adapter.traces, []);
    }
});

test('reopen rejects durable poison without mutation and provider URL exceptions cross as generic errors', async () => {
    const timestamp = new Date().toISOString();
    const ports = new InMemoryGoalSessionPorts();
    await ports.create({
        ...identity, provider: 'identity-audit', providerSessionId: 'identity-audit-native',
        recoveryMetadata: { checkpoint: 'safe', command: 'docker ps', nested: { token: 'opaque-value' } },
        controllerEpoch: 1, status: 'idle', currentModel: 'model-0', completedTurnIds: [],
        createdAt: timestamp, updatedAt: timestamp, legacyEnvelope: { command: 'docker ps', credential: 'opaque-value' },
    });
    const adapter = new IdentityAuditAdapter('next_turn');
    const poisonedBefore = await ports.load(identity);
    await assert.rejects(new GoalSessionSupervisor(adapter, ports.asRuntimePorts()).openSession({
        ...identity, provider: adapter.provider, controllerEpoch: 2,
    }), (error: unknown) => error instanceof GoalSessionContractError && error.code === 'INVALID_DURABLE_STATE');
    assert.deepEqual(await ports.load(identity), poisonedBefore);
    assert.equal(adapter.openedPersisted, undefined);

    class ThrowingAdapter extends IdentityAuditAdapter {
        override async openSession(): Promise<GoalProviderSessionSnapshot> {
            throw new Error('request failed https://user:TOP-SECRET-CREDENTIAL@example.test/api command docker run');
        }
    }
    const poisonedPorts = new InMemoryGoalSessionPorts();
    const throwing = new ThrowingAdapter('next_turn');
    const failure = await new GoalSessionSupervisor(throwing, poisonedPorts.asRuntimePorts()).openSession({
        goalId: 'provider-error-goal', sessionId: 'provider-error-session', provider: throwing.provider, controllerEpoch: 1,
    }).catch(error => error as Error);
    assert.equal(failure.message, 'Provider operation failed safely');
    assert.doesNotMatch(JSON.stringify(failure), /TOP-SECRET|example\.test|docker run/);
});

test('host source policy blocks system, credential, and engine state while preserving project roots', () => {
    for (const source of [
        '/run', '/run/docker.sock', '/var/run', '/var/run/docker.sock', '/proc/self/environ',
        '/etc/passwd', '/root/arbitrary-file', '/boot/grub', '/var/lib/docker/overlay2',
        '/var/lib/containers/storage', '/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs',
    ]) assert.equal(isSensitiveHostSourcePath(source), true, source);
    assert.equal(isSensitiveHostSourcePath('/var/www/project'), false);
    assert.equal(isSensitiveHostSourcePath('/usr/src/project'), false);
});

test('supervisor cancellation claim wins at the process-like adapter first-effect transaction', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-barrier-audit-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'provider.sqlite');
    const supervisorPorts = new SqliteGoalSessionTestPorts(filename);
    const adapterPorts = new SqliteGoalSessionTestPorts(filename);
    t.after(() => { supervisorPorts.close(); adapterPorts.close(); });
    let releaseTurnPublication!: () => void;
    let turnPublicationStarted!: () => void;
    let releaseCancellation!: () => void;
    const turnPublicationGate = new Promise<void>(resolve => { releaseTurnPublication = resolve; });
    const publicationStarted = new Promise<void>(resolve => { turnPublicationStarted = resolve; });
    const cancellationGate = new Promise<void>(resolve => { releaseCancellation = resolve; });
    class ProcessLikeAdapter extends IdentityAuditAdapter {
        override async publishOperationBarrier(publication: GoalProviderBarrierPublication): Promise<void> {
            if (publication.pendingCancellationId) await cancellationGate;
            else if (publication.generation > 1) {
                turnPublicationStarted();
                await turnPublicationGate;
            }
        }
        override async *beginTurn(request: GoalBeginTurnRequest): AsyncIterable<GoalSessionEvent> {
            void request;
            yield { type: 'completion', outcome: 'succeeded' };
        }
    }
    const adapter = new ProcessLikeAdapter('next_turn');
    const first = new GoalSessionSupervisor(adapter, supervisorPorts.asRuntimePorts());
    await first.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    const effectsBeforeTurn = adapterPorts.providerEffectCount();
    const running = first.runTurn({
        ...identity, controllerEpoch: 1, turnId: 'barrier-turn', executionId: 'barrier-execution',
        attemptId: 'barrier-attempt', objective: 'prove exact provider boundary',
        repository: { repository: 'integry/propr', worktreePath: '/tmp/provider-boundary', branch: 'audit' },
        requestedModel: 'model-0',
    });
    await publicationStarted;
    const cancelling = new GoalSessionSupervisor(adapter, adapterPorts.asRuntimePorts()).cancel({
        ...identity, controllerEpoch: 1, reason: 'invalidate before first effect',
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await supervisorPorts.load(identity))?.providerBarrierIntent?.phase === 'pending') break;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    const invalidated = (await supervisorPorts.load(identity))!;
    releaseTurnPublication();
    await assert.rejects(running);
    assert.equal(adapterPorts.providerEffectCount(), effectsBeforeTurn);
    releaseCancellation();
    assert.equal((await cancelling).status, 'terminated');
});

test('SQLite takeover settles one published cancellation barrier without replacing terminal ownership', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-takeover-audit-'));
    const filename = path.join(directory, 'state.sqlite');
    const firstPorts = new SqliteGoalSessionTestPorts(filename);
    const secondPorts = new SqliteGoalSessionTestPorts(filename);
    t.after(() => {
        firstPorts.close(); secondPorts.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
    class GatedCancelAdapter extends IdentityAuditAdapter {
        cancelCalls = 0;
        override async cancel(): Promise<void> {
            this.cancelCalls += 1;
            await cancelGate;
        }
    }
    const adapter = new GatedCancelAdapter('next_turn');
    const first = new GoalSessionSupervisor(adapter, firstPorts.asRuntimePorts());
    const second = new GoalSessionSupervisor(adapter, secondPorts.asRuntimePorts());
    await first.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    const cancelling = first.cancel({ ...identity, controllerEpoch: 1, reason: 'gated published cancellation' });
    for (let attempt = 0; attempt < 100 && adapter.cancelCalls < 1; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    const takeover = second.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 2 });
    const published = await secondPorts.load(identity);
    assert.ok(published?.status === 'cancelling' || published?.status === 'terminated');
    assert.equal(published?.controllerEpoch, 1);
    const cancellationId = published?.cancellationIntent?.cancellationId;
    assert.equal(adapter.cancelCalls, 1, 'takeover adopts the durable stage without a second provider call');

    releaseCancel();
    const [cancelled, reopened] = await Promise.all([cancelling, takeover]);
    assert.equal(cancelled.status, 'terminated');
    assert.equal(reopened.status, 'terminated');
    assert.equal(reopened.controllerEpoch, 1, 'terminal takeover never replaces the cancellation owner');
    assert.equal(reopened.cancellationIntent?.cancellationId, cancellationId);
    assert.equal((await secondPorts.replay(identity)).filter(record => record.event.type === 'completion').length, 1);
    const calls = adapter.cancelCalls;
    const terminalRace = await second.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 3 });
    assert.equal(terminalRace.controllerEpoch, 1);
    assert.equal(adapter.cancelCalls, calls, 'terminal takeover performs no provider mutation');
});

test('independent processes allocate unique exact model order and deterministically retain newest 64', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-order-audit-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'state.sqlite');
    const seed = new SqliteGoalSessionTestPorts(filename);
    seed.close();
    const moduleUrl = new URL('./SqliteGoalSessionTestPorts.ts', import.meta.url).href;
    const lock = new Database(filename);
    lock.exec('BEGIN IMMEDIATE');
    const busyRetry = runChildProcess(`
        import { SqliteGoalSessionTestPorts } from ${JSON.stringify(moduleUrl)};
        const ports = new SqliteGoalSessionTestPorts(${JSON.stringify(filename)});
        const identity = ${JSON.stringify(identity)};
        await ports.claim(identity, 'busy-operation', 'model-busy');
        await ports.settle(identity, 'busy-operation', { requestedModel: 'model-busy', appliesAt: 'next_turn' });
        ports.close();
    `);
    await new Promise(resolve => setTimeout(resolve, 100));
    lock.exec('COMMIT');
    lock.close();
    await busyRetry;
    await Promise.all(Array.from({ length: 4 }, (_, worker) => runChildProcess(`
        import { SqliteGoalSessionTestPorts } from ${JSON.stringify(moduleUrl)};
        const ports = new SqliteGoalSessionTestPorts(${JSON.stringify(filename)});
        const identity = ${JSON.stringify(identity)};
        for (let index = 0; index < 25; index += 1) {
            const id = 'worker-' + ${JSON.stringify(worker)} + '-' + index;
            await ports.claim(identity, id, 'model-' + id);
            await ports.settle(identity, id, { requestedModel: 'model-' + id, appliesAt: 'next_turn' });
        }
        ports.close();
    `)));
    const database = new Database(filename, { readonly: true });
    t.after(() => database.close());
    const rows = database.prepare(
        'SELECT operation_id, sequence, status FROM goal_session_runtime_model_changes ORDER BY sequence',
    ).all() as Array<{ operation_id: string; sequence: number; status: string }>;
    assert.equal(rows.length, 101);
    assert.equal(new Set(rows.map(row => row.sequence)).size, 101);
    assert.deepEqual(rows.map(row => row.sequence), Array.from({ length: 101 }, (_, index) => index + 1));
    assert.equal(rows.filter(row => row.status === 'settled').length, 64);
    assert.equal(rows.filter(row => row.status === 'retired').length, 37);
});

function runChildProcess(source: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`)));
    });
}
