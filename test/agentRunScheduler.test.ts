import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import type { AgentConfig, RepoToMonitor, StoredAgentDefinition, TriggerAgentRunInput } from '@propr/core';
import { nextCronOccurrence, parseCronExpression } from '@propr/shared';
import {
  claimAgentDefinitionScheduleSlot,
  closeConnection,
  createAgentDefinition,
  createAgentRun,
  createAgentRunCostGate,
  getAgentDefinition,
  getAgentRunById,
  listAgentRuns,
  transitionAgentRun,
  triggerAgentRun,
  updateAgentDefinition,
  type CreateAgentDefinitionInput,
} from '@propr/core';
import {
  AGENT_RUN_STUCK_FAILURE_REASON,
  cleanupAgentRunGrants,
  isAgentOwnerInstanceMember,
  latestDueSlot,
  recoverStuckAgentRuns,
  runAgentScheduleSweep,
  runDeferredAgentRunRetrySweep,
  scheduleAgentRunSweeps,
  type AgentRunSweepDependencies,
} from '../src/agentRunScheduler.ts';

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0900 = Date.UTC(2026, 9, 6, 9, 0);
/** Sorts after every random run id, so a run with it is on the last page. */
const LAST_RUN_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

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

    test('a slot claimed by a sweep that stopped before recording its run is resumed with the same key', async () => {
      const definition = await define();
      // The daemon claimed 09:00 and exited before the trigger created a receipt.
      assert.ok(await claimAgentDefinitionScheduleSlot(definition.id, { claimedNextRunAt: T0900, nextRunAt: T0900 + HOUR, slot: T0900 }, { database }));
      assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).total, 0);

      const result = await runAgentScheduleSweep(deps());
      assert.equal(result.created, 1);
      const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].idempotencyKey, `schedule:${new Date(T0900).toISOString()}`);
      const row = await database('agent_definitions').where({ id: definition.id }).first();
      assert.equal(row.pending_schedule_slot, null);
      assert.equal(Number(row.next_run_at), T0900 + HOUR);

      // Released: nothing to resume or claim until 10:00.
      assert.deepEqual(await runAgentScheduleSweep(deps()), { created: 0, existing: 0, invalid: 0, disabled: 0, lost: 0, failed: 0 });
    });

    test('a slot whose trigger or membership lookup failed stays pending and is retried', async () => {
      const definition = await define();
      const failing = await runAgentScheduleSweep(deps({ trigger: () => Promise.reject(new Error('configuration unavailable')) }));
      assert.equal(failing.failed, 1);
      const failingMember = await runAgentScheduleSweep(deps({ isMember: () => Promise.reject(new Error('database down')) }));
      assert.equal(failingMember.failed, 1);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.nextRunAt, T0900 + HOUR);

      const recovered = await runAgentScheduleSweep(deps());
      assert.equal(recovered.created, 1);
      const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].idempotencyKey, `schedule:${new Date(T0900).toISOString()}`);
    });

    test('a pending slot whose run already exists is released without another run', async () => {
      const definition = await define();
      // The receipt was recorded but the sweep stopped before releasing the slot.
      await claimAgentDefinitionScheduleSlot(definition.id, { claimedNextRunAt: T0900, nextRunAt: T0900 + HOUR, slot: T0900 }, { database });
      const claimed = await getAgentDefinition(definition.id, 'alice', { database });
      await trigger({ definition: claimed!, trigger: 'schedule', idempotencyKey: `schedule:${new Date(T0900).toISOString()}`, gate: proceed });

      const result = await runAgentScheduleSweep(deps());
      assert.equal(result.existing, 1);
      assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).total, 1);
      assert.equal((await database('agent_definitions').where({ id: definition.id }).first()).pending_schedule_slot, null);
    });

    test('a pending slot of an agent disabled after the claim records a skipped run', async () => {
      const definition = await define();
      await claimAgentDefinitionScheduleSlot(definition.id, { claimedNextRunAt: T0900, nextRunAt: T0900 + HOUR, slot: T0900 }, { database });
      await database('agent_definitions').where({ id: definition.id }).update({ enabled: false });

      const result = await runAgentScheduleSweep(deps());
      assert.equal(result.invalid, 1);
      const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
      assert.equal(runs[0].state, 'skipped');
      assert.match(runs[0].skipReason ?? '', /Agent is disabled/);
      assert.equal((await database('agent_definitions').where({ id: definition.id }).first()).pending_schedule_slot, null);
    });

    test('a pending slot whose queued receipt was never enqueued is dispatched before release', async () => {
      const definition = await define();
      // The daemon created the queued receipt and exited before enqueueing it.
      await claimAgentDefinitionScheduleSlot(definition.id, { claimedNextRunAt: T0900, nextRunAt: T0900 + HOUR, slot: T0900 }, { database });
      const { run } = await createAgentRun({ definition, trigger: 'schedule', idempotencyKey: `schedule:${new Date(T0900).toISOString()}` }, { database, now });

      // A failed dispatch keeps the obligation.
      const failing = await runAgentScheduleSweep(deps({ enqueue: () => Promise.reject(new Error('redis down')) }));
      assert.equal(failing.failed, 1);
      assert.equal(Number((await database('agent_definitions').where({ id: definition.id }).first()).pending_schedule_slot), T0900);

      const result = await runAgentScheduleSweep(deps());
      assert.equal(result.existing, 1);
      assert.deepEqual(enqueued, [run.id]);
      assert.equal((await getAgentRunById(run.id, { database }))?.state, 'queued');
      assert.equal((await database('agent_definitions').where({ id: definition.id }).first()).pending_schedule_slot, null);
      assert.equal((await listAgentRuns(definition.id, 'alice', {}, { database })).total, 1);
    });

    test('a pending slot whose receipt is past queued is released without dispatching', async () => {
      const definition = await define();
      await claimAgentDefinitionScheduleSlot(definition.id, { claimedNextRunAt: T0900, nextRunAt: T0900 + HOUR, slot: T0900 }, { database });
      const { run } = await createAgentRun({ definition, trigger: 'schedule', idempotencyKey: `schedule:${new Date(T0900).toISOString()}` }, { database, now });
      await transitionAgentRun(run.id, ['queued'], 'running', {}, { database, now });

      assert.equal((await runAgentScheduleSweep(deps())).existing, 1);
      assert.deepEqual(enqueued, []);
      assert.equal((await database('agent_definitions').where({ id: definition.id }).first()).pending_schedule_slot, null);
    });

    test('a pending slot of a schedule turned off after the claim records a skipped run and starts nothing', async () => {
      const definition = await define();
      await claimAgentDefinitionScheduleSlot(definition.id, { claimedNextRunAt: T0900, nextRunAt: T0900 + HOUR, slot: T0900 }, { database });
      await updateAgentDefinition(definition.id, 'alice', { scheduleEnabled: false }, { database, now });
      let triggered = 0;

      const result = await runAgentScheduleSweep(deps({ trigger: input => { triggered += 1; return trigger(input); } }));
      assert.equal(result.invalid, 1);
      assert.equal(triggered, 0);
      assert.deepEqual(enqueued, []);
      const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].state, 'skipped');
      assert.match(runs[0].skipReason ?? '', /schedule was turned off/);
      const stored = await getAgentDefinition(definition.id, 'alice', { database });
      assert.equal(stored?.enabled, true);
      assert.equal(stored?.nextRunAt, null);
      assert.equal((await database('agent_definitions').where({ id: definition.id }).first()).pending_schedule_slot, null);
    });

    test('an offboarded owner\'s undispatched queued receipt is skipped, not left queued', async () => {
      const definition = await define();
      await claimAgentDefinitionScheduleSlot(definition.id, { claimedNextRunAt: T0900, nextRunAt: T0900 + HOUR, slot: T0900 }, { database });
      const { run } = await createAgentRun({ definition, trigger: 'schedule', idempotencyKey: `schedule:${new Date(T0900).toISOString()}` }, { database, now });
      members.clear();

      assert.equal((await runAgentScheduleSweep(deps())).disabled, 1);
      assert.deepEqual(enqueued, []);
      const stored = await getAgentRunById(run.id, { database });
      assert.equal(stored?.state, 'skipped');
      assert.match(stored?.skipReason ?? '', /no longer an instance member/);
    });

    test('a long downtime coalesces into the actual latest due slot', async () => {
      const definition = await define({ scheduleCron: '*/15 * * * *' });
      // 105 days of 15-minute slots: more than 10,000 missed occurrences.
      await database('agent_definitions').where({ id: definition.id }).update({ next_run_at: T0900 });
      clock = T0900 + 105 * DAY + 7 * MINUTE;
      const result = await runAgentScheduleSweep(deps());
      assert.equal(result.created, 1);
      const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
      assert.equal(runs[0].idempotencyKey, `schedule:${new Date(T0900 + 105 * DAY).toISOString()}`);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.nextRunAt, T0900 + 105 * DAY + 15 * MINUTE);
    });

    test('latestDueSlot matches a slot-by-slot walk', () => {
      for (const expression of ['*/15 * * * *', '0 * * * *', '30 9 * * 1-5', '0 0 1 * *']) {
        const cron = parseCronExpression(expression);
        const start = nextCronOccurrence(cron, new Date(T0900 - MINUTE)).getTime();
        for (const span of [0, MINUTE, HOUR, 3 * DAY + 17 * MINUTE, 40 * DAY]) {
          const now = start + span;
          let expected = start;
          for (let following = nextCronOccurrence(cron, new Date(start)).getTime(); following <= now;
            following = nextCronOccurrence(cron, new Date(following)).getTime()) expected = following;
          assert.equal(latestDueSlot(cron, start, now), expected, `${expression} after ${span}ms`);
        }
      }
    });

    test('the cost gate can defer a scheduled run', async () => {
      const definition = await define();
      await runAgentScheduleSweep(deps({ gate: () => ({ action: 'defer', until: clock + 30 * MINUTE, reason: 'Usage is high.' }) }));
      const { runs } = await listAgentRuns(definition.id, 'alice', {}, { database });
      assert.equal(runs[0].state, 'deferred');
      assert.deepEqual(enqueued, []);
    });
  });

  describe('owner membership', () => {
    const environment = { whitelist: process.env.GITHUB_USER_WHITELIST, admins: process.env.PROPR_ADMIN_USERS };
    afterEach(() => {
      for (const [key, value] of [['GITHUB_USER_WHITELIST', environment.whitelist], ['PROPR_ADMIN_USERS', environment.admins]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const addGrant = (id: string, username: string) => database('github_user_grants').insert({
      github_user_id: id, github_username: username, source: 'github', access_token_encrypted: 'sealed',
    });

    test('an owner who signed in without a membership row is an implicit member', async () => {
      delete process.env.GITHUB_USER_WHITELIST;
      delete process.env.PROPR_ADMIN_USERS;
      await addGrant('alice', 'alice-gh');
      assert.equal(await isAgentOwnerInstanceMember('alice', database), true);
      assert.equal(await isAgentOwnerInstanceMember('nobody', database), false);

      process.env.GITHUB_USER_WHITELIST = 'alice-gh';
      assert.equal(await isAgentOwnerInstanceMember('alice', database), true);
      process.env.GITHUB_USER_WHITELIST = 'someone-else';
      assert.equal(await isAgentOwnerInstanceMember('alice', database), false);
    });

    test('the default membership check keeps an implicit member\'s schedule', async () => {
      delete process.env.GITHUB_USER_WHITELIST;
      const definition = await define();
      await addGrant('alice', 'alice-gh');
      const result = await runAgentScheduleSweep(deps({ isMember: undefined }));
      assert.equal(result.created, 1);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.scheduleEnabled, true);
    });
    test('a failed grant lookup keeps the pending slot instead of disabling the schedule', async () => {
      delete process.env.GITHUB_USER_WHITELIST;
      const definition = await define();
      await addGrant('alice', 'alice-gh');
      await database.schema.renameTable('github_user_grants', 'github_user_grants_offline');
      const failing = await runAgentScheduleSweep(deps({ isMember: undefined }));
      assert.equal(failing.failed, 1);
      assert.equal(failing.disabled, 0);
      const pending = await database('agent_definitions').where({ id: definition.id }).first();
      assert.equal(Number(pending.pending_schedule_slot), T0900);
      assert.equal((await getAgentDefinition(definition.id, 'alice', { database }))?.scheduleEnabled, true);

      await database.schema.renameTable('github_user_grants_offline', 'github_user_grants');
      assert.equal((await runAgentScheduleSweep(deps({ isMember: undefined }))).created, 1);
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

    test('reaches a stuck run behind more live runs than one batch', async () => {
      const definition = await define();
      for (let index = 0; index < 101; index++) await runningRun(definition, `live-${index}`, 'processing', 30 * MINUTE);
      const stuck = await runningRun(definition, 'stuck', 'failed', 11 * MINUTE);
      await database('agent_runs').where({ id: stuck.id }).update({ id: LAST_RUN_ID });

      assert.equal(await recoverStuckAgentRuns({ database, now }), 1);
      assert.equal((await getAgentRunById(LAST_RUN_ID, { database }))?.state, 'failed');
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
      const fences = new Map<string, { expiredBy?: number }>();
      const count = await cleanupAgentRunGrants({ database, now, revoke: async (runId, phase, fence) => {
        revoked.push(`${runId}:${phase}`);
        fences.set(`${runId}:${phase}`, fence);
      } });
      assert.equal(count, 3);
      assert.deepEqual(revoked.sort(), [
        `${done.id}:action`, `${expired.id}:report`, '00000000-0000-4000-8000-000000000000:report',
      ].sort());
      // A live run may have replaced its expired grant meanwhile, so that revoke is fenced by expiry.
      assert.deepEqual(fences.get(`${expired.id}:report`), { expiredBy: clock });
      assert.deepEqual(fences.get(`${done.id}:action`), {});
    });

    test('a failed revocation is retried on the next sweep', async () => {
      const definition = await define();
      const { run } = await createAgentRun({ definition, trigger: 'manual', idempotencyKey: 'done' }, { database, now });
      await transitionAgentRun(run.id, ['queued'], 'cancelled', {}, { database, now });
      await database('mcp_records').insert({ kind: 'agent_run_grant', id: `${run.id}:report`, value: 'sealed', owner_id: 'alice', expires_at: clock + HOUR });
      const count = await cleanupAgentRunGrants({ database, now, revoke: async () => { throw new Error('API unreachable'); } });
      assert.equal(count, 0);
    });

    test('reaches a leftover grant behind more live or failing grants than one batch', async () => {
      const definition = await define();
      const records: Array<{ kind: string; id: string; value: string; owner_id: string; expires_at: number }> = [];
      for (let index = 0; index < 100; index++) {
        const { run } = await createAgentRun({ definition, trigger: 'manual', idempotencyKey: `live-${index}` }, { database, now });
        await transitionAgentRun(run.id, ['queued'], 'running', {}, { database, now });
        for (const phase of ['report', 'action']) {
          records.push({ kind: 'agent_run_grant', id: `${run.id}:${phase}`, value: 'sealed', owner_id: 'alice', expires_at: clock + MINUTE });
        }
      }
      // Grants of ended runs whose revocation keeps failing.
      const failing = new Set<string>();
      for (let index = 0; index < 5; index++) {
        const { run } = await createAgentRun({ definition, trigger: 'manual', idempotencyKey: `failing-${index}` }, { database, now });
        await transitionAgentRun(run.id, ['queued'], 'cancelled', {}, { database, now });
        failing.add(run.id);
        records.push({ kind: 'agent_run_grant', id: `${run.id}:report`, value: 'sealed', owner_id: 'alice', expires_at: clock - HOUR });
      }
      // Its run is gone, and it expires after every live grant.
      records.push({ kind: 'agent_run_grant', id: `${LAST_RUN_ID}:report`, value: 'sealed', owner_id: 'alice', expires_at: clock + DAY });
      await database.batchInsert('mcp_records', records, 50);

      const revoked: string[] = [];
      const revoke = async (runId: string, phase: string) => {
        if (failing.has(runId)) throw new Error('API unreachable');
        revoked.push(`${runId}:${phase}`);
      };
      assert.equal(await cleanupAgentRunGrants({ database, now, revoke }), 1);
      assert.deepEqual(revoked, [`${LAST_RUN_ID}:report`]);
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
