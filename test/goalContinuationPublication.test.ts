import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';
import type { GoalJobData } from '../packages/core/src/goalExports.js';
import type { AgentTaskOptions } from '../packages/core/src/agents/types.js';
import type { GoalRow } from '../src/jobs/goalAttemptState.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-publication-'));
process.env.GIT_CLONES_BASE_PATH = path.join(root, 'clones');
process.env.GIT_WORKTREES_BASE_PATH = path.join(root, 'worktrees');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const repo = path.join(root, 'clones', 'acme', 'repo');
const remote = path.join(root, 'remote.git');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let pullNumber = 400;
let createdHead: unknown;
let repairState = 'merged';
let restorationError: Error | undefined;
const octokit = {
  auth: async () => ({ token: 'test-token' }),
  request: async (route: string, params: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: {
      state: repairState === 'open' ? 'open' : 'closed', merged: repairState === 'merged', draft: true, node_id: 'PR_old',
    } };
    if (route === 'GET /repos/{owner}/{repo}') return { data: { default_branch: 'main' } };
    if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
      try { git(remote, 'show-ref', '--verify', `refs/${params.ref}`); }
      catch { throw Object.assign(new Error('Ref not found'), { status: 404 }); }
      return { data: {} };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: [] };
    if (route === 'POST /repos/{owner}/{repo}/pulls') {
      createdHead = params.head;
      return { data: { number: ++pullNumber, html_url: `https://github.com/acme/repo/pull/${pullNumber}`, state: 'open', draft: true } };
    }
    throw new Error(`Unexpected GitHub request: ${route}`);
  },
};
const childProcess = await import('node:child_process');
await mock.module('node:child_process', { namedExports: {
  ...childProcess,
  execFileSync: (...args: Parameters<typeof execFileSync>) => {
    // Hosted runners use a different UID from the agent container. Keep the
    // fixture owned by the test runner while exercising real Git operations.
    if (args[0] === 'sudo' && args[1]?.[0] === 'chown') {
      assert.deepEqual(args[1].slice(0, 4), ['chown', '-R', '1000:1000', '--']);
      assert.ok(args[1][4].startsWith(`${root}${path.sep}`));
      return Buffer.alloc(0);
    }
    return execFileSync(...args);
  },
} });
const core = await import('@propr/core');
await mock.module('@propr/core', { namedExports: {
  ...core,
  ensureGitRepository: async () => {},
  getStateManager: () => ({ getTaskState: async () => null }),
  ensureRepoCloned: async () => repo,
  getAuthenticatedOctokit: async () => octokit,
  createWorktreeFromExistingBranch: async (...args: Parameters<typeof core.createWorktreeFromExistingBranch>) => {
    if (restorationError) throw restorationError;
    return core.createWorktreeFromExistingBranch(...args);
  },
  // Keep Git worktree allocation real; isolate network and preview transport.
  commitChanges: async (worktree: string) => {
    git(worktree, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'bootstrap');
    return { commitHash: git(worktree, 'rev-parse', 'HEAD') };
  },
  pushBranch: async (worktree: string, branch: string) => { git(worktree, 'push', 'origin', branch); },
  loadRepositoryVisualPreviewSettings: async () => ({}),
  prepareVisualPreviewEvidence: async () => ({ evidence: { assets: [], toolSuggestions: [] } }),
  cleanupPreparedVisualPreviewEvidence: async () => {},
} });
const { continuedGoalBootstrapId, prepareContinuedGoal } = await import('../src/jobs/goalContinuation.js');
const { ensureGoalWorktree, executePreparedGoal } = await import('../src/jobs/processGoalJob.js');
const { publishDirectGoalCheckpoint } = await import('../src/jobs/goalCheckpointPublisher.js');
const { db } = core;
const { runGoalProtocol } = await import('../packages/core/src/agents/impl/codexAppServerGoalProtocol.js');

before(async () => {
  await core.runMigrations();
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(remote);
  git(remote, 'init', '--bare', '--initial-branch=main');
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');
});

after(async () => {
  await core.closeStateManager();
  await core.closeEventPublisher();
  await core.closeConnection();
  fs.rmSync(root, { recursive: true, force: true });
});

for (const state of ['merged', 'closed', 'deleted'] as const) {
  test(`${state} continuation repairs, allocates, publishes a second bootstrap and re-arms its provider`, async () => {
    const id = `publication-${state}`;
    const job: GoalJobData = { goalId: id, taskId: `task-${id}`, repoOwner: 'acme', repoName: 'repo', generation: 4, claimId: `claim-${id}` };
    const old = await core.createWorktreeForIssue(repo, { issueId: `goal-${id.slice(0, 8)}`, issueTitle: 'Ship it', owner: 'acme', repoName: 'repo' }, { baseBranch: 'main' });
    const oldFile = `old-work-${state}.txt`;
    fs.writeFileSync(path.join(old.worktreePath, oldFile), 'published work');
    git(old.worktreePath, 'add', '.');
    git(old.worktreePath, 'commit', '-m', 'old work');
    git(old.worktreePath, 'push', 'origin', old.branchName);
    const oldHead = git(old.worktreePath, 'rev-parse', 'HEAD');
    if (state === 'merged') {
      // A squash merge puts the content on main under a different commit.
      fs.writeFileSync(path.join(repo, oldFile), 'published work');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'squash merged goal');
      git(repo, 'push', 'origin', 'main');
    }
    if (state === 'deleted') {
      git(repo, 'worktree', 'remove', old.worktreePath);
      git(repo, 'push', 'origin', '--delete', old.branchName);
    }
    await db('goals').insert({
      goal_id: id, owner_id: 'owner-1', owner_login: 'alice', repository: 'acme/repo', objective: 'Ship it',
      launch_strategy: 'direct', initial_prompt: '/goal Ship it', agent_id: 'codex-agent', agent_alias: 'codex',
      agent_type: 'codex', requested_model: 'gpt-5.6', desired_state: 'running', current_task_id: job.taskId,
      run_generation: job.generation, run_claim: job.claimId, claimed_at: db.fn.now(), session_id: 'thread-1',
      branch_name: old.branchName, worktree_path: old.worktreePath, base_branch: 'main', continue_requested: true,
      final_pr_number: 379, final_pr_url: 'https://github.com/acme/repo/pull/379',
    });
    await db('goal_checkpoints').insert({
      checkpoint_id: `original-${id}`, goal_id: id, owner_id: 'owner-1', idempotency_key: `goal-bootstrap:${id}`,
      operation: 'goal.checkpoint.bootstrap', payload_hash: 'original', kind: 'bootstrap', state: 'completed',
      requested_generation: 1, requested_claim: 'old-claim', pr_number: 379,
    });
    const goal = await db('goals').where({ goal_id: id }).first() as GoalRow;
    repairState = state;
    const repaired = await prepareContinuedGoal(job, goal);
    const worktree = await ensureGoalWorktree(repaired, job, 'test-token');
    if (state === 'closed') {
      assert.equal(worktree.branchName, old.branchName);
      assert.equal(git(worktree.worktreePath, 'rev-parse', 'HEAD'), oldHead);
    } else {
      assert.notEqual(worktree.branchName, old.branchName);
      assert.equal(git(worktree.worktreePath, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'));
      assert.equal(fs.existsSync(path.join(worktree.worktreePath, oldFile)), state === 'merged');
    }
    await db('goal_inputs').insert({ input_id: `continuation-${id}`, idempotency_key: `continue-${id}`, payload_hash: 'hash', goal_id: id, owner_id: goal.owner_id, operation: 'goal.continue', kind: 'resume', message: 'Continue', state: 'pending' });
    const checkpointId = await continuedGoalBootstrapId(goal);
    assert.equal(await continuedGoalBootstrapId({ ...goal, run_generation: goal.run_generation + 1 }), checkpointId, 'recovery keeps the accepted continuation bootstrap identity');
    const publication = await publishDirectGoalCheckpoint(job, { kind: 'bootstrap', checkpointId });
    assert.equal(publication.rejected, undefined);
    assert.equal(createdHead, worktree.branchName);
    const replay = await publishDirectGoalCheckpoint(job, { kind: 'bootstrap', checkpointId });
    assert.deepEqual(replay, publication);
    const rows = await db('goal_checkpoints').where({ goal_id: id }).orderBy('requested_generation');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].state, 'completed');
    assert.equal(rows[1].state, 'completed');
    assert.equal(rows[1].idempotency_key, checkpointId);
    const published = await db('goals').where({ goal_id: id }).first() as GoalRow;
    const provider: AgentTaskOptions[] = [];
    const providerRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let nativeStatus = 'complete';
    let nativeTurn: string | null = null;
    const connection = {
      request: async (method: string, params: Record<string, unknown>) => {
        providerRequests.push({ method, params });
        if (method === 'initialize') return {};
        if (method === 'thread/resume') return { thread: { id: 'thread-1', sessionId: 'conversation-1', model: 'gpt-5.6' } };
        if (method === 'thread/goal/set') {
          nativeStatus = String(params.status);
          if (nativeStatus === 'active') nativeTurn = 'continued-turn';
          return {};
        }
        if (method === 'thread/goal/get') return { goal: { status: nativeStatus, objective: '/goal Ship it' } };
        throw new Error(`Unexpected provider request ${method}`);
      },
      notify: () => {},
      takeStartedTurn: () => { const turn = nativeTurn; nativeTurn = null; return turn; },
      discardStartedTurn: () => {},
      waitForTurn: async () => { nativeStatus = 'complete'; return { params: { turn: { status: 'completed' } } }; },
      agentMessageCursor: 0,
      agentMessagesForTurn: () => [],
      takeServerRequests: () => [],
      takeResolvedServerRequests: () => [],
    };
    await executePreparedGoal(job, {
      goal: published, worktree, githubToken: 'test-token', pendingInput: null,
      agent: { executeTask: async (options: AgentTaskOptions) => {
        assert.ok(published.final_pr_number && published.final_pr_number !== 379);
        assert.equal(git(worktree.worktreePath, 'rev-parse', `origin/${worktree.branchName}`), git(worktree.worktreePath, 'rev-parse', 'HEAD'));
        provider.push(options);
        const resumed = await runGoalProtocol(connection as never, options, options.model);
        assert.equal(resumed.completion?.status, 'completed');
        return { success: true, modelUsed: 'gpt-5.6', executionTimeMs: 1, logs: '', modifiedFiles: [] };
      } },
    } as never);
    assert.deepEqual(providerRequests.find(request => request.method === 'thread/goal/set')?.params,
      { threadId: 'thread-1', objective: '/goal Ship it', status: 'active' });
    assert.equal(provider[0].continueTerminalGoal, true);
    assert.equal(provider[0].resumeSessionId, 'thread-1');
    assert.equal(Boolean((await db('goals').where({ goal_id: id }).first()).continue_requested), false);
  });
}

test('default restoration propagates transient fetch and setup failures without losing saved identities', async () => {
  const goal = await db('goals').where({ goal_id: 'publication-closed' }).first() as GoalRow;
  const job: GoalJobData = { goalId: goal.goal_id, taskId: goal.current_task_id, repoOwner: 'acme', repoName: 'repo', generation: goal.run_generation, claimId: goal.run_claim! };
  const missing = path.join(root, 'expired-checkout');
  await db('goals').where({ goal_id: goal.goal_id }).update({ continue_requested: true, worktree_path: missing });
  const saved = { ...goal, continue_requested: true, worktree_path: missing };
  repairState = 'open';
  try {
    for (const message of ['fetch connection reset', 'EACCES: setup failed']) {
      restorationError = new Error(message);
      await assert.rejects(prepareContinuedGoal(job, saved), { message });
      const stored = await db('goals').where({ goal_id: goal.goal_id }).first();
      for (const key of ['branch_name', 'worktree_path', 'final_pr_number', 'final_pr_url'] as const) {
        assert.equal(stored[key], saved[key]);
      }
    }
  } finally { restorationError = undefined; }
});
