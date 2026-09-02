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
import { up as simplifyGoalFoundation } from '../src/db/migrations/20260902000000_simplify_goal_foundation.js';

const GOAL_MIGRATION = '20260831000000_create_goal_control_plane.js';
const GOAL_CORRECTION_MIGRATION = '20260902000000_simplify_goal_foundation.js';
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
      : migrations.filter((name) => ![GOAL_MIGRATION, GOAL_CORRECTION_MIGRATION].includes(name));
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
    const retiredHierarchy = await database('sqlite_master').where({ type: 'table' })
      .whereIn('name', ['goal_nodes', 'goal_node_dependencies']).pluck('name');
    assert.deepEqual(retiredHierarchy, []);

    const repository = new GoalRepository(database);
    const goal = await repository.createGoal({
      ownerUserId: 'restart-owner', repository: 'octo/repo', objective: 'Restart acceptance',
      agent: 'claude', requestedModel: 'claude-opus-4-8', idempotencyKey: 'restart-create',
    });
    const lease = await repository.claimLease(goal.goalId, 'restart-controller', 60_000);
    const fence = { leaseOwner: 'restart-controller', leaseEpoch: lease.epoch };
    await repository.appendInternalEvent(goal.goalId, {
      kind: 'lifecycle', eventType: 'created', idempotencyKey: 'restart-event', ...fence,
    });
    const beforeRestart = (await new GoalLifecycleService(repository).getDetail(goal.goalId)).summary;

    await database.destroy();
    database = openDatabase(filename, true);
    await applyDatabaseMigrations(database);
    const afterRestart = (await new GoalLifecycleService(database).getDetail(goal.goalId)).summary;
    assert.deepEqual(afterRestart, beforeRestart);
    assert.equal(afterRestart.planProgress, null);
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

test('obsolete branch schemas fail without rewriting unknown session or event data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-goal-branch-upgrade-'));
  const database = openDatabase(join(directory, 'legacy.sqlite'), false);
  try {
    await database.schema.createTable('goals', (table) => {
      table.text('goal_id').primary();
    });
    await database.schema.createTable('goal_events', (table) => {
      table.increments('id').primary();
      table.text('goal_id').notNullable();
      table.integer('sequence').notNullable();
      table.text('source').notNullable();
      table.text('kind').notNullable();
      table.text('event_type').notNullable();
      table.text('payload_json').nullable();
      table.text('idempotency_key').notNullable();
      table.integer('lease_epoch').notNullable();
      table.text('created_at').notNullable();
    });
    await database.schema.createTable('goal_nodes', (table) => {
      table.text('node_id').primary();
      table.text('goal_id').notNullable();
    });
    await database.schema.createTable('goal_provider_sessions', (table) => {
      table.text('session_id').primary();
      table.text('goal_id').notNullable();
      table.text('sibling_session_column').notNullable();
    });

    await database('goals').insert({ goal_id: 'legacy-goal' });
    await database('goal_events').insert({
      goal_id: 'legacy-goal', sequence: 1, source: 'sibling-provider', kind: 'lifecycle',
      event_type: 'created', payload_json: null, idempotency_key: 'legacy-event',
      lease_epoch: 1, created_at: '2026-09-01T00:00:00.000Z',
    });
    await database('goal_nodes').insert({ node_id: 'old-node', goal_id: 'legacy-goal' });
    await database('goal_provider_sessions').insert({
      session_id: 'legacy-session', goal_id: 'legacy-goal',
      sibling_session_column: 'must-survive',
    });

    await assert.rejects(
      simplifyGoalFoundation(database),
      /Unsupported unreleased goal branch schema.*unconstrained goal_events.source.*rebase #2059 and #2065/
    );
    assert.equal(await database.schema.hasTable('goal_nodes'), true);
    const event = await database('goal_events').first();
    assert.equal(event.idempotency_key, 'legacy-event');
    assert.equal(event.source, 'sibling-provider');
    assert.equal(
      (await database('goal_provider_sessions').first()).sibling_session_column,
      'must-survive'
    );
  } finally {
    await database.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
