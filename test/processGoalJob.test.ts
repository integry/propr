import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { executePreparedGoal, processGoalJob } from '../src/jobs/processGoalJob.ts';
import type { GoalJobData } from '../packages/core/src/goalExports.ts';
import type { AgentTaskOptions } from '../packages/core/src/agents/types.ts';
import { assertProviderIdentityMatches } from '../src/jobs/goalAttemptState.ts';

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  const { closeStateManager } = await import('../packages/core/src/utils/workerStateManager.ts');
  await closeStateManager();
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
      nextCheckpoint: async () => null,
      publishCheckpoint: async () => ({ commitSha: null, pullRequest: { number: 1, url: '', state: 'open', draft: true } }),
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

test('direct goals publish a requested boundary checkpoint and a final checkpoint through the worker', async () => {
  const data: GoalJobData = {
    goalId: 'goal-direct', taskId: 'goal-task-direct', repoOwner: 'acme', repoName: 'repo',
    generation: 1, claimId: 'claim-direct',
  };
  const goal = {
    goal_id: data.goalId, owner_id: 'owner-1', repository: 'acme/repo', objective: 'Ship it',
    launch_strategy: 'direct', initial_prompt: '/goal Ship it', base_branch: 'main', branch_name: 'goal/ship-it',
    worktree_path: '/tmp/worktree', agent_id: 'agent-1', agent_alias: 'codex', agent_type: 'codex',
    requested_model: 'gpt-5.6', desired_state: 'running', result_state: null,
    current_task_id: data.taskId, session_id: 'thread-1', conversation_id: null,
    run_generation: data.generation, run_claim: data.claimId, claimed_at: new Date().toISOString(),
    active_turn_id: null, pause_confirmed_at: null, resume_requested: false,
    started_at: new Date().toISOString(), paused_at: null, control_generation: 0, control_ack_generation: 0,
  };
  const published: Array<{ kind: string; checkpointId?: string }> = [];
  const markCompleted = mock.fn(async () => ({ state: 'completed' }));
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
      acknowledgeInput: async () => {}, recordMetrics: async () => {}, handleStopped: async () => null,
      nextCheckpoint: async () => ({ id: 'checkpoint-1', kind: 'manual' }),
      publishCheckpoint: async (_job: GoalJobData, checkpoint: { kind: string; checkpointId?: string }) => {
        published.push({ kind: checkpoint.kind, checkpointId: checkpoint.checkpointId });
        return { commitSha: 'abc', pullRequest: { number: 42, url: 'https://github.com/acme/repo/pull/42', state: 'open', draft: true } };
      },
      saveProviderResult: async () => ({ finalPr: { number: 42, url: 'https://github.com/acme/repo/pull/42' } }),
      scheduleFurtherWork: async () => null, finalizeGoal: async () => true,
      markTaskReconciled: async () => {},
      stateManager: () => ({ markTaskCompleted: markCompleted, markTaskFailed: async () => ({ state: 'failed' }) }),
    },
  };

  const outcome = await processGoalJob({ data } as never, dependencies as never);

  assert.deepEqual(outcome, { status: 'complete', goalId: 'goal-direct' });
  assert.deepEqual(published, [
    { kind: 'manual', checkpointId: 'checkpoint-1' },
    { kind: 'final', checkpointId: undefined },
  ]);
  assert.equal(markCompleted.mock.callCount(), 1);
});

test('goal execution keeps initial prompt identity separate from FIFO continuation input', async () => {
  const data: GoalJobData = {
    goalId: 'goal-identity', taskId: 'goal-task-identity', repoOwner: 'acme', repoName: 'repo',
    generation: 0, claimId: 'claim-identity',
  };
  const initialPrompt = '/goal Ship it\n\nImmutable launch policy';
  const correction = 'Use the existing API shape instead.';
  const captured: AgentTaskOptions[] = [];
  const agent = {
    executeTask: async (options: AgentTaskOptions) => {
      captured.push(options);
      return { success: false, modelUsed: 'test-model', executionTimeMs: 1, logs: '', modifiedFiles: [] };
    },
  };
  const goal = {
    goal_id: data.goalId, initial_prompt: initialPrompt, session_id: null, conversation_id: null,
    requested_model: 'test-model', current_task_id: data.taskId, agent_type: 'claude',
  };
  const prepared = {
    goal, agent, githubToken: 'token', worktree: { worktreePath: '/tmp/worktree', branchName: 'goal/ship-it' },
    pendingInput: { input_id: 'input-1', message: correction },
  };

  await executePreparedGoal(data, prepared as never);
  await executePreparedGoal({ ...data, generation: 1 }, {
    ...prepared, goal: { ...goal, session_id: 'session-1' },
  } as never);

  assert.equal(captured[0].prompt, initialPrompt);
  assert.equal(captured[0].nativeGoalObjective, initialPrompt);
  assert.equal(captured[0].initialControlInputId, undefined);
  assert.equal(captured[1].prompt, correction);
  assert.equal(captured[1].nativeGoalObjective, initialPrompt);
  assert.equal(captured[1].resumeSessionId, 'session-1');
});

test('resumed providers cannot replace the persisted session or conversation identity', () => {
  const persisted = { session_id: 'session-1', conversation_id: 'conversation-1' };
  assert.doesNotThrow(() => assertProviderIdentityMatches(persisted, 'session-1', 'conversation-1'));
  assert.throws(
    () => assertProviderIdentityMatches(persisted, 'session-2', 'conversation-1'),
    /instead of persisted session/,
  );
  assert.throws(
    () => assertProviderIdentityMatches(persisted, 'session-1', 'conversation-2'),
    /instead of persisted conversation/,
  );
});
