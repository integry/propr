import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Knex } from 'knex';
import {
  GoalWaitError,
  activeGoalWaiterCount,
  encodeGoalWaitCursor,
  notifyGoalWaiters,
  waitForGoal,
} from '../services/goalWait.js';
import { goalId, goalWaitHarness, insertGoal, openDatabase, otherGoalId, ownerId, repository } from './goalWaitHarness.js';

let db: Knex;
const { update, insertCheckpoint, wait, journal } = goalWaitHarness(() => db);

/**
 * A view of `db` that commits `write` immediately before the first journal
 * query whose SQL matches `pattern` executes, simulating a worker commit
 * landing between two of the waiter's awaited reads.
 */
function interleaveBeforeQuery(pattern: RegExp, write: () => Promise<unknown>): Knex {
  let pending = true;
  return new Proxy(db, {
    apply(target, thisArg, args: unknown[]) {
      const builder = Reflect.apply(target, thisArg, args) as Knex.QueryBuilder;
      if (args[0] !== 'goal_events') return builder;
      const run = builder.then.bind(builder);
      Object.assign(builder, {
        then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          if (!pending || !pattern.test(builder.toString())) return run(onFulfilled, onRejected);
          pending = false;
          return write().then(() => run(onFulfilled, onRejected), onRejected);
        },
      });
      return builder;
    },
  });
}

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

test('the journal records confirmed and requested lifecycle states from persisted columns only', async () => {
  await update({ claimed_at: '2026-10-04 10:00:00', started_at: '2026-10-04 10:00:00' });
  await update({ attempt_heartbeat_at: '2026-10-04 10:00:05' });
  await update({ desired_state: 'paused', paused_at: '2026-10-04 10:01:00', pause_confirmed_at: null });
  await update({ pause_confirmed_at: '2026-10-04 10:01:05' });
  await update({ pause_confirmed_at: '2026-10-04 10:01:05', updated_at: '2026-10-04 10:01:06' });
  await update({ resume_requested: true });
  await update({ desired_state: 'running', resume_requested: false, pause_confirmed_at: null, claimed_at: null });
  await update({ desired_state: 'cancelled' });
  await update({ result_state: 'cancelled' });
  assert.deepEqual(await journal(), ['queued', 'running', 'pausing', 'paused', 'resuming', 'running', 'cancelling', 'cancelled'],
    'heartbeats and re-saves of the same state append nothing');
});

test('a state condition that already holds matches immediately only without a cursor', async () => {
  await update({ claimed_at: '2026-10-04 10:00:00', started_at: '2026-10-04 10:00:00', desired_state: 'paused', pause_confirmed_at: '2026-10-04 10:01:00' });
  const immediate = await wait({ until: 'paused' });
  assert.equal(immediate.outcome, 'matched');
  assert.equal(immediate.matchedImmediately, true);
  assert.equal(immediate.event?.state, 'paused');
  assert.equal(immediate.goal.lifecycleState, 'paused');
  assert.equal(immediate.goal.pauseConfirmed, true);
  const newest = await db('goal_events').where({ goal_id: goalId }).max({ sequence: 'sequence' }).first();
  assert.equal(immediate.cursor, encodeGoalWaitCursor(goalId, Number(newest!.sequence)), 'the cursor is the captured boundary');

  const resumed = await wait({ until: 'paused', afterCursor: immediate.cursor });
  assert.equal(resumed.outcome, 'timed_out', 'with a cursor only a newer qualifying event matches');
  assert.equal(resumed.event, null);
  assert.equal(resumed.cursor, immediate.cursor);
});

test('a future transition wakes the waiter through a notification without waiting for the fallback poll', async () => {
  const started = Date.now();
  const pending = wait({ until: 'completed', timeoutSeconds: 5, pollIntervalMs: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 30));
  await update({ result_state: 'completed', completed_at: '2026-10-04 10:05:00' });
  notifyGoalWaiters(goalId);
  const result = await pending;
  assert.equal(result.outcome, 'matched');
  assert.equal(result.matchedImmediately, false);
  assert.equal(result.event?.state, 'completed');
  assert.equal(result.goal.goalCompleted, true);
  assert.ok(Date.now() - started < 2_000, 'woken by the notification');
  assert.equal(result.cursor, result.event?.cursor);
});

test('a transition committed while the waiter registers is observed even when its notification is lost', async () => {
  const cursor = (await wait({ timeoutSeconds: 0 })).cursor;
  // The subscription hook commits a transition between registration and the first read and never notifies.
  const result = await wait({
    until: 'failed', afterCursor: cursor, timeoutSeconds: 5, pollIntervalMs: 60_000,
    subscribe: () => {
      void update({ result_state: 'failed', failure_reason: 'boom' }).then(() => undefined);
      return () => {};
    },
  });
  assert.equal(result.outcome, 'matched');
  assert.equal(result.event?.state, 'failed');

  // Without a notification at all, the bounded fallback re-read still finds it.
  await update({ result_state: null });
  const boundary = (await wait({ timeoutSeconds: 0 })).cursor;
  const pending = wait({ afterCursor: boundary, timeoutSeconds: 5, pollIntervalMs: 40 });
  await new Promise(resolve => setTimeout(resolve, 20));
  await update({ result_state: 'completed' });
  const polled = await pending;
  assert.equal(polled.outcome, 'matched');
  assert.equal(polled.event?.state, 'completed');
});

test('duplicate notifications never create events or false matches', async () => {
  const before = await journal();
  const pending = wait({ until: 'completed', timeoutSeconds: 0.3, pollIntervalMs: 60_000 });
  for (let index = 0; index < 20; index++) notifyGoalWaiters(goalId);
  await new Promise(resolve => setTimeout(resolve, 20));
  for (let index = 0; index < 20; index++) notifyGoalWaiters(goalId);
  const result = await pending;
  assert.equal(result.outcome, 'timed_out');
  assert.deepEqual(await journal(), before);
});

test('pause and cancellation requests do not satisfy confirmed-state waits', async () => {
  await update({ claimed_at: '2026-10-04 10:00:00', started_at: '2026-10-04 10:00:00' });
  const cursor = (await wait({ timeoutSeconds: 0 })).cursor;
  await update({ desired_state: 'paused', paused_at: '2026-10-04 10:01:00' });
  const requested = await wait({ until: 'paused', afterCursor: cursor });
  assert.equal(requested.outcome, 'timed_out');
  assert.equal(requested.goal.lifecycleState, 'pausing');
  assert.equal(requested.goal.pauseConfirmed, false);
  await update({ pause_confirmed_at: '2026-10-04 10:01:05' });
  const confirmed = await wait({ until: 'paused', afterCursor: requested.cursor });
  assert.equal(confirmed.outcome, 'matched');
  assert.equal(confirmed.event?.previousState, 'pausing');

  await update({ desired_state: 'cancelled' });
  const cancelling = await wait({ until: 'cancelled', afterCursor: confirmed.cursor });
  assert.equal(cancelling.outcome, 'timed_out');
  assert.equal(cancelling.goal.lifecycleState, 'cancelling');
  const terminal = await wait({ until: 'terminal', afterCursor: confirmed.cursor });
  assert.equal(terminal.outcome, 'timed_out', 'a cancellation request is not terminal');
  await update({ result_state: 'cancelled' });
  const cancelled = await wait({ until: 'cancelled', afterCursor: cancelling.cursor });
  assert.equal(cancelled.outcome, 'matched');
});

test('finishing a child task does not satisfy goal completion', async () => {
  await update({ claimed_at: '2026-10-04 10:00:00', started_at: '2026-10-04 10:00:00' });
  const cursor = (await wait({ timeoutSeconds: 0 })).cursor;
  await db('tasks').insert({ task_id: 'child-task-1', repository, task_type: 'issue', correlation_id: goalId, created_at: '2026-10-04 10:01:00' });
  await db('task_history').insert({ task_id: 'child-task-1', state: 'completed', timestamp: '2026-10-04 10:02:00' });
  await update({ current_task_id: 'goal-task-child-2', updated_at: '2026-10-04 10:02:01' });
  notifyGoalWaiters(goalId);
  const result = await wait({ until: 'completed', afterCursor: cursor });
  assert.equal(result.outcome, 'timed_out');
  assert.equal(result.goal.goalCompleted, false);
});

test('checkpoint waits only return checkpoints published after the boundary', async () => {
  await insertCheckpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'completed');
  const old = await wait({ until: 'checkpoint' });
  assert.equal(old.outcome, 'timed_out', 'an existing checkpoint is never reported as new work');

  await insertCheckpoint('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'processing');
  await db('goal_checkpoints').where({ checkpoint_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }).update({ state: 'skipped' });
  const skipped = await wait({ until: 'checkpoint', afterCursor: old.cursor });
  assert.equal(skipped.outcome, 'timed_out', 'a checkpoint with nothing to commit is not published work');

  await insertCheckpoint('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'processing');
  await db('goal_checkpoints').where({ checkpoint_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }).update({ state: 'completed', commit_sha: 'def456' });
  // Re-saving a published checkpoint does not publish it twice.
  await db('goal_checkpoints').where({ checkpoint_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }).update({ state: 'failed' });
  await db('goal_checkpoints').where({ checkpoint_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }).update({ state: 'completed' });
  const published = await wait({ until: 'checkpoint', afterCursor: skipped.cursor });
  assert.equal(published.outcome, 'matched');
  assert.equal(published.event?.kind, 'checkpoint');
  assert.equal(published.event?.checkpoint?.id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(published.event?.checkpoint?.commitSha, 'def456');
  const again = await wait({ until: 'checkpoint', afterCursor: published.cursor });
  assert.equal(again.outcome, 'timed_out');
  assert.equal((await journal()).filter(entry => entry === 'checkpoint:cccccccc-cccc-4ccc-8ccc-cccccccccccc').length, 1);
});

test('resuming with a cursor replays every transition in order, across a database reconnect', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'propr-goal-wait-'));
  const filename = path.join(root, 'propr.sqlite');
  let fileDb = await openDatabase(filename);
  try {
    await insertGoal(fileDb, { claimed_at: '2026-10-04 10:00:00', started_at: '2026-10-04 10:00:00' });
    const options = (database: Knex) => ({ db: database, ownerId, goalId, repository, timeoutSeconds: 0.2, pollIntervalMs: 25 });
    const cursor = (await waitForGoal({ ...options(fileDb), timeoutSeconds: 0 })).cursor;
    // Transitions happen while no client is connected.
    const goals = () => fileDb('goals').where({ goal_id: goalId });
    await goals().update({ desired_state: 'paused' });
    await goals().update({ pause_confirmed_at: '2026-10-04 10:01:00' });
    await goals().update({ resume_requested: true });
    await goals().update({ desired_state: 'running', resume_requested: false, pause_confirmed_at: null });
    await goals().update({ result_state: 'completed' });
    await fileDb.destroy();
    fileDb = await openDatabase(filename);

    const paused = await waitForGoal({ ...options(fileDb), afterCursor: cursor, until: 'paused' });
    assert.equal(paused.outcome, 'matched', 'a pause that was already resumed is still reported to a cursor holder');
    assert.equal(paused.event?.state, 'paused');
    assert.equal(paused.goal.lifecycleState, 'completed', 'the projection is the current state');
    const next = await waitForGoal({ ...options(fileDb), afterCursor: paused.cursor });
    assert.equal(next.event?.state, 'resuming');
    const done = await waitForGoal({ ...options(fileDb), afterCursor: next.cursor, until: 'terminal' });
    assert.equal(done.event?.state, 'completed');
    const after = await waitForGoal({ ...options(fileDb), afterCursor: done.cursor, until: 'paused' });
    assert.equal(after.outcome, 'unreachable', 'a terminal goal can never confirm a pause');
  } finally {
    await fileDb.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid, wrong-goal, foreign and expired cursors fail with recovery instructions', async () => {
  await insertGoal(db, { goal_id: otherGoalId });
  const own = (await wait({ timeoutSeconds: 0 })).cursor;
  const foreign = (await wait({ goalId: otherGoalId, timeoutSeconds: 0 })).cursor;
  const rejects = async (afterCursor: string, code: string) => {
    await assert.rejects(wait({ afterCursor }), (error: unknown) => {
      assert.ok(error instanceof GoalWaitError);
      assert.equal(error.code, code);
      assert.ok(error.recovery && error.recovery.length > 20);
      return true;
    });
  };
  await rejects('not-a-cursor', 'CURSOR_INVALID');
  await rejects('gwc1.%%%', 'CURSOR_INVALID');
  await rejects(foreign, 'CURSOR_WRONG_GOAL');
  await rejects(encodeGoalWaitCursor(goalId, 9_999_999), 'CURSOR_INVALID');
  const sequence = Number(JSON.parse(Buffer.from(own.slice(5), 'base64url').toString()).s);
  // This goal's ID with another goal's position was never issued for this goal.
  const foreignSequence = Number(JSON.parse(Buffer.from(foreign.slice(5), 'base64url').toString()).s);
  await rejects(encodeGoalWaitCursor(goalId, foreignSequence), 'CURSOR_INVALID');
  await update({ desired_state: 'paused' });

  // A position freed by deleting another goal was never issued for this goal,
  // even when it falls inside this goal's sequence range: it is invalid, not expired.
  await db('goals').where({ goal_id: otherGoalId }).delete();
  assert.equal((await db('goal_events').where({ sequence: foreignSequence })).length, 0, 'the deletion cascaded');
  const range = await db('goal_events').where({ goal_id: goalId }).min({ low: 'sequence' }).max({ high: 'sequence' }).first();
  assert.ok(foreignSequence > Number(range!.low) && foreignSequence < Number(range!.high), 'the freed position lies inside this goal\'s range');
  await rejects(encodeGoalWaitCursor(goalId, foreignSequence), 'CURSOR_INVALID');
  await rejects(encodeGoalWaitCursor(goalId, Number(range!.low) - 1), 'CURSOR_INVALID');
  assert.equal((await wait({ afterCursor: own, timeoutSeconds: 0 })).outcome, 'matched', 'this goal\'s own cursor still resumes');

  // Only history trimmed from this goal's own journal expires a cursor.
  await db('goal_events').where({ goal_id: goalId }).where('sequence', '<=', sequence).delete();
  await rejects(own, 'CURSOR_EXPIRED');
  await rejects(encodeGoalWaitCursor(goalId, 9_999_999), 'CURSOR_INVALID');
});

test('a checkpoint and completion committed between journal reads are matched, not declared unreachable', async () => {
  await update({ claimed_at: '2026-10-04 10:00:00', started_at: '2026-10-04 10:00:00' });
  const cursor = (await wait({ until: 'checkpoint', timeoutSeconds: 0 })).cursor;
  // The worker publishes a checkpoint and then completes the goal after the
  // waiter's event read and before its terminal-reachability read.
  const result = await wait({
    db: interleaveBeforeQuery(/'lifecycle'/, async () => {
      await insertCheckpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'completed');
      await update({ result_state: 'completed', completed_at: '2026-10-04 10:05:00' });
    }),
    until: 'checkpoint', afterCursor: cursor, timeoutSeconds: 2, pollIntervalMs: 25,
  });
  assert.equal(result.outcome, 'matched', 'the checkpoint satisfies the wait even though the goal is now completed');
  assert.equal(result.event?.checkpoint?.id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.equal(result.cursor, result.event?.cursor);
  assert.equal(result.goal.lifecycleState, 'completed');

  const next = await wait({ until: 'checkpoint', afterCursor: result.cursor });
  assert.equal(next.outcome, 'unreachable', 'only after the checkpoint is consumed is the completed goal unreachable');
  assert.equal(next.event, null);
});

test('a transition committed after the cursorless boundary is reported once, with its own cursor', async () => {
  await update({ claimed_at: '2026-10-04 10:00:00', started_at: '2026-10-04 10:00:00' });
  // Pause is confirmed after the boundary is captured and before the immediate-match read.
  const result = await wait({
    db: interleaveBeforeQuery(/'lifecycle'/, () => update({ desired_state: 'paused', pause_confirmed_at: '2026-10-04 10:01:00' })),
    until: 'paused', timeoutSeconds: 2, pollIntervalMs: 25,
  });
  assert.equal(result.outcome, 'matched');
  assert.equal(result.event?.state, 'paused');
  assert.equal(result.matchedImmediately, false, 'the pause happened after the boundary, so it is a new event');
  assert.equal(result.cursor, result.event?.cursor, 'the returned cursor includes the reported event');

  const resumed = await wait({ until: 'paused', afterCursor: result.cursor });
  assert.equal(resumed.outcome, 'timed_out', 'resuming never replays the reported transition');
  assert.equal(resumed.event, null);
});

test('every read checks ownership, repository and caller authorization; revocation ends an open wait', async () => {
  await assert.rejects(wait({ ownerId: '999' }), { code: 'NOT_FOUND' });
  await assert.rejects(wait({ repository: 'acme/other' }), { code: 'NOT_FOUND' });

  let revoked = false;
  const pending = wait({
    timeoutSeconds: 5, pollIntervalMs: 60_000,
    authorize: async () => { if (revoked) throw new Error('ACCESS_REVOKED'); },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  revoked = true;
  await update({ desired_state: 'paused' });
  notifyGoalWaiters(goalId);
  await assert.rejects(pending, /ACCESS_REVOKED/, 'no event is delivered after access is revoked');

  const transferred = wait({ timeoutSeconds: 5, pollIntervalMs: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  await update({ owner_id: '999', desired_state: 'running' });
  notifyGoalWaiters(goalId);
  await assert.rejects(transferred, { code: 'NOT_FOUND' });
  assert.equal(activeGoalWaiterCount(goalId), 0);
});

test('cancellation, timeouts and concurrent waits release every listener and timer without touching the goal', async () => {
  const before = await db('goals').where({ goal_id: goalId }).first();
  const controller = new AbortController();
  const aborted = wait({ timeoutSeconds: 30, pollIntervalMs: 60_000, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(activeGoalWaiterCount(goalId), 1);
  controller.abort();
  await assert.rejects(aborted, { code: 'WAIT_ABORTED' });
  assert.equal(activeGoalWaiterCount(goalId), 0);
  assert.deepEqual(await db('goals').where({ goal_id: goalId }).first(), before, 'cancelling a wait never changes the goal');

  const concurrent = await Promise.all(Array.from({ length: 12 }, () => wait({ timeoutSeconds: 0.1, pollIntervalMs: 30 })));
  assert.ok(concurrent.every(result => result.outcome === 'timed_out'));
  for (let index = 0; index < 25; index++) await wait({ timeoutSeconds: 0, pollIntervalMs: 30 });
  assert.equal(activeGoalWaiterCount(), 0);

  const limited = [wait({ timeoutSeconds: 0.2, maxConcurrentPerOwner: 2 }), wait({ timeoutSeconds: 0.2, maxConcurrentPerOwner: 2 })];
  await assert.rejects(wait({ timeoutSeconds: 0.2, maxConcurrentPerOwner: 2 }), (error: unknown) => {
    assert.ok(error instanceof GoalWaitError);
    assert.equal(error.code, 'WAIT_LIMIT');
    assert.match(error.message, /2 are open across propr goal wait and MCP wait_goal/);
    return true;
  });
  await Promise.all(limited);
  assert.equal((await wait({ timeoutSeconds: 0, maxConcurrentPerOwner: 2 })).outcome, 'timed_out', 'slots are returned');
  assert.equal(activeGoalWaiterCount(), 0);
});

test('without a condition a wait returns the next durable event after the boundary', async () => {
  const boundary = await wait({ timeoutSeconds: 0 });
  assert.equal(boundary.outcome, 'timed_out');
  assert.equal(boundary.goal.lifecycleState, 'queued');
  await update({ claimed_at: '2026-10-04 10:00:00' });
  await update({ desired_state: 'paused' });
  const first = await wait({ afterCursor: boundary.cursor });
  assert.equal(first.event?.state, 'running');
  const second = await wait({ afterCursor: first.cursor });
  assert.equal(second.event?.state, 'pausing');
  assert.equal((await wait({ afterCursor: second.cursor })).outcome, 'timed_out');
});
