import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { createAgentDefinition, type StoredAgentDefinition } from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import { claimAgentRunAction, createAgentRun, transitionAgentRun, type StoredAgentRun } from '../packages/core/src/services/agents/agentRunStore.ts';
import {
  findUnproductiveScheduledStreak,
  pauseScheduleForUnproductiveStreak,
  recordAgentRunActingMutations,
} from '../packages/core/src/services/agents/agentRunProductivity.ts';

/**
 * F25: a write that makes a run's productivity verdict final (its terminal
 * transition, or a late settlement of its acting count) is serialized with the
 * pause transaction of `pauseScheduleForUnproductiveStreak` through the
 * definition row's lock. Postgres locks rows, so without that shared lock the
 * pause transaction could disable a schedule on a streak that a productive run
 * had already ended before the pause was committed. The interleaving itself is
 * exercised against PostgreSQL when `PROPR_TEST_POSTGRES_URL` points at one
 * (the `pg` driver must be resolvable); on SQLite, which serializes writers,
 * the statements the lock is made of are asserted instead.
 */

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const NOW = Date.UTC(2026, 10, 11, 22, 0);
const POSTGRES_URL = process.env.PROPR_TEST_POSTGRES_URL;

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
  /** A scheduled run with an unchanged report, completed without an acting step. */
  unchangedRun: () => Promise<StoredAgentRun>;
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
    unchangedRun: async () => (await transitionAgentRun((await reportedRun()).id, ['report_ready'], 'completed', {}, deps))!,
    claimedActingRun: async () => {
      const run = await reportedRun();
      await transitionAgentRun(run.id, ['report_ready'], 'acting', {}, deps);
      return (await claimAgentRunAction(run.id, `agent-run-${run.id}-action`, deps))!;
    },
  };
}

describe('productivity-final writes take the definition lock (F25)', () => {
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

  function assertLockedWrite(statements: string[], write: RegExp): void {
    const lock = statements.findIndex(sql => sql.startsWith('select') && sql.includes('from `agent_definitions`') && sql.includes('select `definition_id` from `agent_runs`'));
    const update = statements.findIndex(sql => write.test(sql));
    assert.notEqual(lock, -1, `the definition row is locked through the run:\n${statements.join('\n')}`);
    assert.notEqual(update, -1, `the write happened:\n${statements.join('\n')}`);
    assert.ok(lock < update, 'the lock comes before the write');
    assert.ok(statements.slice(0, lock).some(sql => sql.startsWith('begin')), 'inside a transaction opened before the lock');
    assert.ok(statements.slice(update).some(sql => sql.startsWith('commit')), 'committed after the write');
  }

  test('a terminal transition locks the definition row before it writes the run', async () => {
    const f = await fixture(database);
    const acting = await f.claimedActingRun();
    const statements = await statementsOf(() => transitionAgentRun(acting.id, ['acting'], 'completed', { actingMutations: 1, actingMutationsPending: false }, { database, now: f.clock }));
    assertLockedWrite(statements, /^update `agent_runs` set .*`state` = \?/);
    // Transitions that cannot decide a verdict stay a single statement.
    const { run } = await createAgentRun({ definition: f.definition, trigger: 'schedule' }, { database, now: f.clock });
    const plain = await statementsOf(() => transitionAgentRun(run.id, ['queued'], 'running', {}, { database, now: f.clock }));
    assert.ok(!plain.some(sql => sql.startsWith('begin')), plain.join('\n'));
    const reported = await statementsOf(() => transitionAgentRun(run.id, ['running'], 'report_ready', { report: 'r', reportNovelty: 'new', reportHash: 'a'.repeat(64) }, { database, now: f.clock }));
    assert.ok(!reported.some(sql => sql.startsWith('begin')), reported.join('\n'));
    for (const to of ['completed', 'failed'] as const) {
      const ended = await statementsOf(() => transitionAgentRun(run.id, ['report_ready'], to, {}, { database, now: f.clock }));
      assertLockedWrite(ended, /^update `agent_runs` set .*`state` = \?/);
    }
  });

  test('a late settlement of an acting count locks the definition row before it writes the run', async () => {
    const f = await fixture(database);
    const acting = await f.claimedActingRun();
    await transitionAgentRun(acting.id, ['acting'], 'cancelled', {}, { database, now: f.clock });
    const statements = await statementsOf(() => recordAgentRunActingMutations(acting.id, { actionTaskId: acting.actionTaskId!, actingMutations: 2 }, { database, now: f.clock }));
    assertLockedWrite(statements, /^update `agent_runs` set `acting_mutations` = \?/);
    assert.equal((await database('agent_runs').where({ id: acting.id }).first()).acting_mutations, 2);
  });
});

/**
 * A database whose transactions run `hook` once, right after the pause transaction
 * has read the streak and before it changes the schedule: the second statement on
 * `agent_definitions` after the claim is the pending-slot reset that follows the read.
 */
function hookedAfterStreakRead(database: Knex, hook: () => Promise<void>): Knex {
  let armed = true;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return (callback: (trx: Knex.Transaction) => Promise<unknown>) => target.transaction(trx => {
        let definitionStatements = 0;
        const wrapped = new Proxy(trx, {
          apply(fn, thisArg, args: unknown[]) {
            const builder = Reflect.apply(fn, thisArg, args) as Knex.QueryBuilder;
            if (args[0] === 'agent_definitions' && ++definitionStatements === 2 && armed) {
              armed = false;
              const then = builder.then.bind(builder);
              builder.then = ((resolve?: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                hook().then(() => then(resolve, reject), reject)) as typeof builder.then;
            }
            return builder;
          },
        });
        return callback(wrapped as Knex.Transaction);
      });
    },
  });
}

describe('PostgreSQL: a productive write cannot land between the pause\'s streak read and its commit (F25)', { skip: POSTGRES_URL ? false : 'PROPR_TEST_POSTGRES_URL is not set' }, () => {
  let database: Knex;
  /** A second connection pool, as another worker: it gives up on a lock after half a second. */
  let writer: Knex;

  /** Builds the two tables the streak code touches from the SQLite migrations, so the columns never drift. */
  async function createSchema(): Promise<void> {
    const sqlite = await openSqlite();
    try {
      for (const table of ['agent_definitions', 'agent_runs']) {
        const columns = await sqlite.raw(`PRAGMA table_info(${table})`) as { name: string; type: string; pk: number }[];
        await database.schema.dropTableIfExists(table);
        await database.schema.createTable(table, builder => {
          for (const column of columns) {
            const type = column.type.toLowerCase();
            const built = type === 'boolean' ? builder.boolean(column.name)
              : type === 'integer' || type === 'bigint' ? builder.bigInteger(column.name)
                : type === 'float' || type === 'real' ? builder.double(column.name)
                  : builder.text(column.name);
            if (column.pk) built.primary();
          }
          // The idempotent run insert names this constraint.
          if (table === 'agent_runs') builder.unique(['definition_id', 'idempotency_key']);
        });
      }
    } finally {
      await sqlite.destroy();
    }
  }

  beforeEach(async () => {
    database = knex({ client: 'pg', connection: POSTGRES_URL });
    writer = knex({ client: 'pg', connection: POSTGRES_URL, pool: {
      min: 0, max: 2,
      afterCreate: (connection: { query: (sql: string, done: (error: Error | null) => void) => void }, done: (error: Error | null, connection: unknown) => void) => {
        connection.query("SET lock_timeout = '500ms'", error => done(error, connection));
      },
    } });
    await createSchema();
  });
  afterEach(async () => {
    await writer.destroy();
    await database.destroy();
  });

  const LOCK_TIMEOUT = '55P03';
  const pause = (f: Fixture) => ({ deduplicationKey: `agents:${f.definition.id}:unproductive:start`, streakKey: 'start', threshold: 2 });

  test('a terminal transition that would end the streak waits for the pause, or is seen by it', async () => {
    const f = await fixture(database);
    await f.unchangedRun();
    await f.unchangedRun();
    const acting = await f.claimedActingRun();
    assert.equal((await findUnproductiveScheduledStreak(f.definition.id, 2, { database })).reachedThreshold, true, 'the pending run is skipped');

    let interleaved: 'blocked' | 'landed' | null = null;
    const hooked = hookedAfterStreakRead(database, async () => {
      // Another worker completes the acting run productively now, after the streak was read.
      try {
        await transitionAgentRun(acting.id, ['acting'], 'completed', { actingMutations: 1, actingMutationsPending: false }, { database: writer, now: f.clock });
        interleaved = 'landed';
      } catch (error) {
        assert.equal((error as { code?: string }).code, LOCK_TIMEOUT, String(error));
        interleaved = 'blocked';
      }
    });
    assert.equal(await pauseScheduleForUnproductiveStreak(f.definition.id, pause(f), { database: hooked, now: f.clock }), 'disabled');
    assert.equal(interleaved, 'blocked', 'the productive completion could not commit before the pause was committed');
    // Released with the pause: the write lands now, after the schedule change it was too late for.
    const completed = await transitionAgentRun(acting.id, ['acting'], 'completed', { actingMutations: 1, actingMutationsPending: false }, { database: writer, now: f.clock });
    assert.equal(completed?.actingMutations, 1);

    // The other order: a productive completion committed first is seen, and the schedule is kept.
    const next = await fixture(database);
    await next.unchangedRun();
    await next.unchangedRun();
    const productive = await next.claimedActingRun();
    const seen = hookedAfterStreakRead(database, async () => undefined);
    const committedFirst = transitionAgentRun(productive.id, ['acting'], 'completed', { actingMutations: 1, actingMutationsPending: false }, { database: writer, now: next.clock });
    assert.equal((await committedFirst)?.actingMutations, 1);
    assert.equal(await pauseScheduleForUnproductiveStreak(next.definition.id, pause(next), { database: seen, now: next.clock }), 'streak_ended');
    assert.equal((await database('agent_definitions').where({ id: next.definition.id }).first()).schedule_enabled, true);
  });

  test('a late settlement of a cancelled run\'s acting count waits for the pause as well', async () => {
    const f = await fixture(database);
    await f.unchangedRun();
    await f.unchangedRun();
    const acting = await f.claimedActingRun();
    // Cancelled by its owner while its step held the grant: the count is settled later by the step's worker.
    assert.ok(await transitionAgentRun(acting.id, ['acting'], 'cancelled', {}, { database, now: f.clock }));
    assert.equal((await findUnproductiveScheduledStreak(f.definition.id, 2, { database })).runs.length, 2, 'the cancelled run still owes its count');

    let interleaved: 'blocked' | 'landed' | null = null;
    const hooked = hookedAfterStreakRead(database, async () => {
      try {
        await recordAgentRunActingMutations(acting.id, { actionTaskId: acting.actionTaskId!, actingMutations: 3 }, { database: writer, now: f.clock });
        interleaved = 'landed';
      } catch (error) {
        assert.equal((error as { code?: string }).code, LOCK_TIMEOUT, String(error));
        interleaved = 'blocked';
      }
    });
    assert.equal(await pauseScheduleForUnproductiveStreak(f.definition.id, pause(f), { database: hooked, now: f.clock }), 'disabled');
    assert.equal(interleaved, 'blocked');
    const settled = await recordAgentRunActingMutations(acting.id, { actionTaskId: acting.actionTaskId!, actingMutations: 3 }, { database: writer, now: f.clock });
    assert.equal(settled?.actingMutations, 3);
  });
});
