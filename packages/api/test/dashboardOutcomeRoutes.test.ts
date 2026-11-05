import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import { createDashboardRoutes } from '../routes/dashboardRoutes.js';
import {
  advanceOutcomeProjection, compactOutcome, installOutcomeProjection, loadCompletedRows,
  loadOutcomeSummaries, OUTCOME_TABLES as T, rebuildOutcomeProjection,
} from '../routes/dashboardOutcomeQueries.js';
import {
  NOW,
  call,
  createDashboardTestDatabase,
  minutesAgo,
  seedTask,
} from './dashboardTestHarness.js';

let database: Knex;

before(async () => { database = await createDashboardTestDatabase(); });
after(async () => database.destroy());

async function drainProjection(db: Knex) {
  for (let attempts = 0; attempts < 20; attempts++) {
    if (!await advanceOutcomeProjection(db)) return;
  }
  assert.fail('projection did not drain');
}

for (const scenario of ['transfer', 'same entity', 'empty former entity', 'reused history ID'] as const) {
  test(`completion ownership reconciliation: ${scenario}`, async () => {
    const db = await createDashboardTestDatabase();
    try {
      await seedTask(db, { taskId: 'a', repository: 'acme/new', states: [{ state: 'completed', timestamp: minutesAgo(5) }] });
      await seedTask(db, { taskId: 'z', repository: scenario === 'same entity' ? 'acme/new' : 'acme/old', states: [
        ...(scenario === 'empty former entity' ? [] : [{ state: 'completed', timestamp: minutesAgo(4) }, { state: 'pending', timestamp: minutesAgo(3) }]),
        { state: 'completed', timestamp: minutesAgo(1), metadata: { notificationRecap: 'Transferred completion.' } },
      ] });
      await installOutcomeProjection(db);
      await drainProjection(db);
      const before = await loadOutcomeSummaries(db, 'all');
      const history = await db('task_history').where({ task_id: 'z', state: 'completed' }).orderBy('history_id', 'desc').first();
      if (scenario === 'reused history ID') {
        await db('task_history').where('history_id', history.history_id).delete();
        await db('task_history').insert({ ...history, task_id: 'a' });
      } else {
        await db('task_history').where('history_id', history.history_id).update({ task_id: 'a' });
      }
      // Make the reported queue ordering deterministic even across a clock tick.
      await db(T.dirty).update({ changed_at: 1 });
      const formerDirty = await db(T.dirty).where('task_id', 'z').first();
      await db(T.outbox).delete();
      assert.equal(await advanceOutcomeProjection(db), true);
      assert.equal((await db(T.runs).where('completion_id', history.history_id).first()).task_id, 'a');
      assert.equal(await db(T.dirty).where('task_id', 'a').first(), undefined);
      assert.deepEqual(await db(T.dirty).where('task_id', 'z').first(), formerDirty, 'former task still needs its own source reconciliation');
      const after = await loadOutcomeSummaries(db, 'all');
      const oracle = await loadCompletedRows(db, 'all');
      assert.deepEqual(after.map(row => ({ ...compactOutcome(row), eventCount: row.eventCount })),
        oracle.map(row => ({ ...compactOutcome(row), eventCount: row.eventCount })));
      for (const entity of after) assert.notEqual(entity.revision, before.find(row => row.entityId === entity.entityId)?.revision);
      assert.deepEqual((await db(T.outbox).orderBy('repository')).map(row => row.repository),
        scenario === 'same entity' ? ['acme/new'] : ['acme/new', 'acme/old']);
      await drainProjection(db);
      assert.equal((await db(T.dirty)).length, 0);
      await seedTask(db, { taskId: 'later', issueNumber: 20, states: [{ state: 'completed', timestamp: minutesAgo(0) }] });
      await drainProjection(db);
      assert.equal((await loadOutcomeSummaries(db, 'all'))[0].taskId, 'later');
    } finally { await db.destroy(); }
  });
}

for (const boundaryChange of ['transfer again', 'rebuild'] as const) {
  test(`ownership reconciliation rejects a snapshot invalidated by ${boundaryChange}`, async t => {
    const db = await createDashboardTestDatabase();
    try {
      for (const taskId of ['a', 'z']) await seedTask(db, { taskId, issueNumber: taskId === 'a' ? 1 : 2,
        states: [{ state: 'completed', timestamp: minutesAgo(1) }] });
      await installOutcomeProjection(db);
      await drainProjection(db);
      const history = await db('task_history').where('task_id', 'z').first();
      await db('task_history').where('history_id', history.history_id).update({ task_id: 'a' });
      await db(T.dirty).update({ changed_at: 1 });
      const transaction = db.transaction.bind(db);
      const interception = t.mock.method(db, 'transaction', async (...args: Parameters<typeof db.transaction>) => {
        const result = await transaction(...args);
        interception.mock.restore();
        // The read snapshot has closed; mutate before the writer acquires its lock.
        if (boundaryChange === 'rebuild') await rebuildOutcomeProjection(db);
        else await db('task_history').where('history_id', history.history_id).update({ task_id: 'z' });
        return result;
      });
      await advanceOutcomeProjection(db);
      assert.deepEqual((await db(T.dirty).orderBy('task_id')).map(row => row.task_id), ['a', 'z']);
      assert.equal((await db(T.runs).where('completion_id', history.history_id).first())?.task_id,
        boundaryChange === 'rebuild' ? undefined : 'z');
      await drainProjection(db);
      assert.equal((await db(T.dirty)).length, 0);
      const summaries = await loadOutcomeSummaries(db, 'all');
      const oracle = await loadCompletedRows(db, 'all');
      assert.deepEqual(summaries.map(compactOutcome), oracle.map(compactOutcome));
    } finally { await db.destroy(); }
  });
}

test('outcomes exclude operational handoffs without letting them consume the result limit', async () => {
  const handoffs = Array.from({ length: 30 }, (_, index) => ({
    taskId: `lock-handoff-${index}`,
    issueNumber: 2513,
    taskType: 'pr-comment',
    states: [{
      state: 'cancelled',
      timestamp: minutesAgo(index + 1),
      reason: index % 2 === 0
        ? 'PR comment job rescheduled: pr_locked_by_other_job'
        : 'Task handed to another attempt',
      metadata: index % 2 === 0 ? {} : { jobResultStatus: 'rescheduled' },
    }],
  }));
  for (const handoff of handoffs) await seedTask(database, handoff);

  await seedTask(database, {
    taskId: 'meaningful-completion',
    issueNumber: 2506,
    taskType: 'pr-comment',
    states: [{ state: 'completed', timestamp: minutesAgo(40), reason: 'Review processing completed successfully' }],
  });
  await seedTask(database, {
    taskId: 'user-cancelled',
    issueNumber: 2507,
    taskType: 'pr-comment',
    states: [{ state: 'cancelled', timestamp: minutesAgo(35), reason: 'Cancelled by user' }],
  });

  const dashboard = createDashboardRoutes({
    db: database,
    redisClient: {} as RedisClientType,
    taskQueue: {} as never,
    liveDetails: async () => null,
    now: () => NOW,
  });
  const outcomes = await call(dashboard.getOutcomes, { repository: 'all', limit: '2' });
  const items = outcomes.body.items as Array<Record<string, unknown>>;
  // Only completions are outcomes: neither the handoffs nor the user's
  // cancellation is listed, and the handoffs do not use up the limit.
  assert.deepEqual(items.map(item => item.taskId), ['meaningful-completion']);
  assert.deepEqual(items.map(item => item.prNumber), [2506]);
});

test('outcomes identify issue-typed historical PR-comment tasks by their task ID', async () => {
  const repository = 'integry/legacy-pr-comments';
  await seedTask(database, {
    taskId: 'pr-comments-batch-integry-propr-2506-5831013617-2026-09-25T10-37-33Z-87ecb969a008',
    repository,
    issueNumber: 2506,
    taskType: 'issue',
    states: [{ state: 'completed', timestamp: minutesAgo(5), reason: 'PR comment job completed' }],
  });
  await seedTask(database, {
    taskId: 'issue-integry-propr-2507-claude-opus-5-5-legacy',
    repository,
    issueNumber: 2507,
    taskType: 'issue',
    states: [{ state: 'completed', timestamp: minutesAgo(6), reason: 'Task completed successfully' }],
  });

  const dashboard = createDashboardRoutes({
    db: database,
    redisClient: {} as RedisClientType,
    taskQueue: {} as never,
    liveDetails: async () => null,
    now: () => NOW,
  });
  const outcomes = await call(dashboard.getOutcomes, { repository, limit: '10' });
  const items = outcomes.body.items as Array<Record<string, unknown>>;
  assert.deepEqual(items.map(item => [item.issueNumber, item.prNumber]), [
    [2506, 2506],
    [2507, null],
  ]);
});
