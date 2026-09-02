import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { processGoalJob } from '../src/jobs/processGoalJob.ts';
import type { GoalJobData } from '../packages/core/src/goalExports.ts';

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

test('processGoalJob fails provider success without the exact open draft PR', async () => {
  const data: GoalJobData = {
    goalId: 'goal-1', taskId: 'goal-task-1', repoOwner: 'acme', repoName: 'repo',
    generation: 2, claimId: 'claim-2',
  };
  const goal = {
    goal_id: data.goalId, owner_id: 'owner-1', repository: 'acme/repo', objective: 'Ship it',
    initial_prompt: '/goal Ship it', base_branch: 'main', branch_name: 'goal/ship-it',
    worktree_path: '/tmp/worktree', agent_id: 'agent-1', agent_alias: 'codex', agent_type: 'codex',
    requested_model: 'gpt-5.6', desired_state: 'running', result_state: null,
    current_task_id: data.taskId, session_id: 'thread-1', conversation_id: 'conversation-1',
    run_generation: data.generation, run_claim: data.claimId, claimed_at: new Date().toISOString(),
    active_turn_id: null, pause_confirmed_at: null, resume_requested: false,
    started_at: new Date().toISOString(), paused_at: null, control_generation: 0, control_ack_generation: 0,
  };
  const finalize = mock.fn(async () => true);
  const markFailed = mock.fn(async () => ({ state: 'failed' }));
  const dependencies = {
    claim: async () => goal,
    withHeartbeat: async (_job: GoalJobData, operation: () => Promise<unknown>) => operation(),
    prepare: async () => ({ ready: true, value: {
      goal, agent: {}, githubToken: 'token', worktree: { worktreePath: '/tmp/worktree', branchName: 'goal/ship-it' }, pendingInput: null,
    } }),
    execute: async () => ({ success: true, modelUsed: 'gpt-5.6', executionTimeMs: 1, logs: '', modifiedFiles: [] }),
    result: {
      loadGoal: async () => goal,
      fencedGoal: async () => goal,
      acknowledgeInput: async () => {},
      recordMetrics: async () => {},
      handleStopped: async () => null,
      saveProviderResult: async () => ({}),
      scheduleFurtherWork: async () => null,
      finalizeGoal: finalize,
      markTaskReconciled: async () => {},
      stateManager: () => ({ markTaskCompleted: async () => ({ state: 'completed' }), markTaskFailed: markFailed }),
    },
  };

  const outcome = await processGoalJob({ data } as never, dependencies as never);
  assert.deepEqual(outcome, { status: 'failed', goalId: 'goal-1' });
  assert.equal(finalize.mock.calls[0].arguments[1], 'failed');
  assert.match(finalize.mock.calls[0].arguments[2] as string, /required open draft PR/);
  assert.match((markFailed.mock.calls[0].arguments[1] as Error).message, /required open draft PR/);
});
