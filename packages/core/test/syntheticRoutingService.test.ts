import assert from 'node:assert/strict';
import { after, afterEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { SyntheticAgentConfig } from '@propr/shared';
import {
  SyntheticPoolExhaustedError,
  SyntheticRoutingService,
  type SyntheticUsageSnapshotProvider,
} from '../src/services/syntheticRoutingService.js';
import type {
  Agent,
  AgentConfig,
  AgentExecutionResult,
  AgentTaskOptions,
  AnalysisResult,
  AnalyzeOptions,
} from '../src/agents/types.js';
import { db as globalDatabase } from '../src/db/connection.js';
import { up as createSyntheticRoutingCursors } from '../src/db/migrations/20260830000000_create_synthetic_routing_cursors.js';

const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_B = '22222222-2222-4222-8222-222222222222';

class FakeAgent implements Agent {
  analyzeCalls: AnalyzeOptions[] = [];
  taskCalls: AgentTaskOptions[] = [];
  analysisResults: Array<AnalysisResult | Error> = [];
  taskResults: Array<AgentExecutionResult | Error> = [];

  constructor(readonly config: AgentConfig) {}

  async analyze(_prompt: string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
    this.analyzeCalls.push(options);
    const next = this.analysisResults.shift();
    if (next instanceof Error) throw next;
    return next ?? { response: this.config.alias, modelUsed: options.model || '', executionTimeMs: 1, success: true };
  }

  async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
    this.taskCalls.push(options);
    await options.onContainerId?.(`${this.config.alias}-container-${this.taskCalls.length}`, `${this.config.alias}-run-${this.taskCalls.length}`);
    const next = this.taskResults.shift();
    if (next instanceof Error) throw next;
    return next ?? { success: true, logs: '', modifiedFiles: [], modelUsed: options.model || '', executionTimeMs: 1 };
  }

  async healthCheck(): Promise<boolean> { return true; }
}

function direct(alias: string, model: string): FakeAgent {
  return new FakeAgent({
    id: alias, alias, type: model.startsWith('gpt') ? 'codex' : 'claude', enabled: true,
    dockerImage: 'test', configPath: 'test', supportedModels: [model], defaultModel: model,
  });
}

function config(options: {
  strategy?: 'round_robin' | 'usage_based';
  priorityA?: number;
  priorityB?: number;
  usageA?: { sessionMaxPercent?: number; weeklyMaxPercent?: number };
  usageB?: { sessionMaxPercent?: number; weeklyMaxPercent?: number };
} = {}): SyntheticAgentConfig {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', alias: 'pool', enabled: true, defaultModel: 'smart',
    models: [{
      id: 'smart', enabled: true, strategy: options.strategy ?? 'round_robin',
      members: [
        { id: MEMBER_A, directAgentAlias: 'large', model: 'claude-opus-4-6', enabled: true, priority: options.priorityA ?? 100, usageLimits: options.usageA },
        { id: MEMBER_B, directAgentAlias: 'small', model: 'gpt-5-mini', enabled: true, priority: options.priorityB ?? 0, usageLimits: options.usageB },
      ],
    }],
  };
}

let databases: Knex[] = [];

async function database(): Promise<Knex> {
  const value = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createSyntheticRoutingCursors(value);
  await value.schema.createTable('tasks', table => table.string('task_id').primary());
  await value.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.string('task_id').notNullable();
    table.string('state').notNullable();
    table.timestamp('timestamp');
    table.text('reason');
    table.json('metadata');
  });
  databases.push(value);
  return value;
}

function service(
  database: Knex,
  synthetic: SyntheticAgentConfig,
  agents: FakeAgent[],
  usageSnapshotProvider?: SyntheticUsageSnapshotProvider,
): SyntheticRoutingService {
  const byAlias = new Map(agents.map(agent => [agent.config.alias, agent]));
  return new SyntheticRoutingService({
    database,
    loadSyntheticConfigs: async () => [synthetic],
    getDirectAgent: alias => byAlias.get(alias),
    usageSnapshotProvider: usageSnapshotProvider ?? { getSnapshot: async () => null },
  });
}

afterEach(async () => {
  await Promise.all(databases.map(value => value.destroy()));
  databases = [];
});

after(async () => {
  await globalDatabase.destroy();
});

describe('SyntheticRoutingService', () => {
  test('passes direct-agent requests through unchanged', async () => {
    const db = await database();
    const large = direct('large', 'claude-opus-4-6');
    const router = service(db, config(), [large]);
    const session = router.begin({ requestedAgentAlias: 'large', requestedModel: 'claude-opus-4-6' });
    const selection = await session.select();
    assert.equal(selection.synthetic, false);
    assert.equal(selection.physicalAgent, large);
    const result = await session.analyze('hello');
    assert.equal(result.response, 'large');
    assert.equal(large.analyzeCalls[0].metadata?.syntheticRouting, undefined);
  });

  test('uses only the highest eligible priority and falls back when it is context-ineligible', async () => {
    const db = await database();
    const large = direct('large', 'claude-opus-4-6');
    const small = direct('small', 'gpt-5-mini');
    const router = service(db, config(), [large, small]);

    const preferred = await router.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart', requiredTokens: 100_000 }).select();
    assert.equal(preferred.memberId, MEMBER_A);

    const fallbackConfig = config({ priorityA: 0, priorityB: 100 });
    const fallbackRouter = service(db, fallbackConfig, [large, small]);
    const fallback = await fallbackRouter.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart', requiredTokens: 300_000 }).select();
    assert.equal(fallback.memberId, MEMBER_A);
    assert.match(fallback.diagnostics.find(item => item.memberId === MEMBER_B)?.reason || '', /context window/);
  });

  test('round robin cursor persists across service instances', async () => {
    const db = await database();
    const agents = [direct('large', 'claude-opus-4-6'), direct('small', 'gpt-5-mini')];
    const pool = config({ priorityB: 100 });

    const first = await service(db, pool, agents).begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' }).select();
    const second = await service(db, pool, agents).begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' }).select();
    const third = await service(db, pool, agents).begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' }).select();

    assert.deepEqual([first.memberId, second.memberId, third.memberId], [MEMBER_A, MEMBER_B, MEMBER_A]);
  });

  test('usage based selection rejects unknown capped aliases and picks greatest normalized headroom', async () => {
    const db = await database();
    const agents = [direct('large', 'claude-opus-4-6'), direct('small', 'gpt-5-mini')];
    const pool = config({ strategy: 'usage_based', priorityB: 100, usageA: { weeklyMaxPercent: 80 }, usageB: { weeklyMaxPercent: 80 } });
    const usage: SyntheticUsageSnapshotProvider = {
      getSnapshot: async alias => alias === 'large'
        ? { directAgentAlias: alias, capturedAt: new Date(), weeklyPercent: 70 }
        : { directAgentAlias: alias, capturedAt: new Date(), weeklyPercent: 20 },
    };
    const chosen = await service(db, pool, agents, usage).begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' }).select();
    assert.equal(chosen.memberId, MEMBER_B);

    const unknown = service(db, pool, agents, { getSnapshot: async () => null });
    await assert.rejects(
      () => unknown.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' }).select(),
      (error: unknown) => error instanceof SyntheticPoolExhaustedError && /alias-specific usage data unavailable/.test(error.message),
    );
  });

  test('failed analysis member is attempted once and routing metadata is attached to each attempt', async () => {
    const db = await database();
    const large = direct('large', 'claude-opus-4-6');
    const small = direct('small', 'gpt-5-mini');
    large.analysisResults.push({ response: '', modelUsed: 'claude-opus-4-6', executionTimeMs: 1, success: false, error: 'provider unavailable' });
    const router = service(db, config({ priorityB: 100 }), [large, small]);

    const session = router.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' });
    const result = await session.analyze('hello');
    assert.equal(result.response, 'small');
    assert.equal(large.analyzeCalls.length, 1);
    assert.equal(small.analyzeCalls.length, 1);
    const firstMetadata = large.analyzeCalls[0].metadata?.syntheticRouting as Record<string, unknown>;
    const secondMetadata = small.analyzeCalls[0].metadata?.syntheticRouting as Record<string, unknown>;
    assert.equal(firstMetadata.virtualAgentAlias, 'pool');
    assert.equal(firstMetadata.attemptNumber, 1);
    assert.equal(secondMetadata.attemptNumber, 2);
    assert.equal(firstMetadata.callId, secondMetadata.callId);
    assert.deepEqual(session.routingMetadata, secondMetadata);
  });

  test('applies call-scoped physical eligibility to initial selection and every retry', async () => {
    const db = await database();
    const large = direct('large', 'claude-opus-4-6');
    const small = direct('small', 'gpt-5-mini');
    large.analysisResults.push({ response: '', modelUsed: 'claude-opus-4-6', executionTimeMs: 1, success: false, error: 'provider unavailable' });
    const router = service(db, config({ priorityB: 100 }), [large, small]);
    const session = router.begin({
      requestedAgentAlias: 'pool',
      requestedModel: 'smart',
      physicalAgentEligibility: agent => agent.config.alias === 'large',
    });

    const first = await session.select();
    assert.equal(first.physicalAgentAlias, 'large');
    await assert.rejects(
      () => session.analyze('hello'),
      (error: unknown) => error instanceof SyntheticPoolExhaustedError
        && /physical agent is ineligible for this routing session/.test(error.message),
    );
    assert.equal(large.analyzeCalls.length, 1);
    assert.equal(small.analyzeCalls.length, 0);
  });

  test('explicit cancellation is not retried', async () => {
    const db = await database();
    const large = direct('large', 'claude-opus-4-6');
    const small = direct('small', 'gpt-5-mini');
    large.analysisResults.push({ response: '', modelUsed: 'claude-opus-4-6', executionTimeMs: 1, success: false, error: 'Execution aborted by user request' });
    const result = await service(db, config({ priorityB: 100 }), [large, small])
      .begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' }).analyze('hello');
    assert.equal(result.success, false);
    assert.equal(small.analyzeCalls.length, 0);
  });

  test('transport abort fails over to the next eligible member', async () => {
    const db = await database();
    const large = direct('large', 'claude-opus-4-6');
    const small = direct('small', 'gpt-5-mini');
    large.analysisResults.push({ response: '', modelUsed: 'claude-opus-4-6', executionTimeMs: 1, success: false, error: 'upstream stream aborted; connection canceled while reading response' });

    const result = await service(db, config({ priorityB: 100 }), [large, small])
      .begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' }).analyze('hello');

    assert.equal(result.success, true);
    assert.equal(result.response, 'small');
    assert.equal(large.analyzeCalls.length, 1);
    assert.equal(small.analyzeCalls.length, 1);
  });

  test('structured implementation cancellation is not retried when error text is absent', async () => {
    const db = await database();
    const large = direct('large', 'claude-opus-4-6');
    const small = direct('small', 'gpt-5-mini');
    large.taskResults.push({
      success: false,
      logs: '',
      modifiedFiles: [],
      modelUsed: 'claude-opus-4-6',
      executionTimeMs: 1,
      terminationReason: 'cancelled' as never,
    });

    const result = await service(db, config({ priorityB: 100 }), [large, small])
      .begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' })
      .executeTask({
        worktreePath: '/tmp/worktree',
        issueRef: { number: 1, repoOwner: 'integry', repoName: 'propr' },
        prompt: 'implement it',
        model: 'smart',
        githubToken: 'test-token',
      });

    assert.equal(result.success, false);
    assert.equal(large.taskCalls.length, 1);
    assert.equal(small.taskCalls.length, 0);
  });

  test('implementation failover preserves virtual task identity and records each physical container', async () => {
    const db = await database();
    await db('tasks').insert({ task_id: 'task-1' });
    const large = direct('large', 'claude-opus-4-6');
    const small = direct('small', 'gpt-5-mini');
    large.taskResults.push({ success: false, error: 'runtime failed', logs: '', modifiedFiles: [], modelUsed: 'claude-opus-4-6', executionTimeMs: 1 });
    const router = service(db, config({ priorityB: 100 }), [large, small]);

    const result = await router.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart' }).executeTask({
      worktreePath: '/tmp/worktree',
      issueRef: { number: 1, repoOwner: 'integry', repoName: 'propr' },
      prompt: 'implement it',
      model: 'smart',
      githubToken: 'test-token',
      branchName: 'virtual-branch',
      taskId: 'task-1',
    });

    assert.equal(result.success, true);
    assert.equal(large.taskCalls.length, 1);
    assert.equal(small.taskCalls.length, 1);
    assert.equal(large.taskCalls[0].branchName, 'virtual-branch');
    assert.equal(small.taskCalls[0].branchName, 'virtual-branch');
    const history = await db('task_history').where({ task_id: 'task-1' }).orderBy('history_id');
    assert.equal(history.length, 2);
    const first = JSON.parse(history[0].metadata);
    const second = JSON.parse(history[1].metadata);
    assert.equal(first.syntheticRouting.physicalAgentAlias, 'large');
    assert.equal(first.containerId, 'large-container-1');
    assert.equal(second.syntheticRouting.physicalAgentAlias, 'small');
    assert.equal(second.containerId, 'small-container-1');
    assert.equal(first.syntheticRouting.callId, second.syntheticRouting.callId);
  });
});
