import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { parseUnattendedWindow, unattendedWindowState, type SyntheticAgentConfig } from '@propr/shared';
import type { AgentConfig } from '../packages/core/src/config/configManagerAgents.ts';
import type { RepoToMonitor } from '../packages/core/src/config/configManager.ts';
import type { SyntheticUsageSnapshot, SyntheticUsageSnapshotProvider } from '../packages/core/src/services/syntheticRoutingTypes.ts';
import { createAgentDefinition, type StoredAgentDefinition } from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import {
  countActiveUnattendedAgentRuns,
  createAgentRun,
  getAgentRunById,
  transitionAgentRun,
  transitionDeferredAgentRun,
  type StoredAgentRun,
} from '../packages/core/src/services/agents/agentRunStore.ts';
import { interpretUnattendedWindow } from '../packages/core/src/config/configManagerUnattended.ts';
import { retryDueDeferredAgentRuns } from '../packages/core/src/services/agents/agentRunDeferredRetry.ts';
import { triggerAgentRun, type AgentRunGate } from '../packages/core/src/services/agents/agentRunTrigger.ts';
import {
  createAgentRunCostGate,
  DEFAULT_AGENT_RUN_USAGE_PAUSE_PERCENT,
  type AgentRunCostGateOptions,
  evaluateProviderCapacity,
  loadUsagePauseThreshold,
  type ProviderCapacityDependencies,
} from '../packages/core/src/services/agents/agentRunCostGate.ts';

const { advanceAfterReport } = await import('../src/jobs/agentRuns/autonomy.ts');

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const NOW = Date.UTC(2026, 9, 6, 14, 30);
const MINUTE = 60_000;

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-claude', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'propr/agent', configPath: '~/.claude',
    supportedModels: ['opus'], defaultModel: 'opus', ...overrides,
  };
}

type Usage = Omit<SyntheticUsageSnapshot, 'directAgentAlias' | 'capturedAt'>;

/** Injected Agent Tank: aliases without usage have no snapshot (disabled, unreachable or stale). */
function snapshots(usage: Record<string, Usage>): SyntheticUsageSnapshotProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getSnapshot(alias) {
      calls.push(alias);
      return usage[alias] ? { directAgentAlias: alias, capturedAt: new Date(NOW - MINUTE), ...usage[alias] } : null;
    },
  };
}

function pool(members: Array<{ alias: string; enabled?: boolean }>): SyntheticAgentConfig {
  return {
    id: 'pool', alias: 'pool', enabled: true, defaultModel: 'opus',
    models: [{ id: 'opus', enabled: true, members: members.map((member, index) => ({
      id: `m${index}`, directAgentAlias: member.alias, model: 'opus', enabled: member.enabled ?? true,
    })) }],
  } as unknown as SyntheticAgentConfig;
}

const agents = [agent(), agent({ id: 'agent-claude-2', alias: 'claude-2' }), agent({ id: 'agent-codex', type: 'codex', alias: 'codex' })];

function capacityDeps(usage: Record<string, Usage>, overrides: ProviderCapacityDependencies = {}): ProviderCapacityDependencies {
  return {
    now: () => NOW, snapshotProvider: snapshots(usage),
    loadAgents: async () => agents, loadSyntheticAgents: async () => [pool([{ alias: 'claude' }, { alias: 'claude-2' }])],
    loadDefaultAgentAlias: async () => null,
    ...overrides,
  };
}

/** Unattended limits that never hold a run: no window and a free concurrency slot. */
const NO_UNATTENDED_LIMITS = {
  loadMaxConcurrent: async () => 1,
  loadWindow: async () => ({ configured: false as const }),
  countActiveUnattendedRuns: async () => 0,
};

function gateFor(usage: Record<string, Usage>, threshold = 90, limits: Partial<AgentRunCostGateOptions> = {}) {
  return createAgentRunCostGate({
    now: () => NOW,
    loadThreshold: async () => threshold,
    evaluateCapacity: (alias, limit, modelName) => evaluateProviderCapacity(alias, limit, { ...capacityDeps(usage), modelName }),
    ...NO_UNATTENDED_LIMITS,
    ...limits,
  });
}

function definition(overrides: Partial<StoredAgentDefinition> = {}): StoredAgentDefinition {
  return {
    id: 'def-1', ownerId: 'alice', name: 'Triage', description: null, repositories: [], prompt: 'Summarize', attachments: [],
    agentAlias: 'claude', modelName: 'opus', capabilities: [], includePreviousReports: false, previousReportsLimit: 0,
    scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
    autonomyMode: 'dry_run', enabled: true, revision: 1, createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function run(overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    id: 'run-1', definitionId: 'def-1', ownerId: 'alice', trigger: 'schedule', triggerSource: 'schedule',
    idempotencyKey: null, state: 'report_ready', autonomyMode: 'auto', definitionSnapshot: definition({ autonomyMode: 'auto' }),
    reportTaskId: 'agent-run-run-1-report', actionTaskId: null, report: 'Report', reportTruncated: false,
    actionSummary: null, skipReason: null, failureReason: null, approvedBy: null, operatorNote: null, deferredUntil: null, deferrals: 0,
    createdAt: NOW, startedAt: NOW, reportedAt: NOW, finishedAt: null, updatedAt: NOW, ...overrides,
  };
}

describe('loadUsagePauseThreshold', () => {
  test('reads the stored setting and falls back to the default for invalid values or read errors', async () => {
    const stored = (value: unknown) => ({ readConfig: (async () => value) as never });
    assert.equal(await loadUsagePauseThreshold(stored(75)), 75);
    assert.equal(await loadUsagePauseThreshold(stored(100)), 100);
    for (const value of [49, 101, 90.5, '80', null]) {
      assert.equal(await loadUsagePauseThreshold(stored(value)), DEFAULT_AGENT_RUN_USAGE_PAUSE_PERCENT, String(value));
    }
    assert.equal(await loadUsagePauseThreshold({ readConfig: async () => { throw new Error('db down'); } }), 90);
  });
});

describe('evaluateProviderCapacity', () => {
  test('reports a direct agent as ok, near_limit or unknown with its usage and session reset', async () => {
    const ok = await evaluateProviderCapacity('claude', 90, capacityDeps({ claude: { sessionPercent: 40, weeklyPercent: 20 } }));
    assert.deepEqual(ok, { status: 'ok', provider: 'claude', sessionPercent: 40, weeklyPercent: 20 });

    const near = await evaluateProviderCapacity('claude', 90,
      capacityDeps({ claude: { sessionPercent: 95, weeklyPercent: 20, sessionResetsAt: new Date(NOW + 10 * MINUTE) } }));
    assert.deepEqual(near, { status: 'near_limit', provider: 'claude', sessionPercent: 95, weeklyPercent: 20, resetsInMs: 10 * MINUTE });

    assert.deepEqual(await evaluateProviderCapacity('claude', 90, capacityDeps({})), { status: 'unknown', provider: 'claude' });
    assert.equal((await evaluateProviderCapacity('missing', 90, capacityDeps({}))).status, 'unknown');
  });

  test('resolves the default agent when the definition names none', async () => {
    const usage = { codex: { sessionPercent: 97 } };
    const capacity = await evaluateProviderCapacity(null, 90, capacityDeps(usage, { loadDefaultAgentAlias: async () => 'codex' }));
    assert.equal(capacity.status, 'near_limit');
    assert.equal(capacity.provider, 'codex');
  });

  test('a synthetic pool is near_limit only when every enabled member is', async () => {
    const oneFree = await evaluateProviderCapacity('pool', 90, capacityDeps({ claude: { sessionPercent: 95 }, 'claude-2': { sessionPercent: 30 } }));
    assert.equal(oneFree.status, 'ok');

    const allBusy = await evaluateProviderCapacity('pool', 90, capacityDeps({
      claude: { sessionPercent: 95, sessionResetsAt: new Date(NOW + 20 * MINUTE) },
      'claude-2': { sessionPercent: 92, sessionResetsAt: new Date(NOW + 5 * MINUTE) },
    }));
    assert.deepEqual(allBusy, { status: 'near_limit', provider: 'pool', sessionPercent: 92, resetsInMs: 5 * MINUTE });

    const weekly = await evaluateProviderCapacity('pool', 90, capacityDeps({ claude: { weeklyPercent: 95 }, 'claude-2': { weeklyPercent: 93 } }));
    assert.deepEqual(weekly, { status: 'near_limit', provider: 'pool', weeklyPercent: 93 });

    // A disabled member is never routed to, so it cannot keep the pool open.
    const disabledFree = await evaluateProviderCapacity('pool', 90, capacityDeps(
      { claude: { sessionPercent: 95 }, codex: { sessionPercent: 10 } },
      { loadSyntheticAgents: async () => [pool([{ alias: 'claude' }, { alias: 'codex', enabled: false }])] },
    ));
    assert.equal(disabledFree.status, 'near_limit');

    const unknownMember = await evaluateProviderCapacity('pool', 90, capacityDeps({ claude: { sessionPercent: 95 } }));
    assert.equal(unknownMember.status, 'unknown');
  });

  test('a pool with a weekly-limited and a session-limited member reports only the session-limited member', async () => {
    const usage = {
      claude: { weeklyPercent: 95 },
      'claude-2': { sessionPercent: 95, sessionResetsAt: new Date(NOW + 5 * MINUTE) },
    };
    const missingWeekly = await evaluateProviderCapacity('pool', 90, capacityDeps(usage));
    assert.deepEqual(missingWeekly, { status: 'near_limit', provider: 'pool', sessionPercent: 95, resetsInMs: 5 * MINUTE });

    const lowWeekly = await evaluateProviderCapacity('pool', 90, capacityDeps({
      claude: { sessionPercent: 10, weeklyPercent: 97 },
      'claude-2': { sessionPercent: 95, weeklyPercent: 40, sessionResetsAt: new Date(NOW + 5 * MINUTE) },
    }));
    assert.deepEqual(lowWeekly, { status: 'near_limit', provider: 'pool', sessionPercent: 95, weeklyPercent: 40, resetsInMs: 5 * MINUTE });
  });

  test('a failing snapshot provider or configuration read is unknown, never an error', async () => {
    const failing = { getSnapshot: async () => { throw new Error('Agent Tank unreachable'); } };
    assert.equal((await evaluateProviderCapacity('claude', 90, capacityDeps({}, { snapshotProvider: failing }))).status, 'unknown');
    assert.equal((await evaluateProviderCapacity('claude', 90, capacityDeps({}, { loadAgents: async () => { throw new Error('db'); } }))).status, 'unknown');
  });
});

describe('createAgentRunCostGate', () => {
  const context = (trigger: StoredAgentRun['trigger'], existing?: StoredAgentRun) =>
    ({ definition: definition(), trigger, triggerSource: null, run: existing });

  test('a manual run proceeds even at 99% without reading usage', async () => {
    const provider = snapshots({ claude: { sessionPercent: 99, weeklyPercent: 99 } });
    const gate = createAgentRunCostGate({
      loadThreshold: async () => 90,
      evaluateCapacity: (alias, limit) => evaluateProviderCapacity(alias, limit, capacityDeps({}, { snapshotProvider: provider })),
    });
    assert.deepEqual(await gate(context('manual')), { action: 'proceed' });
    assert.deepEqual(provider.calls, []);
  });

  test('unknown capacity (Agent Tank disabled) proceeds', async () => {
    for (const trigger of ['schedule', 'api', 'mcp', 'cli'] as const) {
      assert.deepEqual(await gateFor({})(context(trigger)), { action: 'proceed' });
    }
  });

  test('usage under the threshold proceeds', async () => {
    assert.deepEqual(await gateFor({ claude: { sessionPercent: 89, weeklyPercent: 89 } })(context('schedule')), { action: 'proceed' });
  });

  test('weekly usage at or over the threshold skips with a full sentence', async () => {
    const decision = await gateFor({ claude: { sessionPercent: 10, weeklyPercent: 93 } })(context('schedule'));
    assert.equal(decision?.action, 'skip');
    assert.match((decision as { reason: string }).reason, /^Weekly subscription usage for claude is at 93% \(pause threshold 90%\).*\.$/);
  });

  test('session usage defers until shortly after the reset, at most one defer step', async () => {
    const soon = await gateFor({ claude: { sessionPercent: 95, sessionResetsAt: new Date(NOW + 10 * MINUTE) } })(context('api'));
    assert.equal(soon?.action, 'defer');
    assert.equal((soon as { until: number }).until, NOW + 12 * MINUTE);
    assert.match((soon as { reason: string }).reason,
      /^Session subscription usage for claude is at 95% \(pause threshold 90%\), so the run was deferred until 2026-10-06 14:42 UTC\.$/);

    const later = await gateFor({ claude: { sessionPercent: 95, sessionResetsAt: new Date(NOW + 3 * 60 * MINUTE) } })(context('api'));
    assert.equal((later as { until: number }).until, NOW + 30 * MINUTE);

    const noReset = await gateFor({ claude: { sessionPercent: 95 } })(context('api'));
    assert.equal((noReset as { until: number }).until, NOW + 30 * MINUTE);
  });

  test('a pool with one weekly-limited and one session-limited member defers instead of skipping', async () => {
    const gate = gateFor({
      claude: { weeklyPercent: 95 },
      'claude-2': { sessionPercent: 95, sessionResetsAt: new Date(NOW + 5 * MINUTE) },
    });
    const decision = await gate({ definition: definition({ agentAlias: 'pool' }), trigger: 'schedule', triggerSource: null, run: undefined });
    assert.equal(decision?.action, 'defer');
    assert.equal((decision as { until: number }).until, NOW + 7 * MINUTE);
    assert.match((decision as { reason: string }).reason, /^Session subscription usage for pool is at 95% \(pause threshold 90%\)/);
  });

  test('after 6 deferrals the 7th evaluation skips', async () => {
    const gate = gateFor({ claude: { sessionPercent: 95 } });
    for (let deferrals = 0; deferrals < 6; deferrals += 1) {
      assert.equal((await gate(context('schedule', run({ state: 'deferred', deferrals }))))?.action, 'defer', `deferral ${deferrals + 1}`);
    }
    const seventh = await gate(context('schedule', run({ state: 'deferred', deferrals: 6 })));
    assert.equal(seventh?.action, 'skip');
    assert.match((seventh as { reason: string }).reason, /already deferred 6 times, so it was skipped\.$/);
  });

  test('the threshold comes from the setting', async () => {
    assert.equal((await gateFor({ claude: { sessionPercent: 95 } }, 96)(context('schedule')))?.action, 'proceed');
    assert.equal((await gateFor({ claude: { sessionPercent: 60 } }, 50)(context('schedule')))?.action, 'defer');
  });
});

describe('triggerAgentRun with the cost gate', () => {
  let database: Knex;
  let enqueued: string[];
  let stored: StoredAgentDefinition;
  const deps = () => ({
    database, now: () => NOW,
    enqueue: async (_name: string, data: { runId: string }) => { enqueued.push(data.runId); },
    loadRepos: async () => [] as RepoToMonitor[], loadAgents: async () => agents, loadSyntheticAgents: async () => [],
  });

  beforeEach(async () => {
    database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await database.raw('PRAGMA foreign_keys = ON');
    await database.migrate.latest({ directory: migrations });
    enqueued = [];
    stored = await createAgentDefinition({ ownerId: 'alice', name: 'Triage', prompt: 'Summarize', repositories: [],
      agentAlias: 'claude', modelName: 'opus' }, { database, now: () => NOW });
  });

  afterEach(async () => {
    await database.destroy();
  });

  test('a scheduled run with the session at 95% is recorded deferred with a reason and not enqueued', async () => {
    const gate = gateFor({ claude: { sessionPercent: 95, sessionResetsAt: new Date(NOW + 10 * MINUTE) } });
    const result = await triggerAgentRun({ definition: stored, trigger: 'schedule', gate }, deps());
    assert.equal(result.run.state, 'deferred');
    assert.equal(result.run.deferredUntil, NOW + 12 * MINUTE);
    assert.match(result.run.skipReason ?? '', /^Session subscription usage for claude is at 95%/);
    assert.equal(result.enqueued, false);
    assert.deepEqual(enqueued, []);
  });

  test('a scheduled run with weekly usage at 95% is recorded skipped', async () => {
    const result = await triggerAgentRun({ definition: stored, trigger: 'schedule', gate: gateFor({ claude: { weeklyPercent: 95 } }) }, deps());
    assert.equal(result.run.state, 'skipped');
    assert.match(result.run.skipReason ?? '', /^Weekly subscription usage for claude is at 95% \(pause threshold 90%\)/);
    assert.deepEqual(enqueued, []);
  });

  test('a manual run at 99% is queued and enqueued', async () => {
    const result = await triggerAgentRun({ definition: stored, trigger: 'manual', gate: gateFor({ claude: { sessionPercent: 99, weeklyPercent: 99 } }) }, deps());
    assert.equal(result.run.state, 'queued');
    assert.deepEqual(enqueued, [result.run.id]);
  });

  test('with Agent Tank disabled a scheduled run proceeds', async () => {
    const result = await triggerAgentRun({ definition: stored, trigger: 'schedule', gate: gateFor({}) }, deps());
    assert.equal(result.run.state, 'queued');
    assert.deepEqual(enqueued, [result.run.id]);
  });
});

describe('deferred run retry consumer', () => {
  let database: Knex;
  let enqueued: string[];
  let stored: StoredAgentDefinition;
  let clock: number;
  let usage: Record<string, Usage>;
  const now = () => clock;
  const gate = () => createAgentRunCostGate({
    now, database, loadThreshold: async () => 90,
    evaluateCapacity: (alias, limit, modelName) => evaluateProviderCapacity(alias, limit, { ...capacityDeps(usage), now, modelName }),
  });
  const enqueue = async (_name: string, data: { runId: string }) => { enqueued.push(data.runId); };
  const triggerDeps = () => ({ database, now, enqueue, loadRepos: async () => [] as RepoToMonitor[], loadAgents: async () => agents, loadSyntheticAgents: async () => [] });
  const retry = (overrides: Parameters<typeof retryDueDeferredAgentRuns>[0] = {}) =>
    retryDueDeferredAgentRuns({ database, now, enqueue, gate: gate(), ...overrides });

  async function deferredRun(): Promise<StoredAgentRun> {
    const { run } = await triggerAgentRun({ definition: stored, trigger: 'schedule', gate: gate() }, triggerDeps());
    assert.equal(run.state, 'deferred');
    return run;
  }

  beforeEach(async () => {
    database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await database.raw('PRAGMA foreign_keys = ON');
    await database.migrate.latest({ directory: migrations });
    enqueued = [];
    clock = NOW;
    usage = { claude: { sessionPercent: 95, sessionResetsAt: new Date(NOW + 10 * MINUTE) } };
    stored = await createAgentDefinition({ ownerId: 'alice', name: 'Triage', prompt: 'Summarize', repositories: [],
      agentAlias: 'claude', modelName: 'opus' }, { database, now });
  });

  afterEach(async () => {
    await database.destroy();
  });

  test('a run that is not due yet is left deferred', async () => {
    const run = await deferredRun();
    clock = run.deferredUntil! - 1;
    usage = { claude: { sessionPercent: 10 } };
    assert.deepEqual(await retry(), { queued: 0, redispatched: 0, deferred: 0, skipped: 0, failed: 0 });
    assert.equal((await getAgentRunById(run.id, { database }))?.state, 'deferred');
    assert.deepEqual(enqueued, []);
  });

  test('once the session recovers, the due run is queued and its report phase enqueued', async () => {
    const run = await deferredRun();
    clock = run.deferredUntil!;
    usage = { claude: { sessionPercent: 10 } };
    assert.deepEqual(await retry(), { queued: 1, redispatched: 0, deferred: 0, skipped: 0, failed: 0 });
    const queued = await getAgentRunById(run.id, { database });
    assert.equal(queued?.state, 'queued');
    // Enqueued, so the run no longer carries a dispatch obligation.
    assert.equal(queued?.deferredUntil, null);
    assert.deepEqual(enqueued, [run.id]);
    // A second pass finds nothing due.
    assert.deepEqual(await retry(), { queued: 0, redispatched: 0, deferred: 0, skipped: 0, failed: 0 });
    assert.deepEqual(enqueued, [run.id]);
  });

  test('a still-limited run is deferred again until its sixth deferral, then persisted as skipped', async () => {
    const run = await deferredRun();
    let current = run;
    for (let deferrals = 2; deferrals <= 6; deferrals += 1) {
      clock = current.deferredUntil!;
      usage = { claude: { sessionPercent: 95, sessionResetsAt: new Date(clock + 40 * MINUTE) } };
      assert.equal((await retry()).deferred, 1);
      current = (await getAgentRunById(run.id, { database }))!;
      assert.equal(current.state, 'deferred');
      assert.equal(current.deferrals, deferrals);
      assert.equal(current.deferredUntil, clock + 30 * MINUTE);
    }
    clock = current.deferredUntil!;
    assert.equal((await retry()).skipped, 1);
    const skipped = await getAgentRunById(run.id, { database });
    assert.equal(skipped?.state, 'skipped');
    assert.match(skipped?.skipReason ?? '', /already deferred 6 times, so it was skipped\.$/);
    assert.deepEqual(enqueued, []);
  });

  test('overlapping retries of the same due run count one deferral and enqueue once', async () => {
    const run = await deferredRun();
    clock = run.deferredUntil!;
    await Promise.all([retry(), retry()]);
    assert.equal((await getAgentRunById(run.id, { database }))?.deferrals, 2);
    clock += 30 * MINUTE;
    usage = { claude: { sessionPercent: 10 } };
    await Promise.all([retry(), retry()]);
    assert.equal((await getAgentRunById(run.id, { database }))?.state, 'queued');
    assert.deepEqual(enqueued, [run.id]);
  });

  test('an older proceed or skip decision does not override a deferral another retry persisted first', async () => {
    const run = await deferredRun();
    clock = run.deferredUntil!;
    // Retry B re-defers the run while retry A is still awaiting its own decision.
    const redeferFirst = (decision: Awaited<ReturnType<AgentRunGate>>): AgentRunGate => async () => {
      assert.equal((await retry()).deferred, 1);
      return decision;
    };
    const weeklySkip = { action: 'skip' as const, reason: 'Weekly usage is over the threshold.' };
    for (const decision of [{ action: 'proceed' as const }, weeklySkip]) {
      const before = (await getAgentRunById(run.id, { database }))!;
      clock = before.deferredUntil!;
      assert.deepEqual(await retry({ gate: redeferFirst(decision) }), { queued: 0, redispatched: 0, deferred: 0, skipped: 0, failed: 0 });
      const after = (await getAgentRunById(run.id, { database }))!;
      assert.equal(after.state, 'deferred');
      assert.equal(after.deferrals, before.deferrals + 1);
      assert.ok(after.deferredUntil! > before.deferredUntil!);
    }
    assert.deepEqual(enqueued, []);
  });

  test('an agent disabled during a retry does not skip a run another retry re-deferred first', async () => {
    const run = await deferredRun();
    clock = run.deferredUntil!;
    const loadDefinition = async () => {
      assert.equal((await retry()).deferred, 1);
      return undefined;
    };
    assert.deepEqual(await retry({ loadDefinition }), { queued: 0, redispatched: 0, deferred: 0, skipped: 0, failed: 0 });
    const current = await getAgentRunById(run.id, { database });
    assert.equal(current?.state, 'deferred');
    assert.equal(current?.deferrals, 2);
  });

  test('weekly usage reaching the threshold while deferred skips the run', async () => {
    const run = await deferredRun();
    clock = run.deferredUntil!;
    usage = { claude: { sessionPercent: 95, weeklyPercent: 92 } };
    assert.equal((await retry()).skipped, 1);
    const skipped = await getAgentRunById(run.id, { database });
    assert.equal(skipped?.state, 'skipped');
    assert.match(skipped?.skipReason ?? '', /^Weekly subscription usage for claude is at 92%/);
  });

  test('a run cancelled while it is evaluated stays cancelled and is not enqueued', async () => {
    const run = await deferredRun();
    clock = run.deferredUntil!;
    const cancelling: AgentRunGate = async () => {
      await transitionAgentRun(run.id, ['deferred'], 'cancelled', {}, { database, now });
      return { action: 'proceed' };
    };
    assert.deepEqual(await retry({ gate: cancelling }), { queued: 0, redispatched: 0, deferred: 0, skipped: 0, failed: 0 });
    assert.equal((await getAgentRunById(run.id, { database }))?.state, 'cancelled');
    assert.deepEqual(enqueued, []);
  });

  test('a run whose agent was disabled while deferred is skipped', async () => {
    const run = await deferredRun();
    await database('agent_definitions').where({ id: stored.id }).update({ enabled: false });
    clock = run.deferredUntil!;
    usage = { claude: { sessionPercent: 10 } };
    assert.equal((await retry()).skipped, 1);
    const skipped = await getAgentRunById(run.id, { database });
    assert.equal(skipped?.state, 'skipped');
    assert.match(skipped?.skipReason ?? '', /disabled or deleted while this run was deferred/);
    assert.deepEqual(enqueued, []);
  });

  test('a run queued by a retry interrupted before its enqueue is dispatched on the next pass', async () => {
    const run = await deferredRun();
    clock = run.deferredUntil!;
    // The retry's transition persisted, then the daemon exited before enqueueing.
    assert.ok(await transitionDeferredAgentRun(run.id, run.deferredUntil!, 'queued', {}, { database, now }));
    assert.deepEqual(await retry(), { queued: 0, redispatched: 1, deferred: 0, skipped: 0, failed: 0 });
    assert.deepEqual(enqueued, [run.id]);
    const dispatched = await getAgentRunById(run.id, { database });
    assert.equal(dispatched?.state, 'queued');
    assert.equal(dispatched?.deferredUntil, null);
    assert.deepEqual(await retry(), { queued: 0, redispatched: 0, deferred: 0, skipped: 0, failed: 0 });
    assert.deepEqual(enqueued, [run.id]);
  });

  test('an admitted run whose redispatch fails keeps its obligation until an enqueue succeeds', async () => {
    const run = await deferredRun();
    clock = run.deferredUntil!;
    assert.ok(await transitionDeferredAgentRun(run.id, run.deferredUntil!, 'queued', {}, { database, now }));
    assert.equal((await retry({ enqueue: async () => { throw new Error('redis down'); } })).redispatched, 0);
    const pending = await getAgentRunById(run.id, { database });
    assert.equal(pending?.state, 'queued');
    assert.equal(pending?.deferredUntil, run.deferredUntil);
    assert.equal((await retry()).redispatched, 1);
    assert.deepEqual(enqueued, [run.id]);
  });

  test('a run claimed by the worker before its dispatch was recorded is not dispatched again', async () => {
    const run = await deferredRun();
    clock = run.deferredUntil!;
    assert.ok(await transitionDeferredAgentRun(run.id, run.deferredUntil!, 'queued', {}, { database, now }));
    assert.ok(await transitionAgentRun(run.id, ['queued'], 'running', {}, { database, now }));
    assert.equal((await retry()).redispatched, 0);
    assert.deepEqual(enqueued, []);
  });

  test('a run that cannot be enqueued after recovery is failed with the reason', async () => {
    const run = await deferredRun();
    clock = run.deferredUntil!;
    usage = { claude: { sessionPercent: 10 } };
    const result = await retry({ enqueue: async () => { throw new Error('redis down'); } });
    assert.equal(result.failed, 1);
    const failed = await getAgentRunById(run.id, { database });
    assert.equal(failed?.state, 'failed');
    assert.match(failed?.failureReason ?? '', /redis down/);
  });
});

describe('auto acting step', () => {
  function transitions(initial: StoredAgentRun) {
    let current = initial;
    const notified: string[] = [];
    const started: string[] = [];
    return {
      notified, started, current: () => current,
      deps: {
        transitionRun: (async (_id: string, from: string[], to: StoredAgentRun['state'], patch = {}) => {
          if (!from.includes(current.state)) return null;
          current = { ...current, ...patch, state: to };
          return current;
        }) as never,
        startActing: async (acting: StoredAgentRun) => { started.push(acting.id); return acting; },
        notifyAwaitingApproval: async (waiting: StoredAgentRun) => { notified.push(waiting.id); },
      },
    };
  }

  test('an unattended auto run over the threshold waits for approval instead of acting', async () => {
    const s = transitions(run());
    const result = await advanceAfterReport(s.current(), { ...s.deps, gate: gateFor({ claude: { sessionPercent: 95 } }) });
    assert.equal(result?.state, 'awaiting_approval');
    assert.match(result?.skipReason ?? '', /^Acting paused: session subscription usage for claude is at 95% \(pause threshold 90%\)/);
    assert.deepEqual(s.started, []);
    assert.deepEqual(s.notified, ['run-1']);
  });

  test('an auto run under the threshold, or triggered manually, starts acting', async () => {
    const under = transitions(run());
    assert.equal((await advanceAfterReport(under.current(), { ...under.deps, gate: gateFor({ claude: { sessionPercent: 50 } }) }))?.state, 'acting');
    assert.deepEqual(under.started, ['run-1']);

    const manual = transitions(run({ trigger: 'manual' }));
    assert.equal((await advanceAfterReport(manual.current(), { ...manual.deps, gate: gateFor({ claude: { weeklyPercent: 99 } }) }))?.state, 'acting');
  });
});

describe('agent_run_usage_pause_percent setting', () => {
  test('accepts integers from 50 to 100 and rejects anything else', async () => {
    const { extractSettingSaves } = await import('../packages/api/routes/configSettings.ts');
    for (const value of [50, 90, 100]) {
      const result = await extractSettingSaves({ agent_run_usage_pause_percent: value });
      assert.equal(result.error, undefined);
      assert.equal(result.normalized.agent_run_usage_pause_percent, value);
      assert.deepEqual(result.saves, [{ name: 'agent_run_usage_pause_percent' }]);
    }
    for (const value of [49, 101, 90.5, 'ninety', null]) {
      assert.match((await extractSettingSaves({ agent_run_usage_pause_percent: value })).error ?? '', /agent_run_usage_pause_percent must be an integer from 50 to 100/, String(value));
    }
  });
});

describe('unattended window parsing', () => {
  test('accepts HH:MM-HH:MM@Zone, overnight windows, 24:00 and a UTC default', () => {
    assert.deepEqual(parseUnattendedWindow('02:00-07:00@Europe/Riga'), { ok: true, window: { start: 120, end: 420, timeZone: 'Europe/Riga' } });
    assert.deepEqual(parseUnattendedWindow(' 22:30 - 06:00 @ UTC '), { ok: true, window: { start: 1350, end: 360, timeZone: 'UTC' } });
    assert.deepEqual(parseUnattendedWindow('9:00-24:00'), { ok: true, window: { start: 540, end: 1440, timeZone: 'UTC' } });
  });

  test('rejects malformed windows with a reason', () => {
    for (const [value, reason] of [
      ['02:00 to 07:00', /HH:MM-HH:MM@Time\/Zone/],
      ['25:00-07:00@UTC', /between 00:00 and 24:00/],
      ['02:60-07:00@UTC', /between 00:00 and 24:00/],
      ['24:00-07:00@UTC', /between 00:00 and 24:00/],
      ['02:00-02:00@UTC', /different times/],
      ['00:00-24:00@UTC', /different times/],
      ['02:00-07:00@Mars/Olympus', /unknown time zone "Mars\/Olympus"/],
    ] as const) {
      const parsed = parseUnattendedWindow(value);
      assert.equal(parsed.ok, false, value);
      assert.match((parsed as { error: string }).error, reason, value);
    }
  });

  test('a stored window is interpreted as none, valid or malformed', () => {
    assert.deepEqual(interpretUnattendedWindow(null), { configured: false });
    assert.deepEqual(interpretUnattendedWindow('  '), { configured: false });
    assert.equal((interpretUnattendedWindow('02:00-07:00@Europe/Riga') as { window?: unknown }).window !== undefined, true);
    assert.deepEqual(interpretUnattendedWindow(42), { configured: true, value: '42', error: 'the stored value is not text' });
    assert.match((interpretUnattendedWindow('nightly') as { error: string }).error, /HH:MM-HH:MM/);
  });
});

describe('unattended admission limits in the cost gate', () => {
  const window = (value: string) => ({ loadWindow: async () => interpretUnattendedWindow(value) });
  const capacityUnknown = async () => ({ status: 'unknown' as const, provider: 'claude' });
  const gateAt = (timestamp: number, limits: Partial<AgentRunCostGateOptions>) => createAgentRunCostGate({
    now: () => timestamp, loadThreshold: async () => 90, evaluateCapacity: capacityUnknown, ...NO_UNATTENDED_LIMITS, ...limits,
  });
  const context = (trigger: StoredAgentRun['trigger'], existing?: StoredAgentRun) =>
    ({ definition: definition(), trigger, triggerSource: null, run: existing });

  test('with the cap reached an unattended run is deferred one short step with the reason', async () => {
    const gate = gateFor({}, 90, { loadMaxConcurrent: async () => 1, countActiveUnattendedRuns: async () => 2 });
    for (const trigger of ['schedule', 'api', 'mcp', 'cli'] as const) {
      const decision = await gate(context(trigger));
      assert.equal(decision?.action, 'defer', trigger);
      assert.equal((decision as { until: number }).until, NOW + 5 * MINUTE);
      assert.notEqual((decision as { countsDeferral?: boolean }).countsDeferral, false);
      assert.equal((decision as { reason: string }).reason,
        '2 unattended runs are already active (cap 1), so the run was deferred until 2026-10-06 14:35 UTC.');
    }

    const one = await gateFor({}, 90, { loadMaxConcurrent: async () => 1, countActiveUnattendedRuns: async () => 1 })(context('schedule'));
    assert.match((one as { reason: string }).reason, /^1 unattended run is already active \(cap 1\)/);

    const free = gateFor({}, 90, { loadMaxConcurrent: async () => 3, countActiveUnattendedRuns: async () => 2 });
    assert.deepEqual(await free(context('schedule')), { action: 'proceed' });
  });

  test('cap deferrals count against the deferral limit', async () => {
    const gate = gateFor({}, 90, { countActiveUnattendedRuns: async () => 1 });
    assert.equal((await gate(context('schedule', run({ state: 'deferred', deferrals: 5 }))))?.action, 'defer');
    const skipped = await gate(context('schedule', run({ state: 'deferred', deferrals: 6 })));
    assert.equal(skipped?.action, 'skip');
    assert.equal((skipped as { reason: string }).reason,
      '1 unattended run is already active (cap 1), and the run was already deferred 6 times, so it was skipped.');
  });

  test('outside the window an unattended run is deferred until it opens, without counting a deferral', async () => {
    // NOW is 17:30 in Riga (UTC+3); the window opens at 02:00 local, 23:00 UTC.
    const gate = gateFor({}, 90, window('02:00-07:00@Europe/Riga'));
    for (const deferrals of [0, 6, 20]) {
      const decision = await gate(context('schedule', deferrals ? run({ state: 'deferred', deferrals }) : undefined));
      assert.deepEqual(decision, {
        action: 'defer',
        until: Date.UTC(2026, 9, 6, 23, 0),
        countsDeferral: false,
        reason: 'Outside the unattended window 02:00-07:00 Europe/Riga, so the run was deferred until it opens at 02:00 Europe/Riga (2026-10-06 23:00 UTC).',
      }, `deferrals ${deferrals}`);
    }
    assert.deepEqual(await gateFor({}, 90, window('17:00-18:00@Europe/Riga'))(context('api')), { action: 'proceed' });
    // Overnight: 22:00-06:00 UTC is closed at 14:30 UTC and opens at 22:00 the same day.
    assert.equal((await gateFor({}, 90, window('22:00-06:00@UTC'))(context('api')) as { until: number }).until, Date.UTC(2026, 9, 6, 22, 0));
  });

  test('inside the window the concurrency cap still applies', async () => {
    const gate = gateFor({}, 90, { ...window('17:00-18:00@Europe/Riga'), countActiveUnattendedRuns: async () => 1 });
    assert.equal((await gate(context('schedule')))?.action, 'defer');
  });

  test('a malformed window skips unattended runs with a reason instead of allowing them', async () => {
    const decision = await gateFor({}, 90, window('25:00-07:00@Europe/Riga'))(context('schedule'));
    assert.deepEqual(decision, {
      action: 'skip',
      reason: 'The unattended window setting "25:00-07:00@Europe/Riga" is malformed (times must be between 00:00 and 24:00), so unattended runs are blocked until it is fixed in Settings.',
    });
    const zone = await gateFor({}, 90, window('02:00-07:00@Europe/Atlantis'))(context('api'));
    assert.match((zone as { reason: string }).reason, /unknown time zone "Europe\/Atlantis"/);
  });

  test('the window follows DST: the spring gap and the autumn offset change', async () => {
    // Riga springs forward on 2027-03-28 at 03:00 EET (01:00 UTC) to 04:00 EEST. A window that
    // starts at 03:30 has no 03:30 that day, so it opens at the first local minute after the gap.
    const gapWindow = parseUnattendedWindow('03:30-07:00@Europe/Riga');
    assert.ok(gapWindow.ok);
    assert.deepEqual(unattendedWindowState(gapWindow.window, Date.UTC(2027, 2, 28, 0, 30)), { open: false, opensAt: Date.UTC(2027, 2, 28, 1, 0) });
    const gapDecision = await gateAt(Date.UTC(2027, 2, 28, 0, 30), window('03:30-07:00@Europe/Riga'))(context('schedule'));
    assert.equal((gapDecision as { until: number }).until, Date.UTC(2027, 2, 28, 1, 0));
    assert.match((gapDecision as { reason: string }).reason, /opens at 04:00 Europe\/Riga \(2027-03-28 01:00 UTC\)\.$/);
    // It closes at 07:00 EEST (04:00 UTC), one hour earlier in UTC than the day before.
    assert.equal(unattendedWindowState(gapWindow.window, Date.UTC(2027, 2, 28, 2, 0)).closesAt, Date.UTC(2027, 2, 28, 4, 0));
    assert.equal(unattendedWindowState(gapWindow.window, Date.UTC(2027, 2, 27, 2, 0)).closesAt, Date.UTC(2027, 2, 27, 5, 0));

    // Riga falls back on 2026-10-25 at 04:00 EEST to 03:00 EET: 02:00 local is 23:00 UTC before
    // the change and 00:00 UTC after it.
    const before = await gateAt(Date.UTC(2026, 9, 24, 12, 0), window('02:00-07:00@Europe/Riga'))(context('schedule'));
    assert.equal((before as { until: number }).until, Date.UTC(2026, 9, 24, 23, 0));
    const after = await gateAt(Date.UTC(2026, 9, 25, 12, 0), window('02:00-07:00@Europe/Riga'))(context('schedule'));
    assert.equal((after as { until: number }).until, Date.UTC(2026, 9, 26, 0, 0));
    // The repeated 03:00-04:00 hour opens the window at its first occurrence (03:00 EEST, 00:00 UTC).
    const repeated = parseUnattendedWindow('03:00-03:30@Europe/Riga');
    assert.ok(repeated.ok);
    assert.deepEqual(unattendedWindowState(repeated.window, Date.UTC(2026, 9, 24, 22, 0)), { open: false, opensAt: Date.UTC(2026, 9, 25, 0, 0) });
  });

  test('manual runs are exempt and the limits are not even read', async () => {
    let reads = 0;
    const counting = {
      loadMaxConcurrent: async () => { reads += 1; return 1; },
      loadWindow: async () => { reads += 1; return interpretUnattendedWindow('nonsense'); },
      countActiveUnattendedRuns: async () => { reads += 1; return 5; },
    };
    assert.deepEqual(await gateFor({}, 90, counting)(context('manual')), { action: 'proceed' });
    assert.equal(reads, 0);
  });

  test('the usage checks come first', async () => {
    const gate = gateFor({ claude: { weeklyPercent: 95 } }, 90, { ...window('02:00-07:00@Europe/Riga'), countActiveUnattendedRuns: async () => 3 });
    const decision = await gate(context('schedule'));
    assert.equal(decision?.action, 'skip');
    assert.match((decision as { reason: string }).reason, /^Weekly subscription usage for claude is at 95%/);
  });

  test('an admitted auto run\'s acting step is not held by the window or the cap', async () => {
    const gate = gateFor({}, 90, { ...window('25:00-07:00@UTC'), countActiveUnattendedRuns: async () => 3 });
    assert.deepEqual(await gate(context('schedule', run({ state: 'report_ready' }))), { action: 'proceed' });
  });
});

describe('unattended admission limits with stored settings', () => {
  let database: Knex;
  let enqueued: string[];
  let stored: StoredAgentDefinition;
  let clock: number;
  const now = () => clock;
  const gate = () => createAgentRunCostGate({ now, database, loadThreshold: async () => 90, evaluateCapacity: async () => ({ status: 'unknown', provider: 'claude' }) });
  const enqueue = async (_name: string, data: { runId: string }) => { enqueued.push(data.runId); };
  const deps = () => ({ database, now, enqueue, loadRepos: async () => [] as RepoToMonitor[], loadAgents: async () => agents, loadSyntheticAgents: async () => [] });
  const setConfig = (key: string, value: unknown) => database('system_configs')
    .insert({ key, value: JSON.stringify(value), created_at: database.fn.now(), updated_at: database.fn.now() })
    .onConflict('key').merge(['value']);

  beforeEach(async () => {
    database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await database.raw('PRAGMA foreign_keys = ON');
    await database.migrate.latest({ directory: migrations });
    enqueued = [];
    clock = NOW;
    stored = await createAgentDefinition({ ownerId: 'alice', name: 'Triage', prompt: 'Summarize', repositories: [],
      agentAlias: 'claude', modelName: 'opus' }, { database, now });
  });

  afterEach(async () => {
    await database.destroy();
  });

  test('only queued, running and acting runs with an unattended trigger are counted', async () => {
    const base = { definition: stored };
    const states = [['schedule', 'queued'], ['api', 'running'], ['cli', 'acting'], ['manual', 'running'],
      ['schedule', 'deferred'], ['mcp', 'awaiting_approval'], ['schedule', 'completed']] as const;
    for (const [index, [trigger, state]] of states.entries()) {
      const { run: created } = await createAgentRun({ ...base, trigger, idempotencyKey: `k${index}` }, { database, now });
      await database('agent_runs').where({ id: created.id }).update({ state });
    }
    assert.equal(await countActiveUnattendedAgentRuns({ database }), 3);
  });

  test('with the default cap of 1 a second scheduled run is deferred, a manual run is not', async () => {
    const first = await triggerAgentRun({ definition: stored, trigger: 'schedule', idempotencyKey: 'a', gate: gate() }, deps());
    assert.equal(first.run.state, 'queued');
    const second = await triggerAgentRun({ definition: stored, trigger: 'api', idempotencyKey: 'b', gate: gate() }, deps());
    assert.equal(second.run.state, 'deferred');
    assert.equal(second.run.deferrals, 1);
    assert.equal(second.run.deferredUntil, NOW + 5 * MINUTE);
    assert.equal(second.run.skipReason, '1 unattended run is already active (cap 1), so the run was deferred until 2026-10-06 14:35 UTC.');
    const manual = await triggerAgentRun({ definition: stored, trigger: 'manual', idempotencyKey: 'c', gate: gate() }, deps());
    assert.equal(manual.run.state, 'queued');
    assert.deepEqual(enqueued, [first.run.id, manual.run.id]);

    await setConfig('unattended_max_concurrent', 2);
    const third = await triggerAgentRun({ definition: stored, trigger: 'cli', idempotencyKey: 'd', gate: gate() }, deps());
    assert.equal(third.run.state, 'queued');
  });

  test('a window wait is retried when the window opens and never counts a deferral', async () => {
    await setConfig('unattended_window', '02:00-07:00@Europe/Riga');
    const { run: deferred } = await triggerAgentRun({ definition: stored, trigger: 'schedule', gate: gate() }, deps());
    assert.equal(deferred.state, 'deferred');
    assert.equal(deferred.deferrals, 0);
    assert.equal(deferred.deferredUntil, Date.UTC(2026, 9, 6, 23, 0));

    // Due, but the window moved meanwhile: waiting again still counts nothing.
    await setConfig('unattended_window', '05:00-07:00@Europe/Riga');
    clock = deferred.deferredUntil!;
    assert.equal((await retryDueDeferredAgentRuns({ database, now, enqueue, gate: gate() })).deferred, 1);
    const waiting = (await getAgentRunById(deferred.id, { database }))!;
    assert.equal(waiting.deferrals, 0);
    assert.equal(waiting.deferredUntil, Date.UTC(2026, 9, 7, 2, 0));

    clock = waiting.deferredUntil!;
    assert.equal((await retryDueDeferredAgentRuns({ database, now, enqueue, gate: gate() })).queued, 1);
    assert.deepEqual(enqueued, [deferred.id]);
  });

  test('a malformed stored window records the scheduled run as skipped', async () => {
    await setConfig('unattended_window', '2am-7am');
    const { run: skipped } = await triggerAgentRun({ definition: stored, trigger: 'schedule', gate: gate() }, deps());
    assert.equal(skipped.state, 'skipped');
    assert.match(skipped.skipReason ?? '', /^The unattended window setting "2am-7am" is malformed/);
    assert.deepEqual(enqueued, []);
  });
});

describe('unattended limit settings', () => {
  test('unattended_max_concurrent accepts integers from 1 to 100', async () => {
    const { extractSettingSaves } = await import('../packages/api/routes/configSettings.ts');
    for (const value of [1, 4, 100]) {
      const result = await extractSettingSaves({ unattended_max_concurrent: value });
      assert.equal(result.error, undefined);
      assert.equal(result.normalized.unattended_max_concurrent, value);
    }
    for (const value of [0, 101, 1.5, 'two', null]) {
      assert.match((await extractSettingSaves({ unattended_max_concurrent: value })).error ?? '', /unattended_max_concurrent must be an integer from 1 to 100/, String(value));
    }
  });

  test('the settings response reports a stored window that no longer parses', async () => {
    const { agentUnattendedSettingsResponse } = await import('../packages/api/routes/configRoutesSettings.ts');
    const storeWith = (values: Record<string, unknown>) =>
      ({ getConfig: async (key: string, fallback: unknown) => key in values ? values[key] : fallback }) as never;
    assert.deepEqual(await agentUnattendedSettingsResponse(storeWith({})),
      { agent_run_usage_pause_percent: 90, unattended_max_concurrent: 1, unattended_window: null });
    assert.deepEqual(await agentUnattendedSettingsResponse(storeWith({ unattended_max_concurrent: 3, unattended_window: '02:00-07:00@Europe/Riga' })),
      { agent_run_usage_pause_percent: 90, unattended_max_concurrent: 3, unattended_window: '02:00-07:00@Europe/Riga' });
    assert.deepEqual(await agentUnattendedSettingsResponse(storeWith({ unattended_window: '26:00-07:00@UTC' })), {
      agent_run_usage_pause_percent: 90, unattended_max_concurrent: 1, unattended_window: '26:00-07:00@UTC',
      unattended_window_error: 'times must be between 00:00 and 24:00',
    });
  });

  test('unattended_window accepts a valid window, clears on empty or null and rejects malformed values', async () => {
    const { extractSettingSaves } = await import('../packages/api/routes/configSettings.ts');
    const saved = await extractSettingSaves({ unattended_window: ' 02:00-07:00@Europe/Riga ' });
    assert.equal(saved.error, undefined);
    assert.equal(saved.normalized.unattended_window, '02:00-07:00@Europe/Riga');
    assert.deepEqual(saved.saves, [{ name: 'unattended_window' }]);
    for (const cleared of ['', null]) {
      assert.equal((await extractSettingSaves({ unattended_window: cleared })).normalized.unattended_window, null);
    }
    assert.match((await extractSettingSaves({ unattended_window: '02:00-07:00@Nowhere/City' })).error ?? '', /unattended_window is malformed: unknown time zone/);
    assert.match((await extractSettingSaves({ unattended_window: 7 })).error ?? '', /unattended_window must be a string or null/);
  });
});
