import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, describe, mock, test } from 'node:test';
import fs from 'fs-extra';
import type { Job } from 'bullmq';
import type { AgentRunState } from '@propr/shared';
import type { AgentRunJobData, AgentTaskOptions, StoredAgentDefinition, StoredAgentRun } from '@propr/core';
import { UsageLimitError } from '../packages/core/src/claude/claudeHelpers.ts';

// The scratch workspace root is read from the environment at import time.
const SCRATCH_BASE = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-run-worktrees-'));
process.env.GIT_WORKTREES_BASE_PATH = SCRATCH_BASE;

const {
  AGENT_RUN_USAGE_LIMIT_REASON,
  agentRunReportTaskId,
  createAgentRunProcessor,
} = await import('../src/jobs/processAgentRunJob.ts');
const { advanceAfterReport } = await import('../src/jobs/agentRuns/autonomy.ts');
const { AGENT_INPUTS_DIR, copyAgentInputFiles, prepareAgentRunWorkspace } = await import('../src/jobs/agentRuns/workspace.ts');
type AgentRunProcessorDeps = import('../src/jobs/processAgentRunJob.ts').AgentRunProcessorDeps;
type AgentRunWorkspace = import('../src/jobs/agentRuns/workspace.ts').AgentRunWorkspace;

// Importing @propr/core opens the shared database connection.
after(async () => {
  await fs.remove(SCRATCH_BASE);
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

function definition(overrides: Partial<StoredAgentDefinition> = {}): StoredAgentDefinition {
  return {
    id: 'def-1', ownerId: 'user-1', name: 'Dependency watch', description: null,
    repositories: ['acme/web', 'acme/api'], prompt: 'Review outdated dependencies.', attachments: [],
    agentAlias: 'claude', modelName: 'opus', capabilities: ['repository_read'],
    includePreviousReports: true, previousReportsLimit: 2,
    scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
    autonomyMode: 'dry_run', enabled: true, revision: 1, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function storedRun(overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    id: 'run-1', definitionId: 'def-1', ownerId: 'user-1', trigger: 'manual', triggerSource: 'user:user-1',
    idempotencyKey: null, state: 'queued', autonomyMode: 'dry_run', definitionSnapshot: definition(),
    reportTaskId: null, actionTaskId: null, report: null, reportTruncated: false, actionSummary: null,
    skipReason: null, failureReason: null, approvedBy: null, deferredUntil: null, deferrals: 0,
    createdAt: NOW, startedAt: null, reportedAt: null, finishedAt: null, updatedAt: NOW,
    ...overrides,
  };
}

const job = { id: 'agent-run-run-1-report', data: { runId: 'run-1', definitionId: 'def-1', ownerId: 'user-1', phase: 'report', correlationId: 'corr-1' } } as Job<AgentRunJobData>;

interface Harness {
  deps: Partial<AgentRunProcessorDeps>;
  run: () => StoredAgentRun;
  transitions: Array<{ from: readonly AgentRunState[]; to: AgentRunState; patch: Record<string, unknown> }>;
  stateCalls: Array<[string, ...unknown[]]>;
  executeTask: ReturnType<typeof mock.fn>;
  listPreviousReports: ReturnType<typeof mock.fn>;
  buildPrompt: ReturnType<typeof mock.fn>;
  prepareWorkspace: ReturnType<typeof mock.fn>;
  cleanup: ReturnType<typeof mock.fn>;
}

/** In-memory run store honouring the compare-and-set semantics of `transitionAgentRun`. */
function harness(options: {
  run?: StoredAgentRun;
  invalid?: string | null;
  execute?: (options: AgentTaskOptions) => Promise<unknown>;
  prepare?: () => Promise<AgentRunWorkspace>;
  onRunning?: (current: StoredAgentRun) => StoredAgentRun;
} = {}): Harness {
  let current = options.run ?? storedRun();
  const transitions: Harness['transitions'] = [];
  const stateCalls: Harness['stateCalls'] = [];
  const cleanup = mock.fn(async () => undefined);
  const record = (name: string) => async (...args: unknown[]) => { stateCalls.push([name, ...args]); return null; };

  const transitionRun = (async (_id: string, from: readonly AgentRunState[], to: AgentRunState, patch: Record<string, unknown> = {}) => {
    transitions.push({ from, to, patch });
    if (!from.includes(current.state)) return null;
    current = { ...current, ...patch, state: to } as StoredAgentRun;
    if (to === 'running' && options.onRunning) current = options.onRunning(current);
    return current;
  }) as AgentRunProcessorDeps['transitionRun'];

  const executeTask = mock.fn(options.execute ?? (async () => ({
    success: true, logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 10,
    summary: '## Summary\nTwo dependencies are outdated.',
  })));
  const listPreviousReports = mock.fn(async () => [{ runId: 'run-0', reportedAt: NOW - 1000, report: 'Old report' }]);
  const buildPrompt = mock.fn(() => 'PROMPT');
  const prepareWorkspace = mock.fn(options.prepare ?? (async () => ({
    worktreePath: '/tmp/worktree', branchName: 'agent-run/run-1',
    promptWorkspace: { repositoriesReadable: true, primaryRepository: '.', contextRepositories: ['.propr/context/acme__api'] },
    attachments: [], cleanup,
  })));

  return {
    run: () => current,
    transitions, stateCalls, executeTask, listPreviousReports, buildPrompt, prepareWorkspace, cleanup,
    deps: {
      getRun: async () => current,
      transitionRun,
      validateDefinition: async () => options.invalid ?? null,
      listPreviousReports: listPreviousReports as unknown as AgentRunProcessorDeps['listPreviousReports'],
      stateManager: () => ({
        createTaskStateIfAbsent: record('create'),
        updateTaskState: record('update'),
        markTaskCompleted: record('completed'),
        markTaskFailed: record('failed'),
        markTaskCancelled: record('cancelled'),
      }) as unknown as ReturnType<AgentRunProcessorDeps['stateManager']>,
      getGitHubAccess: async () => ({ token: 'ghs_token', octokit: {} }),
      prepareWorkspace: prepareWorkspace as unknown as AgentRunProcessorDeps['prepareWorkspace'],
      resolveAgent: async () => ({ agent: { executeTask } as never, alias: 'claude', model: 'opus' }),
      buildPrompt: buildPrompt as unknown as AgentRunProcessorDeps['buildPrompt'],
      withCostCap: async (_target, operation) => operation(),
      advanceAfterReport: run => advanceAfterReport(run, { transitionRun }),
    },
  };
}

describe('processAgentRunJob', () => {
  test('a queued dry_run produces a stored report and completes with a visible task', async () => {
    const h = harness();
    const result = await createAgentRunProcessor(h.deps)(job);

    assert.equal(result.status, 'complete');
    assert.equal(h.run().state, 'completed');
    assert.equal(h.run().report, '## Summary\nTwo dependencies are outdated.');
    assert.equal(h.run().reportTaskId, agentRunReportTaskId('run-1'));
    assert.deepEqual(h.transitions.map(t => t.to), ['running', 'report_ready', 'completed']);

    const [create] = h.stateCalls;
    assert.equal(create[0], 'create');
    assert.equal(create[1], 'agent-run-run-1-report');
    assert.deepEqual(create[2], {
      number: 0, repoOwner: 'acme', repoName: 'web', type: 'agent-run', title: 'Agent: Dependency watch', subtitle: 'Report run',
    });
    const completed = h.stateCalls.find(call => call[0] === 'completed');
    assert.ok(completed);
    assert.equal((completed[2] as { notificationRecap?: string }).notificationRecap, 'Two dependencies are outdated.');

    const options = h.executeTask.mock.calls[0].arguments[0] as AgentTaskOptions & { toolPolicy: unknown };
    assert.equal(options.prompt, 'PROMPT');
    assert.equal(options.taskId, 'agent-run-run-1-report');
    assert.equal(options.model, 'opus');
    assert.equal(options.worktreePath, '/tmp/worktree');
    assert.deepEqual(options.toolPolicy, { capabilities: ['repository_read'], readOnly: true });
    assert.equal(h.cleanup.mock.callCount(), 1);
  });

  test('previous reports are loaded for the definition and passed to the prompt builder', async () => {
    const h = harness();
    await createAgentRunProcessor(h.deps)(job);

    assert.deepEqual(h.listPreviousReports.mock.calls[0].arguments, ['def-1', { limit: 2, beforeCreatedAt: NOW, excludeRunId: 'run-1' }]);
    const promptInput = h.buildPrompt.mock.calls[0].arguments[0] as { previousReports: unknown; workspace: unknown; run: { id: string } };
    assert.deepEqual(promptInput.previousReports, [{ runId: 'run-0', reportedAt: NOW - 1000, report: 'Old report' }]);
    assert.deepEqual(promptInput.workspace, { repositoriesReadable: true, primaryRepository: '.', contextRepositories: ['.propr/context/acme__api'] });
    assert.equal(promptInput.run.id, 'run-1');
  });

  test('previous reports are not loaded when the definition does not include them', async () => {
    const h = harness({ run: storedRun({ definitionSnapshot: definition({ includePreviousReports: false }) }) });
    await createAgentRunProcessor(h.deps)(job);
    assert.equal(h.listPreviousReports.mock.callCount(), 0);
  });

  for (const state of ['cancelled', 'skipped', 'deferred'] as const) {
    test(`a ${state} run does nothing: no task, no workspace, no container`, async () => {
      const h = harness({ run: storedRun({ state }) });
      const result = await createAgentRunProcessor(h.deps)(job);
      assert.equal(result.status, 'skipped');
      assert.equal(h.stateCalls.length, 0);
      assert.equal(h.transitions.length, 0);
      assert.equal(h.prepareWorkspace.mock.callCount(), 0);
      assert.equal(h.executeTask.mock.callCount(), 0);
    });
  }

  test('a definition that no longer validates fails the run without a task', async () => {
    const h = harness({ invalid: 'Repositories are not enabled: acme/web' });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'failed');
    assert.equal(h.run().state, 'failed');
    assert.equal(h.run().failureReason, 'Repositories are not enabled: acme/web');
    assert.equal(h.stateCalls.length, 0);
    assert.equal(h.executeTask.mock.callCount(), 0);
  });

  test('a run cancelled between pickup and start cancels its task and never starts a container', async () => {
    const h = harness();
    // Cancel lands after the task exists but before queued → running.
    h.deps.transitionRun = (async () => null) as unknown as AgentRunProcessorDeps['transitionRun'];
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(h.stateCalls.map(call => call[0]), ['create', 'cancelled']);
    assert.equal(h.prepareWorkspace.mock.callCount(), 0);
    assert.equal(h.executeTask.mock.callCount(), 0);
  });

  test('a failed execution fails the run and task and still cleans up the workspace', async () => {
    const h = harness({
      execute: async () => ({ success: false, error: 'container exited', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 }),
    });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'failed');
    assert.equal(h.run().state, 'failed');
    assert.equal(h.run().failureReason, 'Agent execution failed: container exited');
    assert.ok(h.stateCalls.some(call => call[0] === 'failed'));
    assert.equal(h.cleanup.mock.callCount(), 1);
  });

  test('an empty report fails the run', async () => {
    const h = harness({
      execute: async () => ({ success: true, summary: '   ', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 }),
    });
    await createAgentRunProcessor(h.deps)(job);
    assert.equal(h.run().state, 'failed');
    assert.equal(h.run().failureReason, 'The agent finished without a report');
    assert.equal(h.cleanup.mock.callCount(), 1);
  });

  test('a provider usage limit fails the run with a retry hint and is not requeued', async () => {
    const h = harness({ execute: async () => { throw new UsageLimitError('limit', NOW + 1000); } });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'failed');
    assert.equal(h.run().state, 'failed');
    assert.equal(h.run().failureReason, AGENT_RUN_USAGE_LIMIT_REASON);
    assert.equal(h.cleanup.mock.callCount(), 1);
  });

  test('a cancel during execution is not overwritten by the late result', async () => {
    const h = harness({ onRunning: current => ({ ...current, state: 'cancelled' }) });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.equal(h.run().state, 'cancelled');
    assert.equal(h.run().report, null);
    assert.equal(h.cleanup.mock.callCount(), 1);
  });

  test('preview runs keep their report in report_ready until the acting step exists', async () => {
    const h = harness({ run: storedRun({ autonomyMode: 'preview' }) });
    await createAgentRunProcessor(h.deps)(job);
    assert.equal(h.run().state, 'report_ready');
    assert.ok(h.run().report);
  });

  test('the executor never calls a commit or push helper', async () => {
    const source = await fs.readFile(new URL('../src/jobs/processAgentRunJob.ts', import.meta.url), 'utf8')
      + await fs.readFile(new URL('../src/jobs/agentRuns/workspace.ts', import.meta.url), 'utf8');
    for (const helper of ['pushBranch', 'ensureBranchAndPush', 'commitChanges', "'push'"]) {
      assert.ok(!source.includes(helper), `${helper} must not be used`);
    }
  });
});

describe('agent run workspace', () => {
  test('without repository_read the workspace is an empty git directory with only the input files', async () => {
    const inputs = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inputs-'));
    try {
      const storedPath = path.join(inputs, 'def-1', 'abc-notes.txt');
      await fs.outputFile(storedPath, 'notes');
      const workspace = await prepareAgentRunWorkspace({
        runId: 'run-scratch',
        definition: definition({ capabilities: ['web'] }),
        githubToken: 'unused',
      });
      try {
        assert.equal(workspace.promptWorkspace.repositoriesReadable, false);
        assert.ok(workspace.worktreePath.startsWith(SCRATCH_BASE));
        assert.deepEqual((await fs.readdir(workspace.worktreePath)).sort(), ['.git']);
        assert.ok(await fs.pathExists(path.join(workspace.worktreePath, '.git', 'HEAD')));

        const copied = await copyAgentInputFiles(workspace.worktreePath, 'def-1', [{
          id: 'a1', originalName: '../notes.txt', storedPath, mimeType: 'text/plain', size: 5, tokenEstimate: 1, type: 'text',
        }], undefined, inputs);
        assert.deepEqual(copied, [{ originalName: '../notes.txt', workspacePath: path.join(AGENT_INPUTS_DIR, 'notes.txt') }]);
        assert.equal(await fs.readFile(path.join(workspace.worktreePath, AGENT_INPUTS_DIR, 'notes.txt'), 'utf8'), 'notes');
      } finally {
        await workspace.cleanup();
      }
      assert.equal(await fs.pathExists(workspace.worktreePath), false);
    } finally {
      await fs.remove(inputs);
    }
  });

  test('input files outside the definition folder are skipped', async () => {
    const inputs = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inputs-'));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-target-'));
    try {
      const outside = path.join(inputs, 'def-2', 'secret.txt');
      await fs.outputFile(outside, 'secret');
      const warn = mock.fn();
      const copied = await copyAgentInputFiles(target, 'def-1', [{
        id: 'a1', originalName: 'secret.txt', storedPath: outside, mimeType: 'text/plain', size: 6, tokenEstimate: 1, type: 'text',
      }], { warn } as never, inputs);
      assert.deepEqual(copied, []);
      assert.equal(warn.mock.callCount(), 1);
    } finally {
      await fs.remove(inputs);
      await fs.remove(target);
    }
  });
});
