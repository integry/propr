import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import type { AgentConfig, RepoToMonitor, StoredAgentDefinition, TriggerAgentRunInput } from '@propr/core';
import {
  closeConnection,
  createAgentDefinition,
  createAgentRun,
  createAgentRunCostGate,
  getAgentDefinition,
  getAgentRunById,
  listAgentRuns,
  transitionAgentRun,
  triggerAgentRun,
  type CreateAgentDefinitionInput,
} from '@propr/core';
import {
  AGENT_RUN_STUCK_FAILURE_REASON,
  cleanupAgentRunGrants,
  recoverStuckAgentRuns,
  runAgentScheduleSweep,
  runDeferredAgentRunRetrySweep,
  scheduleAgentRunSweeps,
  type AgentRunSweepDependencies,
} from '../src/agentRunScheduler.ts';

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0900 = Date.UTC(2026, 9, 6, 9, 0);

after(async () => {
  await closeConnection();
});

async function openDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.raw('PRAGMA foreign_keys = ON');
  await database.migrate.latest({ directory: migrations });
  return database;
}

const agents: AgentConfig[] = [{
  id: 'agent-claude', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'propr/agent', configPath: '~/.claude',
  supportedModels: ['opus'], defaultModel: 'opus',
} as AgentConfig];

describe('agent run scheduler', () => {
  let database: Knex;
  let clock: number;
  let enqueued: string[];
  let repos: RepoToMonitor[];
  let members: Set<string>;
  const now = () => clock;
  const enqueue = async (_name: string, data: { runId: string }) => { enqueued.push(data.runId); };
  const proceed = () => ({ action: 'proceed' as const });
  const trigger = (input: TriggerAgentRunInput) => triggerAgentRun(input, {
    database, now, enqueue,
    loadRepos: async () => repos, loadAgents: async () => agents, loadSyntheticAgents: async () => [],
  });
  const deps = (overrides: AgentRunSweepDependencies = {}): AgentRunSweepDependencies => ({
    database, now, enqueue, trigger, gate: proceed, isMember: async ownerId => members.has(ownerId), ...overrides,
  });
  /** An hourly agent whose next slot is 09:00. */
  const define = (overrides: Partial<CreateAgentDefinitionInput> = {}): Promise<StoredAgentDefinition> =>
    createAgentDefinition({
      ownerId: 'alice', name: 'Triage', prompt: 'Summarize', repositories: ['acme/app'], agentAlias: 'claude', modelName: 'opus',
      autonomyMode: 'dry_run', scheduleCron: '0 * * * *', scheduleEnabled: true, ...overrides,
    }, { database, now: () => T0900 - 30 * MINUTE });

  beforeEach(async () => {
    database = await openDatabase();
    clock = T0900 + MINUTE;
    enqueued = [];
    repos = [{ id: 'id-app', name: 'acme/app', enabled: true } as RepoToMonitor];
    members = new Set(['alice']);
  });

  afterEach(async () => {
    await database.destroy();
  });

  describe('schedule sweep', () => {
    test('fires a due definition once and moves next_run_at to the next slot', async () => {
      const definition = await define();
      assert.equal(definition.nextRunAt, T0900);

      const result = await runAgentScheduleSweep(deps());
      assert.equal(result.created, 1);
      const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].trigger, 'schedule');
      assert.equal(runs[0].triggerSource, 'schedule:0 * * * *');
      assert.equal(runs[0].idempotencyKey, `schedule:${new Date(T0900).toISOString()}`);
      assert.deepEqual(enqueued, [runs[0].id]);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.nextRunAt, T0900 + HOUR);

      // Nothing is due any more.
      assert.equal((await runAgentScheduleSweep(deps())).created, 0);
      assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).total, 1);
    });

    test('two concurrent sweeps over the same due definition create exactly one run', async () => {
      const definition = await define();
      const results = await Promise.all([runAgentScheduleSweep(deps()), runAgentScheduleSweep(deps())]);
      assert.equal(results.reduce((sum, result) => sum + result.created, 0), 1);
      assert.equal(results.reduce((sum, result) => sum + result.lost, 0), 1);
      assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).total, 1);
      assert.equal(enqueued.length, 1);
    });

    test('a replayed slot returns the existing run instead of creating another', async () => {
      const definition = await define();
      await runAgentScheduleSweep(deps());
      // A schedule edit put next_run_at back on the slot that already ran.
      await database('agent_definitions').where({ id: definition.id }).update({ next_run_at: T0900 });
      const result = await runAgentScheduleSweep(deps());
      assert.equal(result.existing, 1);
      assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).total, 1);
    });

    test('missed slots coalesce into one run for the latest due slot', async () => {
      const definition = await define();
      // Down across 09:00, 10:00 and 11:00.
      clock = T0900 + 2 * HOUR + 30 * MINUTE;
      const result = await runAgentScheduleSweep(deps());
      assert.equal(result.created, 1);
      const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].idempotencyKey, `schedule:${new Date(T0900 + 2 * HOUR).toISOString()}`);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.nextRunAt, T0900 + 3 * HOUR);
    });

    test('an owner who is no longer a member gets the schedule disabled and no run', async () => {
      const definition = await define();
      members.clear();
      const result = await runAgentScheduleSweep(deps());
      assert.equal(result.disabled, 1);
      assert.equal(result.created, 0);
      const stored = await getAgentDefinition(definition.id, 'alice', { database });
      assert.equal(stored?.scheduleEnabled, false);
      assert.equal(stored?.nextRunAt, null);
      assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).total, 0);
      assert.deepEqual(enqueued, []);
    });

    test('a definition that no longer validates records a skipped run with the reason', async () => {
      const definition = await define();
      repos = [];
      const result = await runAgentScheduleSweep(deps());
      assert.equal(result.invalid, 1);
      const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].state, 'skipped');
      assert.match(runs[0].skipReason ?? '', /Repositories are not enabled: acme\/app/);
      assert.deepEqual(enqueued, []);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.nextRunAt, T0900 + HOUR);
    });

    test('one failing definition does not stop the sweep', async () => {
      const broken = await define({ name: 'Broken' });
      const healthy = await define({ name: 'Healthy' });
      const result = await runAgentScheduleSweep(deps({
        trigger: input => input.definition.id === broken.id ? Promise.reject(new Error('boom')) : trigger(input),
      }));
      assert.equal(result.failed, 1);
      assert.equal(result.created, 1);
      assert.equal((await listAgentRuns(healthy.id, 'alice', {}, { database })).total, 1);
    });

    test('the cost gate can defer a scheduled run', async () => {
      const definition = await define();
      await runAgentScheduleSweep(deps({ gate: () => ({ action: 'defer', until: clock + 30 * MINUTE, reason: 'Usage is high.' }) }));
      const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
      assert.equal(runs[0].state, 'deferred');
      assert.deepEqual(enqueued, []);
    });
  });

  describe('deferred retry sweep', () => {
    const limitedGate = () => createAgentRunCostGate({
      now, loadThreshold: async () => 90,
      evaluateCapacity: async () => ({ status: 'near_limit', provider: 'claude', sessionPercent: 95 }),
    });

    async function deferredRun(definition: StoredAgentDefinition, deferrals = 1) {
      const { run } = await createAgentRun({
        definition, trigger: 'schedule', idempotencyKey: `schedule:${deferrals}`, initialState: 'deferred',
        deferredUntil: clock - MINUTE, skipReason: 'Usage is high.',
      }, { database, now });
      if (deferrals !== 1) await database('agent_runs').where({ id: run.id }).update({ deferrals });
      return run;
    }

    test('a deferred run whose provider recovered is queued and enqueued', async () => {
      const run = await deferredRun(await define());
      const result = await runDeferredAgentRunRetrySweep(deps());
      assert.equal(result.queued, 1);
      assert.equal((await getAgentRunById(run.id, { database }))?.state, 'queued');
      assert.deepEqual(enqueued, [run.id]);
    });

    test('a run still limited is deferred again and counts the deferral', async () => {
      const run = await deferredRun(await define());
      const result = await runDeferredAgentRunRetrySweep(deps({ gate: limitedGate() }));
      assert.equal(result.deferred, 1);
      const stored = await getAgentRunById(run.id, { database });
      assert.equal(stored?.state, 'deferred');
      assert.equal(stored?.deferrals, 2);
      assert.ok((stored?.deferredUntil ?? 0) > clock);
    });

    test('a run that stays limited past 6 deferrals is skipped', async () => {
      const run = await deferredRun(await define(), 6);
      const result = await runDeferredAgentRunRetrySweep(deps({ gate: limitedGate() }));
      assert.equal(result.skipped, 1);
      const stored = await getAgentRunById(run.id, { database });
      assert.equal(stored?.state, 'skipped');
      assert.match(stored?.skipReason ?? '', /already deferred 6 times/);
      assert.deepEqual(enqueued, []);
    });
  });

  describe('stuck run recovery', () => {
    async function runningRun(definition: StoredAgentDefinition, key: string, taskState: string, endedAgo: number) {
      const { run } = await createAgentRun({ definition, trigger: 'manual', idempotencyKey: key }, { database, now });
      const taskId = `agent-run-${run.id}`;
      await transitionAgentRun(run.id, ['queued'], 'running', { reportTaskId: taskId }, { database, now });
      await database('tasks').insert({ task_id: taskId, repository: 'acme/app', issue_number: 0, task_type: 'agent_run', created_at: new Date(clock - HOUR).toISOString() });
      await database('task_history').insert({ task_id: taskId, state: 'processing', timestamp: new Date(clock - HOUR).toISOString() });
      await database('task_history').insert({ task_id: taskId, state: taskState, timestamp: new Date(clock - endedAgo).toISOString() });
      return run;
    }

    test('fails runs whose task has been terminal for more than ten minutes', async () => {
      const definition = await define();
      const stuck = await runningRun(definition, 'a', 'failed', 11 * MINUTE);
      const recent = await runningRun(definition, 'b', 'failed', 5 * MINUTE);
      const live = await runningRun(definition, 'c', 'processing', 30 * MINUTE);

      assert.equal(await recoverStuckAgentRuns({ database, now }), 1);
      const failed = await getAgentRunById(stuck.id, { database });
      assert.equal(failed?.state, 'failed');
      assert.equal(failed?.failureReason, AGENT_RUN_STUCK_FAILURE_REASON);
      assert.equal((await getAgentRunById(recent.id, { database }))?.state, 'running');
      assert.equal((await getAgentRunById(live.id, { database }))?.state, 'running');
    });
  });

  describe('grant cleanup', () => {
    test('revokes grants of terminal or missing runs and expired grants only', async () => {
      const definition = await define();
      const { run: active } = await createAgentRun({ definition, trigger: 'manual', idempotencyKey: 'active' }, { database, now });
      await transitionAgentRun(active.id, ['queued'], 'running', {}, { database, now });
      const { run: done } = await createAgentRun({ definition, trigger: 'manual', idempotencyKey: 'done' }, { database, now });
      await transitionAgentRun(done.id, ['queued'], 'cancelled', {}, { database, now });
      const { run: expired } = await createAgentRun({ definition, trigger: 'manual', idempotencyKey: 'expired' }, { database, now });
      await transitionAgentRun(expired.id, ['queued'], 'running', {}, { database, now });
      const record = (id: string, expiresAt: number) => ({ kind: 'agent_run_grant', id, value: 'sealed', owner_id: 'alice', expires_at: expiresAt });
      await database('mcp_records').insert([
        record(`${active.id}:report`, clock + HOUR),
        record(`${done.id}:action`, clock + HOUR),
        record(`${expired.id}:report`, clock - MINUTE),
        record('00000000-0000-4000-8000-000000000000:report', clock + HOUR),
      ]);
      await database('mcp_records').insert({ kind: 'client', id: 'other', value: 'x', owner_id: null, expires_at: clock - HOUR });

      const revoked: string[] = [];
      const count = await cleanupAgentRunGrants({ database, now, revoke: async (runId, phase) => { revoked.push(`${runId}:${phase}`); } });
      assert.equal(count, 3);
      assert.deepEqual(revoked.sort(), [
        `${done.id}:action`, `${expired.id}:report`, '00000000-0000-4000-8000-000000000000:report',
      ].sort());
    });

    test('a failed revocation is retried on the next sweep', async () => {
      const definition = await define();
      const { run } = await createAgentRun({ definition, trigger: 'manual', idempotencyKey: 'done' }, { database, now });
      await transitionAgentRun(run.id, ['queued'], 'cancelled', {}, { database, now });
      await database('mcp_records').insert({ kind: 'agent_run_grant', id: `${run.id}:report`, value: 'sealed', owner_id: 'alice', expires_at: clock + HOUR });
      const count = await cleanupAgentRunGrants({ database, now, revoke: async () => { throw new Error('API unreachable'); } });
      assert.equal(count, 0);
    });
  });

  describe('scheduleAgentRunSweeps', () => {
    afterEach(() => mock.timers.reset());

    test('runs the sweeps on their intervals and stops clearing the intervals', async () => {
      mock.timers.enable({ apis: ['setInterval'] });
      let sweepTicks = 0;
      let grantTicks = 0;
      const stop = scheduleAgentRunSweeps(MINUTE, {
        grantCleanupIntervalMs: 10 * MINUTE,
        deps: { ...deps(), now: () => { sweepTicks += 1; return clock; } },
        grantCleanup: { database, now: () => { grantTicks += 1; return clock; }, revoke: async () => {} },
      });
      const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
      await settle();
      const initialSweep = sweepTicks;
      assert.ok(initialSweep > 0);

      mock.timers.tick(MINUTE);
      await settle();
      assert.ok(sweepTicks > initialSweep);

      await stop();
      const afterStop = { sweepTicks, grantTicks };
      mock.timers.tick(20 * MINUTE);
      await settle();
      assert.deepEqual({ sweepTicks, grantTicks }, afterStop);
    });
  });
});
