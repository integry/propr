import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { GoalJobData } from '../packages/core/src/goalExports.ts';
import type { AgentTaskOptions } from '../packages/core/src/agents/types.ts';
import {
  GoalWorktreeLostError,
  prepareContinuedGoal,
  restoreMissingGoalWorktree,
  type GoalContinuationOperations,
  type GoalPullRequestState,
} from '../src/jobs/goalContinuation.ts';
import { executePreparedGoal } from '../src/jobs/processGoalJob.ts';
import type { GoalRow } from '../src/jobs/goalAttemptState.ts';

let db: typeof import('../packages/core/src/db/connection.ts')['db'];
const worktrees: string[] = [];

before(async () => {
  const connection = await import('../packages/core/src/db/connection.ts');
  await connection.runMigrations();
  db = connection.db;
});

after(async () => {
  for (const dir of worktrees) fs.rmSync(dir, { recursive: true, force: true });
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  const { closeStateManager } = await import('../packages/core/src/utils/workerStateManager.ts');
  const { closeEventPublisher } = await import('../packages/core/src/utils/eventPublisher.ts');
  await closeStateManager();
  await closeConnection();
  await closeEventPublisher();
});

function existingWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-continuation-'));
  worktrees.push(dir);
  return dir;
}

async function continuedGoal(id: string, overrides: Record<string, unknown> = {}): Promise<{ job: GoalJobData; goal: GoalRow }> {
  const job: GoalJobData = { goalId: id, taskId: `task-${id}`, repoOwner: 'acme', repoName: 'repo', generation: 4, claimId: `claim-${id}` };
  await db('goals').where({ goal_id: id }).delete();
  await db('goals').insert({
    goal_id: id, owner_id: 'owner-1', owner_login: 'alice', repository: 'acme/repo', objective: 'Ship it',
    launch_strategy: 'direct', initial_prompt: '/goal Ship it', agent_id: 'codex-agent', agent_alias: 'codex',
    agent_type: 'codex', requested_model: 'gpt-5.6', desired_state: 'running', current_task_id: job.taskId,
    run_generation: job.generation, run_claim: job.claimId, claimed_at: db.fn.now(), session_id: 'thread-1',
    branch_name: 'goal/ship-it', worktree_path: existingWorktree(), continue_requested: true,
    final_pr_number: 379, final_pr_url: 'https://github.com/acme/repo/pull/379',
    ...overrides,
  });
  return { job, goal: await db('goals').where({ goal_id: id }).first() as GoalRow };
}

function operations(pull: GoalPullRequestState | null, rebuild?: () => Promise<string | null>) {
  const calls: string[] = [];
  const ops: GoalContinuationOperations = {
    readPullRequest: async (_repository, number) => { calls.push(`read:${number}`); return pull; },
    cleanupWorktree: async goal => { calls.push(`cleanup:${goal.branch_name}`); },
    convertToDraft: async nodeId => { calls.push(`draft:${nodeId}`); },
    rebuildWorktree: async goal => {
      calls.push(`rebuild:${goal.branch_name}`);
      if (!rebuild) throw new Error('unexpected rebuild');
      return rebuild();
    },
  };
  return { ops, calls };
}

const openDraft: GoalPullRequestState = { state: 'open', merged: false, draft: true, nodeId: 'PR_1' };

test('a goal that was not continued is left untouched', async () => {
  const { job, goal } = await continuedGoal('goal-plain', { continue_requested: false });
  const { ops, calls } = operations(openDraft);
  assert.equal(await prepareContinuedGoal(job, goal, ops), goal);
  assert.deepEqual(calls, []);
});

test('an open draft PR and an existing worktree need no changes', async () => {
  const { job, goal } = await continuedGoal('goal-draft');
  const { ops, calls } = operations(openDraft);
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.branch_name, 'goal/ship-it');
  assert.equal(prepared.final_pr_number, 379);
  assert.deepEqual(calls, ['read:379']);
});

test('a merged PR continues on a fresh branch so merged commits are not proposed again', async () => {
  const { job, goal } = await continuedGoal('goal-merged');
  const { ops } = operations({ ...openDraft, state: 'closed', merged: true });
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.branch_name, null);
  assert.equal(prepared.worktree_path, null);
  assert.equal(prepared.final_pr_number, null);
  assert.equal(prepared.final_pr_url, null);
  assert.equal(prepared.session_id, 'thread-1', 'the provider session is kept');
});

test('a closed PR keeps the branch and drops the PR so a new draft is opened', async () => {
  const { job, goal } = await continuedGoal('goal-closed');
  const { ops } = operations({ ...openDraft, state: 'closed' });
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.branch_name, 'goal/ship-it');
  assert.equal(prepared.final_pr_number, null);
});

test('a PR marked ready for review is converted back to a draft', async () => {
  const { job, goal } = await continuedGoal('goal-ready');
  const { ops, calls } = operations({ ...openDraft, draft: false, nodeId: 'PR_ready' });
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.final_pr_number, 379);
  assert.deepEqual(calls, ['read:379', 'draft:PR_ready']);
});

test('an expired worktree is rebuilt from the remote branch', async () => {
  const missing = path.join(os.tmpdir(), `goal-continuation-missing-${Date.now()}`);
  const rebuilt = existingWorktree();
  const { job, goal } = await continuedGoal('goal-expired', { worktree_path: missing });
  const { ops, calls } = operations(openDraft, async () => rebuilt);
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.worktree_path, rebuilt);
  assert.equal(prepared.branch_name, 'goal/ship-it');
  assert.deepEqual(calls, ['read:379', 'rebuild:goal/ship-it']);
});

test('a deleted remote branch continues on a fresh branch', async () => {
  const missing = path.join(os.tmpdir(), `goal-continuation-gone-${Date.now()}`);
  const { job, goal } = await continuedGoal('goal-branch-gone', { worktree_path: missing });
  const { ops } = operations(openDraft, async () => null);
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.branch_name, null);
  assert.equal(prepared.worktree_path, null);
  assert.equal(prepared.final_pr_number, null);
});

test('the continued attempt tells the provider to re-arm, then clears the flag once it ran', async () => {
  const { job, goal } = await continuedGoal('goal-execute');
  const captured: AgentTaskOptions[] = [];
  const agent = {
    executeTask: async (options: AgentTaskOptions) => {
      captured.push(options);
      await options.onGoalRearmed?.();
      return { success: false, modelUsed: 'gpt-5.6', executionTimeMs: 1, logs: '', modifiedFiles: [] };
    },
  };
  await executePreparedGoal(job, {
    goal, agent, githubToken: 'token', worktree: { worktreePath: goal.worktree_path, branchName: goal.branch_name },
    pendingInput: { input_id: 'bare-continue', kind: 'resume', message: 'ProPR reopened this goal after the previous run failed: steer error' },
  } as never);

  assert.match(captured[0].initialControlInputMessage!, /previous run failed: steer error/);
  assert.equal(captured[0].initialControlInputId, 'bare-continue');
  assert.equal(captured[0].continueTerminalGoal, true);
  assert.equal(captured[0].resumeSessionId, 'thread-1');
  const stored = await db('goals').where({ goal_id: goal.goal_id }).first();
  assert.equal(Boolean(stored.continue_requested), false);
});

for (const message of ['fetch failed: connection reset', 'EACCES: worktree setup failed']) {
  test(`restoration failure preserves branch and PR: ${message}`, async () => {
    const { job, goal } = await continuedGoal(`goal-error-${message.slice(0, 6)}`, { worktree_path: '/missing/goal-worktree' });
    const { ops } = operations(openDraft, async () => { throw new Error(message); });
    await assert.rejects(prepareContinuedGoal(job, goal, ops), { message });
    const stored = await db('goals').where({ goal_id: goal.goal_id }).first();
    for (const key of ['branch_name', 'worktree_path', 'final_pr_number', 'final_pr_url']) {
      assert.equal(stored[key], goal[key as keyof GoalRow]);
    }
  });
}

test('fresh repair cleans the old checkout before clearing its identity', async () => {
  const { job, goal } = await continuedGoal('goal-cleanup');
  const { ops } = operations({ ...openDraft, merged: true });
  ops.cleanupWorktree = async original => {
    assert.equal(original.worktree_path, goal.worktree_path);
    assert.equal((await db('goals').where({ goal_id: goal.goal_id }).first()).worktree_path, goal.worktree_path);
    throw new Error('cleanup failed');
  };
  await assert.rejects(prepareContinuedGoal(job, goal, ops), /cleanup failed/);
  assert.equal((await db('goals').where({ goal_id: goal.goal_id }).first()).branch_name, goal.branch_name);
});

for (const merged of [false, true]) {
  test(`superseded preparation cannot ${merged ? 'clean a merged checkout' : 'restore an expired checkout'}`, async () => {
    const { job, goal } = await continuedGoal(`goal-superseded-${merged}`, merged ? {} : { worktree_path: '/missing/checkout' });
    const { ops, calls } = operations({ ...openDraft, merged });
    ops.readPullRequest = async () => {
      await db('goals').where({ goal_id: goal.goal_id }).update({ run_claim: 'replacement-claim' });
      return { ...openDraft, merged };
    };
    await assert.rejects(prepareContinuedGoal(job, goal, ops), /lost its attempt claim/);
    assert.deepEqual(calls, []);
    assert.equal((await db('goals').where({ goal_id: goal.goal_id }).first()).branch_name, goal.branch_name);
  });
}

for (const failure of ['before-session', 'after-session']) {
  test(`continuation remains requested when provider fails ${failure} without re-arming`, async () => {
    const { job, goal } = await continuedGoal(`goal-no-rearm-${failure}`);
    await executePreparedGoal(job, {
      goal, githubToken: 'token', worktree: { worktreePath: goal.worktree_path, branchName: goal.branch_name }, pendingInput: null,
      agent: { executeTask: async () => ({ success: false, sessionId: failure === 'after-session' ? 'thread-1' : undefined, executionTimeMs: 1, logs: '', modifiedFiles: [] }) },
    } as never);
    assert.equal(Boolean((await db('goals').where({ goal_id: goal.goal_id }).first()).continue_requested), true);
  });
}

test('transient PR reads retry once; permanent failures do not retry', async () => {
  for (const status of [503, 403]) {
    const { job, goal } = await continuedGoal(`goal-read-${status}`);
    const { ops } = operations(openDraft);
    let calls = 0;
    ops.readPullRequest = async () => { if (++calls === 1) throw Object.assign(new Error('remote failure'), { status }); return openDraft; };
    if (status === 503) await prepareContinuedGoal(job, goal, ops);
    else await assert.rejects(prepareContinuedGoal(job, goal, ops), /remote failure/);
    assert.equal(calls, status === 503 ? 2 : 1);
  }
});

test('fresh branch continuation tells the provider where preserved work can be recovered', async () => {
  const { job, goal } = await continuedGoal('goal-preserved-input');
  await db('goal_inputs').insert({ input_id: 'preserved-input', idempotency_key: 'preserved-input', payload_hash: 'hash', goal_id: goal.goal_id, owner_id: goal.owner_id, kind: 'resume', operation: 'goal.continue', message: 'Continue after failure', state: 'pending' });
  const { ops } = operations({ ...openDraft, merged: true });
  await prepareContinuedGoal(job, goal, ops);
  const input = await db('goal_inputs').where({ input_id: 'preserved-input' }).first();
  assert.ok(input.message.includes(goal.worktree_path));
  assert.ok(input.message.includes(goal.branch_name));
});

test('transient rebuild retries once without changing branch identity', async () => {
  const { job, goal } = await continuedGoal('goal-rebuild-retry', { worktree_path: '/missing/retry' });
  let calls = 0;
  const { ops } = operations(openDraft, async () => {
    if (++calls === 1) throw Object.assign(new Error('fetch reset'), { code: 'ECONNRESET' });
    return '/rebuilt/retry';
  });
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(calls, 2);
  assert.equal(prepared.branch_name, goal.branch_name);
  assert.equal(prepared.worktree_path, '/rebuilt/retry');
});

test('takeover during a transient repair error prevents retry', async () => {
  const { job, goal } = await continuedGoal('goal-retry-takeover');
  const { ops } = operations(openDraft);
  let calls = 0;
  ops.readPullRequest = async () => {
    calls++;
    await db('goals').where({ goal_id: goal.goal_id }).update({ run_claim: 'replacement' });
    throw Object.assign(new Error('service unavailable'), { status: 503 });
  };
  await assert.rejects(prepareContinuedGoal(job, goal, ops), /lost its attempt claim/);
  assert.equal(calls, 1);
});

test('a stale provider cannot acknowledge the replacement attempt re-arm', async () => {
  const { job, goal } = await continuedGoal('goal-rearm-takeover');
  await assert.rejects(executePreparedGoal(job, {
    goal, githubToken: 'token', worktree: { worktreePath: goal.worktree_path, branchName: goal.branch_name }, pendingInput: null,
    agent: { executeTask: async (options: AgentTaskOptions) => {
      await db('goals').where({ goal_id: goal.goal_id }).update({ run_claim: 'replacement' });
      await options.onGoalRearmed?.();
      throw new Error('should not execute after lost claim');
    } },
  } as never), /lost its attempt claim/);
  assert.equal(Boolean((await db('goals').where({ goal_id: goal.goal_id }).first()).continue_requested), true);
});

test('a live goal whose checkout was pruned is rebuilt in place without touching the PR', async () => {
  const missing = path.join(os.tmpdir(), `goal-live-missing-${Date.now()}`);
  const { job, goal } = await continuedGoal('goal-live-pruned', { worktree_path: missing, continue_requested: false });
  const { ops, calls } = operations(openDraft, async () => missing);
  const { goal: restored, restored: flag } = await restoreMissingGoalWorktree(job, goal, ops);
  assert.equal(flag, true);
  assert.equal(restored.worktree_path, missing);
  assert.equal(restored.branch_name, 'goal/ship-it');
  assert.deepEqual(calls, ['rebuild:goal/ship-it']);
});

test('a rebuilt checkout at a new path is saved under the attempt claim', async () => {
  const missing = path.join(os.tmpdir(), `goal-live-moved-${Date.now()}`);
  const rebuilt = existingWorktree();
  const { job, goal } = await continuedGoal('goal-live-moved', { worktree_path: missing, continue_requested: false });
  const { ops } = operations(openDraft, async () => rebuilt);
  const { goal: restored } = await restoreMissingGoalWorktree(job, goal, ops);
  assert.equal(restored.worktree_path, rebuilt);
  assert.equal((await db('goals').where({ goal_id: goal.goal_id }).first()).worktree_path, rebuilt);
});

test('an existing checkout is left alone', async () => {
  const { job, goal } = await continuedGoal('goal-live-present', { continue_requested: false });
  const { ops, calls } = operations(openDraft);
  const result = await restoreMissingGoalWorktree(job, goal, ops);
  assert.equal(result.restored, false);
  assert.equal(result.goal, goal);
  assert.deepEqual(calls, []);
});

test('a pruned checkout whose branch is gone is unrecoverable', async () => {
  const missing = path.join(os.tmpdir(), `goal-live-gone-${Date.now()}`);
  const { job, goal } = await continuedGoal('goal-live-gone', { worktree_path: missing, continue_requested: false });
  const { ops } = operations(openDraft, async () => null);
  await assert.rejects(restoreMissingGoalWorktree(job, goal, ops), (error: Error) => error instanceof GoalWorktreeLostError && /goal\/ship-it/.test(error.message));
  assert.equal((await db('goals').where({ goal_id: goal.goal_id }).first()).worktree_path, missing);
});

test('a takeover during a transient rebuild error prevents the retry', async () => {
  const { job, goal } = await continuedGoal('goal-live-takeover', { worktree_path: '/missing/live-takeover', continue_requested: false });
  let calls = 0;
  const { ops } = operations(openDraft, async () => {
    calls++;
    await db('goals').where({ goal_id: goal.goal_id }).update({ run_claim: 'replacement' });
    throw Object.assign(new Error('fetch reset'), { code: 'ECONNRESET' });
  });
  await assert.rejects(restoreMissingGoalWorktree(job, goal, ops), /lost its attempt claim/);
  assert.equal(calls, 1);
});
