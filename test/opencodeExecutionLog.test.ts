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
  return { stdout: '', stderr: 'execution failed', exitCode: 1 };
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
