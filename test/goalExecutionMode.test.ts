import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { buildNativeGoalCommand } from '../packages/core/src/goals.ts';
import { helpAdvertisesNativeGoal } from '../packages/core/src/agents/goalCapabilities.ts';
import { buildDockerArgs as buildClaudeDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import { buildCodexDockerArgs } from '../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.ts';
import { AntigravityAgent } from '../packages/core/src/agents/impl/AntigravityAgent.ts';
import type { AgentConfig } from '../packages/core/src/agents/types.ts';

const baseConfig = (type: AgentConfig['type']): AgentConfig => ({
  id: `${type}-id`,
  type,
  alias: `${type}-test`,
  enabled: true,
  dockerImage: 'propr/agent:test',
  configPath: `/tmp/${type}-config`,
  supportedModels: ['test-model'],
  defaultModel: 'test-model',
});

const common = {
  worktreePath: '/tmp/worktree',
  githubToken: 'token',
  modelName: 'test-model',
  issueNumber: 0,
  taskId: 'goal-123',
};

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

describe('native goal provider contract', () => {
  test('builds the exact native first input without a ProPR wrapper', () => {
    assert.equal(buildNativeGoalCommand('Ship the dashboard'), '/goal Ship the dashboard');
  });

  test('Claude changes only persistence/resume arguments in goal mode', () => {
    const normal = buildClaudeDockerArgs(baseConfig('claude'), 1000, common);
    const initial = buildClaudeDockerArgs(baseConfig('claude'), 1000, { ...common, executionMode: 'goal' });
    const resumed = buildClaudeDockerArgs(baseConfig('claude'), 1000, { ...common, executionMode: 'goal', resumeSessionId: 'claude-session' });
    assert.ok(normal.includes('--no-session-persistence'));
    assert.ok(normal.includes('--max-turns'));
    assert.equal(initial.includes('--no-session-persistence'), false);
    assert.equal(initial.includes('--max-turns'), false);
    assert.deepEqual(resumed.slice(resumed.indexOf('--resume'), resumed.indexOf('--resume') + 2), ['--resume', 'claude-session']);
  });

  test('Codex removes ephemeral mode and resumes the exact thread', () => {
    const normal = buildCodexDockerArgs(baseConfig('codex'), common);
    const initial = buildCodexDockerArgs(baseConfig('codex'), { ...common, executionMode: 'goal' });
    const resumed = buildCodexDockerArgs(baseConfig('codex'), { ...common, executionMode: 'goal', resumeSessionId: 'codex-thread' });
    assert.ok(normal.includes('--ephemeral'));
    assert.ok(normal.includes('features.multi_agent=false'));
    assert.equal(initial.includes('--ephemeral'), false);
    assert.equal(initial.includes('features.multi_agent=false'), false);
    assert.ok(resumed.includes('resume'));
    assert.ok(resumed.includes('codex-thread'));
    assert.equal(resumed[resumed.indexOf('codex-thread') + 1], '-');
  });

  test('Antigravity retains state and resumes the exact conversation', () => {
    const agent = new AntigravityAgent(baseConfig('antigravity')) as unknown as {
      buildDockerArgs(params: typeof common & { executionMode?: 'task' | 'goal'; resumeConversationId?: string }): string[];
    };
    const normal = agent.buildDockerArgs(common);
    const initial = agent.buildDockerArgs({ ...common, executionMode: 'goal' });
    const resumed = agent.buildDockerArgs({ ...common, executionMode: 'goal', resumeConversationId: 'agy-conversation' });
    assert.ok(normal.includes('PROPR_EPHEMERAL_STATE=1'));
    assert.equal(initial.includes('PROPR_EPHEMERAL_STATE=1'), false);
    assert.deepEqual(resumed.slice(resumed.indexOf('--conversation'), resumed.indexOf('--conversation') + 2), ['--conversation', 'agy-conversation']);
  });

  test('capability detection does not emulate goal mode when help omits it', () => {
    assert.equal(helpAdvertisesNativeGoal('Commands:\n  /goal <objective>  Start a native goal'), true);
    assert.equal(helpAdvertisesNativeGoal('Commands:\n  exec\n  resume'), false);
  });
});
