import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Knex } from 'knex';
import { waitForGoal } from '../services/goalWait.js';
import { goalId, insertGoal, openDatabase, otherGoalId, ownerId, repository } from './goalWaitHarness.js';

/**
 * Blockers opened before the blocker journal existed must still satisfy a
 * cursorless `until: blocked` wait once the database is upgraded, because a
 * refreshed observation of an open blocker never journals anything.
 */

const directory = fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url));
const journalMigration = '20261112000000_journal_goal_blockers.js';
const finishedGoalId = '33333333-3333-4333-8333-333333333333';
const ids = {
  current: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  staleAttempt: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  closed: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  finishedGoal: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  otherCurrent: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
};

let db: Knex;

function blocker(blockerId: string, goal: string, values: Record<string, unknown> = {}) {
  return {
    blocker_id: blockerId, goal_id: goal, owner_id: ownerId, repository, task_id: `goal-task-${goal}`,
    run_generation: 1, run_claim: 'claim-1', provider: 'claude', category: 'question', source: 'ask_operator',
    request_key: `request-${blockerId}`, summary: 'Which region?', response_actions: '["answer"]', status: 'open',
    ...values,
  };
}

const wait = (goal: string, options: { afterCursor?: string } = {}) => waitForGoal({
  db, ownerId, goalId: goal, repository, until: 'blocked', timeoutSeconds: 0.1, pollIntervalMs: 25, ...options,
});

before(async () => {
  db = await openDatabase();
  // Roll back to the schema that predates the blocker journal and open blockers there.
  await db.migrate.down({ directory, name: journalMigration });
  assert.equal(await db.schema.hasColumn('goal_events', 'blocker_id'), false);
  await insertGoal(db);
  await insertGoal(db, { goal_id: otherGoalId, run_generation: 3, run_claim: 'claim-3' });
  await insertGoal(db, { goal_id: finishedGoalId, result_state: 'completed' });
  await db('goal_blockers').insert([
    blocker(ids.staleAttempt, goalId, { run_generation: 0, run_claim: 'claim-0' }),
    blocker(ids.closed, goalId, { status: 'resolved', resolution: 'answered' }),
    blocker(ids.current, goalId),
    blocker(ids.otherCurrent, otherGoalId, { run_generation: 3, run_claim: 'claim-3' }),
    blocker(ids.finishedGoal, finishedGoalId),
  ]);
  await db.migrate.latest({ directory });
});

after(async () => {
  await db.destroy();
});

test('the upgrade journals one opening for each blocker still open for its current attempt', async () => {
  const events = await db('goal_events').where({ kind: 'blocker' }).orderBy('sequence')
    .select('goal_id', 'blocker_id', 'state', 'previous_state', 'run_generation');
  assert.deepEqual(events.map(event => ({ ...event })), [
    { goal_id: goalId, blocker_id: ids.current, state: 'open', previous_state: null, run_generation: 1 },
    { goal_id: otherGoalId, blocker_id: ids.otherCurrent, state: 'open', previous_state: null, run_generation: 3 },
  ]);
});

test('a blocker opened before the upgrade matches until blocked immediately', async () => {
  const matched = await wait(goalId);
  assert.equal(matched.outcome, 'matched');
  assert.equal(matched.matchedImmediately, true);
  assert.deepEqual(matched.event?.blocker, { id: ids.current, status: 'open', category: 'question' });

  const other = await wait(otherGoalId);
  assert.equal(other.outcome, 'matched');
  assert.equal(other.event?.blocker?.id, ids.otherCurrent);

  // A refreshed observation still journals nothing, so a cursor past the opening stays quiet.
  await db('goal_blockers').where({ blocker_id: ids.current }).update({ last_observed_at: db.fn.now() });
  assert.equal((await wait(goalId, { afterCursor: matched.cursor })).outcome, 'timed_out');

  // The backfilled opening pairs with the closing the trigger journals.
  await db('goal_blockers').where({ blocker_id: ids.current }).update({ status: 'resolved', resolution: 'answered' });
  const states = await db('goal_events').where({ blocker_id: ids.current }).orderBy('sequence').pluck('state');
  assert.deepEqual(states, ['open', 'resolved']);
  assert.equal((await wait(goalId)).outcome, 'timed_out');
});

test('a finished goal and an earlier attempt gain no opening', async () => {
  assert.equal((await wait(finishedGoalId)).outcome, 'timed_out');
  const unjournaled = await db('goal_events').whereIn('blocker_id', [ids.staleAttempt, ids.closed, ids.finishedGoal]).count({ n: '*' }).first();
  assert.equal(Number(unjournaled?.n), 0);
});
