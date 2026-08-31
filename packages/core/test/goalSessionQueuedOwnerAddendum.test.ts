import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
    GoalBeginTurnRequest,
    GoalModelChangeIntent,
    GoalProviderModelChangeRequest,
    GoalProviderReconcileRequest,
    GoalSessionAdapter,
    GoalSessionEvent,
} from '../src/agents/goalSession/contract.js';
import { GoalSessionSupervisor } from '../src/agents/goalSession/GoalSessionSupervisor.js';
import { InMemoryGoalSessionPorts } from '../src/agents/goalSession/InMemoryGoalSessionPorts.js';
import {
    compactImmediateModelIntents,
    MODEL_CHANGE_SETTLED_RETRY_HORIZON,
} from '../src/agents/goalSession/modelChangeProtocol.js';
import {
    fingerprintGoalWorktree,
    normalizeGitRepositoryIdentity,
} from '../src/agents/goalSession/worktreeIdentity.js';
import { SqliteGoalSessionTestPorts } from './SqliteGoalSessionTestPorts.js';

const identity = { goalId: 'queued-addendum-goal', sessionId: 'queued-addendum-session' };
const repository = {
    repository: 'integry/propr', worktreePath: '/tmp/queued-addendum-worktree', branch: 'follow-up',
};

class AddendumAdapter implements GoalSessionAdapter {
    readonly provider = 'queued-addendum-provider';
    readonly capabilities = {
        nativeSessionId: 'eager' as const,
        steering: 'active_turn' as const,
        pause: 'active_turn' as const,
        modelChange: 'next_safe_boundary' as const,
    };
    readonly modelCalls: GoalProviderModelChangeRequest[] = [];
    readonly reconcileRequests: GoalProviderReconcileRequest[] = [];
    readonly beginRequests: GoalBeginTurnRequest[] = [];
    currentModel = 'model-base';

    async openSession() {
        return { providerSessionId: 'queued-native', recoveryMetadata: { checkpoint: 'open' }, model: this.currentModel };
    }

    beginTurn(request: GoalBeginTurnRequest): AsyncIterable<GoalSessionEvent> {
        this.beginRequests.push(structuredClone(request));
        return (async function* () { yield { type: 'completion', outcome: 'succeeded' } as const; })();
    }

    async resumeSession(_request: unknown, snapshot: { providerSessionId: string; recoveryMetadata: object }) {
        return snapshot;
    }

    async requestModelChange(request: GoalProviderModelChangeRequest) {
        this.modelCalls.push(structuredClone(request));
        this.currentModel = request.model;
        return { requestedModel: request.model, appliesAt: 'immediate' as const, effectiveModel: request.model };
    }

    async cancel() {}

    async reconcile(request: GoalProviderReconcileRequest) {
        this.reconcileRequests.push(structuredClone(request));
        return { outcome: 'alive' as const, reason: 'authoritative recovery target matched' };
    }
}

function temporaryDatabase(): { filename: string; cleanup: () => void } {
    const directory = mkdtempSync(join(tmpdir(), 'goal-model-retention-'));
    return { filename: join(directory, 'state.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('compaction retains every unresolved generation and the newest settled retry horizon in order', () => {
    const unresolved = new Set([7, 89, 151]);
    const intents: GoalModelChangeIntent[] = Array.from({ length: 240 }, (_, offset) => {
        const generation = offset + 1;
        return {
            modelChangeId: `change-${generation}`,
            model: `model-${generation}`,
            requestedAt: new Date(generation * 1000).toISOString(),
            generation,
            phase: unresolved.has(generation) ? 'provider_in_doubt' : 'superseded',
            acknowledgement: { requestedModel: `model-${generation}`, appliesAt: 'immediate' },
        };
    });
    const compacted = compactImmediateModelIntents(intents);

    assert.deepEqual(compacted.filter(intent => !['committed', 'superseded'].includes(intent.phase ?? ''))
        .map(intent => intent.generation), [...unresolved]);
    assert.deepEqual(compacted.filter(intent => intent.phase === 'superseded').map(intent => intent.generation),
        Array.from({ length: MODEL_CHANGE_SETTLED_RETRY_HORIZON }, (_, offset) => 177 + offset));
    assert.deepEqual(compacted.map(intent => intent.generation),
        [...compacted.map(intent => intent.generation)].sort((left, right) => left! - right!));
});

test('reopen compacts an oversized settled ledger from an older process without losing the latest model', async () => {
    const adapter = new AddendumAdapter();
    adapter.currentModel = 'model-300';
    const ports = new InMemoryGoalSessionPorts();
    const timestamp = new Date().toISOString();
    const intents: GoalModelChangeIntent[] = Array.from({ length: 300 }, (_, offset) => ({
        modelChangeId: `legacy-${offset + 1}`,
        model: `model-${offset + 1}`,
        requestedAt: timestamp,
        generation: offset + 1,
        phase: 'committed',
        acknowledgement: {
            requestedModel: `model-${offset + 1}`, appliesAt: 'immediate', effectiveModel: `model-${offset + 1}`,
        },
    }));
    await ports.create({
        ...identity, provider: adapter.provider, providerSessionId: 'queued-native', recoveryMetadata: {},
        controllerEpoch: 1, status: 'idle', currentModel: 'model-300', requestedModel: 'model-300',
        completedTurnIds: [], modelChangeGeneration: 300, modelChangeIntents: intents,
        modelChangeIntent: intents.at(-1), createdAt: timestamp, updatedAt: timestamp,
    });
    const supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    const reopened = await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 2 });

    assert.equal(reopened.currentModel, 'model-300');
    assert.equal(reopened.requestedModel, 'model-300');
    assert.equal(reopened.modelChangeGeneration, 300);
    assert.equal(reopened.modelChangeIntents?.length, MODEL_CHANGE_SETTLED_RETRY_HORIZON);
    assert.equal(reopened.modelChangeIntent?.modelChangeId, 'legacy-300');
});

test('thousands of model switches stay bounded across a crash, takeover, cached retry, and SQLite reopen', async t => {
    const database = temporaryDatabase();
    t.after(database.cleanup);
    const adapter = new AddendumAdapter();
    let ports = new SqliteGoalSessionTestPorts(database.filename);
    let supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
    await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });

    let sizeAtHorizon = 0;
    for (let generation = 0; generation < 5_001; generation += 1) {
        const model = `model-${generation.toString().padStart(4, '0')}`;
        if (generation === 80) {
            ports.setTransitionFault('before_commit');
            await assert.rejects(supervisor.requestModelChange({ ...identity, controllerEpoch: 1, model }),
                /Injected crash/);
            const unresolved = await ports.load(identity);
            assert.equal(unresolved?.modelChangeIntents?.at(-1)?.phase, 'provider_in_doubt');
            assert.ok((unresolved?.modelChangeIntents?.length ?? 0) <= MODEL_CHANGE_SETTLED_RETRY_HORIZON + 1);
            ports.close();
            ports = new SqliteGoalSessionTestPorts(database.filename);
            supervisor = new GoalSessionSupervisor(adapter, ports.asRuntimePorts());
            await supervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 2 });
        } else {
            await supervisor.requestModelChange({
                ...identity, controllerEpoch: generation < 80 ? 1 : 2, model,
            });
        }
        if (generation === 100) sizeAtHorizon = JSON.stringify(await ports.load(identity)).length;
    }

    const settled = await ports.load(identity);
    assert.equal(settled?.currentModel, 'model-5000');
    assert.equal(settled?.requestedModel, 'model-5000');
    assert.equal(settled?.modelChangeGeneration, 5_001);
    assert.equal(settled?.modelChangeIntents?.length, MODEL_CHANGE_SETTLED_RETRY_HORIZON);
    assert.equal(settled?.modelChangeIntents?.at(0)?.generation, 4_938);
    assert.equal(settled?.modelChangeIntents?.at(-1)?.generation, 5_001);
    assert.ok(JSON.stringify(settled).length <= sizeAtHorizon + 2_048);
    assert.ok(JSON.stringify(settled).length < 32_000);

    const latestId = settled?.modelChangeIntents?.at(-1)?.modelChangeId;
    await supervisor.requestModelChange({ ...identity, controllerEpoch: 2, model: 'model-5000' });
    assert.equal(adapter.modelCalls.at(-1)?.modelChangeId, latestId, 'cached retry keeps its provider idempotency identity');
    assert.equal(adapter.modelCalls.at(-1)?.applicationGeneration, 5_001);

    const events = await ports.replay(identity);
    assert.equal(events.filter(record => record.event.type === 'model_change_acknowledged').length, 5_001);
    assert.equal(events.filter(record => record.event.type === 'model_changed').length, 5_001);
    assert.equal(events.find(record => record.event.type === 'model_changed')?.event.type === 'model_changed'
        ? events.find(record => record.event.type === 'model_changed')!.event.model : undefined, 'model-0000');

    const firstOperationId = adapter.modelCalls[0]?.modelChangeId;
    assert.ok(firstOperationId);
    assert.equal((await supervisor.requestModelChange({
        ...identity, controllerEpoch: 2, model: 'model-0000', operationId: firstOperationId,
    })).outcome, 'outside_retry_horizon');
    const retained = settled?.modelChangeIntents?.at(0);
    assert.ok(retained);
    assert.equal((await supervisor.requestModelChange({
        ...identity, controllerEpoch: 2, model: retained.model, operationId: retained.modelChangeId,
    })).requestedModel, retained.model);
    const neverIssued = await supervisor.requestModelChange({
        ...identity, controllerEpoch: 2, model: 'model-never-issued', operationId: 'adversarial-never-issued-after-5001',
    });
    assert.notEqual(neverIssued.outcome, 'outside_retry_horizon');
    await assert.rejects(supervisor.requestModelChange({
        ...identity, controllerEpoch: 2, model: 'model-conflict', operationId: 'adversarial-never-issued-after-5001',
    }), /different model/);
    ports.close();
});

test('Git remotes normalize canonical identities and reject credential-bearing or malformed values', () => {
    const accepted = new Map([
        ['git@github.com:integry/propr.git', 'integry/propr'],
        ['https://github.com/integry/propr.git', 'integry/propr'],
    ]);
    for (const [remote, expected] of accepted) assert.equal(normalizeGitRepositoryIdentity(remote), expected);
    for (const remote of [
        'https://alice:secret@/integry/propr',
        'https://alice:token-value@github.com/integry/propr.git',
        'ssh://git:private-key@github.com/integry/propr.git',
        'token-user@github.com:integry/propr.git?access_token=query-secret',
        'https://oauth2:secret@gitlab.example.com/group/project.git',
        'file:///tmp/credential/repository',
        'alice:secret@github.com/integry/propr',
        'https://github.com',
        'https://github.com/integry/repository\nsecret',
    ]) assert.equal(normalizeGitRepositoryIdentity(remote), undefined);
});

test('turn and recovery boundaries never expose credential-bearing remotes in provider, state, event, or error data', async () => {
    const token = 'TOP-SECRET-GIT-TOKEN';
    const credentialRemote = `https://owner:${token}@github.com/integry/propr.git`;
    const adapter = new AddendumAdapter();
    const turnPorts = new InMemoryGoalSessionPorts();
    const turnSupervisor = new GoalSessionSupervisor(adapter, turnPorts.asRuntimePorts());
    await turnSupervisor.openSession({ ...identity, provider: adapter.provider, controllerEpoch: 1 });
    await assert.rejects(turnSupervisor.runTurn({
        ...identity, controllerEpoch: 1, turnId: 'credential-turn', executionId: 'credential-execution',
        attemptId: 'credential-attempt', objective: 'scrub remote',
        repository: {
            ...repository,
            repository: credentialRemote,
            credentialBearingRemote: credentialRemote,
        } as typeof repository,
        requestedModel: 'model-base',
    }), /trustworthy Git repository/);
    assert.equal(adapter.beginRequests.length, 0);

    const recoveryIdentity = { goalId: 'credential-recovery-goal', sessionId: 'credential-recovery-session' };
    const recoveryPorts = new InMemoryGoalSessionPorts();
    const timestamp = new Date().toISOString();
    await recoveryPorts.create({
        ...recoveryIdentity, provider: adapter.provider, providerSessionId: 'queued-native', recoveryMetadata: {},
        controllerEpoch: 1, status: 'running', currentModel: 'model-base', completedTurnIds: [],
        activeTurn: {
            turnId: 'recovery-turn', executionId: 'recovery-execution', attemptId: 'recovery-attempt', executionEpoch: 1,
            objective: 'recover securely', requestedModel: 'model-base', repository, status: 'running',
        },
        createdAt: timestamp, updatedAt: timestamp,
    });
    recoveryPorts.setRepositoryInspection(repository, {
        ...repository, exists: true, observedRepository: credentialRemote, observedBranch: repository.branch,
        observedWorktreeFingerprint: fingerprintGoalWorktree(repository),
        reason: `untrusted diagnostic ${credentialRemote}`,
    });
    const recoverySupervisor = new GoalSessionSupervisor(adapter, recoveryPorts.asRuntimePorts());
    const recoveryResult = await recoverySupervisor.reconcile(recoveryIdentity, 1, repository);
    assert.equal(recoveryResult.outcome, 'blocked');
    assert.equal(adapter.reconcileRequests.length, 0);

    let invalidError = '';
    try {
        await turnSupervisor.runTurn({
            ...identity, controllerEpoch: 1, turnId: 'invalid-turn', executionId: 'invalid-execution',
            objective: 'reject malformed remote', repository: {
                ...repository, repository: `https://owner:${token}@/integry/propr`,
            }, requestedModel: 'model-base',
        });
    } catch (error) {
        invalidError = error instanceof Error ? error.message : String(error);
    }
    const boundaryData = JSON.stringify({
        beginRequests: adapter.beginRequests,
        reconcileRequests: adapter.reconcileRequests,
        turnState: await turnPorts.load(identity),
        turnEvents: await turnPorts.replay(identity),
        recoveryState: await recoveryPorts.load(recoveryIdentity),
        recoveryEvents: await recoveryPorts.replay(recoveryIdentity),
        invalidError,
    });
    assert.doesNotMatch(boundaryData, new RegExp(token));
    assert.doesNotMatch(boundaryData, /owner:TOP-SECRET/);
    assert.match(invalidError, /trustworthy Git repository/);
});
