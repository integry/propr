import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, mock } from 'node:test';

// The worker's execution control opens and closes goal blockers; the operator's
// Inbox card must follow both, after the blocker write has committed.
test('a blocker the worker records notifies its owner once, and closing it dismisses the card', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goal-blocker-notify-'));
  process.env.DB_FILENAME = join(directory, 'propr.sqlite');
  const { db, closeConnection, closeEventPublisher, getEventPublisher, listNotifications } = await import('@propr/core');
  const { closeAttemptBlockers, createGoalExecutionControl } = await import('../src/jobs/goalAttemptState.ts');
  const publication = mock.method(getEventPublisher(), 'publishGoalUpdate', async () => true);
  try {
    await db.migrate.latest({ directory: fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url)) });
    const goalId = '11111111-1111-4111-8111-111111111111';
    await db('goals').insert({
      goal_id: goalId, owner_id: 'owner-1', owner_login: 'owner', repository: 'acme/web', title: 'Ship the deploy',
      objective: 'o', launch_strategy: 'direct', initial_prompt: 'p', agent_id: 'claude', agent_alias: 'claude',
      agent_type: 'claude', requested_model: 'm', desired_state: 'running', current_task_id: 'task-1',
      run_generation: 1, run_claim: 'claim-1',
    });
    const job = { goalId, taskId: 'task-1', generation: 1, claimId: 'claim-1', repoOwner: 'acme', repoName: 'web' };
    const control = createGoalExecutionControl(job);
    const report = (requestKey: string) => ({
      category: 'question' as const, source: 'ask_operator', requestKey,
      summary: 'Which region?', questions: [], responseActions: ['answer' as const],
    });

    await control.reportBlocker!(report('q-1'));
    await control.reportBlocker!(report('q-1'));
    await control.reportBlocker!(report('q-2'));
    const cards = (await listNotifications('owner-1')).notifications;
    assert.equal(cards.length, 2, 'one card per blocker, none for a repeated observation');
    assert.ok(cards.every(card => card.metadata?.goalId === goalId && card.severity === 'warning'));
    assert.ok(cards.every(card => card.title === 'Goal needs your answer: Ship the deploy'));

    await control.resolveBlocker!('q-1', 'answered');
    const remaining = (await listNotifications('owner-1')).notifications;
    assert.equal(remaining.length, 1);
    const q2 = await db('goal_blockers').where({ request_key: 'q-2' }).first('blocker_id');
    assert.equal(remaining[0].metadata?.blockerId, q2.blocker_id);

    await closeAttemptBlockers(job);
    assert.deepEqual((await listNotifications('owner-1')).notifications, [], 'an ended attempt leaves no stale card');
  } finally {
    publication.mock.restore();
    await closeConnection();
    await closeEventPublisher();
    await rm(directory, { recursive: true, force: true });
  }
});
