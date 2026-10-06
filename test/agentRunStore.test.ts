import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { AGENT_REPORT_MAX_CHARS, AGENT_RUN_STATES } from '@propr/shared';
import { createAgentDefinition, type StoredAgentDefinition } from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import {
  AGENT_RUN_TRANSITIONS,
  claimAgentRunAction,
  createAgentRun,
  getAgentRun,
  getAgentRunById,
  listAgentRuns,
  listDueDeferredRuns,
  listPreviousReports,
  rowToAgentRun,
  transitionAgentRun,
  type AgentRunRow,
  type StoredAgentRun,
} from '../packages/core/src/services/agents/agentRunStore.ts';

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const NOW = Date.UTC(2026, 9, 6, 10, 7);

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

describe('AGENT_RUN_TRANSITIONS', () => {
  test('covers every state and terminal states have no outgoing edges', () => {
    assert.deepEqual(Object.keys(AGENT_RUN_TRANSITIONS).sort(), [...AGENT_RUN_STATES].sort());
    for (const state of ['completed', 'failed', 'skipped', 'rejected', 'cancelled'] as const) {
      assert.deepEqual(AGENT_RUN_TRANSITIONS[state], []);
    }
  });
});

describe('agentRunStore', () => {
  let database: Knex;
  let clock: number;
  let definition: StoredAgentDefinition;
  const deps = () => ({ database, now: () => clock });

  beforeEach(async () => {
    database = await openDatabase();
    clock = NOW;
    definition = await createAgentDefinition({ ownerId: 'alice', name: 'Triage', prompt: 'Summarize', autonomyMode: 'preview' }, deps());
  });
  afterEach(async () => { await database.destroy(); });

  async function runWithReport(report: string): Promise<StoredAgentRun> {
    const { run } = await createAgentRun({ definition, trigger: 'schedule' }, deps());
    await transitionAgentRun(run.id, ['queued'], 'running', { reportTaskId: `task-${run.id}` }, deps());
    const reported = await transitionAgentRun(run.id, ['running'], 'report_ready', { report }, deps());
    assert.ok(reported);
    return reported;
  }

  test('creates a queued run with a definition snapshot and captured autonomy', async () => {
    const { run, created } = await createAgentRun({ definition, trigger: 'manual', triggerSource: 'alice' }, deps());
    assert.equal(created, true);
    assert.equal(run.state, 'queued');
    assert.equal(run.ownerId, 'alice');
    assert.equal(run.autonomyMode, 'preview');
    assert.equal(run.definitionSnapshot?.prompt, 'Summarize');
    assert.equal(run.finishedAt, null);
    assert.deepEqual(await getAgentRunById(run.id, deps()), run);
  });

  test('replaying the same idempotency key returns the existing run', async () => {
    const first = await createAgentRun({ definition, trigger: 'schedule', idempotencyKey: 'slot-1' }, deps());
    clock += 1000;
    const second = await createAgentRun({ definition, trigger: 'schedule', idempotencyKey: 'slot-1' }, deps());
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.run.id, first.run.id);
    assert.equal(second.run.createdAt, NOW);
    const [{ count }] = await database('agent_runs').count<{ count: number }[]>({ count: '*' });
    assert.equal(Number(count), 1);

    const unkeyed = await createAgentRun({ definition, trigger: 'manual' }, deps());
    const unkeyedAgain = await createAgentRun({ definition, trigger: 'manual' }, deps());
    assert.ok(unkeyed.created && unkeyedAgain.created);
    assert.notEqual(unkeyed.run.id, unkeyedAgain.run.id);
  });

  test('creates skipped and deferred runs', async () => {
    const skipped = await createAgentRun({ definition, trigger: 'schedule', initialState: 'skipped', skipReason: 'previous run active' }, deps());
    assert.equal(skipped.run.state, 'skipped');
    assert.equal(skipped.run.skipReason, 'previous run active');
    assert.equal(skipped.run.finishedAt, NOW);

    const deferred = await createAgentRun({ definition, trigger: 'schedule', initialState: 'deferred', deferredUntil: NOW + 60_000 }, deps());
    assert.equal(deferred.run.deferredUntil, NOW + 60_000);
    assert.equal(deferred.run.deferrals, 1);
    await assert.rejects(createAgentRun({ definition, trigger: 'schedule', initialState: 'deferred' }, deps()), /deferredUntil/);
  });

  test('walks the happy path and stamps timestamps', async () => {
    const { run } = await createAgentRun({ definition, trigger: 'manual' }, deps());
    clock += 1000;
    const running = await transitionAgentRun(run.id, ['queued'], 'running', { reportTaskId: 'task-1' }, deps());
    assert.equal(running?.state, 'running');
    assert.equal(running?.startedAt, NOW + 1000);
    assert.equal(running?.reportTaskId, 'task-1');
    clock += 1000;
    const reported = await transitionAgentRun(run.id, ['running'], 'report_ready', { report: 'All good' }, deps());
    assert.equal(reported?.reportedAt, NOW + 2000);
    assert.equal(reported?.report, 'All good');
    const awaiting = await transitionAgentRun(run.id, ['report_ready'], 'awaiting_approval', {}, deps());
    assert.equal(awaiting?.finishedAt, null);
    const acting = await transitionAgentRun(run.id, ['awaiting_approval'], 'acting', { approvedBy: 'alice', actionTaskId: 'task-2' }, deps());
    assert.equal(acting?.approvedBy, 'alice');
    clock += 1000;
    const completed = await transitionAgentRun(run.id, ['acting'], 'completed', { actionSummary: 'Opened 1 issue' }, deps());
    assert.equal(completed?.state, 'completed');
    assert.equal(completed?.finishedAt, NOW + 3000);
    assert.equal(completed?.startedAt, NOW + 1000);
    assert.equal(completed?.actionSummary, 'Opened 1 issue');
  });

  test('a late transition from a cancelled run returns null and leaves the row unchanged', async () => {
    const { run } = await createAgentRun({ definition, trigger: 'manual' }, deps());
    await transitionAgentRun(run.id, ['queued'], 'running', {}, deps());
    const cancelled = await transitionAgentRun(run.id, ['queued', 'running'], 'cancelled', {}, deps());
    assert.equal(cancelled?.state, 'cancelled');
    clock += 5000;
    const late = await transitionAgentRun(run.id, ['running'], 'report_ready', { report: 'too late' }, deps());
    assert.equal(late, null);
    assert.deepEqual(await getAgentRunById(run.id, deps()), cancelled);
    assert.equal(await transitionAgentRun('missing', ['running'], 'failed', {}, deps()), null);
  });

  /**
   * Wraps the database so the first `method` (update/insert) on agent_runs
   * resolves only after `compete` has run against the real database, i.e. a
   * competing writer lands between the write completing and its result being
   * delivered.
   */
  function competeAfter(method: 'update' | 'insert', compete: () => Promise<unknown>): Knex {
    let armed = true;
    return new Proxy(database, {
      apply(target, thisArg, args: unknown[]) {
        const builder = Reflect.apply(target, thisArg, args) as Knex.QueryBuilder;
        if (args[0] !== 'agent_runs') return builder;
        const original = builder[method].bind(builder) as (...a: unknown[]) => Knex.QueryBuilder;
        (builder as unknown as Record<string, unknown>)[method] = (...methodArgs: unknown[]) => {
          const query = original(...methodArgs);
          if (!armed) return query;
          armed = false;
          const settle = query.then.bind(query);
          (query as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            settle(async (result: unknown) => { await compete(); return result; }).then(resolve, reject);
          return query;
        };
        return builder;
      },
    });
  }

  test('a transition returns the row it wrote even if a competing transition lands before its result', async () => {
    const { run } = await createAgentRun({ definition, trigger: 'manual' }, deps());
    const racing = competeAfter('update', async () => {
      clock += 5000;
      const cancelled = await transitionAgentRun(run.id, ['running'], 'cancelled', {}, deps());
      assert.equal(cancelled?.state, 'cancelled');
    });
    const running = await transitionAgentRun(run.id, ['queued'], 'running', { reportTaskId: 'task-1' }, { database: racing, now: () => clock });
    assert.equal(running?.state, 'running');
    assert.equal(running?.startedAt, NOW);
    assert.equal(running?.finishedAt, null);
    assert.equal(running?.reportTaskId, 'task-1');
    assert.equal((await getAgentRunById(run.id, deps()))?.state, 'cancelled');
  });

  test('a created run is returned as inserted even if a competing transition lands before its result', async () => {
    let createdId: string | undefined;
    const racing = competeAfter('insert', async () => {
      const [row] = await database('agent_runs').select('id');
      createdId = row.id;
      clock += 5000;
      assert.ok(await transitionAgentRun(row.id, ['queued'], 'cancelled', {}, deps()));
    });
    const created = await createAgentRun({ definition, trigger: 'schedule', idempotencyKey: 'slot-1' }, { database: racing, now: () => clock });
    assert.equal(created.created, true);
    assert.equal(created.run.id, createdId);
    assert.equal(created.run.state, 'queued');
    assert.equal(created.run.finishedAt, null);
    assert.equal((await getAgentRunById(created.run.id, deps()))?.state, 'cancelled');
  });

  test('claimAgentRunAction claims an acting run once and only while it is acting', async () => {
    const reported = await runWithReport('Report');
    assert.equal(await claimAgentRunAction(reported.id, 'action-task', deps()), null);
    await transitionAgentRun(reported.id, ['report_ready'], 'awaiting_approval', {}, deps());
    await transitionAgentRun(reported.id, ['awaiting_approval'], 'acting', { approvedBy: 'alice' }, deps());
    const claimed = await claimAgentRunAction(reported.id, 'action-task', deps());
    assert.equal(claimed?.actionTaskId, 'action-task');
    assert.equal(claimed?.state, 'acting');
    assert.equal(claimed?.approvedBy, 'alice');
    assert.equal(await claimAgentRunAction(reported.id, 'other-task', deps()), null);
    assert.equal((await getAgentRunById(reported.id, deps()))?.actionTaskId, 'action-task');
  });

  test('rejects illegal transition pairs as programming errors', async () => {
    const { run } = await createAgentRun({ definition, trigger: 'manual' }, deps());
    await assert.rejects(transitionAgentRun(run.id, ['cancelled'], 'report_ready', {}, deps()), /illegal agent run transition cancelled → report_ready/);
    await assert.rejects(transitionAgentRun(run.id, ['queued', 'deferred'], 'running', {}, deps()), /deferred → running/);
    await assert.rejects(transitionAgentRun(run.id, [], 'running', {}, deps()), /source state/);
    await assert.rejects(transitionAgentRun(run.id, ['queued'], 'deferred', {}, deps()), /deferredUntil/);
    assert.equal((await getAgentRunById(run.id, deps()))?.state, 'queued');
  });

  test('truncates long reports', async () => {
    const run = await runWithReport('x'.repeat(AGENT_REPORT_MAX_CHARS + 10));
    assert.equal(run.report?.length, AGENT_REPORT_MAX_CHARS);
    assert.equal(run.reportTruncated, true);
    const short = await runWithReport('short');
    assert.equal(short.reportTruncated, false);
  });

  test('deferring increments deferrals and due deferred runs are listed oldest first', async () => {
    const { run: a } = await createAgentRun({ definition, trigger: 'schedule' }, deps());
    const { run: b } = await createAgentRun({ definition, trigger: 'schedule' }, deps());
    const { run: c } = await createAgentRun({ definition, trigger: 'schedule' }, deps());
    await transitionAgentRun(a.id, ['queued'], 'deferred', { deferredUntil: NOW + 2000 }, deps());
    await transitionAgentRun(b.id, ['queued'], 'deferred', { deferredUntil: NOW + 1000 }, deps());
    await transitionAgentRun(c.id, ['queued'], 'deferred', { deferredUntil: NOW + 60_000 }, deps());

    assert.deepEqual((await listDueDeferredRuns(NOW + 5000, 10, deps())).map(run => run.id), [b.id, a.id]);
    assert.deepEqual((await listDueDeferredRuns(NOW + 5000, 1, deps())).map(run => run.id), [b.id]);

    await transitionAgentRun(b.id, ['deferred'], 'queued', {}, deps());
    const again = await transitionAgentRun(b.id, ['queued'], 'deferred', { deferredUntil: NOW + 3000 }, deps());
    assert.equal(again?.deferrals, 2);
  });

  test('owner scoping for reads and lists', async () => {
    const { run } = await createAgentRun({ definition, trigger: 'manual' }, deps());
    assert.equal((await getAgentRun(run.id, 'alice', deps()))?.id, run.id);
    assert.equal(await getAgentRun(run.id, 'other', deps()), undefined);
    assert.equal((await listAgentRuns(definition.id, 'other', {}, deps())).total, 0);
  });

  test('lists runs newest first with paging', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      clock = NOW + index * 1000;
      ids.push((await createAgentRun({ definition, trigger: 'manual' }, deps())).run.id);
    }
    const page = await listAgentRuns(definition.id, 'alice', { limit: 2 }, deps());
    assert.equal(page.total, 3);
    assert.deepEqual(page.runs.map(run => run.id), [ids[2], ids[1]]);
    const next = await listAgentRuns(definition.id, 'alice', { limit: 2, offset: 2 }, deps());
    assert.deepEqual(next.runs.map(run => run.id), [ids[0]]);
  });

  test('listPreviousReports returns only runs with reports, newest first, excluding the current run', async () => {
    clock = NOW;
    const oldest = await runWithReport('report 1');
    await transitionAgentRun(oldest.id, ['report_ready'], 'completed', {}, deps());
    clock = NOW + 1000;
    const rejected = await runWithReport('report 2');
    await transitionAgentRun(rejected.id, ['report_ready'], 'awaiting_approval', {}, deps());
    await transitionAgentRun(rejected.id, ['awaiting_approval'], 'rejected', {}, deps());
    clock = NOW + 2000;
    const failed = await createAgentRun({ definition, trigger: 'schedule' }, deps());
    await transitionAgentRun(failed.run.id, ['queued'], 'failed', { failureReason: 'boom' }, deps());
    await createAgentRun({ definition, trigger: 'schedule', initialState: 'skipped' }, deps());
    clock = NOW + 3000;
    const newest = await runWithReport('report 3');
    clock = NOW + 4000;
    const current = await runWithReport('current');

    const reports = await listPreviousReports(definition.id, { limit: 5, beforeCreatedAt: current.createdAt }, deps());
    assert.deepEqual(reports.map(report => report.runId), [newest.id, rejected.id, oldest.id]);
    assert.deepEqual(reports.map(report => report.report), ['report 3', 'report 2', 'report 1']);
    assert.equal(reports[0].reportedAt, NOW + 3000);

    const bounded = await listPreviousReports(definition.id, { limit: 2, excludeRunId: current.id }, deps());
    assert.deepEqual(bounded.map(report => report.runId), [newest.id, rejected.id]);
    assert.deepEqual(await listPreviousReports(definition.id, { limit: 0 }, deps()), []);
  });

  test('rowToAgentRun tolerates an unreadable snapshot and unknown values', () => {
    const run = rowToAgentRun({
      id: 'r', definition_id: 'd', owner_id: 'o', trigger: 'manual', trigger_source: null, idempotency_key: null,
      state: 'bogus', autonomy_mode: 'bogus', definition_snapshot: '{not json', report_task_id: null, action_task_id: null,
      report: null, report_truncated: 0, action_summary: null, skip_reason: null, failure_reason: null, approved_by: null,
      deferred_until: null, deferrals: 0, created_at: 1, started_at: null, reported_at: null, finished_at: null, updated_at: 1,
    } satisfies AgentRunRow);
    assert.equal(run.state, 'failed');
    assert.equal(run.autonomyMode, 'dry_run');
    assert.equal(run.definitionSnapshot, null);
    assert.equal(run.reportTruncated, false);
  });
});
