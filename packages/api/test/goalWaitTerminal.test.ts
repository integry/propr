import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import { activeGoalWaiterCount } from '../services/goalWait.js';
import { goalId, goalWaitHarness, insertGoal, openDatabase } from './goalWaitHarness.js';

// Projection consistency, waits resumed past a terminal event, and journal timestamps.
let db: Knex;
const { update, insertCheckpoint, wait, journal } = goalWaitHarness(() => db);

before(async () => {
  db = await openDatabase();
});

beforeEach(async () => {
  await db('goals').delete();
  await insertGoal(db);
});

after(async () => {
  await db.destroy();
  assert.equal(activeGoalWaiterCount(), 0, 'no wake listener outlives its wait');
});

test('the goal projection is built from one goal row, so its completion fields always agree', async () => {
  await update({ claimed_at: '2026-10-04 10:00:00', started_at: '2026-10-04 10:00:00' });
  const cursor = (await wait({ timeoutSeconds: 0 })).cursor;
  await insertCheckpoint('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'completed');

  // The worker completes the goal immediately after the projection's goal row
  // is read. Reads of the goal row: initial authorization, then the projection.
  let goalReads = 0;
  const completingAfterProjectionRead = new Proxy(db, {
    apply(target, thisArg, args: unknown[]) {
      const builder = Reflect.apply(target, thisArg, args) as Knex.QueryBuilder;
      if (args[0] !== 'goals') return builder;
      const run = builder.then.bind(builder);
      Object.assign(builder, {
        then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          if (++goalReads !== 2) return run(onFulfilled, onRejected);
          return run(async (row: unknown) => {
            await update({ result_state: 'completed', completed_at: '2026-10-04 10:05:00', final_pr_number: 7 });
            return row;
          }).then(onFulfilled, onRejected);
        },
      });
      return builder;
    },
  });
  const result = await wait({ db: completingAfterProjectionRead, until: 'checkpoint', afterCursor: cursor, timeoutSeconds: 2 });
  assert.equal(result.outcome, 'matched');
  assert.equal(goalReads, 2, 'completion was committed after the projection read');
  assert.equal((await journal()).at(-1), 'completed', 'the completion event is already journaled');
  assert.deepEqual(
    { lifecycleState: result.goal.lifecycleState, resultState: result.goal.resultState, terminal: result.goal.terminal,
      goalCompleted: result.goal.goalCompleted, completedAt: result.goal.completedAt, finalPr: result.goal.finalPr },
    { lifecycleState: 'running', resultState: null, terminal: false, goalCompleted: false, completedAt: null, finalPr: null },
    'every field describes the same goal row; none comes from a newer journal read',
  );

  // The completion is not lost: it is the next event after the returned cursor.
  const next = await wait({ until: 'terminal', afterCursor: result.cursor });
  assert.equal(next.outcome, 'matched');
  assert.deepEqual(
    { lifecycleState: next.goal.lifecycleState, resultState: next.goal.resultState, terminal: next.goal.terminal,
      goalCompleted: next.goal.goalCompleted, completedAt: next.goal.completedAt, finalPr: next.goal.finalPr },
    { lifecycleState: 'completed', resultState: 'completed', terminal: true, goalCompleted: true,
      completedAt: '2026-10-04 10:05:00', finalPr: { number: 7, url: null } },
  );

  // A historical event may be older than the projection, and the projection still agrees with itself.
  await update({ desired_state: 'paused', pause_confirmed_at: '2026-10-04 10:06:00' });
  const replayed = await wait({ afterCursor: cursor, until: 'checkpoint' });
  assert.equal(replayed.event?.kind, 'checkpoint');
  assert.equal(replayed.goal.lifecycleState, 'completed');
  assert.equal(replayed.goal.pauseConfirmed, false, 'a terminal goal is never reported as a confirmed pause');
});

for (const terminalState of ['completed', 'failed', 'cancelled'] as const) {
  test(`resuming past a consumed ${terminalState} event is unreachable at once instead of waiting out the timeout`, async () => {
    await update({ claimed_at: '2026-10-04 10:00:00', started_at: '2026-10-04 10:00:00' });
    const start = (await wait({ timeoutSeconds: 0 })).cursor;
    await update({ result_state: terminalState, completed_at: '2026-10-04 10:05:00' });

    // An unconsumed terminal event still matches, for the exact state and for `terminal`.
    for (const until of [terminalState, 'terminal'] as const) {
      const matched = await wait({ until, afterCursor: start, timeoutSeconds: 30 });
      assert.equal(matched.outcome, 'matched');
      assert.equal(matched.event?.state, terminalState);
    }
    // A cursorless wait still matches the state the goal already holds.
    const immediate = await wait({ until: 'terminal', timeoutSeconds: 30 });
    assert.equal(immediate.outcome, 'matched');
    assert.equal(immediate.matchedImmediately, true);

    // Cursors at the terminal event: from the matched event, from an immediate
    // match, and from a condition-less wait that reported the event.
    const consumed = (await wait({ until: terminalState, afterCursor: start })).cursor;
    const reported = await wait({ afterCursor: start });
    assert.equal(reported.event?.state, terminalState);
    for (const afterCursor of [consumed, immediate.cursor, reported.cursor]) {
      for (const until of [terminalState, 'terminal', 'checkpoint', 'paused', undefined] as const) {
        const startedAt = Date.now();
        // A fallback poll far beyond the test proves the wait never sleeps.
        const result = await wait({ until, afterCursor, timeoutSeconds: 30, pollIntervalMs: 60_000 });
        assert.equal(result.outcome, 'unreachable', `until ${until ?? 'any event'}`);
        assert.equal(result.event, null);
        assert.equal(result.matchedImmediately, false);
        assert.equal(result.cursor, afterCursor, 'the cursor does not move');
        assert.equal(result.goal.lifecycleState, terminalState);
        assert.equal(result.goal.terminal, true);
        assert.ok(Date.now() - startedAt < 5_000, 'returned without blocking');
      }
    }
    assert.equal(activeGoalWaiterCount(goalId), 0);
  });
}

test('journal timestamps use the same format as goal and checkpoint timestamps', async () => {
  const sqliteTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const cursor = (await wait({ timeoutSeconds: 0 })).cursor;
  await update({ claimed_at: db.fn.now(), started_at: db.fn.now(), updated_at: db.fn.now() });
  const lifecycle = await wait({ afterCursor: cursor });
  assert.match(lifecycle.event!.occurredAt, sqliteTimestamp);
  assert.match(String(lifecycle.goal.updatedAt), sqliteTimestamp);
  await insertCheckpoint('ffffffff-ffff-4fff-8fff-ffffffffffff', 'completed');
  const checkpoint = await wait({ afterCursor: lifecycle.cursor, until: 'checkpoint' });
  assert.match(checkpoint.event!.occurredAt, sqliteTimestamp);
  const created = await db('goal_events').where({ goal_id: goalId }).orderBy('sequence').first('created_at');
  assert.match(created!.created_at, sqliteTimestamp, 'the goal\'s first event uses it too');
});
