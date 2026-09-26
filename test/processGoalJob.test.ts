import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { executePreparedGoal, processGoalJob } from '../src/jobs/processGoalJob.ts';
import type { GoalJobData } from '../packages/core/src/goalExports.ts';
import type { AgentTaskOptions } from '../packages/core/src/agents/types.ts';
import { assertProviderIdentityMatches } from '../src/jobs/goalAttemptState.ts';
import { labelCompletedGoalPullRequest } from '../src/jobs/goalPullRequestLabel.ts';

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  const { closeStateManager } = await import('../packages/core/src/utils/workerStateManager.ts');
  const { closeEventPublisher } = await import('../packages/core/src/utils/eventPublisher.ts');
  await closeStateManager();
  await closeConnection();
  // Goal transitions now publish a push event; close the publisher's Redis
  // client so a test process is not held open by best-effort telemetry.
  await closeEventPublisher();
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

test('whole-session direct goals publish an agent declaration and continue after acknowledgement', async () => {
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
  const wholeSessionGoal = { ...goal, agent_type: 'antigravity' };
  const published: Array<{ kind: string; message?: string; include?: string[]; exclude?: string[] }> = [];
  let continuedAfterCheckpoint = false;
  const dependencies = {
    claim: async () => wholeSessionGoal,
    withHeartbeat: async (_job: GoalJobData, operation: () => Promise<unknown>) => operation(),
    prepare: async () => ({ ready: true, value: {
      goal: wholeSessionGoal, agent: {}, githubToken: 'token', worktree: { worktreePath: '/tmp/worktree', branchName: 'goal/ship-it' }, pendingInput: null,
    } }),
    execute: async () => ({
      success: true, modelUsed: 'gpt-5.6', executionTimeMs: 1, logs: '', modifiedFiles: [],
      summary: '{"checkpointReady":true,"message":"feat: stable slice","include":["src/stable.ts"],"exclude":["src/wip.ts"],"summary":"Stable slice complete."}',
    }),
    result: {
      loadGoal: async () => wholeSessionGoal,
      fencedGoal: async () => wholeSessionGoal,
      acknowledgeInput: async () => {}, recordMetrics: async () => {}, handleStopped: async () => null,
      publishCheckpoint: async (_job: GoalJobData, checkpoint: { kind: string; commitMessage?: string; include?: string[]; exclude?: string[] }) => {
        published.push({ kind: checkpoint.kind, message: checkpoint.commitMessage, include: checkpoint.include, exclude: checkpoint.exclude });
        return { commitSha: 'abc', pullRequest: { number: 42, url: 'https://github.com/acme/repo/pull/42', state: 'open', draft: true } };
      },
      saveProviderResult: async () => ({ finalPr: { number: 42, url: 'https://github.com/acme/repo/pull/42' } }),
      scheduleFurtherWork: async (_data: GoalJobData, _goal: unknown, _result: unknown, checkpointPublished: boolean) => {
        continuedAfterCheckpoint = checkpointPublished;
        return { status: 'continuing' };
      },
      finalizeGoal: async () => true,
      markTaskReconciled: async () => {},
      stateManager: () => ({ markTaskCompleted: async () => ({ state: 'completed' }), markTaskFailed: async () => ({ state: 'failed' }) }),
    },
  };

  const outcome = await processGoalJob({ data } as never, dependencies as never);

  assert.deepEqual(outcome, { status: 'continuing' });
  assert.deepEqual(published, [
    { kind: 'agent', message: 'feat: stable slice', include: ['src/stable.ts'], exclude: ['src/wip.ts'] },
  ]);
  assert.equal(continuedAfterCheckpoint, true);
});

test('whole-session direct goals record a malformed declaration and continue for correction', async () => {
  const data: GoalJobData = {
    goalId: 'goal-rejected', taskId: 'goal-task-rejected', repoOwner: 'acme', repoName: 'repo',
    generation: 1, claimId: 'claim-rejected',
  };
  const goal = {
    goal_id: data.goalId, owner_id: 'owner-1', repository: 'acme/repo', objective: 'Ship it',
    launch_strategy: 'direct', initial_prompt: '/goal Ship it', base_branch: 'main', branch_name: 'goal/ship-it',
    worktree_path: '/tmp/worktree', agent_id: 'agent-1', agent_alias: 'antigravity', agent_type: 'antigravity',
    requested_model: 'claude-opus', desired_state: 'running', result_state: null,
    current_task_id: data.taskId, session_id: 'session-1', conversation_id: null,
    run_generation: data.generation, run_claim: data.claimId, claimed_at: new Date().toISOString(),
    active_turn_id: null, pause_confirmed_at: null, resume_requested: false,
    started_at: new Date().toISOString(), paused_at: null, control_generation: 0, control_ack_generation: 0,
  };
  const rejected: Array<Record<string, unknown>> = [];
  let continued = false;
  const dependencies = {
    claim: async () => goal,
    withHeartbeat: async (_job: GoalJobData, operation: () => Promise<unknown>) => operation(),
    prepare: async () => ({ ready: true, value: {
      goal, agent: {}, githubToken: 'token',
      worktree: { worktreePath: '/tmp/worktree', branchName: 'goal/ship-it' }, pendingInput: null,
    } }),
    execute: async () => ({
      success: true, modelUsed: 'claude-opus', executionTimeMs: 1, logs: '', modifiedFiles: [],
      summary: '{"checkpointReady":true,"message":"","include":["../outside.ts"]}',
    }),
    result: {
      loadGoal: async () => goal, fencedGoal: async () => goal, acknowledgeInput: async () => {},
      recordMetrics: async () => {}, handleStopped: async () => null,
      rejectCheckpoint: async (_job: GoalJobData, request: Record<string, unknown>) => { rejected.push(request); },
      publishCheckpoint: async () => { throw new Error('Malformed declaration must not be published'); },
      saveProviderResult: async () => ({}),
      scheduleFurtherWork: async (_job: GoalJobData, _goal: unknown, _result: unknown, handled: boolean) => {
        continued = handled;
        return { status: 'continuing' };
      },
      finalizeGoal: async () => true, markTaskReconciled: async () => {},
      stateManager: () => ({ markTaskCompleted: async () => ({ state: 'completed' }), markTaskFailed: async () => ({ state: 'failed' }) }),
    },
  };

  const outcome = await processGoalJob({ data } as never, dependencies as never);

  assert.deepEqual(outcome, { status: 'continuing' });
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].error), /message must be a non-empty string/);
  assert.equal(continued, true);
});

test('completed goals label their final PR with the regular task PR label', async () => {
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const retryNames: string[] = [];

  await labelCompletedGoalPullRequest('acme/repo', 42, {
    resolveLabel: async () => 'AI',
    getOctokit: async () => ({
      request: async (endpoint: string, options: Record<string, unknown>) => {
        requests.push({ endpoint, options });
        return { data: {} };
      },
    }) as never,
    retry: async (operation, operationName) => {
      retryNames.push(operationName);
      return operation();
    },
  });

  assert.deepEqual(requests, [{
    endpoint: 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
    options: { owner: 'acme', repo: 'repo', issue_number: 42, labels: ['AI'] },
  }]);
  assert.deepEqual(retryNames, ['add_goal_pr_label_42']);
});

test('goal processing defers the PR label until successful terminal reconciliation', async () => {
  const data: GoalJobData = {
    goalId: 'goal-complete', taskId: 'goal-task-complete', repoOwner: 'acme', repoName: 'repo',
    generation: 1, claimId: 'claim-complete',
  };
  const goal = {
    goal_id: data.goalId, owner_id: 'owner-1', repository: 'acme/repo', objective: 'Ship it',
    launch_strategy: 'orchestrate', initial_prompt: '/goal Ship it', base_branch: 'main', branch_name: 'goal/ship-it',
    worktree_path: '/tmp/worktree', agent_id: 'agent-1', agent_alias: 'codex', agent_type: 'codex',
    requested_model: 'gpt-5.6', desired_state: 'running', result_state: null,
    current_task_id: data.taskId, session_id: 'thread-1', conversation_id: null,
    run_generation: data.generation, run_claim: data.claimId,
  };
  const events: string[] = [];
  let completedTaskResult: Record<string, unknown> | undefined;
  const dependencies = {
    claim: async () => goal,
    withHeartbeat: async (_job: GoalJobData, operation: () => Promise<unknown>) => operation(),
    prepare: async () => ({ ready: true, value: {
      goal, agent: {}, githubToken: 'token',
      worktree: { worktreePath: '/tmp/worktree', branchName: 'goal/ship-it' }, pendingInput: null,
    } }),
    execute: async () => ({
      success: true, modelUsed: 'gpt-5.6', executionTimeMs: 1, logs: '',
      modifiedFiles: ['src/inbox.tsx'], summary: 'Added swipe dismissal, Undo, and compact notification recaps.',
    }),
    result: {
      loadGoal: async () => goal, fencedGoal: async () => goal, acknowledgeInput: async () => {},
      recordMetrics: async () => {}, handleStopped: async () => null,
      saveProviderResult: async () => ({ finalPr: { number: 42, url: 'https://github.com/acme/repo/pull/42' } }),
      publishVisualPreviews: async (_goal: unknown, pullRequest: { number: number }) => {
        events.push(`previews:${pullRequest.number}`);
      },
      scheduleFurtherWork: async () => null,
      finalizeGoal: async () => { events.push('finalized'); return true; },
      updatePullRequestDescription: async (_goal: unknown, prNumber: number) => { events.push(`description:${prNumber}`); },
      labelPullRequest: async (repository: string, prNumber: number) => { events.push(`labeled:${repository}#${prNumber}`); },
      markTaskReconciled: async () => { events.push('reconciled'); },
      stateManager: () => ({
        markTaskCompleted: async (_taskId: string, result: Record<string, unknown>) => {
          completedTaskResult = result;
          events.push('task-completed');
          return { state: 'completed' };
        },
        markTaskFailed: async () => ({ state: 'failed' }),
      }),
    },
  };

  const outcome = await processGoalJob({ data } as never, dependencies as never);

  assert.deepEqual(outcome, { status: 'complete', goalId: 'goal-complete' });
  assert.deepEqual(events, ['previews:42', 'finalized', 'description:42', 'labeled:acme/repo#42', 'task-completed', 'reconciled']);
  assert.equal(
    completedTaskResult?.notificationRecap,
    'Added swipe dismissal, Undo, and compact notification recaps.',
  );
});

test('goal execution keeps initial prompt identity separate from FIFO continuation input', async () => {
  const data: GoalJobData = {
    goalId: 'goal-identity', taskId: 'goal-task-identity', repoOwner: 'acme', repoName: 'repo',
    generation: 0, claimId: 'claim-identity',
  };
  const initialPrompt = '/goal Ship it';
  const correction = 'Additional ProPR delivery context for the goal above. Use the existing API shape.';
  const captured: AgentTaskOptions[] = [];
  const agent = {
    executeTask: async (options: AgentTaskOptions) => {
      captured.push(options);
      return { success: false, modelUsed: 'test-model', executionTimeMs: 1, logs: '', modifiedFiles: [] };
    },
  };
  const goal = {
    goal_id: data.goalId, initial_prompt: initialPrompt, session_id: null, conversation_id: null,
    requested_model: 'test-model', current_task_id: data.taskId, agent_type: 'codex',
  };
  const prepared = {
    goal, agent, githubToken: 'token', worktree: { worktreePath: '/tmp/worktree', branchName: 'goal/ship-it' },
    pendingInput: { input_id: 'input-1', message: correction, kind: 'context' },
  };

  await executePreparedGoal(data, prepared as never);
  await executePreparedGoal({ ...data, generation: 1 }, {
    ...prepared, goal: { ...goal, session_id: 'session-1' },
  } as never);

  assert.equal(captured[0].prompt, initialPrompt);
  assert.equal(captured[0].nativeGoalObjective, initialPrompt);
  assert.equal(captured[0].initialControlInputId, 'input-1');
  assert.equal(captured[0].initialControlInputMessage, correction);
  assert.equal(captured[1].prompt, correction);
  assert.equal(captured[1].nativeGoalObjective, initialPrompt);
  assert.equal(captured[1].resumeSessionId, 'session-1');
});

test('fresh whole-session providers receive the durable context with the first prompt before FIFO input', async () => {
  const data: GoalJobData = {
    goalId: 'goal-whole-session', taskId: 'goal-task-whole-session', repoOwner: 'acme', repoName: 'repo',
    generation: 0, claimId: 'claim-whole-session',
  };
  const initialPrompt = '/goal Ship it';
  const initialContext = 'Additional ProPR delivery context for the goal above:\n\nImmutable launch policy';
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
    requested_model: 'test-model', current_task_id: data.taskId, agent_type: 'antigravity',
  };
  const prepared = {
    goal, agent, githubToken: 'token', worktree: { worktreePath: '/tmp/worktree', branchName: 'goal/ship-it' },
    pendingInput: { input_id: 'context-1', message: initialContext, kind: 'context' },
  };

  await executePreparedGoal(data, prepared as never);
  await executePreparedGoal({ ...data, generation: 1 }, {
    ...prepared,
    goal: { ...goal, session_id: 'session-1' },
    pendingInput: { input_id: 'input-1', message: correction, kind: 'input' },
  } as never);

  assert.equal(captured[0].prompt, `${initialPrompt}\n\n${initialContext}`);
  assert.equal(captured[0].nativeGoalObjective, initialPrompt);
  assert.equal(captured[0].initialControlInputId, undefined);
  assert.equal(captured[0].initialControlInputMessage, undefined);
  assert.equal(captured[1].prompt, correction);
  assert.equal(captured[1].nativeGoalObjective, initialPrompt);
  assert.equal(captured[1].resumeSessionId, 'session-1');
});

test('Claude native goals receive the durable context and checkpoint feedback as live control input', async () => {
  const data: GoalJobData = {
    goalId: 'goal-claude-native', taskId: 'goal-task-claude-native', repoOwner: 'acme', repoName: 'repo',
    generation: 1, claimId: 'claim-claude-native',
  };
  const initialPrompt = '/goal Ship it';
  const initialContext = 'Additional ProPR delivery context for the goal above:\n\nImmutable launch policy';
  const captured: AgentTaskOptions[] = [];
  const agent = {
    executeTask: async (options: AgentTaskOptions) => {
      captured.push(options);
      return { success: false, modelUsed: 'claude-opus-5', executionTimeMs: 1, logs: '', modifiedFiles: [] };
    },
  };
  const goal = {
    goal_id: data.goalId, initial_prompt: initialPrompt, session_id: null, conversation_id: null,
    requested_model: 'claude-opus-5', current_task_id: data.taskId, agent_type: 'claude',
  };

  await executePreparedGoal(data, {
    goal, agent, githubToken: 'token', worktree: { worktreePath: '/tmp/worktree', branchName: 'goal/ship-it' },
    pendingInput: { input_id: 'context-1', message: initialContext, kind: 'context' },
  } as never);
  await executePreparedGoal({ ...data, generation: 2 }, {
    goal: { ...goal, session_id: 'session-1' }, agent, githubToken: 'token',
    worktree: { worktreePath: '/tmp/worktree', branchName: 'goal/ship-it' },
    pendingInput: null, checkpointFeedback: 'ProPR accepted and published your checkpoint as commit abc.',
  } as never);

  assert.equal(captured[0].prompt, initialPrompt);
  assert.equal(captured[0].nativeGoalObjective, initialPrompt);
  assert.equal(captured[0].initialControlInputId, 'context-1');
  assert.equal(captured[0].initialControlInputMessage, initialContext);
  assert.ok(captured[0].goalControl);
  assert.equal(captured[1].resumeSessionId, 'session-1');
  assert.equal(captured[1].initialGoalFeedback, 'ProPR accepted and published your checkpoint as commit abc.');
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
