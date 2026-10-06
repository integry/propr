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
  await database('llm_executions').insert(rows);
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
