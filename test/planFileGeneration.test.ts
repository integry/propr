import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, beforeEach, describe, mock, test } from 'node:test';
import type { Agent, AnalyzeOptions } from '../packages/core/src/agents/types.js';
import type { SyntheticRoutingSession as RoutingSession } from '../packages/core/src/services/syntheticRoutingService.js';

const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'propr-plan-workspaces-'));
process.env.PROPR_PLAN_WORKSPACE_ROOT = workspaceRoot;
after(() => rmSync(workspaceRoot, { recursive: true, force: true }));

const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };
await mock.module('../packages/core/src/utils/logger.js', {
  defaultExport: { ...logger, withCorrelation: mock.fn(() => logger) },
});

class PlanningFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningFailedError';
  }
}
await mock.module('../packages/core/src/services/planning/index.js', {
  namedExports: {
    PlanningFailedError,
    updateTraceForRun: mock.fn(async () => undefined),
    validatePromptTokens: mock.fn(async (prompt: string) => ({ valid: true, tokenCount: Math.ceil(prompt.length / 4), source: 'tiktoken' as const })),
    CLAUDE_CODE_OVERHEAD: 5_000,
    getModelHardLimit: mock.fn(() => 200_000),
    getRawInputCharLimit: mock.fn(() => null),
  },
});
await mock.module('../packages/core/src/config/modelAliases.js', {
  namedExports: { resolveModelAlias: (model: string) => model },
});
await mock.module('../packages/core/src/utils/llmLogger.js', {
  namedExports: {
    buildAnalysisWorkRef: (executionType: string, taskId: string, repository: string) => ({ workType: 'plan', planDraftId: taskId, workRepository: repository, executionType }),
    withTaskLogAttribution: (metadata: Record<string, unknown>, attribution: unknown) => ({ ...metadata, proprLogAttribution: attribution }),
  },
});
await mock.module('../packages/core/src/utils/llmEstimation.js', {
  namedExports: { estimateLlmDuration: mock.fn(async () => ({ estimatedDurationMs: 1, isHistoricalEstimate: false, sampleCount: 0, avgMsPerToken: 0 })) },
});
const replies: string[] = [];
const runLightweightLLMAnalysis = mock.fn(async (options: { prompt: string; routingSession?: RoutingSession }) => {
  if (options.routingSession instanceof SyntheticRoutingSession) {
    const result = await options.routingSession.analyze(options.prompt);
    assert.equal(result.success, true);
    return result.response;
  }
  const reply = replies.shift();
  if (reply === undefined) throw new Error('Unexpected reply-mode call');
  return reply;
});
await mock.module('../packages/core/src/claude/claudeService.js', { namedExports: { runLightweightLLMAnalysis } });

// Exercise the real routing retry loop without opening database/queue connections.
await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: {} } });
await mock.module('../packages/core/src/config/configManager.js', { namedExports: { loadSyntheticAgents: async () => [] } });
await mock.module('../packages/core/src/services/syntheticUsageSnapshotProvider.js', {
  namedExports: { AliasSpecificAgentTankSnapshotProvider: class {} },
});
await mock.module('../packages/core/src/utils/tokenCalculation.js', {
  namedExports: { estimateTokens: (text: string) => Math.ceil(text.length / 4) },
});
const { SyntheticRoutingSession, SyntheticRoutingService, SyntheticPoolExhaustedError } = await import('../packages/core/src/services/syntheticRoutingService.js');

const { PLAN_VALIDATOR_SCRIPT, validatePlanTaskFiles, validatePlanText } = await import('../packages/core/src/services/taskPlanning/planValidation.js');
const { runPlanFileAgent, PlanFileAgentUnavailableError } = await import('../packages/core/src/services/taskPlanning/planFileAgent.js');
const { buildPlanFilePrompt, resolvePlanGenerationMode, tryGeneratePlanWithFiles } = await import('../packages/core/src/services/taskPlanning/planFileGeneration.js');
const { callLLMForPlan } = await import('../packages/core/src/services/taskPlanning/llmCalling.js');

const task = (title: string) => ({ title, body: `Why ${title} matters`, implementation: `~~~diff\n+ ${title}\n~~~` });
const json = (value: unknown) => JSON.stringify(value, null, 2);

type TaskOptions = { worktreePath: string; prompt: string; model?: string; taskId?: string; maxTurns?: number; metadata?: Record<string, unknown> };
/** A routing session whose agent writes files into the workspace it is given. */
function fakeAgent(write: (workspace: string, options: TaskOptions) => void | Promise<void>, result: Record<string, unknown> = { success: true }) {
  const calls: TaskOptions[] = [];
  return {
    calls,
    session: {
      fork: () => ({}),
      executeTask: async (options: TaskOptions) => {
        calls.push(options);
        await write(options.worktreePath, options);
        return { modifiedFiles: [], logs: '', modelUsed: options.model, executionTimeMs: 1, ...result };
      },
    },
  };
}
/** Stub member selection only; physical invocation and failover use the production loop. */
function routedAgents(...agents: ReturnType<typeof fakeAgent>[]) {
  let next = 0;
  return new SyntheticRoutingSession({
    select: async () => {
      const agent = agents[next++];
      if (!agent) throw new Error('routing pool exhausted');
      return {
        physicalAgent: agent.session, physicalModel: 'opus', synthetic: true,
        memberId: `member-${next}`, attemptNumber: next,
      };
    },
    metadataFor: () => ({}),
    recordAttempt: async () => undefined,
  } as never, { requestedAgentAlias: 'pool', requestedModel: 'smart', requiredTokens: 0, callId: 'routing-test' });
}
const writeTasks = (workspace: string, files: Record<string, string>) => {
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(workspace, 'tasks', name), content);
};
const baseOptions = { model: 'claude:opus', draftId: 'draft-1', repository: 'acme/repo', githubToken: 'token', correlationId: 'plan-1' };

beforeEach(() => {
  delete process.env.PROPR_PLAN_GENERATION_MODE;
  replies.length = 0;
  runLightweightLLMAnalysis.mock.resetCalls();
});

describe('incremental task-file contract in the validator', () => {
  test('assembles task files in name order into plan.json', async () => {
    const report = await validatePlanTaskFiles({ '002.json': json(task('Second')), '001.json': json(task('First')) });
    assert.equal(report.valid, true, report.errors.join('; '));
    assert.equal(report.taskCount, 2);
    assert.deepEqual(JSON.parse(report.planText!).map((item: { title: string }) => item.title), ['First', 'Second']);
  });

  test('names the file that needs fixing', async () => {
    const report = await validatePlanTaskFiles({ '001.json': json(task('Fine')), '002.json': '{"title": "Broken",', '003.json': json([task('Array')]) });
    assert.equal(report.valid, false);
    assert.equal(report.planText, null);
    assert.match(report.errors.join('\n'), /tasks\/002\.json is not valid JSON/);
    assert.match(report.errors.join('\n'), /tasks\/003\.json must hold one task object, not an array/);
    const incomplete = await validatePlanTaskFiles({ '001.json': json({ title: 'Only a title' }) });
    assert.match(incomplete.errors[0], /^task 1 \(tasks\/001\.json\) has no non-empty "body" string$/);
  });

  test('reports a missing or empty tasks directory and keeps the plain plan.json form unchanged', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'propr-validator-'));
    try {
      writeFileSync(path.join(directory, 'validate-plan.mjs'), PLAN_VALIDATOR_SCRIPT);
      const empty = spawnSync(process.execPath, ['validate-plan.mjs', '--tasks', 'tasks'], { cwd: directory, encoding: 'utf8' });
      assert.equal(empty.status, 1);
      assert.match(JSON.parse(empty.stdout).errors[0], /no task files: write one task object per file as tasks\/001\.json/);
      assert.equal(existsSync(path.join(directory, 'plan.json')), false, 'nothing is assembled from no tasks');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    const plain = await validatePlanText(json([{ title: 'Only a title' }]));
    assert.equal(plain.errors[0], 'task 1 has no non-empty "body" string');
  });
});

describe('plan file agent with task files', () => {
  test('returns the plan the agent wrote task by task and cleans the workspace up', async () => {
    const agent = fakeAgent(workspace => writeTasks(workspace, { '001.json': json(task('One')), '002.json': json(task('Two')) }));
    const plan = await runPlanFileAgent({ ...baseOptions, purpose: 'generation', prompt: 'Plan it', taskFiles: true, executionType: 'plan-generation', routingSession: agent.session as never });
    assert.deepEqual(plan.map(item => item.title), ['One', 'Two']);
    assert.equal(agent.calls[0].model, 'opus');
    assert.equal(agent.calls[0].maxTurns, 200, 'one turn per task file must fit, beyond the shipped CLAUDE_MAX_TURNS=10');
    assert.equal((agent.calls[0].metadata?.proprLogAttribution as { executionType: string }).executionType, 'plan-generation');
    assert.deepEqual(readdirSync(workspaceRoot), [], 'workspace removed');
  });

  for (const failure of ['result', 'throw']) {
    test(`isolates task files across routing retries after a failed ${failure}`, async () => {
      const abandoned = fakeAgent(workspace => {
        writeTasks(workspace, {
          '001.json': json(task('Old one')), '002.json': json(task('Old two')), '003.json': json(task('Abandoned')),
        });
        const validation = spawnSync(process.execPath, ['validate-plan.mjs', '--tasks', 'tasks'], { cwd: workspace, encoding: 'utf8' });
        assert.equal(validation.status, 0, validation.stderr);
        writeFileSync(path.join(workspace, 'validate-plan.mjs'), 'tampered');
        if (failure === 'throw') throw new Error('transport failed');
      }, { success: false, error: 'transport failed' });
      const replacement = fakeAgent(async workspace => {
        assert.notEqual(workspace, abandoned.calls[0].worktreePath);
        assert.deepEqual(readdirSync(path.join(workspace, 'tasks')), []);
        assert.equal(existsSync(path.join(workspace, 'plan.json')), false);
        assert.equal(readFileSync(path.join(workspace, 'validate-plan.mjs'), 'utf8'), PLAN_VALIDATOR_SCRIPT);
        await Promise.resolve();
        // Even a late write to the abandoned workspace cannot enter this plan.
        writeTasks(abandoned.calls[0].worktreePath, { '004.json': json(task('Late abandoned task')) });
        writeTasks(workspace, { '001.json': json(task('Replacement one')), '002.json': json(task('Replacement two')) });
        const validation = spawnSync(process.execPath, ['validate-plan.mjs', '--tasks', 'tasks'], { cwd: workspace, encoding: 'utf8' });
        assert.equal(validation.status, 0, validation.stderr);
      });
      const result = await callLLMForPlan({
        ...baseOptions, runId: 'run-retry', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
        repairModel: 'codex:gpt', granularity: 'balanced', routingSession: routedAgents(abandoned, replacement),
      });
      assert.deepEqual(result.plan.map(item => item.title), ['Replacement one', 'Replacement two']);
      assert.equal(abandoned.calls.length, 1);
      assert.equal(replacement.calls.length, 1);
      assert.equal(runLightweightLLMAnalysis.mock.callCount(), 0);
      assert.deepEqual(readdirSync(workspaceRoot), []);
    });
  }

  for (const taskFiles of [true, false]) {
    test(`rejects an empty successful retry instead of accepting abandoned ${taskFiles ? 'task files' : 'plan.json'}`, async () => {
      const abandoned = fakeAgent(workspace => {
        if (taskFiles) writeTasks(workspace, { '001.json': json(task('Abandoned')) });
        else writeFileSync(path.join(workspace, 'plan.json'), json([task('Abandoned')]));
      }, { success: false, error: 'transport failed' });
      const replacement = fakeAgent(() => undefined);
      await assert.rejects(runPlanFileAgent({
        ...baseOptions, purpose: 'generation', prompt: 'Plan it', taskFiles, executionType: 'plan-generation',
        routingSession: routedAgents(abandoned, replacement),
      }), taskFiles ? /wrote no task files/ : /produced no plan.json/);
      assert.deepEqual(readdirSync(workspaceRoot), []);
    });
  }

  test('retains earlier output evidence when routing exhausts after an empty retry', async () => {
    const abandoned = fakeAgent(workspace => writeTasks(workspace, { '001.json': json(task('Abandoned')) }), { success: false });
    const replacement = fakeAgent(() => { throw new Error('could not run'); });
    await assert.rejects(tryGeneratePlanWithFiles({
      ...baseOptions, fullContext: 'Plan it', routingSession: routedAgents(abandoned, replacement),
    }), (error: Error) => error instanceof PlanningFailedError && !(error instanceof PlanFileAgentUnavailableError)
      && /failed after producing output/.test(error.message));
    assert.deepEqual(readdirSync(workspaceRoot), []);
  });

  test('does not invoke another agent if preparing its isolated workspace fails', async () => {
    const files = { 'context.txt': 'original context' };
    const abandoned = fakeAgent(workspace => {
      writeTasks(workspace, { '001.json': json(task('Abandoned')) });
      // Make preparation fail on the retry, after the first attempt produced output.
      Object.assign(files, { 'missing/context.txt': 'cannot write here' });
    }, { success: false });
    const replacement = fakeAgent(() => undefined);
    await assert.rejects(runPlanFileAgent({
      ...baseOptions, purpose: 'generation', prompt: 'Plan it', taskFiles: true, files, executionType: 'plan-generation',
      routingSession: routedAgents(abandoned, replacement),
    }), (error: Error) => error instanceof PlanningFailedError && !(error instanceof PlanFileAgentUnavailableError)
      && /Could not prepare the plan workspace/.test(error.message));
    assert.equal(replacement.calls.length, 0);
    assert.deepEqual(readdirSync(workspaceRoot), []);
  });

  test('re-validates with its own validator', async () => {
    const agent = fakeAgent(workspace => {
      writeFileSync(path.join(workspace, 'validate-plan.mjs'), 'console.log(JSON.stringify({ valid: true, taskCount: 1, errors: [] }))');
      writeTasks(workspace, { '001.json': json({ title: 'Stub' }) });
    });
    await assert.rejects(
      runPlanFileAgent({ ...baseOptions, purpose: 'generation', prompt: 'Plan it', taskFiles: true, executionType: 'plan-generation', routingSession: agent.session as never }),
      /task 1 \(tasks\/001\.json\) has no non-empty "body"/,
    );
  });

  test('accepts the file count limit and rejects overflow without returning a prefix', async () => {
    for (const count of [200, 201]) {
      const agent = fakeAgent(workspace => {
        for (let index = 1; index <= count; index++) {
          writeTasks(workspace, { [`${String(index).padStart(3, '0')}.json`]: json(task(`Task ${index}`)) });
        }
      });
      const result = runPlanFileAgent({ ...baseOptions, purpose: 'generation', prompt: 'Plan it', taskFiles: true, executionType: 'plan-generation', routingSession: agent.session as never });
      if (count === 200) assert.equal((await result).length, count);
      else await assert.rejects(result, /201 task files; the limit is 200/);
    }
    assert.deepEqual(readdirSync(workspaceRoot), []);
  });

  const unacceptableFiles = {
    oversized: (workspace: string) => writeTasks(workspace, { '002.json': json(task('Large')).padEnd(8 * 1024 * 1024 + 1, ' ') }),
    directory: (workspace: string) => mkdirSync(path.join(workspace, 'tasks', '002.json')),
    symlink: (workspace: string) => symlinkSync(path.join(workspace, 'tasks', '001.json'), path.join(workspace, 'tasks', '002.json')),
    'dangling symlink': (workspace: string) => symlinkSync(path.join(workspace, 'missing.json'), path.join(workspace, 'tasks', '002.json')),
  };
  for (const [kind, write] of Object.entries(unacceptableFiles)) {
    test(`rejects a task file of type ${kind} alongside a valid task`, async () => {
      const agent = fakeAgent(workspace => {
        writeTasks(workspace, { '001.json': json(task('Valid prefix')) });
        write(workspace);
      });
      await assert.rejects(
        tryGeneratePlanWithFiles({ ...baseOptions, fullContext: 'Plan it', routingSession: agent.session as never }),
        (error: Error) => error instanceof PlanningFailedError && !(error instanceof PlanFileAgentUnavailableError)
          && /002\.json/.test(error.message) && /exceeds|regular file/.test(error.message),
      );
      assert.deepEqual(readdirSync(workspaceRoot), []);
    });
  }

  for (const target of ['file', 'directory']) {
    test(`rejects a task ${target} symlink to outside the workspace`, async () => {
      const outside = mkdtempSync(path.join(tmpdir(), 'propr-outside-tasks-'));
      writeFileSync(path.join(outside, '001.json'), json(task('Outside task')));
      try {
        const agent = fakeAgent(workspace => {
          if (target === 'directory') {
            rmSync(path.join(workspace, 'tasks'), { recursive: true });
            symlinkSync(outside, path.join(workspace, 'tasks'));
          } else {
            writeTasks(workspace, { '001.json': json(task('Valid prefix')) });
            symlinkSync(path.join(outside, '001.json'), path.join(workspace, 'tasks', '002.json'));
          }
        });
        await assert.rejects(
          tryGeneratePlanWithFiles({ ...baseOptions, fullContext: 'Plan it', routingSession: agent.session as never }),
          /without symlinks/,
        );
        assert.equal(existsSync(path.join(outside, '001.json')), true, 'cleanup leaves the outside directory untouched');
        assert.deepEqual(readdirSync(workspaceRoot), []);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }

  test('rejects an empty task directory even when execution reports success', async () => {
    const agent = fakeAgent(() => undefined);
    await assert.rejects(
      tryGeneratePlanWithFiles({ ...baseOptions, fullContext: 'Plan it', routingSession: agent.session as never }),
      /wrote no task files/,
    );
  });

  test('rejects unsuccessful generation in the single-file mode too', async () => {
    const agent = fakeAgent(workspace => writeFileSync(path.join(workspace, 'plan.json'), json([task('Prefix')])), { success: false });
    await assert.rejects(
      runPlanFileAgent({ ...baseOptions, purpose: 'generation', prompt: 'Plan it', executionType: 'plan-generation', routingSession: agent.session as never }),
      /Plan generation did not finish/,
    );
  });

  test('an agent that ran but wrote nothing is a planning failure, not an unavailable agent', async () => {
    const agent = fakeAgent(() => undefined, { success: false, error: 'model refused' });
    await assert.rejects(
      runPlanFileAgent({ ...baseOptions, purpose: 'generation', prompt: 'Plan it', taskFiles: true, executionType: 'plan-generation', routingSession: agent.session as never }),
      (error: Error) => !(error instanceof PlanFileAgentUnavailableError) && /did not finish\. The agent reported: model refused/.test(error.message),
    );
  });

  test('an agent task that throws is unavailable, except for usage limits, which keep their type', async () => {
    const throwing = (error: Error) => ({ executeTask: async () => { throw error; } });
    await assert.rejects(
      runPlanFileAgent({ ...baseOptions, purpose: 'generation', prompt: 'x', taskFiles: true, executionType: 'plan-generation', routingSession: throwing(new Error('docker unavailable')) as never }),
      (error: Error) => error instanceof PlanFileAgentUnavailableError && /docker unavailable/.test(error.message),
    );
    const usageLimit = Object.assign(new Error('limit reached'), { name: 'UsageLimitError' });
    await assert.rejects(
      runPlanFileAgent({ ...baseOptions, purpose: 'generation', prompt: 'x', taskFiles: true, executionType: 'plan-generation', routingSession: throwing(usageLimit) as never }),
      (error: Error) => error === usageLimit,
    );
  });
});

describe('file-based plan generation', () => {
  test('selects files unless the reply mode is chosen explicitly', () => {
    assert.equal(resolvePlanGenerationMode({}), 'file');
    assert.equal(resolvePlanGenerationMode({ PROPR_PLAN_GENERATION_MODE: 'file' }), 'file');
    assert.equal(resolvePlanGenerationMode({ PROPR_PLAN_GENERATION_MODE: ' Response ' }), 'response');
  });

  test('keeps the planner prompt and replaces its reply format with the file contract', () => {
    const prompt = buildPlanFilePrompt('<context>everything</context>');
    assert.ok(prompt.startsWith('<context>everything</context>'));
    assert.match(prompt, /tasks\/001\.json/);
    assert.match(prompt, /node validate-plan\.mjs --tasks tasks/);
    assert.match(prompt, /Do not put the plan in your reply/);
  });

  test('returns null in reply mode without running an agent', async () => {
    process.env.PROPR_PLAN_GENERATION_MODE = 'response';
    const agent = fakeAgent(() => { throw new Error('must not run'); });
    assert.equal(await tryGeneratePlanWithFiles({ ...baseOptions, fullContext: 'x', routingSession: agent.session as never }), null);
    assert.equal(agent.calls.length, 0);
  });

  test('callLLMForPlan uses the files and still enforces granularity', async () => {
    const agent = fakeAgent((workspace, options) => {
      assert.match(options.prompt, /^Generate a plan/);
      writeTasks(workspace, { '001.json': json(task('A')), '002.json': json(task('B')) });
    });
    const result = await callLLMForPlan({
      ...baseOptions, runId: 'run-1', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
      repairModel: 'codex:gpt', granularity: 'single', routingSession: agent.session as never,
    });
    assert.equal(agent.calls.length, 1);
    assert.equal(runLightweightLLMAnalysis.mock.callCount(), 0, 'the reply path is not used');
    assert.equal(result.plan.length, 1, 'single granularity merges the written tasks');
    assert.equal(result.enforcementMetadata.enforced, true);
  });

  test('rejects an unsuccessful execution even after it wrote a valid task', async () => {
    const agent = fakeAgent(async workspace => {
      writeTasks(workspace, { '001.json': json(task('Completed prefix')) });
      await Promise.resolve();
    }, { success: false, error: 'execution failed' });
    await assert.rejects(callLLMForPlan({
      ...baseOptions, runId: 'run-1', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
      repairModel: 'codex:gpt', granularity: 'balanced', routingSession: agent.session as never,
    }), /Plan generation did not finish\. The agent reported: execution failed/);
    assert.equal(runLightweightLLMAnalysis.mock.callCount(), 0);
    assert.deepEqual(readdirSync(workspaceRoot), []);
  });

  const partialOutputs = {
    'valid task': (workspace: string) => writeTasks(workspace, { '001.json': json(task('Prefix')) }),
    'invalid task': (workspace: string) => writeTasks(workspace, { '001.json': '{' }),
    'empty task': (workspace: string) => writeTasks(workspace, { '001.json': '' }),
    'temporary task': (workspace: string) => writeTasks(workspace, { '001.json.tmp': '{' }),
    'assembled plan': (workspace: string) => writeFileSync(path.join(workspace, 'plan.json'), json([task('Plan')])),
    'uninspectable task directory': (workspace: string) => {
      rmSync(path.join(workspace, 'tasks'), { recursive: true });
      writeFileSync(path.join(workspace, 'tasks'), 'incomplete output');
    },
  };
  for (const [kind, write] of Object.entries(partialOutputs)) {
    test(`does not fall back after execution throws with ${kind} output`, async () => {
      const agent = fakeAgent(async workspace => {
        write(workspace);
        await Promise.resolve();
        throw new Error('execution crashed');
      });
      await assert.rejects(callLLMForPlan({
        ...baseOptions, runId: 'run-1', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
        repairModel: 'codex:gpt', granularity: 'balanced', routingSession: agent.session as never,
      }), (error: Error) => error instanceof PlanningFailedError && !(error instanceof PlanFileAgentUnavailableError) && /execution crashed/.test(error.message));
      assert.equal(runLightweightLLMAnalysis.mock.callCount(), 0);
      assert.deepEqual(readdirSync(workspaceRoot), []);
    });
  }

  test('preserves usage limits after producing output', async () => {
    const usageLimit = Object.assign(new Error('limit reached'), { name: 'UsageLimitError' });
    const agent = fakeAgent(workspace => {
      writeTasks(workspace, { '001.json': json(task('Prefix')) });
      throw usageLimit;
    });
    await assert.rejects(
      tryGeneratePlanWithFiles({ ...baseOptions, fullContext: 'Plan it', routingSession: agent.session as never }),
      (error: Error) => error === usageLimit,
    );
    assert.deepEqual(readdirSync(workspaceRoot), []);
  });

  const terminalFailures = {
    ExecutionAbortedError: { name: 'ExecutionAbortedError' },
    IndexingCancelledError: { name: 'IndexingCancelledError' },
    SecurityException: { name: 'SecurityException' },
    ContextTokenLimitError: { name: 'ContextTokenLimitError' },
    'invalid configuration': { code: 'INVALID_CONFIGURATION' },
    'explicit cancellation reason': { terminationReason: 'user_cancelled' },
    'explicit cancellation message': { message: 'Task was cancelled' },
  };
  for (const [kind, details] of Object.entries(terminalFailures)) {
    test(`preserves ${kind} without routing retry or response fallback`, async () => {
      const terminal = Object.assign(new Error('terminal failure'), details);
      const agent = fakeAgent(async (_workspace, options) => {
        assert.equal(options.taskId, baseOptions.draftId);
        await Promise.resolve();
        throw terminal;
      });
      const replacement = fakeAgent(() => undefined);
      await assert.rejects(callLLMForPlan({
        ...baseOptions, runId: 'run-1', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
        repairModel: 'codex:gpt', granularity: 'balanced', routingSession: routedAgents(agent, replacement),
      }), (error: unknown) => error === terminal);
      assert.equal(agent.calls.length, 1);
      assert.equal(replacement.calls.length, 0);
      assert.equal(runLightweightLLMAnalysis.mock.callCount(), 0);
      assert.deepEqual(readdirSync(workspaceRoot), []);
    });
  }

  for (const kind of ['no output', 'valid task', 'uninspectable task directory']) {
    test(`preserves direct execution cancellation with ${kind}`, async () => {
      const cancellation = Object.assign(new Error('stopped'), { name: 'ExecutionAbortedError' });
      const agent = fakeAgent(async workspace => {
        if (kind !== 'no output') partialOutputs[kind as keyof typeof partialOutputs](workspace);
        await Promise.resolve();
        throw cancellation;
      });
      await assert.rejects(callLLMForPlan({
        ...baseOptions, runId: 'run-1', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
        repairModel: 'codex:gpt', granularity: 'balanced', routingSession: agent.session as never,
      }), (error: unknown) => error === cancellation);
      assert.equal(runLightweightLLMAnalysis.mock.callCount(), 0);
      assert.deepEqual(readdirSync(workspaceRoot), []);
    });
  }

  test('preserves cancellation from the shared file repair runner', async () => {
    process.env.PROPR_PLAN_GENERATION_MODE = 'response';
    replies.push('[{"title":"Broken","body":"Body" "implementation":"Fix"}]');
    const cancellation = Object.assign(new Error('stopped'), { name: 'ExecutionAbortedError' });
    const repair = fakeAgent(async workspace => {
      assert.equal(existsSync(path.join(workspace, 'plan.json')), true);
      await Promise.resolve();
      throw cancellation;
    });
    await assert.rejects(callLLMForPlan({
      ...baseOptions, runId: 'run-1', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
      repairModel: 'codex:gpt', granularity: 'balanced', repairRoutingSession: repair.session as never,
    }), (error: unknown) => error === cancellation);
    assert.equal(repair.calls.length, 1);
    assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1);
    assert.deepEqual(readdirSync(workspaceRoot), []);
  });

  test('an unqualified transport abort still permits response fallback', async () => {
    replies.push(json([task('From reply')]));
    const agent = fakeAgent(() => {
      throw Object.assign(new Error('transport interrupted'), { name: 'AbortError', code: 'ABORT_ERR' });
    });
    const result = await callLLMForPlan({
      ...baseOptions, runId: 'run-1', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
      repairModel: 'codex:gpt', granularity: 'balanced', routingSession: agent.session as never,
    });
    assert.deepEqual(result.plan.map(item => item.title), ['From reply']);
    assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1);
  });

  for (const failure of ['throw', 'result']) {
    test(`response fallback starts a fresh routing call after all file members fail by ${failure}`, async () => {
      const fileCalls: string[] = [];
      const responseCalls: AnalyzeOptions[] = [];
      const agents = ['first', 'second'].map(alias => ({
        config: { alias, enabled: true, supportedModels: ['opus'] },
        executeTask: async () => {
          fileCalls.push(alias);
          await Promise.resolve();
          if (failure === 'throw') throw new Error('temporary transport failure');
          return { success: false, error: 'temporary transport failure' };
        },
        analyze: async (_prompt: string, options: AnalyzeOptions) => {
          assert.deepEqual(fileCalls, ['first', 'second'], 'file routing exhausted before response generation');
          assert.deepEqual(readdirSync(workspaceRoot), [], 'all empty file workspaces have been cleaned up');
          responseCalls.push(options);
          // Response generation also retains its own normal routing failover.
          if (alias === 'first') throw new Error('temporary response transport failure');
          return { success: true, response: json([task('From fresh route')]), modelUsed: 'opus', executionTimeMs: 1 };
        },
      }));
      const router = new SyntheticRoutingService({
        loadSyntheticConfigs: async () => [{
          id: 'pool', alias: 'pool', enabled: true, defaultModel: 'smart',
          models: [{
            id: 'smart', enabled: true, strategy: 'usage_based',
            members: agents.map((agent, index) => ({
              id: agent.config.alias, directAgentAlias: agent.config.alias, model: 'opus', enabled: true, priority: 100 - index,
            })),
          }],
        }],
        getDirectAgent: alias => agents.find(agent => agent.config.alias === alias) as Agent | undefined,
      });
      // Persistence is outside this regression; selection, retries and forks are real.
      mock.method(router, 'recordAttempt', async () => null);
      const routingSession = router.begin({ requestedAgentAlias: 'pool', requestedModel: 'smart', requiredTokens: 50_000 });
      const result = await callLLMForPlan({
        ...baseOptions, runId: 'run-fallback', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
        repairModel: 'codex:gpt', granularity: 'balanced', routingSession,
      });
      assert.deepEqual(result.plan.map(item => item.title), ['From fresh route']);
      assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1);
      const responseSession = runLightweightLLMAnalysis.mock.calls[0].arguments[0].routingSession!;
      assert.notEqual(responseSession, routingSession);
      assert.notEqual(responseSession.callId, routingSession.callId);
      assert.equal(responseSession.requiredTokens, routingSession.requiredTokens);
      assert.equal(responseCalls.length, 2);
      assert.deepEqual(responseCalls.map(options => {
        const routing = options.metadata?.syntheticRouting as { callId: string; attemptNumber: number };
        return { callId: routing.callId, attemptNumber: routing.attemptNumber };
      }), [
        { callId: responseSession.callId, attemptNumber: 1 },
        { callId: responseSession.callId, attemptNumber: 2 },
      ]);
      assert.deepEqual([...routingSession.attemptedMembers], ['first', 'second']);
      await assert.rejects(routingSession.select(), SyntheticPoolExhaustedError);
    });
  }

  test('explicit response mode retains the supplied routing session', async () => {
    process.env.PROPR_PLAN_GENERATION_MODE = 'response';
    replies.push(json([task('From reply')]));
    const agent = fakeAgent(() => { throw new Error('must not run'); });
    const fork = mock.method(agent.session, 'fork');
    const result = await callLLMForPlan({
      ...baseOptions, runId: 'run-response', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
      repairModel: 'codex:gpt', granularity: 'balanced', routingSession: agent.session as never,
    });
    assert.deepEqual(result.plan.map(item => item.title), ['From reply']);
    assert.equal(agent.calls.length, 0);
    assert.equal(fork.mock.callCount(), 0);
    assert.equal(runLightweightLLMAnalysis.mock.calls[0].arguments[0].routingSession, agent.session);
  });

  test('falls back to the model reply only when the agent could not run', async () => {
    replies.push(json([task('From reply')]));
    const unavailable = { fork: () => ({}), executeTask: async () => { throw new Error('no container runtime'); } };
    const result = await callLLMForPlan({
      ...baseOptions, runId: 'run-1', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
      repairModel: 'codex:gpt', granularity: 'balanced', routingSession: unavailable as never,
    });
    assert.deepEqual(result.plan.map(item => item.title), ['From reply']);
    assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1);

    const invalid = fakeAgent(workspace => writeTasks(workspace, { '001.json': json({ title: 'Stub' }) }));
    await assert.rejects(callLLMForPlan({
      ...baseOptions, runId: 'run-2', fullContext: 'Generate a plan', worktreePath: '/tmp/worktree', tokenLimit: 100_000,
      repairModel: 'codex:gpt', granularity: 'balanced', routingSession: invalid.session as never,
    }), /Plan generation did not produce a valid plan: task 1 \(tasks\/001\.json\) has no non-empty "body"/);
    assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1, 'an invalid plan is not regenerated as a reply');
  });
});
