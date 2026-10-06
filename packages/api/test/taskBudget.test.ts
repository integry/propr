import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { loadTaskBudget } from '../routes/taskBudget.js';

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

async function executionsDatabase(rows: Array<{ task_id: string; cost_usd: number }>): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('llm_executions', table => {
    table.increments('execution_id');
    table.text('task_id');
    table.float('cost_usd');
  });
  if (rows.length) await database('llm_executions').insert(rows);
  return database;
}

const exceededHistory = (budget: Record<string, unknown>) => [
  { state: 'claude_execution', metadata: { event: 'budget.exceeded', budget } },
];

test('a retry stopped at its cap still counts the earlier attempt after the Redis cap record expires', async () => {
  const db = await executionsDatabase([{ task_id: 'attempt-1', cost_usd: 4 }, { task_id: 'retry-1', cost_usd: 1.2 }, { task_id: 'other', cost_usd: 9 }]);
  const expiredRedis = { get: async () => null };
  const history = exceededHistory({ capUsd: 5, spentUsd: 5.2, priorSpentUsd: 4, percent: 104, source: 'workflow', budgetTaskIds: ['attempt-1'] });
  const budget = await loadTaskBudget(db, expiredRedis, 'retry-1', history);
  assert.deepEqual(budget, { spentUsd: 5.2, capUsd: 5, percent: 104, source: 'workflow', exceeded: true });
  await db.destroy();
});

test('the Redis cap record and the timeline event are combined without counting an attempt twice', async () => {
  const db = await executionsDatabase([{ task_id: 'attempt-1', cost_usd: 4 }, { task_id: 'retry-1', cost_usd: 1.2 }]);
  const redis = { get: async () => JSON.stringify({ capUsd: 5, source: 'override', budgetTaskIds: ['attempt-1'] }) };
  const history = exceededHistory({ capUsd: 5, spentUsd: 5.2, source: 'override', budgetTaskIds: ['attempt-1', 'retry-1'] });
  const budget = await loadTaskBudget(db, redis, 'retry-1', history);
  assert.equal(budget?.spentUsd, 5.2);
  assert.equal(budget?.percent, 104);
  await db.destroy();
});

test('a run stopped at its cap keeps the spend the guard observed when its executions were never recorded', async () => {
  const db = await executionsDatabase([]);
  const history = exceededHistory({ capUsd: 5, spentUsd: 5.2, percent: 104, source: 'override' });
  const budget = await loadTaskBudget(db, { get: async () => null }, 'task-1', history);
  assert.deepEqual(budget, { spentUsd: 5.2, capUsd: 5, percent: 104, source: 'override', exceeded: true });
  await db.destroy();
});

test('observed and recorded spend are reconciled, not added together', async () => {
  const db = await executionsDatabase([{ task_id: 'task-1', cost_usd: 2 }]);
  const partlyRecorded = await loadTaskBudget(db, { get: async () => null }, 'task-1', exceededHistory({ capUsd: 5, spentUsd: 5.2, source: 'override' }));
  assert.equal(partlyRecorded?.spentUsd, 5.2);
  assert.equal(partlyRecorded?.percent, 104);
  await db('llm_executions').insert({ task_id: 'task-1', cost_usd: 3.5 });
  const recordedLater = await loadTaskBudget(db, { get: async () => null }, 'task-1', exceededHistory({ capUsd: 5, spentUsd: 5.2, source: 'override' }));
  assert.equal(recordedLater?.spentUsd, 5.5);
  assert.equal(recordedLater?.percent, 110);
  await db.destroy();
});

test('an invalid observed spend in the exceeded event is ignored', async () => {
  const db = await executionsDatabase([{ task_id: 'task-1', cost_usd: 1 }]);
  for (const spentUsd of ['9', -3, Number.NaN, null]) {
    const budget = await loadTaskBudget(db, { get: async () => null }, 'task-1', exceededHistory({ capUsd: 5, spentUsd, source: 'override' }));
    assert.equal(budget?.spentUsd, 1);
    assert.equal(budget?.percent, 20);
  }
  await db.destroy();
});
