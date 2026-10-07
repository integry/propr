import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import type { JobsOptions } from 'bullmq';
import type { SyntheticAgentConfig } from '@propr/shared';
import type { AgentConfig } from '../packages/core/src/config/configManagerAgents.ts';
import type { RepoToMonitor } from '../packages/core/src/config/configManager.ts';
import type { AgentRunJobData } from '../packages/core/src/queue/taskQueue.types.ts';
import { createAgentDefinition, type CreateAgentDefinitionInput, type StoredAgentDefinition } from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import { listAgentRuns } from '../packages/core/src/services/agents/agentRunStore.ts';
import {
  AgentRunTriggerError,
  enqueueAgentRunPhase,
  triggerAgentRun,
  validateAgentDefinitionRuntime,
  type AgentRunTriggerDependencies,
} from '../packages/core/src/services/agents/agentRunTrigger.ts';

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const NOW = Date.UTC(2026, 9, 6, 14, 30);

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

async function openDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.raw('PRAGMA foreign_keys = ON');
  await database.migrate.latest({ directory: migrations });
  return database;
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-claude', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'propr/agent', configPath: '~/.claude',
    supportedModels: ['opus', 'sonnet'], defaultModel: 'opus', ...overrides,
  };
}

function repo(name: string, enabled = true): RepoToMonitor {
  return { id: `id-${name}`, name, enabled } as RepoToMonitor;
}

interface EnqueuedJob { name: string; data: AgentRunJobData; options: JobsOptions }

/** BullMQ-like fake: a job id that was already added is ignored. */
function fakeQueue() {
  const jobs: EnqueuedJob[] = [];
  const calls: EnqueuedJob[] = [];
  const enqueue = async (name: string, data: AgentRunJobData, options: JobsOptions) => {
    calls.push({ name, data, options });
    if (!jobs.some(job => job.options.jobId === options.jobId)) jobs.push({ name, data, options });
  };
  return { jobs, calls, enqueue };
}

describe('triggerAgentRun', () => {
  let database: Knex;
  let queue: ReturnType<typeof fakeQueue>;
  let repos: RepoToMonitor[];
  let agents: AgentConfig[];
  let synthetic: SyntheticAgentConfig[];
  const deps = (overrides: Partial<AgentRunTriggerDependencies> = {}): AgentRunTriggerDependencies => ({
    database, now: () => NOW, enqueue: queue.enqueue,
    loadRepos: async () => repos, loadAgents: async () => agents, loadSyntheticAgents: async () => synthetic,
    // The default cost gate sees no usage, so unattended runs proceed.
    costGate: { loadThreshold: async () => 90, evaluateCapacity: async () => ({ status: 'unknown', provider: 'claude' }) },
    ...overrides,
  });
  const define = (overrides: Partial<CreateAgentDefinitionInput> = {}): Promise<StoredAgentDefinition> =>
    createAgentDefinition({ ownerId: 'alice', name: 'Triage', prompt: 'Summarize', repositories: ['acme/app'],
      agentAlias: 'claude', modelName: 'opus', ...overrides }, { database, now: () => NOW });

  beforeEach(async () => {
    database = await openDatabase();
    queue = fakeQueue();
    repos = [repo('acme/app'), repo('acme/lib')];
    agents = [agent(), agent({ id: 'agent-ag', type: 'antigravity', alias: 'gemini', supportedModels: ['pro'] })];
    synthetic = [];
  });
  afterEach(async () => { await database.destroy(); });

  test('creates a queued run and enqueues the report phase once', async () => {
    const definition = await define();
    const result = await triggerAgentRun({ definition, trigger: 'manual', triggerSource: 'alice' }, deps());
    assert.equal(result.created, true);
    assert.equal(result.enqueued, true);
    assert.equal(result.run.state, 'queued');
    assert.equal(queue.calls.length, 1);
    const [job] = queue.calls;
    assert.equal(job.name, 'processAgentRun');
    assert.equal(job.options.jobId, `agent-run-${result.run.id}-report`);
    assert.equal(job.options.attempts, 3);
    assert.deepEqual({ ...job.data, correlationId: undefined }, {
      runId: result.run.id, definitionId: definition.id, ownerId: 'alice', phase: 'report', correlationId: undefined,
    });
    assert.ok(job.data.correlationId);
  });

  test('triggering twice with one idempotency key enqueues exactly one job', async () => {
    const definition = await define();
    const first = await triggerAgentRun({ definition, trigger: 'api', idempotencyKey: 'key-1' }, deps());
    const second = await triggerAgentRun({ definition, trigger: 'api', idempotencyKey: 'key-1' }, deps());
    assert.equal(second.run.id, first.run.id);
    assert.equal(second.created, false);
    assert.equal(second.enqueued, false);
    assert.equal(queue.calls.length, 1);
    assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).total, 1);
  });

  test('a replay does not consult the gate again', async () => {
    const definition = await define();
    let gateCalls = 0;
    const gate = () => { gateCalls += 1; return { action: 'proceed' as const }; };
    await triggerAgentRun({ definition, trigger: 'schedule', idempotencyKey: 'slot', gate }, deps());
    await triggerAgentRun({ definition, trigger: 'schedule', idempotencyKey: 'slot', gate }, deps());
    assert.equal(gateCalls, 1);
  });

  test('without a gate input, an unattended run is admitted through the cost gate', async () => {
    const definition = await define();
    const weekly = { costGate: { loadThreshold: async () => 90,
      evaluateCapacity: async () => ({ status: 'near_limit' as const, provider: 'claude', weeklyPercent: 95 }) } };
    const result = await triggerAgentRun({ definition, trigger: 'api' }, deps(weekly));
    assert.equal(result.run.state, 'skipped');
    assert.match(result.run.skipReason ?? '', /^Weekly subscription usage for claude is at 95% \(pause threshold 90%\)/);
    assert.equal(result.enqueued, false);
    assert.equal(queue.calls.length, 0);

    // A manual run is attended and still proceeds through the same default gate.
    const manual = await triggerAgentRun({ definition, trigger: 'manual' }, deps(weekly));
    assert.equal(manual.run.state, 'queued');
    assert.equal(queue.calls.length, 1);
  });

  test('a disabled definition is rejected with AGENT_DISABLED and creates no run', async () => {
    const definition = await define({ enabled: false });
    await assert.rejects(triggerAgentRun({ definition, trigger: 'manual' }, deps()), (error: unknown) => {
      assert.ok(error instanceof AgentRunTriggerError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'AGENT_DISABLED');
      return true;
    });
    assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).total, 0);
    assert.equal(queue.calls.length, 0);
  });

  test('a definition whose repository was disabled fails with AGENT_INVALID and creates no run', async () => {
    const definition = await define({ repositories: ['acme/app', 'acme/lib'] });
    repos = [repo('acme/app'), repo('acme/lib', false)];
    await assert.rejects(triggerAgentRun({ definition, trigger: 'schedule' }, deps()), (error: unknown) => {
      assert.ok(error instanceof AgentRunTriggerError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'AGENT_INVALID');
      assert.match(error.message, /acme\/lib/);
      return true;
    });
    assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).total, 0);
    assert.equal(queue.calls.length, 0);
  });

  test('a default-agent definition needing propr_mcp is rejected when the default lacks it and creates no run', async () => {
    const definition = await define({ agentAlias: null, modelName: null, autonomyMode: 'auto' });
    await assert.rejects(
      triggerAgentRun({ definition, trigger: 'manual' }, deps({ loadDefaultAgentAlias: async () => 'gemini' })),
      (error: unknown) => error instanceof AgentRunTriggerError && error.code === 'AGENT_INVALID' && error.status === 400,
    );
    assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).total, 0);
    assert.equal(queue.calls.length, 0);
  });

  test('a gate returning defer creates a deferred run and enqueues nothing', async () => {
    const definition = await define();
    const until = NOW + 60_000;
    const result = await triggerAgentRun({ definition, trigger: 'schedule',
      gate: async () => ({ action: 'defer', until, reason: 'Spend cap reached' }) }, deps());
    assert.equal(result.created, true);
    assert.equal(result.enqueued, false);
    assert.equal(result.run.state, 'deferred');
    assert.equal(result.run.deferredUntil, until);
    assert.equal(queue.calls.length, 0);
  });

  test('a gate returning skip creates a skipped run with its reason and enqueues nothing', async () => {
    const definition = await define();
    const result = await triggerAgentRun({ definition, trigger: 'schedule',
      gate: () => ({ action: 'skip', reason: 'Budget exhausted' }) }, deps());
    assert.equal(result.run.state, 'skipped');
    assert.equal(result.run.skipReason, 'Budget exhausted');
    assert.equal(result.enqueued, false);
    assert.equal(queue.calls.length, 0);
  });

  test('an enqueue failure leaves the run failed with a queue failure reason and rethrows', async () => {
    const definition = await define();
    const failure = new Error('Redis connection refused');
    await assert.rejects(
      triggerAgentRun({ definition, trigger: 'manual' }, deps({ enqueue: async () => { throw failure; } })),
      failure,
    );
    const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, 'failed');
    assert.match(runs[0].failureReason ?? '', /queue/);
    assert.match(runs[0].failureReason ?? '', /Redis connection refused/);
    assert.ok(runs[0].finishedAt);
  });

  test('with keepQueuedOnEnqueueFailure an enqueue failure leaves the run queued and rethrows', async () => {
    const definition = await define();
    const failure = new Error('Redis connection refused');
    await assert.rejects(
      triggerAgentRun({ definition, trigger: 'schedule', idempotencyKey: 'schedule:slot', keepQueuedOnEnqueueFailure: true },
        deps({ enqueue: async () => { throw failure; } })),
      failure,
    );
    const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, 'queued');
    assert.equal(runs[0].failureReason, null);
  });
});

describe('enqueueAgentRunPhase', () => {
  test('uses deterministic job ids per phase so double enqueues are deduplicated', async () => {
    const queue = fakeQueue();
    const run = { id: 'run-1', definitionId: 'def-1', ownerId: 'alice' };
    assert.equal(await enqueueAgentRunPhase(run, 'action', queue), 'agent-run-run-1-action');
    await enqueueAgentRunPhase(run, 'action', queue);
    await enqueueAgentRunPhase(run, 'report', queue);
    assert.deepEqual(queue.jobs.map(job => [job.name, job.options.jobId, job.data.phase]), [
      ['processAgentAction', 'agent-run-run-1-action', 'action'],
      ['processAgentRun', 'agent-run-run-1-report', 'report'],
    ]);
  });
});

describe('validateAgentDefinitionRuntime', () => {
  const base: StoredAgentDefinition = {
    id: 'def-1', ownerId: 'alice', name: 'Triage', description: null, repositories: ['Acme/App'], prompt: 'Summarize',
    attachments: [], agentAlias: 'claude', modelName: 'opus', capabilities: ['repository_read'], includePreviousReports: false,
    previousReportsLimit: 0, scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
    autonomyMode: 'dry_run', enabled: true, revision: 1, createdAt: NOW, updatedAt: NOW,
  };
  const syntheticAgent: SyntheticAgentConfig = {
    id: '00000000-0000-4000-8000-000000000001', alias: 'pool', enabled: true, defaultModel: 'mixed',
    models: [{ id: 'mixed', enabled: true, strategy: 'round_robin', members: [
      { id: '00000000-0000-4000-8000-000000000002', directAgentAlias: 'claude', model: 'opus', enabled: true, priority: 100 },
      { id: '00000000-0000-4000-8000-000000000003', directAgentAlias: 'gemini', model: 'pro', enabled: true, priority: 100 },
    ] }, { id: 'claude-only', enabled: true, strategy: 'round_robin', members: [
      { id: '00000000-0000-4000-8000-000000000004', directAgentAlias: 'claude', model: 'opus', enabled: true, priority: 100 },
    ] }],
  };
  const deps: AgentRunTriggerDependencies = {
    loadRepos: async () => [repo('acme/app'), repo('acme/off', false)],
    loadAgents: async () => [agent(), agent({ id: 'agent-ag', type: 'antigravity', alias: 'gemini', supportedModels: ['pro'] }),
      agent({ id: 'agent-off', alias: 'off', enabled: false })],
    loadSyntheticAgents: async () => [syntheticAgent],
  };
  const check = (overrides: Partial<StoredAgentDefinition>) => validateAgentDefinitionRuntime({ ...base, ...overrides }, deps);

  test('accepts enabled repositories case-insensitively with a supported agent and model', async () => {
    assert.equal(await check({}), null);
    assert.equal(await check({ modelName: null }), null);
    assert.equal(await check({ agentAlias: null, modelName: null }), null);
  });

  test('rejects missing or disabled repositories', async () => {
    assert.match(await check({ repositories: ['acme/off'] }) ?? '', /acme\/off/);
    assert.match(await check({ repositories: ['acme/unknown'] }) ?? '', /acme\/unknown/);
  });

  test('rejects disabled agents, unsupported models and a model without an agent', async () => {
    assert.ok(await check({ agentAlias: 'off' }));
    assert.ok(await check({ modelName: 'gpt' }));
    assert.ok(await check({ agentAlias: 'missing' }));
    assert.ok(await check({ agentAlias: null }));
  });

  test('accepts enabled synthetic agents and models', async () => {
    assert.equal(await check({ agentAlias: 'pool', modelName: 'mixed' }), null);
    assert.equal(await check({ agentAlias: 'pool', modelName: null }), null);
    assert.ok(await check({ agentAlias: 'pool', modelName: 'missing' }));
  });

  test('allows propr_mcp only for supported agent types, including the acting step', async () => {
    assert.equal(await check({ capabilities: ['propr_mcp'] }), null);
    assert.equal(await check({ autonomyMode: 'auto' }), null);
    assert.match(await check({ agentAlias: 'gemini', modelName: 'pro', capabilities: ['propr_mcp'] }) ?? '', /propr_mcp/);
    assert.match(await check({ agentAlias: 'gemini', modelName: 'pro', autonomyMode: 'preview' }) ?? '', /propr_mcp/);
    assert.equal(await check({ agentAlias: 'gemini', modelName: 'pro' }), null);
    assert.match(await check({ agentAlias: 'pool', modelName: 'mixed', capabilities: ['propr_mcp'] }) ?? '', /propr_mcp/);
    assert.equal(await check({ agentAlias: 'pool', modelName: 'claude-only', capabilities: ['propr_mcp'] }), null);
  });

  test('validates the default agent when propr_mcp is needed without an agent', async () => {
    const withDefault = (agents: AgentConfig[], alias: string | null) => (overrides: Partial<StoredAgentDefinition>) =>
      validateAgentDefinitionRuntime({ ...base, agentAlias: null, modelName: null, ...overrides },
        { ...deps, loadAgents: async () => agents, loadDefaultAgentAlias: async () => alias });
    const gemini = agent({ id: 'agent-ag', type: 'antigravity', alias: 'gemini', supportedModels: ['pro'] });

    const geminiDefault = withDefault([agent(), gemini], 'gemini');
    assert.match(await geminiDefault({ capabilities: ['propr_mcp'] }) ?? '', /default agent does not support propr_mcp/);
    assert.match(await geminiDefault({ autonomyMode: 'auto' }) ?? '', /propr_mcp/);
    assert.match(await geminiDefault({ autonomyMode: 'preview' }) ?? '', /propr_mcp/);
    assert.equal(await geminiDefault({}), null);

    assert.equal(await withDefault([agent(), gemini], 'claude')({ autonomyMode: 'auto' }), null);
    // The `default` alias is the fallback, and a disabled configured default is skipped like in the registry.
    assert.match(await withDefault([agent(), agent({ id: 'd', type: 'antigravity', alias: 'default' })], null)(
      { capabilities: ['propr_mcp'] }) ?? '', /propr_mcp/);
    assert.equal(await withDefault([agent({ alias: 'default' }), agent({ id: 'g', type: 'antigravity', alias: 'gemini',
      enabled: false })], 'gemini')({ capabilities: ['propr_mcp'] }), null);
    assert.match(await withDefault([agent(), gemini], null)({ capabilities: ['propr_mcp'] }) ?? '', /No default agent/);
    // With no agents configured the registry falls back to an environment Claude agent.
    assert.equal(await withDefault([], null)({ capabilities: ['propr_mcp'] }), null);
  });

  test('ignores synthetic members whose physical agent is disabled', async () => {
    const withAgents = (agents: AgentConfig[]) => validateAgentDefinitionRuntime(
      { ...base, agentAlias: 'pool', modelName: 'mixed', capabilities: ['propr_mcp'] }, { ...deps, loadAgents: async () => agents });
    assert.equal(await withAgents([agent(),
      agent({ id: 'agent-ag', type: 'antigravity', alias: 'gemini', supportedModels: ['pro'], enabled: false })]), null);
    assert.match(await withAgents([agent({ enabled: false }),
      agent({ id: 'agent-ag', type: 'antigravity', alias: 'gemini', supportedModels: ['pro'], enabled: false })]) ?? '', /propr_mcp/);
  });
});

