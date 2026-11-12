/**
 * Synthetic selection with per-agent capacity: a saturated member is only
 * temporarily unavailable within its priority tier, never a failed attempt and
 * never a reason to move to a lower tier; a deferrable selection with no room
 * throws AgentCapacityError; a pinned selection is reused without advancing the
 * round-robin cursor (no double selection across a deferral).
 */
import assert from 'node:assert/strict';
import { after, afterEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { SyntheticAgentConfig } from '@propr/shared';
import { SyntheticRoutingService } from '../src/services/syntheticRoutingService.js';
import { SyntheticAgent } from '../src/agents/SyntheticAgent.js';
import { AgentCapacityError, isAgentCapacityError, runWithAgentCapacityContext, agentCapacityPins } from '../src/agents/agentCapacity.js';
import type { Agent, AgentConfig, AgentExecutionResult, AgentTaskOptions, AnalysisResult } from '../src/agents/types.js';
import { db as globalDatabase } from '../src/db/connection.js';
import { up as createSyntheticRoutingCursors } from '../src/db/migrations/20260830000000_create_synthetic_routing_cursors.js';

const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_B = '22222222-2222-4222-8222-222222222222';
const MEMBER_C = '33333333-3333-4333-8333-333333333333';
const POOL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

class FakeAgent implements Agent {
    taskCalls: AgentTaskOptions[] = [];
    taskResults: Array<AgentExecutionResult | Error> = [];
    constructor(readonly config: AgentConfig) {}
    async analyze(): Promise<AnalysisResult> { return { response: '', modelUsed: '', executionTimeMs: 1, success: true }; }
    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        this.taskCalls.push(options);
        const next = this.taskResults.shift();
        if (next instanceof Error) throw next;
        return next ?? { success: true, logs: '', modifiedFiles: [], modelUsed: options.model || '', executionTimeMs: 1 };
    }
    async healthCheck(): Promise<boolean> { return true; }
}

function direct(alias: string, model = 'claude-opus-4-6'): FakeAgent {
    return new FakeAgent({ id: alias, alias, type: 'claude', enabled: true, dockerImage: 'test', configPath: 'test', supportedModels: [model], defaultModel: model });
}

/** Three members: A and B in the top tier, C below them. */
function pool(strategy: 'round_robin' | 'usage_based' = 'round_robin'): SyntheticAgentConfig {
    return {
        id: POOL_ID, alias: 'pool', enabled: true, defaultModel: 'smart',
        models: [{ id: 'smart', enabled: true, strategy, members: [
            { id: MEMBER_A, directAgentAlias: 'alpha', model: 'claude-opus-4-6', enabled: true, priority: 100 },
            { id: MEMBER_B, directAgentAlias: 'beta', model: 'claude-opus-4-6', enabled: true, priority: 100 },
            { id: MEMBER_C, directAgentAlias: 'gamma', model: 'claude-opus-4-6', enabled: true, priority: 0 },
        ] }],
    };
}

let databases: Knex[] = [];
async function database(): Promise<Knex> {
    const value = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await createSyntheticRoutingCursors(value);
    await value.schema.createTable('tasks', table => table.string('task_id').primary());
    await value.schema.createTable('task_history', table => {
        table.increments('history_id').primary();
        table.string('task_id').notNullable(); table.string('state').notNullable();
        table.timestamp('timestamp'); table.text('reason'); table.json('metadata');
    });
    databases.push(value);
    return value;
}

function router(db: Knex, saturated: Set<string>, agents = [direct('alpha'), direct('beta'), direct('gamma')]) {
    const byAlias = new Map(agents.map(agent => [agent.config.alias, agent]));
    const capacityChecks: string[] = [];
    const service = new SyntheticRoutingService({
        database: db, loadSyntheticConfigs: async () => [pool()], getDirectAgent: alias => byAlias.get(alias),
        usageSnapshotProvider: { getSnapshot: async () => null },
        aliasCapacity: async alias => { capacityChecks.push(alias); return !saturated.has(alias); },
    });
    return { service, byAlias, capacityChecks };
}

async function cursor(db: Knex): Promise<number> {
    const row = await db('synthetic_routing_cursors').first<{ cursor: number } | undefined>();
    return Number(row?.cursor ?? 0);
}

afterEach(async () => { await Promise.all(databases.map(value => value.destroy())); databases = []; });
after(async () => { await globalDatabase.destroy(); });

describe('synthetic selection with per-agent capacity', () => {
    test('a saturated member is skipped for another member of the same tier, without a failed attempt', async () => {
        const db = await database();
        const { service } = router(db, new Set(['alpha']));
        for (let call = 0; call < 3; call++) {
            const selection = await service.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart', deferOnCapacity: true }).select();
            assert.equal(selection.physicalAgentAlias, 'beta', `call ${call}: the free same-tier member is chosen`);
            assert.match(selection.selectionReason, /skipped members at their agent ceiling/);
        }
        assert.equal(await cursor(db), 3, 'each selection advances the cursor exactly once');
        assert.deepEqual(await db('task_history'), [], 'selection writes no attempt row');
    });

    test('a saturated tier defers instead of moving to a lower tier, and does not advance the cursor', async () => {
        const db = await database();
        const { service } = router(db, new Set(['alpha', 'beta']));
        await assert.rejects(service.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart', deferOnCapacity: true }).select(),
            (error: unknown) => error instanceof AgentCapacityError && error.aliases.sort().join() === 'alpha,beta');
        assert.equal(await cursor(db), 0);
        // Without deferral (no queue job: chat, planner, failover) the usual top-tier choice waits at admission.
        const waiting = await service.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' }).select();
        assert.ok(['alpha', 'beta'].includes(waiting.physicalAgentAlias), 'never the lower tier because of capacity');
    });

    test('a direct agent at its ceiling defers only a deferrable selection', async () => {
        const db = await database();
        const { service } = router(db, new Set(['alpha']));
        await assert.rejects(service.begin({ requestedAgentAlias: 'alpha', deferOnCapacity: true }).select(), AgentCapacityError);
        assert.equal((await service.begin({ requestedAgentAlias: 'alpha' }).select()).physicalAgentAlias, 'alpha');
    });

    test('a pinned member is reused after a deferral without selecting or advancing the cursor again', async () => {
        const db = await database();
        const saturated = new Set<string>();
        const { service } = router(db, saturated);
        const first = await service.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart', deferOnCapacity: true }).select();
        assert.equal(await cursor(db), 1);
        // Re-entry: the same member, no second round-robin step.
        const again = await service.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart', deferOnCapacity: true, pinnedMemberId: first.memberId }).select();
        assert.equal(again.memberId, first.memberId);
        assert.match(again.selectionReason, /^pinned/);
        assert.equal(await cursor(db), 1);
        // The pinned member filled up meanwhile: its free tier peer is taken, still without a cursor step.
        saturated.add(first.physicalAgentAlias);
        const moved = await service.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart', deferOnCapacity: true, pinnedMemberId: first.memberId }).select();
        assert.notEqual(moved.memberId, first.memberId);
        assert.notEqual(moved.physicalAgentAlias, 'gamma');
        assert.equal(await cursor(db), 1);
        // Whole tier full: deferred again, pin kept by the caller.
        saturated.add(moved.physicalAgentAlias);
        await assert.rejects(service.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart', deferOnCapacity: true, pinnedMemberId: first.memberId }).select(), AgentCapacityError);
        assert.equal(await cursor(db), 1);
    });

    test('a capacity refusal at the physical boundary is neither failover nor a failed attempt', async () => {
        const db = await database();
        const { service, byAlias } = router(db, new Set());
        const session = service.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' });
        const chosen = await session.select();
        const agent = byAlias.get(chosen.physicalAgentAlias)!;
        agent.taskResults.push(new AgentCapacityError([chosen.physicalAgentAlias], { [chosen.physicalAgentAlias]: 1 }));
        await assert.rejects(session.executeTask({ worktreePath: '/tmp', issueRef: { number: 1, repoOwner: 'o', repoName: 'r' }, prompt: 'p' }), isAgentCapacityError);
        const others = [...byAlias.values()].filter(other => other !== agent);
        assert.deepEqual(others.map(other => other.taskCalls.length), [0, 0], 'no other member is tried');
        assert.equal(session.failureReason(chosen.memberId!), undefined, 'not recorded as a failed attempt');
        // A failed result naming a capacity wait (an adapter that kept only the message) is not retried either.
        const second = service.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' });
        const next = await second.select();
        byAlias.get(next.physicalAgentAlias)!.taskResults.push({ success: false, error: "Timed out waiting for agent capacity: 'x' (limit 1) stayed at its ceiling", logs: '', modifiedFiles: [], modelUsed: '', executionTimeMs: 1 });
        const result = await second.executeTask({ worktreePath: '/tmp', issueRef: { number: 1, repoOwner: 'o', repoName: 'r' }, prompt: 'p' });
        assert.equal(result.success, false);
        assert.equal([...byAlias.values()].reduce((sum, other) => sum + other.taskCalls.length, 0), 2);
    });

    test('a job context pins the pre-check member for the synthetic agent facade, once', async () => {
        const db = await database();
        const { service, byAlias } = router(db, new Set());
        const facade = new SyntheticAgent(pool(), service);
        const options = { worktreePath: '/tmp', issueRef: { number: 1, repoOwner: 'o', repoName: 'r' }, prompt: 'p', model: 'smart' };
        await runWithAgentCapacityContext({ pins: agentCapacityPins([{ requestedAlias: 'pool', requestedModel: 'smart', directAlias: 'beta', memberId: MEMBER_B }]) }, async () => {
            await facade.executeTask(options);
            assert.equal(byAlias.get('beta')!.taskCalls.length, 1, 'the pinned member runs');
            assert.equal(await cursor(db), 0, 'no selection of its own');
            await facade.executeTask(options);
            assert.equal(await cursor(db), 1, 'a later call in the same job selects normally');
        });
    });
});
