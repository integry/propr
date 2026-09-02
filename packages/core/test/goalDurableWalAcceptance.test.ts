import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import knex, { type Knex } from 'knex';
import type { BetterSqliteConnection } from '../src/db/connection.js';
import { up as foundation } from '../src/db/migrations/20260831000000_create_goal_control_plane.js';
import { up as durable } from '../src/db/migrations/20260901000000_add_durable_goal_replay.js';
import { GoalRepository } from '../src/services/goals/goalRepository.js';

function openWal(filename: string): Knex {
  return knex({
    client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true,
    pool: {
      min: 1, max: 1,
      afterCreate(connection: BetterSqliteConnection, done) {
        connection.pragma('journal_mode = WAL');
        connection.pragma('foreign_keys = ON');
        connection.pragma('busy_timeout = 5000');
        done(null, connection);
      },
    },
  });
}

test('two WAL controllers allocate one durable total order and survive restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goal-durable-wal-'));
  const filename = join(directory, 'goal.sqlite');
  let first = openWal(filename);
  let second: Knex | undefined;
  try {
    await foundation(first);
    await durable(first);
    const setup = new GoalRepository(first);
    const goal = await setup.createGoal({
      ownerUserId: 'owner', repository: 'integry/propr', objective: 'WAL ordering',
      agent: 'codex', requestedModel: 'gpt-5.6-sol',
    });
    const lease = await setup.claimLease(goal.goalId, 'controller', 60_000);
    const fence = { leaseOwner: 'controller', leaseEpoch: lease.epoch };
    await setup.upsertProviderSession(goal.goalId, 'codex', {
      ...fence, turnId: 'turn', executionId: 'execution', attemptId: 'attempt',
    });
    const session = await setup.getProviderSession(goal.goalId, 'codex');
    assert(session);
    second = openWal(filename);
    const repositories = [new GoalRepository(first), new GoalRepository(second)];
    await Promise.all(repositories.map((repository, index) => repository.appendTypedEvent(goal.goalId, {
      schemaVersion: 1, type: 'provider.output',
      payload: { stream: 'stdout', outputType: 'text', chunk: `controller-${index}` },
      idempotencyKey: `wal-${index}`, ...fence,
      source: {
        sessionId: session.session_id, turnId: 'turn', executionId: 'execution',
        attemptId: 'attempt', providerSequence: index, chunkIndex: 0,
        leaseGeneration: lease.epoch,
      },
    })));
    assert.deepEqual((await setup.readEventPage(goal.goalId)).events.map(event => event.sequence), [1, 2]);
    await first.destroy();
    await second.destroy();
    second = undefined;
    first = openWal(filename);
    const restarted = new GoalRepository(first);
    assert.equal(await restarted.getLatestSequence(goal.goalId), 2);
    assert.deepEqual((await restarted.readEventPage(goal.goalId)).events.map(event => event.sequence), [1, 2]);
  } finally {
    await first.destroy();
    if (second) await second.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
