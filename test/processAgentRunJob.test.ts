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
// Workspace setup hands the checkout to UID 1000 through sudo, which CI runners
// allow; the runner could then no longer delete the workspace afterwards.
const SUDO_BIN = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-run-bin-'));
await fs.writeFile(path.join(SUDO_BIN, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${SUDO_BIN}${path.delimiter}${process.env.PATH}`;

const {
  AGENT_RUN_ABANDONED_REASON,
  AGENT_RUN_USAGE_LIMIT_REASON,
  AgentRunPersistenceError,
  AgentRunSettlementError,
  agentRunReportTaskId,
  createAgentRunProcessor,
} = await import('../src/jobs/processAgentRunJob.ts');
const { advanceAfterReport } = await import('../src/jobs/agentRuns/autonomy.ts');
const { AGENT_CONTEXT_DIR, AGENT_INPUTS_DIR, assertContextRepositoriesAllowed, cloneContextRepository, copyAgentInputFiles, prepareAgentRunWorkspace, prepareReservedDirectory } = await import('../src/jobs/agentRuns/workspace.ts');
type AgentRunProcessorDeps = import('../src/jobs/processAgentRunJob.ts').AgentRunProcessorDeps;
type AgentRunWorkspace = import('../src/jobs/agentRuns/workspace.ts').AgentRunWorkspace;

// Importing @propr/core opens the shared database connection.
after(async () => {
  try {
    await fs.remove(SCRATCH_BASE);
    await fs.remove(SUDO_BIN);
  } finally {
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
  }
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
  taskState: () => string | null;
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
  /** Stored state of the report task before the delivery; null when it does not exist. */
  task?: string | null;
} = {}): Harness {
  let current = options.run ?? storedRun();
  const transitions: Harness['transitions'] = [];
  const stateCalls: Harness['stateCalls'] = [];
  const cleanup = mock.fn(async () => undefined);
  let task: string | null = options.task ?? null;
  const taskStates: Record<string, string> = { create: 'pending', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  const record = (name: string) => async (...args: unknown[]) => {
    stateCalls.push([name, ...args]);
    const next = name === 'update' ? args[1] as string : taskStates[name];
    // Like WorkerStateManager: a terminal task keeps its state.
    if (name === 'create' ? task === null : task === null || !terminal.has(task)) task = next;
    return null;
  };

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
    taskState: () => task,
    transitions, stateCalls, executeTask, listPreviousReports, buildPrompt, prepareWorkspace, cleanup,
    deps: {
      getRun: async () => current,
      transitionRun,
      validateDefinition: async () => options.invalid ?? null,
      listPreviousReports: listPreviousReports as unknown as AgentRunProcessorDeps['listPreviousReports'],
      stateManager: () => ({
        createTaskStateIfAbsent: record('create'),
        getTaskState: async () => (task === null ? null : { state: task }),
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

/** What the cancel endpoint stores: running → cancelled. */
async function cancelRun(h: Harness): Promise<void> {
  await h.deps.transitionRun!('run-1', ['queued', 'running'], 'cancelled');
}

/** Makes one task-state call fail once, as a Redis outage would. */
function failTaskCallOnce(h: Harness, name: 'markTaskFailed' | 'markTaskCancelled'): void {
  const stateManager = h.deps.stateManager!;
  let failed = false;
  h.deps.stateManager = () => {
    const manager = stateManager();
    return {
      ...manager,
      [name]: async (...args: unknown[]) => {
        if (!failed) { failed = true; throw new Error('redis unavailable'); }
        return (manager[name] as (...callArgs: unknown[]) => Promise<unknown>)(...args);
      },
    } as typeof manager;
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

  test('a definition invalidated after a failed claim fails the task the earlier delivery created', async () => {
    const h = harness();
    const transitionRun = h.deps.transitionRun!;
    let outage = true;
    h.deps.transitionRun = (async (...args: Parameters<typeof transitionRun>) => {
      if (outage && args[2] === 'running') throw new Error('database unavailable');
      return transitionRun(...args);
    }) as AgentRunProcessorDeps['transitionRun'];
    let invalid: string | null = null;
    h.deps.validateDefinition = async () => invalid;
    const processor = createAgentRunProcessor(h.deps);

    await assert.rejects(processor(job), /database unavailable/);
    assert.equal(h.run().state, 'queued');
    assert.equal(h.taskState(), 'pending');

    // An administrator disables a repository before the retry.
    outage = false;
    invalid = 'Repositories are not enabled: acme/web';
    const retried = await processor(job);
    assert.equal(retried.status, 'failed');
    assert.equal(h.run().state, 'failed');
    assert.equal(h.taskState(), 'failed');
    assert.deepEqual(h.stateCalls.map(call => call[0]), ['create', 'failed']);
    assert.equal(h.executeTask.mock.callCount(), 0);
  });

  test('a validation failure whose existing task cannot be ended rejects the delivery and the retry ends it', async () => {
    const h = harness({ invalid: 'Repositories are not enabled: acme/web', task: 'pending' });
    failTaskCallOnce(h, 'markTaskFailed');
    const processor = createAgentRunProcessor(h.deps);
    await assert.rejects(processor(job), AgentRunSettlementError);
    assert.equal(h.run().state, 'failed');
    assert.equal(h.taskState(), 'pending');

    const retried = await processor(job);
    assert.equal(retried.status, 'failed');
    assert.equal(h.taskState(), 'failed');
    assert.ok(!h.stateCalls.some(call => call[0] === 'create'));
  });

  test('a run cancelled between pickup and start cancels its task and never starts a container', async () => {
    const h = harness();
    // Cancel lands after the task exists but before queued → running.
    const createTask = h.deps.stateManager!;
    h.deps.stateManager = () => {
      const manager = createTask();
      return {
        ...manager,
        createTaskStateIfAbsent: async (...args: Parameters<typeof manager.createTaskStateIfAbsent>) => {
          const created = await manager.createTaskStateIfAbsent(...args);
          await cancelRun(h);
          return created;
        },
      } as typeof manager;
    };
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(h.stateCalls.map(call => call[0]), ['create', 'cancelled']);
    assert.equal(h.prepareWorkspace.mock.callCount(), 0);
    assert.equal(h.executeTask.mock.callCount(), 0);
  });

  test('a run failed between pickup and start fails its task', async () => {
    const h = harness();
    h.deps.validateDefinition = async () => {
      await h.deps.transitionRun!('run-1', ['queued'], 'failed', { failureReason: 'Recovered elsewhere' });
      return null;
    };
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'failed');
    assert.equal(h.taskState(), 'failed');
    assert.equal(h.executeTask.mock.callCount(), 0);
  });

  test('a stale delivery that loses the claim to a stalled-job redelivery leaves the claimant\'s task alone', async () => {
    const h = harness();
    let release!: () => void;
    let started!: () => void;
    const executing = new Promise<void>(resolve => { started = resolve; });
    // Delivery B, in another worker process, claims the run and executes.
    h.deps.resolveAgent = async () => ({
      agent: {
        executeTask: async () => {
          started();
          await new Promise<void>(resolve => { release = resolve; });
          return { success: true, summary: 'Report', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 };
        },
      } as never,
      alias: 'claude', model: 'opus',
    });
    const workerB = createAgentRunProcessor(h.deps);
    let second: Promise<unknown> | undefined;
    // Delivery A read the queued run and is interrupted before claiming it.
    const workerA = createAgentRunProcessor({
      ...h.deps,
      validateDefinition: async () => {
        second = workerB(job);
        await executing;
        return null;
      },
    });
    const stale = await workerA(job);
    assert.equal(stale.status, 'skipped');
    assert.equal(h.run().state, 'running');
    assert.equal(h.taskState(), 'claude_execution');
    assert.ok(!h.stateCalls.some(call => call[0] === 'cancelled' || call[0] === 'failed'));

    release();
    assert.equal(((await second) as { status: string }).status, 'complete');
    assert.equal(h.run().state, 'completed');
    assert.equal(h.taskState(), 'completed');
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

  test('a cancel during execution is not overwritten by the late result and cancels the task', async () => {
    // The cancel endpoint could not stop the task, so the agent still returns a report.
    const h: Harness = harness({
      execute: async () => {
        await cancelRun(h);
        return { success: true, summary: 'Report', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 };
      },
    });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.equal(h.run().state, 'cancelled');
    assert.equal(h.run().report, null);
    assert.equal(h.stateCalls.at(-1)?.[0], 'cancelled');
    assert.ok(!h.stateCalls.some(call => call[0] === 'completed' || call[0] === 'failed'));
    assert.equal(h.cleanup.mock.callCount(), 1);
  });

  test('a cancel during execution followed by an agent failure cancels the task instead of failing it', async () => {
    const h: Harness = harness({
      execute: async () => {
        await cancelRun(h);
        return { success: false, error: 'container killed', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 };
      },
    });
    await createAgentRunProcessor(h.deps)(job);
    assert.equal(h.executeTask.mock.callCount(), 1);
    assert.equal(h.run().state, 'cancelled');
    assert.equal(h.stateCalls.at(-1)?.[0], 'cancelled');
    assert.ok(!h.stateCalls.some(call => call[0] === 'failed'));
    assert.equal(h.cleanup.mock.callCount(), 1);
  });

  test('a task stopped directly during execution discards a late report and cancels the run', async () => {
    const h: Harness = harness({
      execute: async () => {
        await h.deps.stateManager!().markTaskCancelled(agentRunReportTaskId('run-1'), 'user');
        return { success: true, summary: 'Report', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 };
      },
    });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.equal(h.run().state, 'cancelled');
    assert.equal(h.run().report, null);
    assert.ok(!h.transitions.some(t => t.to === 'report_ready' || t.to === 'completed'));
    assert.equal(h.taskState(), 'cancelled');
    assert.equal(h.cleanup.mock.callCount(), 1);
  });

  test('a task stopped during the post-processing update cancels the run and publishes no report', async () => {
    const h = harness();
    const stateManager = h.deps.stateManager!;
    h.deps.stateManager = () => {
      const manager = stateManager();
      return {
        ...manager,
        updateTaskState: async (taskId: string, state: string, ...rest: unknown[]) => {
          // The Tasks UI stop lands while the post-processing update is awaited.
          if (state === 'post_processing') await manager.markTaskCancelled(taskId, 'user');
          return (manager.updateTaskState as (...args: unknown[]) => Promise<unknown>)(taskId, state, ...rest);
        },
      } as typeof manager;
    };
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.equal(h.run().state, 'cancelled');
    assert.equal(h.run().report, null);
    assert.ok(!h.transitions.some(t => t.to === 'report_ready' || t.to === 'completed'));
    assert.equal(h.taskState(), 'cancelled');
    assert.ok(!h.stateCalls.some(([name]) => name === 'completed'));
    assert.equal(h.cleanup.mock.callCount(), 1);
  });

  test('a task stopped directly during execution followed by an agent failure cancels the run instead of failing it', async () => {
    const h: Harness = harness({
      execute: async () => {
        await h.deps.stateManager!().markTaskCancelled(agentRunReportTaskId('run-1'), 'user');
        return { success: false, error: 'container killed', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 };
      },
    });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.equal(h.run().state, 'cancelled');
    assert.equal(h.run().failureReason, null);
    assert.ok(!h.transitions.some(t => t.to === 'failed'));
    assert.equal(h.taskState(), 'cancelled');
  });

  test('a task stopped directly during execution followed by a thrown agent error cancels the run', async () => {
    const h: Harness = harness({
      execute: async () => {
        await h.deps.stateManager!().markTaskCancelled(agentRunReportTaskId('run-1'), 'user');
        throw new Error('container stopped');
      },
    });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.equal(h.run().state, 'cancelled');
    assert.ok(!h.transitions.some(t => t.to === 'failed'));
  });

  test('a failure whose task cannot be read is still recorded on the run', async () => {
    const h = harness({
      execute: async () => ({ success: false, error: 'container exited', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 }),
    });
    const stateManager = h.deps.stateManager!;
    let reads = 0;
    h.deps.stateManager = () => ({
      ...stateManager(),
      // The launch check reads the task; later reads fail as a Redis outage would.
      getTaskState: async (id: string) => {
        if (reads++ > 0) throw new Error('redis unavailable');
        return stateManager().getTaskState(id);
      },
    }) as ReturnType<AgentRunProcessorDeps['stateManager']>;
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'failed');
    assert.equal(h.run().state, 'failed');
    assert.equal(h.taskState(), 'failed');
  });

  test('a redelivered abandoned run whose task was stopped directly is cancelled, not failed', async () => {
    const taskId = agentRunReportTaskId('run-1');
    const h = harness({ run: storedRun({ state: 'running', reportTaskId: taskId, startedAt: NOW }), task: 'cancelled' });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.equal(h.run().state, 'cancelled');
    assert.ok(!h.transitions.some(t => t.to === 'failed'));
    assert.equal(h.taskState(), 'cancelled');
  });

  test('a redelivery after the claiming worker was interrupted fails the abandoned run and task', async () => {
    const taskId = agentRunReportTaskId('run-1');
    const h = harness({ run: storedRun({ state: 'running', reportTaskId: taskId, startedAt: NOW }) });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'failed');
    assert.equal(h.run().state, 'failed');
    assert.equal(h.run().failureReason, AGENT_RUN_ABANDONED_REASON);
    assert.deepEqual(h.transitions.map(t => [t.from, t.to]), [[['running'], 'failed']]);
    assert.deepEqual(h.stateCalls.map(call => [call[0], call[1]]), [['failed', taskId]]);
    assert.equal(h.prepareWorkspace.mock.callCount(), 0);
    assert.equal(h.executeTask.mock.callCount(), 0);
  });

  test('a redelivered abandoned run that was cancelled meanwhile cancels its task', async () => {
    const taskId = agentRunReportTaskId('run-1');
    const h = harness({ run: storedRun({ state: 'running', reportTaskId: taskId }) });
    let reads = 0;
    const getRun = h.deps.getRun!;
    // The cancel lands between the redelivery's read and its fail transition.
    h.deps.getRun = async id => (reads++ === 0 ? getRun(id) : { ...h.run(), state: 'cancelled' });
    h.deps.transitionRun = (async () => null) as unknown as AgentRunProcessorDeps['transitionRun'];
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(h.stateCalls.map(call => call[0]), ['cancelled']);
  });

  test('a delivery competing with an attempt still executing in this worker is skipped', async () => {
    let release!: () => void;
    let started!: () => void;
    const executing = new Promise<void>(resolve => { started = resolve; });
    const h = harness({
      execute: async () => {
        started();
        await new Promise<void>(resolve => { release = resolve; });
        return { success: true, summary: 'Report', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 };
      },
    });
    const processor = createAgentRunProcessor(h.deps);
    const first = processor(job);
    await executing;
    const duplicate = await processor(job);
    assert.equal(duplicate.status, 'skipped');
    assert.equal(h.run().state, 'running');
    release();
    assert.equal((await first).status, 'complete');
    assert.equal(h.run().state, 'completed');
    assert.equal(h.executeTask.mock.callCount(), 1);
  });

  test('preview runs keep their report in report_ready until the acting step exists', async () => {
    const h = harness({ run: storedRun({ autonomyMode: 'preview' }) });
    await createAgentRunProcessor(h.deps)(job);
    assert.equal(h.run().state, 'report_ready');
    assert.ok(h.run().report);
  });

  test('a redelivery after the worker stopped once the report was stored completes the dry run and its task', async () => {
    const taskId = agentRunReportTaskId('run-1');
    const h = harness({
      run: storedRun({ state: 'report_ready', reportTaskId: taskId, report: '## Summary\nStored report.' }),
      task: 'post_processing',
    });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'complete');
    assert.equal(h.run().state, 'completed');
    assert.equal(h.run().report, '## Summary\nStored report.');
    assert.deepEqual(h.transitions.map(t => [t.from, t.to]), [[['report_ready'], 'completed']]);
    assert.deepEqual(h.stateCalls.map(call => [call[0], call[1]]), [['completed', taskId]]);
    assert.equal((h.stateCalls[0][2] as { notificationRecap?: string }).notificationRecap, 'Stored report.');
    assert.equal(h.taskState(), 'completed');
    assert.equal(h.prepareWorkspace.mock.callCount(), 0);
    assert.equal(h.executeTask.mock.callCount(), 0);
  });

  test('a redelivery after the run completed but before its task did completes the task', async () => {
    const taskId = agentRunReportTaskId('run-1');
    const h = harness({ run: storedRun({ state: 'completed', reportTaskId: taskId, report: 'Report' }), task: 'post_processing' });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'complete');
    assert.equal(h.transitions.length, 0);
    assert.deepEqual(h.stateCalls.map(call => [call[0], call[1]]), [['completed', taskId]]);
    assert.equal(h.executeTask.mock.callCount(), 0);
  });

  test('a duplicate delivery of a finished run leaves its completed task alone', async () => {
    const taskId = agentRunReportTaskId('run-1');
    const h = harness({ run: storedRun({ state: 'completed', reportTaskId: taskId, report: 'Report' }), task: 'completed' });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'complete');
    assert.equal(h.transitions.length, 0);
    assert.equal(h.stateCalls.length, 0);
    assert.equal(h.executeTask.mock.callCount(), 0);
  });

  test('a redelivered preview run keeps report_ready and completes its task', async () => {
    const taskId = agentRunReportTaskId('run-1');
    const h = harness({
      run: storedRun({ state: 'report_ready', autonomyMode: 'preview', reportTaskId: taskId, report: 'Report' }),
      task: 'post_processing',
    });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'complete');
    assert.equal(h.run().state, 'report_ready');
    assert.equal(h.transitions.length, 0);
    assert.deepEqual(h.stateCalls.map(call => [call[0], call[1]]), [['completed', taskId]]);
  });

  test('a finalization error after the report is stored keeps the report and is retried by the next delivery', async () => {
    const h = harness();
    const advance = h.deps.advanceAfterReport!;
    let attempts = 0;
    h.deps.advanceAfterReport = async run => {
      if (attempts++ === 0) throw new Error('connection reset');
      return advance(run);
    };
    const processor = createAgentRunProcessor(h.deps);
    await assert.rejects(processor(job), /connection reset/);
    assert.equal(h.run().state, 'report_ready');
    assert.ok(h.run().report);
    assert.ok(!h.stateCalls.some(call => call[0] === 'failed' || call[0] === 'completed'));
    assert.equal(h.cleanup.mock.callCount(), 1);

    const retried = await processor(job);
    assert.equal(retried.status, 'complete');
    assert.equal(h.run().state, 'completed');
    assert.equal(h.taskState(), 'completed');
    assert.equal(h.executeTask.mock.callCount(), 1);
  });

  test('a failure transition that cannot be stored rejects the delivery; the retry fails the abandoned run', async () => {
    const h = harness({
      execute: async () => ({ success: false, error: 'container exited', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 }),
    });
    const transitionRun = h.deps.transitionRun!;
    let outage = true;
    h.deps.transitionRun = (async (...args: Parameters<typeof transitionRun>) => {
      if (outage && args[2] === 'failed') throw new Error('database unavailable');
      return transitionRun(...args);
    }) as typeof transitionRun;
    const processor = createAgentRunProcessor(h.deps);
    await assert.rejects(processor(job), AgentRunPersistenceError);
    assert.equal(h.run().state, 'running');
    assert.ok(!h.stateCalls.some(call => call[0] === 'failed'));
    assert.equal(h.cleanup.mock.callCount(), 1);

    outage = false;
    const retried = await processor(job);
    assert.equal(retried.status, 'failed');
    assert.equal(h.run().state, 'failed');
    assert.equal(h.run().failureReason, AGENT_RUN_ABANDONED_REASON);
    assert.equal(h.taskState(), 'failed');
    assert.equal(h.executeTask.mock.callCount(), 1);
  });

  test('a validation failure that cannot be stored rejects the delivery', async () => {
    const h = harness({ invalid: 'Repositories are not enabled: acme/web' });
    h.deps.transitionRun = (async () => { throw new Error('database unavailable'); }) as unknown as AgentRunProcessorDeps['transitionRun'];
    await assert.rejects(createAgentRunProcessor(h.deps)(job), AgentRunPersistenceError);
    assert.equal(h.run().state, 'queued');
  });

  test('an abandoned run whose failure cannot be stored rejects the delivery and leaves the task running', async () => {
    const h = harness({ run: storedRun({ state: 'running', reportTaskId: agentRunReportTaskId('run-1') }), task: 'claude_execution' });
    h.deps.transitionRun = (async () => { throw new Error('database unavailable'); }) as unknown as AgentRunProcessorDeps['transitionRun'];
    await assert.rejects(createAgentRunProcessor(h.deps)(job), AgentRunPersistenceError);
    assert.equal(h.run().state, 'running');
    assert.equal(h.stateCalls.length, 0);
  });

  test('without repository_read the agent launches with no repository mounts or credentials', async () => {
    const h = harness({ run: storedRun({ definitionSnapshot: definition({ capabilities: [] }) }) });
    await createAgentRunProcessor(h.deps)(job);
    const options = h.executeTask.mock.calls[0].arguments[0] as AgentTaskOptions;
    assert.equal(options.repositoryAccess, 'none');
    assert.equal(options.githubToken, '');
  });

  test('a repository-free run completes without GitHub access even when obtaining it would fail', async () => {
    for (const snapshot of [definition({ capabilities: [], repositories: [] }), definition({ capabilities: [] }), definition({ repositories: [] })]) {
      const h = harness({ run: storedRun({ definitionSnapshot: snapshot }) });
      const getGitHubAccess = mock.fn(async () => { throw new Error('installation authentication unavailable'); });
      h.deps.getGitHubAccess = getGitHubAccess;
      const result = await createAgentRunProcessor(h.deps)(job);
      assert.equal(result.status, 'complete');
      assert.equal(h.run().state, 'completed');
      assert.equal(getGitHubAccess.mock.callCount(), 0);
      const input = h.prepareWorkspace.mock.calls[0].arguments[0] as { githubToken: string; octokit?: unknown };
      assert.equal(input.githubToken, '');
      assert.equal(input.octokit, undefined);
      const options = h.executeTask.mock.calls[0].arguments[0] as AgentTaskOptions;
      assert.equal(options.repositoryAccess, 'none');
      assert.equal(options.githubToken, '');
    }
  });

  test('a run reading repositories still fails when GitHub access cannot be obtained', async () => {
    const h = harness();
    h.deps.getGitHubAccess = async () => { throw new Error('installation authentication unavailable'); };
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'failed');
    assert.equal(h.run().state, 'failed');
    assert.equal(h.prepareWorkspace.mock.callCount(), 0);
  });

  test('repository_read without a readable workspace still launches without repository access', async () => {
    const h = harness({
      prepare: async () => ({
        worktreePath: '/tmp/scratch', branchName: 'agent-run/run-1',
        promptWorkspace: { repositoriesReadable: false, primaryRepository: '.', contextRepositories: [] },
        attachments: [], cleanup: async () => undefined,
      }),
    });
    await createAgentRunProcessor(h.deps)(job);
    const options = h.executeTask.mock.calls[0].arguments[0] as AgentTaskOptions;
    assert.equal(options.repositoryAccess, 'none');
    assert.equal(options.githubToken, '');
  });

  test('with repository_read the agent gets the worker credential for the adapter to scope', async () => {
    const h = harness();
    await createAgentRunProcessor(h.deps)(job);
    const options = h.executeTask.mock.calls[0].arguments[0] as AgentTaskOptions;
    assert.equal(options.repositoryAccess, undefined);
    assert.equal(options.githubToken, 'ghs_token');
  });

  test('a run cancelled while its workspace is prepared never starts the agent', async () => {
    const h: Harness = harness({
      prepare: async () => {
        await cancelRun(h);
        return {
          worktreePath: '/tmp/worktree', branchName: 'agent-run/run-1',
          promptWorkspace: { repositoriesReadable: true, primaryRepository: '.', contextRepositories: [] },
          attachments: [], cleanup: h.cleanup,
        };
      },
    });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.equal(h.executeTask.mock.callCount(), 0);
    assert.equal(h.run().state, 'cancelled');
    assert.equal(h.taskState(), 'cancelled');
    assert.equal(h.cleanup.mock.callCount(), 1);
  });

  test('a task stopped while its workspace is prepared cancels the run and never starts the agent', async () => {
    const h: Harness = harness({
      prepare: async () => {
        await h.deps.stateManager!().markTaskCancelled(agentRunReportTaskId('run-1'), 'user');
        return {
          worktreePath: '/tmp/worktree', branchName: 'agent-run/run-1',
          promptWorkspace: { repositoriesReadable: true, primaryRepository: '.', contextRepositories: [] },
          attachments: [], cleanup: h.cleanup,
        };
      },
    });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.equal(h.executeTask.mock.callCount(), 0);
    assert.equal(h.run().state, 'cancelled');
    assert.equal(h.taskState(), 'cancelled');
    assert.equal(h.cleanup.mock.callCount(), 1);
  });

  test('a task that could not be failed rejects the delivery; the retry fails the task of the failed run', async () => {
    const h = harness({
      execute: async () => ({ success: false, error: 'container exited', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 }),
    });
    failTaskCallOnce(h, 'markTaskFailed');
    const processor = createAgentRunProcessor(h.deps);
    await assert.rejects(processor(job), AgentRunSettlementError);
    assert.equal(h.run().state, 'failed');
    assert.equal(h.taskState(), 'claude_execution');

    const retried = await processor(job);
    assert.equal(retried.status, 'failed');
    assert.equal(h.taskState(), 'failed');
    assert.equal(h.executeTask.mock.callCount(), 1);
  });

  test('a redelivered failed run whose worker stopped before the task followed fails the task', async () => {
    const taskId = agentRunReportTaskId('run-1');
    const h = harness({
      run: storedRun({ state: 'failed', reportTaskId: taskId, failureReason: 'Agent execution failed: container exited' }),
      task: 'claude_execution',
    });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'failed');
    assert.deepEqual(h.stateCalls.map(call => [call[0], call[1]]), [['failed', taskId]]);
    assert.equal((h.stateCalls[0][2] as Error).message, 'Agent execution failed: container exited');
    assert.equal(h.transitions.length, 0);
    assert.equal(h.executeTask.mock.callCount(), 0);
  });

  test('a redelivered cancelled run whose task was never stopped cancels the task', async () => {
    const h = harness({ run: storedRun({ state: 'cancelled' }), task: 'pending' });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'cancelled');
    assert.equal(h.taskState(), 'cancelled');
    assert.equal(h.prepareWorkspace.mock.callCount(), 0);
  });

  test('a redelivered failed run whose task already ended is left alone', async () => {
    const h = harness({ run: storedRun({ state: 'failed', reportTaskId: agentRunReportTaskId('run-1') }), task: 'failed' });
    const result = await createAgentRunProcessor(h.deps)(job);
    assert.equal(result.status, 'skipped');
    assert.equal(h.stateCalls.length, 0);
  });

  test('an abandoned run whose task could not be failed rejects the delivery; the retry fails the task', async () => {
    const h = harness({ run: storedRun({ state: 'running', reportTaskId: agentRunReportTaskId('run-1') }), task: 'claude_execution' });
    failTaskCallOnce(h, 'markTaskFailed');
    const processor = createAgentRunProcessor(h.deps);
    await assert.rejects(processor(job), AgentRunSettlementError);
    assert.equal(h.run().state, 'failed');
    assert.equal(h.taskState(), 'claude_execution');

    const retried = await processor(job);
    assert.equal(retried.status, 'failed');
    assert.equal(h.taskState(), 'failed');
  });

  test('a cancelled run whose task could not be cancelled rejects the delivery; the retry cancels the task', async () => {
    const h: Harness = harness({
      execute: async () => {
        await cancelRun(h);
        return { success: true, summary: 'Report', logs: '', modifiedFiles: [], modelUsed: 'opus', executionTimeMs: 1 };
      },
    });
    failTaskCallOnce(h, 'markTaskCancelled');
    const processor = createAgentRunProcessor(h.deps);
    await assert.rejects(processor(job), AgentRunSettlementError);
    assert.equal(h.run().state, 'cancelled');
    assert.equal(h.taskState(), 'post_processing');
    assert.equal(h.cleanup.mock.callCount(), 1);

    const retried = await processor(job);
    assert.equal(retried.status, 'cancelled');
    assert.equal(h.taskState(), 'cancelled');
    assert.equal(h.executeTask.mock.callCount(), 1);
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
        }], { inputRoot: inputs });
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

  test('additional repositories excluded by the primary repository context policy are never checked out', async () => {
    const resolveContextPolicy = mock.fn(async () => ['acme/web']);
    const prepared = prepareAgentRunWorkspace({
      runId: 'run-restricted', definition: definition(), githubToken: 'worker-token', resolveContextPolicy,
    });
    // Rejected before any clone: a clone attempt would fail with a different error.
    await assert.rejects(prepared, /contextRepositories setting of acme\/web does not allow reading acme\/api/);
    assert.deepEqual(resolveContextPolicy.mock.calls.map(call => call.arguments), [['acme/web']]);
  });

  test('context clones authenticate per command and never put the token in the clone URL or config', async () => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-fake-git-'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-'));
    const originalPath = process.env.PATH;
    try {
      // Records each invocation; a clone writes its remote URL to the destination's config, as git does.
      await fs.writeFile(path.join(bin, 'git'), [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> "${bin}/calls"`,
        `printf '%s\\n' "$GIT_CONFIG_KEY_1=$GIT_CONFIG_VALUE_1" >> "${bin}/env"`,
        'for last; do :; done',
        'if [ "$1 $2" = "-c core.hooksPath=/dev/null" ] && [ "$3" = clone ]; then',
        '  mkdir -p "$last/.git"',
        '  for arg; do case "$arg" in https://*) printf \'[remote "origin"]\\n\\turl = %s\\n\' "$arg" > "$last/.git/config";; esac; done',
        'fi',
        '',
      ].join('\n'), { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
      const destination = path.join(root, 'acme__api');
      await cloneContextRepository('acme/api', destination, 'ghs_worker_secret');

      const calls = await fs.readFile(path.join(bin, 'calls'), 'utf8');
      assert.ok(!calls.includes('ghs_worker_secret'));
      assert.match(calls, /^-c core\.hooksPath=\/dev\/null clone .* https:\/\/github\.com\/acme\/api\.git /);
      assert.equal(await fs.readFile(path.join(destination, '.git', 'config'), 'utf8'), '[remote "origin"]\n\turl = https://github.com/acme/api.git\n');
      const header = `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_worker_secret').toString('base64')}`;
      assert.deepEqual((await fs.readFile(path.join(bin, 'env'), 'utf8')).trim().split('\n'), [header]);
    } finally {
      process.env.PATH = originalPath;
      await fs.remove(bin);
      await fs.remove(root);
    }
  });

  test('context policy checks follow the adapter semantics', () => {
    // `all` (or no setting) allows every repository.
    assertContextRepositoriesAllowed('acme/web', ['acme/api'], undefined);
    // Policies are lowercased; definition names may not be.
    assertContextRepositoriesAllowed('acme/web', ['Acme/API'], ['acme/api', 'acme/web']);
    // `none` resolves to the primary repository alone.
    assert.throws(() => assertContextRepositoriesAllowed('acme/web', ['acme/api'], ['acme/web']), /does not allow reading acme\/api/);
    assert.throws(() => assertContextRepositoriesAllowed('acme/web', ['acme/api', 'acme/docs'], ['acme/api', 'acme/web']), /does not allow reading acme\/docs\./);
  });

  test('input files are not written through a checked-out symlink to a directory outside the workspace', async () => {
    const inputs = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inputs-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-workspace-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-outside-'));
    try {
      const storedPath = path.join(inputs, 'def-1', 'abc-notes.txt');
      await fs.outputFile(storedPath, 'notes');
      await fs.outputFile(path.join(outside, 'notes.txt'), 'original');
      await fs.ensureDir(path.join(workspace, '.propr'));
      await fs.symlink(outside, path.join(workspace, AGENT_INPUTS_DIR));

      const copied = await copyAgentInputFiles(workspace, 'def-1', [{
        id: 'a1', originalName: 'notes.txt', storedPath, mimeType: 'text/plain', size: 5, tokenEstimate: 1, type: 'text',
      }], { inputRoot: inputs });

      assert.deepEqual(copied, [{ originalName: 'notes.txt', workspacePath: path.join(AGENT_INPUTS_DIR, 'notes.txt') }]);
      assert.equal(await fs.readFile(path.join(outside, 'notes.txt'), 'utf8'), 'original');
      assert.ok(!(await fs.lstat(path.join(workspace, AGENT_INPUTS_DIR))).isSymbolicLink());
      assert.equal(await fs.readFile(path.join(workspace, AGENT_INPUTS_DIR, 'notes.txt'), 'utf8'), 'notes');
    } finally {
      await fs.remove(inputs);
      await fs.remove(workspace);
      await fs.remove(outside);
    }
  });

  test('reserved directories replace symlinks anywhere on their path and anything already inside them', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-workspace-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-outside-'));
    try {
      await fs.outputFile(path.join(outside, 'context', 'keep.txt'), 'outside');
      // `.propr` itself points outside the workspace.
      await fs.symlink(outside, path.join(workspace, '.propr'));
      const contextDir = await prepareReservedDirectory(workspace, AGENT_CONTEXT_DIR);
      assert.equal(contextDir, path.join(await fs.realpath(workspace), AGENT_CONTEXT_DIR));
      assert.ok(!(await fs.lstat(path.join(workspace, '.propr'))).isSymbolicLink());
      assert.deepEqual(await fs.readdir(contextDir), []);
      assert.equal(await fs.readFile(path.join(outside, 'context', 'keep.txt'), 'utf8'), 'outside');

      // A tracked file symlink inside a real reserved directory is removed, not followed.
      await fs.outputFile(path.join(outside, 'notes.txt'), 'original');
      await fs.ensureDir(path.join(workspace, AGENT_INPUTS_DIR));
      await fs.symlink(path.join(outside, 'notes.txt'), path.join(workspace, AGENT_INPUTS_DIR, 'notes.txt'));
      const inputsDir = await prepareReservedDirectory(workspace, AGENT_INPUTS_DIR);
      assert.deepEqual(await fs.readdir(inputsDir), []);
      assert.equal(await fs.readFile(path.join(outside, 'notes.txt'), 'utf8'), 'original');
    } finally {
      await fs.remove(workspace);
      await fs.remove(outside);
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
      }], { log: { warn } as never, inputRoot: inputs });
      assert.deepEqual(copied, []);
      assert.equal(warn.mock.callCount(), 1);
    } finally {
      await fs.remove(inputs);
      await fs.remove(target);
    }
  });
});
