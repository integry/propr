import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import type { AgentConfig, AgentTaskOptions } from '../packages/core/src/agents/types.js';
import type { LlmLogEntry } from '../packages/core/src/utils/llmLogger.js';

// Avoid loading the agent registry through the logger's model lookup before
// the execution dependencies are mocked.
await mock.module('../packages/core/src/config/modelAliases.js', {
  namedExports: { getOpenRouterId: () => undefined, getDefaultModel: () => 'test-model' },
});
const llmLogger = await import('../packages/core/src/utils/llmLogger.js');
const persistLlmLog = mock.fn(async (_entry: LlmLogEntry) => undefined);
await mock.module('../packages/core/src/utils/llmLogger.js', {
  namedExports: { ...llmLogger, persistLlmLog },
});

await mock.module('../packages/core/src/utils/logger.js', {
  defaultExport: { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() },
});

let failureAt: 'ownership' | 'docker' | undefined;
let dockerResult = { stdout: '', stderr: 'execution failed', exitCode: 1 };
const setWorktreeOwnership = mock.fn(async () => {
  await Promise.resolve();
  if (failureAt === 'ownership') throw new Error('ownership failed');
});
await mock.module('../packages/core/src/claude/claudeHelpers.js', {
  namedExports: {
    setWorktreeOwnership,
    verifyWorktreeStructure: () => null,
    verifyWorktreePostExecution: () => undefined,
    UsageLimitError: class UsageLimitError extends Error {},
  },
});

const executeDockerCommand = mock.fn(async () => {
  await Promise.resolve();
  if (failureAt === 'docker') throw new Error('docker failed');
  return dockerResult;
});
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
  namedExports: { executeDockerCommand },
});
await mock.module('../packages/core/src/agents/impl/utils/index.js', {
  namedExports: {
    buildAnalysisSafetySuffix: () => '',
    executeWithUsageTracking: async (_agent: string, execute: () => Promise<unknown>) => ({
      result: await execute(), usageMetrics: null,
    }),
  },
});

await mock.module('../packages/core/src/config/configManager.js', {
  namedExports: { resolveConfigPath: (path: string) => path },
});
// Token minting and mount policy have their own tests; keep this fixture
// focused on attribution through the execution and failure paths.
await mock.module('../packages/core/src/agents/agentGitAccess.js', {
  namedExports: { prepareAgentGitAccess: async (options: AgentTaskOptions) => options, prepareAnalysisGitAccess: async () => ({ githubToken: '', gitMountArgs: [] }) },
});
const { parseOpenCodeJsonl } = await import('../packages/core/src/agents/impl/openCodeParsing.js');
await mock.module('../packages/core/src/agents/impl/openCodeUtils.js', {
  namedExports: {
    buildOpenCodePrompt: ({ customPrompt }: { customPrompt: string }) => customPrompt,
    buildOpenCodeDockerArgs: async () => [],
    parseOpenCodeJsonl,
    evaluateOpenCodeAnalysis: () => { throw new Error('Unexpected analysis call'); },
  },
});
const { OpenCodeAgent } = await import('../packages/core/src/agents/impl/OpenCodeAgent.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
after(() => closeConnection());

beforeEach(() => {
  persistLlmLog.mock.resetCalls();
  executeDockerCommand.mock.resetCalls();
  dockerResult = { stdout: '', stderr: 'execution failed', exitCode: 1 };
});

const config: AgentConfig = {
  id: 'opencode-test', type: 'opencode', alias: 'opencode', enabled: true,
  dockerImage: 'propr/agent:latest', configPath: '/tmp/opencode-test-config',
  supportedModels: ['opencode-big-pickle'], defaultModel: 'opencode-big-pickle',
};

for (const stage of ['ownership', 'docker', undefined] as const) {
  test(`retains plan attribution on ${stage ? stage + ' exception' : 'unsuccessful execution'}`, async () => {
    failureAt = stage;
    const agent = new OpenCodeAgent(config);
    const workRef = llmLogger.buildAnalysisWorkRef('plan-generation', 'draft-1', 'owner/repo');
    const response = await agent.executeTask({
      worktreePath: '/tmp/plan-repair',
      issueRef: { number: 0, repoOwner: 'owner', repoName: 'repo' },
      prompt: 'Repair plan.json',
      githubToken: 'test-token',
      taskId: 'draft-1',
      metadata: llmLogger.withTaskLogAttribution({ planFileAgent: 'repair', jsonRepair: true }, {
        executionType: 'plan-generation', workRef,
      }),
    });

    assert.equal(response.success, false);
    assert.equal(response.error, stage ? `${stage} failed` : 'execution failed');
    assert.equal(executeDockerCommand.mock.callCount(), stage === 'ownership' ? 0 : 1);
    assert.equal(persistLlmLog.mock.callCount(), 1);
    const entry = persistLlmLog.mock.calls[0].arguments[0];
    assert.equal(entry.executionType, 'plan-generation');
    assert.deepEqual(entry.workRef, workRef);
    assert.equal(entry.success, false);
    assert.equal(entry.errorMessage, response.error);
    assert.equal(entry.draftId, 'draft-1');
    assert.equal(entry.metadata?.planFileAgent, 'repair');
    assert.equal(entry.metadata?.jsonRepair, true);
    assert.equal(entry.metadata?.proprLogAttribution, undefined);
  });
}

// Reproduced on a 0.9.0 launcher install with OpenCode CLI 1.18.31: the model
// had been retired server-side, and the task only showed the generic error.
const MODEL_NOT_FOUND = 'Model not found: opencode/ling-3.0-flash-fin-free. Did you mean: deepseek-v4.1-flash-free, glm-5.3-flash-free, mimo-v2.6-flash-free?';
const GENERIC_ERROR_EVENT = JSON.stringify({ type: 'error', timestamp: 1793299358906, sessionID: 'ses_e77075dcfffeCZerQlZ6a23wb2', error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_1fd9db03' } } });

async function failedTaskReason(): Promise<string | undefined> {
  failureAt = undefined;
  const { agentFailureLine } = await import('@propr/shared');
  const response = await new OpenCodeAgent(config).executeTask({
    worktreePath: '/tmp/opencode-failure-reason',
    issueRef: { number: 42, repoOwner: 'owner', repoName: 'repo' },
    prompt: 'Implement the issue',
    githubToken: 'test-token',
    taskId: 'task-1',
  });
  assert.equal(response.success, false);
  return response.error && agentFailureLine(response.error);
}

test('an OpenCode JSON error event becomes the task failure reason', async () => {
  dockerResult = {
    stdout: JSON.stringify({ type: 'error', error: { name: 'UnknownError', data: { message: MODEL_NOT_FOUND } } }),
    stderr: 'Using disposable OpenCode data directory at /tmp/propr-opencode-data/opencode',
    exitCode: 1,
  };
  assert.equal(await failedTaskReason(), MODEL_NOT_FOUND);
});

test('a generic OpenCode server error does not hide the specific error event before it', async () => {
  dockerResult = {
    stdout: [JSON.stringify({ type: 'error', error: { name: 'UnknownError', data: { message: MODEL_NOT_FOUND } } }), GENERIC_ERROR_EVENT].join('\n'),
    stderr: '',
    exitCode: 1,
  };
  assert.equal(await failedTaskReason(), MODEL_NOT_FOUND);
});

test('a generic OpenCode server error is replaced by the cause logged under its ref', async () => {
  dockerResult = {
    stdout: GENERIC_ERROR_EVENT,
    stderr: [
      'Using disposable OpenCode data directory at /tmp/propr-opencode-data/opencode',
      `timestamp=2026-10-29T18:42:38.883Z level=ERROR run=287a387a message="share subscriber failed" type=message.updated cause="Cause([Fail(ProviderModelNotFoundError: ${MODEL_NOT_FOUND})])"`,
      `timestamp=2026-10-29T18:42:38.906Z level=ERROR run=287a387a message=failed ref=err_1fd9db03 error="ProviderModelNotFoundError: ${MODEL_NOT_FOUND}" cause="ProviderModelNotFoundError: ${MODEL_NOT_FOUND}\\n    at <anonymous> (/$bunfs/root/chunk-pbkyvgma.js:439:94278)"`,
    ].join('\n'),
    exitCode: 1,
  };
  assert.equal(await failedTaskReason(), MODEL_NOT_FOUND);
});

test('a generic OpenCode server error stays when no logged cause matches its ref', async () => {
  dockerResult = {
    stdout: GENERIC_ERROR_EVENT,
    stderr: 'timestamp=2026-10-29T18:42:38.906Z level=ERROR run=1 message=failed ref=err_other error="Other: unrelated"',
    exitCode: 1,
  };
  assert.equal(await failedTaskReason(), 'Unexpected server error. Check server logs for details.');
});
