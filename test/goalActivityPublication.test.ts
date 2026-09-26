import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, mock } from 'node:test';

test('goal checkpoints publish after commit, while fenced writes and heartbeats do not invalidate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goal-activity-'));
  process.env.DB_FILENAME = join(directory, 'propr.sqlite');
  const { db, closeConnection, getEventPublisher } = await import('@propr/core');
  const { rejectDirectGoalCheckpoint } = await import('../src/jobs/goalCheckpointPublisher.ts');
  const { fencedGoalUpdate, saveFencedGoalSession } = await import('../src/jobs/goalAttemptState.ts');
  const frames: string[] = [];
  const checks: Array<Promise<unknown>> = [];
  const publication = mock.method(getEventPublisher(), 'publishGoalUpdate', async ({ goalId }) => {
    frames.push(goalId);
    checks.push(db('goals').where({ goal_id: goalId }).first());
    return true;
  });
  try {
    await db.schema.createTable('goals', table => {
      table.string('goal_id').primary(); table.string('owner_id'); table.string('launch_strategy');
      table.integer('run_generation'); table.string('run_claim'); table.string('current_task_id');
      table.string('session_id'); table.string('conversation_id'); table.string('result_state'); table.string('checkpoint_error'); table.string('attempt_heartbeat_at'); table.string('updated_at');
    });
    await db.schema.createTable('goal_checkpoints', table => {
      for (const field of ['checkpoint_id', 'goal_id', 'owner_id', 'idempotency_key', 'operation', 'payload_hash',
        'kind', 'commit_message', 'include_paths', 'exclude_paths', 'summary', 'state', 'requested_claim',
        'delivered_turn_id', 'error', 'created_at', 'completed_at']) table.string(field);
      table.integer('requested_generation');
    });
    await db('goals').insert({ goal_id: 'goal-1', owner_id: 'alice', launch_strategy: 'direct', run_generation: 1,
      run_claim: 'claim-1', current_task_id: 'task-1', result_state: null });
    const job = { goalId: 'goal-1', taskId: 'task-1', generation: 1, claimId: 'claim-1', repoOwner: 'acme', repoName: 'app' };
    await rejectDirectGoalCheckpoint(job, { kind: 'agent', checkpointId: 'checkpoint-1', error: 'Invalid scope' });
    const [snapshot] = await Promise.all(checks.splice(0));
    assert.equal((snapshot as { checkpoint_error: string }).checkpoint_error, 'Invalid scope');
    assert.deepEqual(frames, ['goal-1']);
    assert.equal(await saveFencedGoalSession(job, 'thread-1'), true);
    const [session] = await Promise.all(checks.splice(0));
    assert.equal((session as { session_id: string }).session_id, 'thread-1');
    assert.equal(await fencedGoalUpdate(job, { attempt_heartbeat_at: new Date().toISOString() }), true);
    assert.equal(await fencedGoalUpdate({ ...job, claimId: 'obsolete' }, { result_state: 'completed' }), false);
    assert.deepEqual(frames, ['goal-1', 'goal-1']);
    assert.equal(await fencedGoalUpdate(job, { result_state: 'completed' }), true);
    await Promise.all(checks);
    assert.deepEqual(frames, ['goal-1', 'goal-1', 'goal-1']);
  } finally {
    publication.mock.restore(); await closeConnection(); await rm(directory, { recursive: true, force: true });
  }
});
