import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { taskComputeUsage } from '../mcp/taskComputeUsage.js';

let db: Knex;

before(async () => {
  db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  await db('tasks').insert([
    { task_id: 'measured', repository: 'acme/a', task_type: 'issue' },
    { task_id: 'unmeasured', repository: 'acme/a', task_type: 'issue' },
  ]);
  const execution = (taskId: string, values: Record<string, unknown>) => ({
    task_id: taskId, start_time: '2026-11-24T00:00:00.000Z', model_name: 'opus', success: true, num_turns: 1, ...values,
  });
  await db('llm_executions').insert([
    execution('measured', {
      cost_usd: 1.5, compute_runtime: 'docker', compute_wall_time_ms: 60_000, compute_queue_ms: 800, compute_cpu_seconds: 20.25,
      compute_peak_memory_bytes: 512, compute_avg_memory_bytes: 256,
    }),
    execution('measured', {
      cost_usd: 0.5, compute_runtime: 'fly', compute_wall_time_ms: 30_000, compute_cpu_seconds: null,
      compute_peak_memory_bytes: 2048, compute_cost_usd: 0.004, compute_cost_source: 'rate_table',
    }),
    // A run from before compute usage was recorded: counted in the LLM cost, not in compute.
    execution('measured', { cost_usd: 1 }),
    execution('unmeasured', { cost_usd: 2 }),
  ]);
});

after(async () => { await db.destroy(); });

test('get_task compute usage sums measured runs beside the LLM cost of the same task', async () => {
  assert.deepEqual(await taskComputeUsage(db, 'measured'), {
    runs: 2, runtimes: ['docker', 'fly'], wallTimeMs: 90_000, queueMs: 800, cpuSeconds: 20.25, peakMemoryBytes: 2048, costUsd: 0.004, llmCostUsd: 3,
  });
});

test('a task no runtime measured, or a schema without compute columns, has no compute usage', async () => {
  assert.equal(await taskComputeUsage(db, 'unmeasured'), null);
  assert.equal(await taskComputeUsage(db, 'missing'), null);
  const legacy = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await legacy.schema.createTable('llm_executions', table => { table.string('task_id'); table.float('cost_usd'); });
    assert.equal(await taskComputeUsage(legacy, 'measured'), null);
  } finally {
    await legacy.destroy();
  }
});
