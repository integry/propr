import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { down, up } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { GoalLifecycleService } from '../src/services/goals/goalLifecycleService.js';
import { GoalRepository } from '../src/services/goals/goalRepository.js';

function openDatabase(filename: string): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
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

test('pre-goal database upgrades, restarts from SQL, and rolls down without data loss', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-goal-migration-'));
  const filename = join(directory, 'upgrade.sqlite');
  let database = openDatabase(filename);
  try {
    const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pre-goal-schema.sql');
    const fixture = await readFile(fixturePath, 'utf8');
    for (const statement of fixture.split(';').map(value => value.trim()).filter(Boolean)) {
      await database.raw(statement);
    }

    await up(database);
    assert.deepEqual(await database('legacy_acceptance_records'), [{ id: 1, value: 'preserve-me' }]);
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
    await repository.appendEvent(goal.goalId, {
      kind: 'lifecycle', eventType: 'created', idempotencyKey: 'restart-event', ...fence,
    });
    const beforeRestart = (await new GoalLifecycleService(repository).getDetail(goal.goalId)).summary;

    await database.destroy();
    database = openDatabase(filename);
    const freshService = new GoalLifecycleService(database);
    const afterRestart = (await freshService.getDetail(goal.goalId)).summary;
    assert.deepEqual(afterRestart, beforeRestart);
    assert.equal(afterRestart.nodeCount, 1);
    assert.equal(afterRestart.latestSequence, 1);

    await down(database);
    assert.deepEqual(await database('legacy_acceptance_records'), [{ id: 1, value: 'preserve-me' }]);
    assert.deepEqual(await database.raw('PRAGMA foreign_key_check'), []);
    const goalTables = await database('sqlite_master').where({ type: 'table' }).whereLike('name', 'goal%');
    assert.deepEqual(goalTables, []);
  } finally {
    await database.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
