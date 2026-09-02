import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { applyDatabaseMigrations } from '../src/db/migrationGate.js';
import { GoalLifecycleService } from '../src/services/goals/goalLifecycleService.js';
import { GoalRepository } from '../src/services/goals/goalRepository.js';

const GOAL_MIGRATION = '20260831000000_create_goal_control_plane.js';
const DURABLE_MIGRATIONS = new Set([
  '20260901000000_add_durable_goal_replay.js',
  '20260901010000_harden_durable_goal_replay.js',
]);
const MIGRATIONS_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'migrations'
);

class GoalMigrationSource implements Knex.MigrationSource<string> {
  constructor(private readonly includeGoalMigration: boolean) {}

  async getMigrations(): Promise<string[]> {
    const migrations = (await readdir(MIGRATIONS_DIRECTORY))
      .filter((name) => name.endsWith('.js'))
      .sort();
    return this.includeGoalMigration
      ? migrations
      : migrations.filter((name) => name !== GOAL_MIGRATION && !DURABLE_MIGRATIONS.has(name));
  }

  getMigrationName(migration: string): string {
    return migration;
  }

  async getMigration(migration: string): Promise<Knex.Migration> {
    return import(pathToFileURL(join(MIGRATIONS_DIRECTORY, migration)).href) as Promise<Knex.Migration>;
  }
}

function openDatabase(filename: string, includeGoalMigration: boolean): Knex {
  const migrations: Knex.MigratorConfig = includeGoalMigration
    ? { directory: MIGRATIONS_DIRECTORY, tableName: 'knex_migrations' }
    : {
      migrationSource: new GoalMigrationSource(false),
      tableName: 'knex_migrations',
    };
  return knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    migrations,
    pool: {
      min: 1,
      max: 1,
      afterCreate(
        connection: BetterSqliteConnection,
        done: (error: Error | null, connection: BetterSqliteConnection) => void
      ) {
        connection.pragma('journal_mode = WAL');
        connection.pragma('foreign_keys = ON');
        connection.pragma('busy_timeout = 5000');
        done(null, connection);
      },
    },
  });
}

test('real pre-goal Knex chain passes the migration gate, reopen, and rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-goal-migration-'));
  const filename = join(directory, 'upgrade.sqlite');
  let database = openDatabase(filename, false);
  try {
    await database.migrate.latest();
    const preGoalMigrations = await database('knex_migrations').orderBy('id');
    assert.equal(preGoalMigrations.some((row) => row.name === GOAL_MIGRATION), false);
    assert.equal(preGoalMigrations.length, (await new GoalMigrationSource(false).getMigrations()).length);
    await database('system_configs').insert({
      key: 'goal-migration-acceptance',
      value: JSON.stringify({ preserve: true }),
    });

    await database.destroy();
    database = openDatabase(filename, true);
    await applyDatabaseMigrations(database);
    const migratedRows = await database('knex_migrations').orderBy('id');
    const goalMigrationRow = migratedRows.find((row) => row.name === GOAL_MIGRATION);
    assert.ok(goalMigrationRow);
    assert.ok(goalMigrationRow.batch > preGoalMigrations.at(-1)!.batch);
    assert.deepEqual(await database.raw('PRAGMA foreign_key_check'), []);
    const eventForeignKeys = await database.raw("PRAGMA foreign_key_list('goal_events')") as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    assert.ok(eventForeignKeys.some((foreignKey) => foreignKey.table === 'goals'
      && foreignKey.from === 'goal_id' && foreignKey.to === 'goal_id'
      && foreignKey.on_delete === 'CASCADE'));
    const indexes = await database('sqlite_master').where({ type: 'index' }).whereIn('name', [
      'goals_owner_state_idx',
      'goal_events_goal_sequence_idx',
      'goal_messages_goal_sequence_idx',
      'goal_pause_intervals_open_idx',
    ]).pluck('name');
    assert.deepEqual(indexes.sort(), [
      'goal_events_goal_sequence_idx',
      'goal_messages_goal_sequence_idx',
      'goal_pause_intervals_open_idx',
      'goals_owner_state_idx',
    ]);

    const repository = new GoalRepository(database);
    const goal = await repository.createGoal({
      ownerUserId: 'restart-owner', repository: 'octo/repo', objective: 'Restart acceptance',
      agent: 'claude', requestedModel: 'claude-opus-4-8', idempotencyKey: 'restart-create',
    });
    const lease = await repository.claimLease(goal.goalId, 'restart-controller', 60_000);
    const fence = { leaseOwner: 'restart-controller', leaseEpoch: lease.epoch };
    await repository.addNode(goal.goalId, {
      kind: 'root_epic', status: 'in_progress', idempotencyKey: 'restart-node', ...fence,
    });
    await repository.upsertProviderSession(goal.goalId, 'claude', {
      ...fence, turnId: 'turn-1', executionId: 'execution-1', attemptId: 'attempt-1',
    });
    const session = await repository.getProviderSession(goal.goalId, 'claude');
    assert(session);
    await repository.appendTypedEvent(goal.goalId, {
      schemaVersion: 1, type: 'checkpoint.saved', payload: { checkpointId: 'restart' },
      idempotencyKey: 'restart-event', ...fence,
      source: {
        sessionId: session.session_id, turnId: 'turn-1', executionId: 'execution-1',
        attemptId: 'attempt-1', providerSequence: 1, chunkIndex: 0,
        leaseGeneration: fence.leaseEpoch,
      },
    });
    const beforeRestart = (await new GoalLifecycleService(repository).getDetail(goal.goalId)).summary;

    await database.destroy();
    database = openDatabase(filename, true);
    await applyDatabaseMigrations(database);
    const afterRestart = (await new GoalLifecycleService(database).getDetail(goal.goalId)).summary;
    assert.deepEqual(afterRestart, beforeRestart);
    assert.equal(afterRestart.nodeCount, 1);
    assert.equal(afterRestart.latestSequence, 1);

    await database.migrate.rollback();
    assert.equal((await database('knex_migrations').where({ name: GOAL_MIGRATION })).length, 0);
    assert.equal((await database('knex_migrations')).length, preGoalMigrations.length);
    assert.equal((await database('system_configs').where({ key: 'goal-migration-acceptance' })).length, 1);
    assert.deepEqual(await database.raw('PRAGMA foreign_key_check'), []);
    const goalTables = await database('sqlite_master').where({ type: 'table' }).whereLike('name', 'goal%');
    assert.deepEqual(goalTables, []);
  } finally {
    await database.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
