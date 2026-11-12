import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { createAgentDefinition, type StoredAgentDefinition } from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import { claimAgentRunAction, createAgentRun, transitionAgentRun, type StoredAgentRun } from '../packages/core/src/services/agents/agentRunStore.ts';
import { recordAgentRunActingMutations } from '../packages/core/src/services/agents/agentRunProductivity.ts';

/**
 * F25: a write that makes a run's productivity verdict final (its terminal
 * transition, or a late settlement of its acting count) runs in its own
 * transaction, which SQLite opens holding its write lock (`BEGIN IMMEDIATE`).
 * The pause transaction of `pauseScheduleForUnproductiveStreak` holds that
 * lock too, so such a write either commits before the pause reads the streak
 * or waits until the pause is committed.
 */

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const NOW = Date.UTC(2026, 10, 11, 22, 0);

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

async function openSqlite(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.raw('PRAGMA foreign_keys = ON');
  await database.migrate.latest({ directory: migrations });
  return database;
}

interface Fixture {
  database: Knex;
  definition: StoredAgentDefinition;
  clock: () => number;
  /** A scheduled run whose acting step is claimed and still owes its count. */
  claimedActingRun: () => Promise<StoredAgentRun>;
}

async function fixture(database: Knex): Promise<Fixture> {
  let now = NOW;
  const clock = () => now;
  const deps = { database, now: clock };
  const definition = await createAgentDefinition({
    ownerId: 'alice', name: 'Nightly triage', prompt: 'Summarize', repositories: ['acme/web'],
    scheduleCron: '0 22 * * *', scheduleEnabled: true, pauseWhenUnproductive: true,
  }, deps);
  async function reportedRun(): Promise<StoredAgentRun> {
    now += 60_000;
    const { run } = await createAgentRun({ definition, trigger: 'schedule' }, deps);
    await transitionAgentRun(run.id, ['queued'], 'running', { reportTaskId: `agent-run-${run.id}-report` }, deps);
    return (await transitionAgentRun(run.id, ['running'], 'report_ready', { report: 'A report', reportHash: 'f'.repeat(64), reportNovelty: 'unchanged' }, deps))!;
  }
  return {
    database, definition, clock,
    claimedActingRun: async () => {
      const run = await reportedRun();
      await transitionAgentRun(run.id, ['report_ready'], 'acting', {}, deps);
      return (await claimAgentRunAction(run.id, `agent-run-${run.id}-action`, deps))!;
    },
  };
}

describe('productivity-final writes run in their own transaction (F25)', () => {
  let database: Knex;
  beforeEach(async () => { database = await openSqlite(); });
  afterEach(async () => { await database.destroy(); });

  /** The statements a call issued, in order, with their transaction boundaries. */
  function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
    const statements: string[] = [];
    const listener = (query: { sql: string }) => { statements.push(query.sql.toLowerCase()); };
    database.on('query', listener);
    return run().then(() => statements).finally(() => database.removeListener('query', listener));
  }

  function assertTransactionalWrite(statements: string[], write: RegExp): void {
    const update = statements.findIndex(sql => write.test(sql));
    assert.notEqual(update, -1, `the write happened:\n${statements.join('\n')}`);
    assert.ok(statements.slice(0, update).some(sql => sql.startsWith('begin')), 'inside a transaction opened before the write');
    assert.ok(statements.slice(update).some(sql => sql.startsWith('commit')), 'committed after the write');
  }

  test('a terminal transition writes the run in its own transaction', async () => {
    const f = await fixture(database);
    const acting = await f.claimedActingRun();
    const statements = await statementsOf(() => transitionAgentRun(acting.id, ['acting'], 'completed', { actingMutations: 1, actingMutationsPending: false }, { database, now: f.clock }));
    assertTransactionalWrite(statements, /^update `agent_runs` set .*`state` = \?/);
    // Transitions that cannot decide a verdict stay a single statement.
    const { run } = await createAgentRun({ definition: f.definition, trigger: 'schedule' }, { database, now: f.clock });
    const plain = await statementsOf(() => transitionAgentRun(run.id, ['queued'], 'running', {}, { database, now: f.clock }));
    assert.ok(!plain.some(sql => sql.startsWith('begin')), plain.join('\n'));
    const reported = await statementsOf(() => transitionAgentRun(run.id, ['running'], 'report_ready', { report: 'r', reportNovelty: 'new', reportHash: 'a'.repeat(64) }, { database, now: f.clock }));
    assert.ok(!reported.some(sql => sql.startsWith('begin')), reported.join('\n'));
    for (const to of ['completed', 'failed'] as const) {
      const ended = await statementsOf(() => transitionAgentRun(run.id, ['report_ready'], to, {}, { database, now: f.clock }));
      assertTransactionalWrite(ended, /^update `agent_runs` set .*`state` = \?/);
    }
  });

  test('a late settlement of an acting count writes the run in its own transaction', async () => {
    const f = await fixture(database);
    const acting = await f.claimedActingRun();
    await transitionAgentRun(acting.id, ['acting'], 'cancelled', {}, { database, now: f.clock });
    const statements = await statementsOf(() => recordAgentRunActingMutations(acting.id, { actionTaskId: acting.actionTaskId!, actingMutations: 2 }, { database, now: f.clock }));
    assertTransactionalWrite(statements, /^update `agent_runs` set `acting_mutations` = \?/);
    assert.equal((await database('agent_runs').where({ id: acting.id }).first()).acting_mutations, 2);
  });
});
