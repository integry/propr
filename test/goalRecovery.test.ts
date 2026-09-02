import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import type { GoalRecoveryQueue } from '../src/goalRecovery.ts';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

after(async () => {
  await database.destroy();
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

test('goal recovery re-enqueues the same task, worktree, session and generation once', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  const { recoverNonterminalGoals } = await import('../src/goalRecovery.ts');
  await database.schema.createTable('goals', table => {
    table.string('goal_id'); table.string('current_task_id'); table.string('repository');
    table.text('objective'); table.text('worktree_path'); table.string('session_id');
    table.timestamp('started_at');
    table.integer('run_generation'); table.string('desired_state'); table.string('result_state');
  });
  await database('goals').insert({
    goal_id: 'goal-id', current_task_id: 'goal-goal-id', repository: 'acme/web',
    objective: 'Finish the release', worktree_path: '/tmp/existing-worktree',
    session_id: 'same-session', run_generation: 3, desired_state: 'running', result_state: null,
  });
  await database('goals').insert({
    goal_id: 'unsafe-goal', current_task_id: 'goal-unsafe', repository: 'acme/web',
    objective: 'Do not duplicate', worktree_path: '/tmp/unsafe-worktree', session_id: null,
    started_at: new Date().toISOString(), run_generation: 0, desired_state: 'running', result_state: null,
  });
  const calls: Array<{ name: string; data: Record<string, unknown>; id: string }> = [];
  const jobs = new Map<string, { getState(): Promise<string> }>();
  const queue: GoalRecoveryQueue = {
    async getJob(id) { return jobs.get(id); },
    async add(name, data, options) {
      calls.push({ name, data, id: options.jobId });
      jobs.set(options.jobId, { getState: async () => 'waiting' });
    },
  };

  const recoveryOptions = { database, queue, isTaskContainerLive: async () => false };
  assert.deepEqual(await recoverNonterminalGoals(recoveryOptions), { recovered: 1, skippedWithoutSession: 1 });
  assert.deepEqual(await recoverNonterminalGoals(recoveryOptions), { recovered: 0, skippedWithoutSession: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'goal-goal-id-3');
  assert.equal(calls[0].data.taskId, 'goal-goal-id');
  assert.equal(calls[0].data.generation, 3);
  assert.equal(calls[0].data.recovery, true);
});
