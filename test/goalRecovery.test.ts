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

test('goal recovery rotates a stale claim, resumes exact identity, and fails closed without one', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  const { recoverNonterminalGoals } = await import('../src/goalRecovery.ts');
  await database.schema.createTable('goals', table => {
    table.string('goal_id'); table.string('current_task_id'); table.string('repository');
    table.text('worktree_path'); table.string('session_id'); table.timestamp('started_at');
    table.integer('run_generation'); table.string('run_claim'); table.timestamp('claimed_at');
    table.timestamp('attempt_heartbeat_at'); table.string('desired_state'); table.string('result_state');
    table.timestamp('pause_confirmed_at'); table.boolean('resume_requested'); table.string('active_turn_id');
    table.timestamp('paused_at'); table.bigInteger('paused_ms').defaultTo(0);
    table.text('failure_reason'); table.timestamp('completed_at'); table.timestamp('updated_at');
  });
  const old = new Date(Date.now() - 10_000).toISOString();
  const common = {
    repository: 'acme/web', started_at: old, desired_state: 'running', result_state: null,
    pause_confirmed_at: null, paused_at: null, paused_ms: 0, resume_requested: false, active_turn_id: null, updated_at: old,
  };
  await database('goals').insert([
    {
      ...common, goal_id: 'resumable', current_task_id: 'goal-resumable', worktree_path: '/tmp/existing-worktree',
      session_id: 'same-thread', run_generation: 3, run_claim: 'claim-3', claimed_at: old, attempt_heartbeat_at: old,
    },
    {
      ...common, goal_id: 'unsafe', current_task_id: 'goal-unsafe', worktree_path: '/tmp/unsafe-worktree',
      session_id: null, run_generation: 0, run_claim: 'unsafe-claim', claimed_at: old, attempt_heartbeat_at: old,
    },
    {
      ...common, goal_id: 'fresh', current_task_id: 'goal-fresh', worktree_path: null,
      session_id: null, run_generation: 0, run_claim: 'fresh-claim', claimed_at: null, attempt_heartbeat_at: null,
    },
    {
      ...common, goal_id: 'live', current_task_id: 'goal-live', worktree_path: '/tmp/live-worktree',
      session_id: 'live-thread', run_generation: 7, run_claim: 'live-claim', claimed_at: old, attempt_heartbeat_at: old,
    },
  ]);
  const calls: Array<{ name: string; data: Record<string, unknown>; id: string }> = [];
  const jobs = new Map<string, { getState(): Promise<string> }>();
  const queue: GoalRecoveryQueue = {
    async getJob(id) { return jobs.get(id); },
    async add(name, data, options) {
      calls.push({ name, data, id: options.jobId });
      jobs.set(options.jobId, { getState: async () => 'waiting' });
    },
  };
  const livenessChecks: Array<{ taskId: string; attempt: string }> = [];
  const options = {
    database,
    queue,
    staleMs: 0,
    isTaskContainerLive: async (taskId: string, attempt: string) => {
      livenessChecks.push({ taskId, attempt });
      return taskId === 'goal-live';
    },
  };

  assert.deepEqual(await recoverNonterminalGoals(options), { recovered: 2, failedClosed: 1, skippedLive: 1 });
  assert.deepEqual(await recoverNonterminalGoals(options), { recovered: 0, failedClosed: 0, skippedLive: 1 });
  assert.equal(calls.length, 2);
  const resumed = calls.find(call => call.data.taskId === 'goal-resumable')!;
  assert.equal(resumed.id, 'goal-resumable-4');
  assert.equal(resumed.data.generation, 4);
  assert.equal(resumed.data.recovery, true);
  assert.equal(typeof resumed.data.claimId, 'string');
  assert.notEqual(resumed.data.claimId, 'claim-3');
  const resumedRow = await database('goals').where({ goal_id: 'resumable' }).first();
  assert.equal(resumedRow.session_id, 'same-thread');
  assert.equal(resumedRow.worktree_path, '/tmp/existing-worktree');
  assert.equal(resumedRow.run_generation, 4);
  assert.equal(resumedRow.run_claim, resumed.data.claimId);
  const fresh = calls.find(call => call.data.taskId === 'goal-fresh')!;
  assert.equal(fresh.data.generation, 0);
  assert.equal(fresh.data.claimId, 'fresh-claim');
  assert.equal(fresh.data.recovery, false);
  const failed = await database('goals').where({ goal_id: 'unsafe' }).first();
  assert.equal(failed.result_state, 'failed');
  assert.match(failed.failure_reason, /before a resumable provider identity/);
  assert.deepEqual(livenessChecks[0], { taskId: 'goal-resumable', attempt: '3:claim-3' });
  assert.ok(livenessChecks.some(check => check.taskId === 'goal-live' && check.attempt === '7:live-claim'));
});
