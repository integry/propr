import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { buildGoalPolicyEnvironment, buildNativeGoalCommand } from '../packages/core/src/goals.ts';
import {
  antigravityConversationIdentity,
  claudeSessionIdentity,
  codexHandshakeSupportsNativeGoal,
} from '../packages/core/src/agents/goalCapabilities.ts';
import { buildDockerArgs as buildClaudeDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import { buildCodexAppServerDockerArgs, buildCodexDockerArgs } from '../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.ts';
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
  test('builds the direct strategy as one visible native prompt policy', () => {
    const prompt = buildNativeGoalCommand({
      objective: 'Ship the dashboard', launchStrategy: 'direct', maxParallelTasks: 3, ultrafix: true,
    });
    assert.match(prompt, /^\/goal Ship the dashboard/);
    assert.match(prompt, /Agent implements directly/);
    assert.match(prompt, /Open a draft implementation PR early/);
    assert.match(prompt, /at most 3 implementation tasks in parallel/);
    assert.match(prompt, /Ultrafix policy: Enabled/);
    assert.match(prompt, /Finish with a draft PR/);
    assert.match(prompt, /validate that each artifact exists/);
  });

  test('builds orchestration as agent-owned prompt policy without scheduler state', () => {
    const prompt = buildNativeGoalCommand({
      objective: 'Ship the platform', launchStrategy: 'orchestrate', maxParallelTasks: null, ultrafix: false,
    });
    assert.match(prompt, /Agent orchestrates through ProPR/);
    assert.match(prompt, /creating GitHub issues/);
    assert.match(prompt, /epic PR/);
    assert.match(prompt, /You—not a ProPR planner—own every planning and hierarchy decision/);
    assert.match(prompt, /No maximum parallel task count was selected/);
    assert.match(prompt, /Ultrafix policy: Disabled/);
    assert.deepEqual(buildGoalPolicyEnvironment(), { PROPR_EXECUTION_MODE: 'goal' });
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

  test('Codex keeps one-shot arguments unchanged and goal mode exposes App Server', () => {
    const normal = buildCodexDockerArgs(baseConfig('codex'), common);
    const appServer = buildCodexAppServerDockerArgs(baseConfig('codex'), { ...common, executionMode: 'goal' });
    assert.ok(normal.includes('--ephemeral'));
    assert.ok(normal.includes('features.multi_agent=false'));
    assert.deepEqual(appServer.slice(appServer.lastIndexOf('codex')), ['codex', 'app-server']);
    assert.equal(appServer.includes('--ephemeral'), false);
    assert.equal(appServer.includes('features.multi_agent=false'), false);
    assert.equal(appServer.includes('exec'), false);
  });

  test('Antigravity retains state and resumes the exact conversation', () => {
    const agent = new AntigravityAgent(baseConfig('antigravity')) as unknown as {
      buildDockerArgs(params: typeof common & { executionMode?: 'task' | 'goal'; resumeConversationId?: string }): string[];
    };
    const normal = agent.buildDockerArgs(common);
    const initial = agent.buildDockerArgs({ ...common, executionMode: 'goal' });
    const resumed = agent.buildDockerArgs({ ...common, executionMode: 'goal', resumeConversationId: 'agy-conversation' });
    assert.ok(normal.includes('PROPR_EPHEMERAL_STATE=1'));
    assert.ok(normal.some(argument => argument.endsWith(':/home/node/.gemini-source:rw')));
    assert.equal(initial.includes('PROPR_EPHEMERAL_STATE=1'), false);
    assert.ok(initial.some(argument => argument.endsWith(':/home/node/.gemini:rw')));
    assert.deepEqual(resumed.slice(resumed.indexOf('--conversation'), resumed.indexOf('--conversation') + 2), ['--conversation', 'agy-conversation']);
  });

  test('capability detection requires provider-specific protocol evidence', () => {
    assert.equal(codexHandshakeSupportsNativeGoal([
      JSON.stringify({ id: 1, result: { userAgent: 'codex' } }),
      JSON.stringify({ id: 2, error: { code: -32000, message: 'Thread not found' } }),
      JSON.stringify({ id: 3, error: { code: -32000, message: 'Thread not found' } }),
      JSON.stringify({ id: 4, error: { code: -32000, message: 'Thread not found' } }),
      JSON.stringify({ id: 5, error: { code: -32000, message: 'Thread not found' } }),
    ].join('\n')), true);
    assert.equal(codexHandshakeSupportsNativeGoal([
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, error: { code: -32601, message: 'Method not found' } }),
      JSON.stringify({ id: 3, error: { code: -32000, message: 'Thread not found' } }),
      JSON.stringify({ id: 4, error: { code: -32000, message: 'Thread not found' } }),
      JSON.stringify({ id: 5, error: { code: -32000, message: 'Thread not found' } }),
    ].join('\n')), false);
    assert.equal(claudeSessionIdentity(JSON.stringify({
      type: 'system', subtype: 'init', session_id: 'session-1', slash_commands: ['help'],
    })), 'session-1');
    assert.equal(antigravityConversationIdentity([
      JSON.stringify({ event: 'init', conversation_id: 'conversation-1', init: { model: 'gemini' } }),
      JSON.stringify({ event: 'result', result: { conversation_id: 'conversation-1', status: 'SUCCESS' } }),
    ].join('\n')), 'conversation-1');
    assert.equal(antigravityConversationIdentity([
      JSON.stringify({ event: 'init', conversation_id: 'conversation-1', init: { model: 'gemini' } }),
      JSON.stringify({ event: 'result', result: { conversation_id: 'different-conversation', status: 'SUCCESS' } }),
    ].join('\n')), undefined);
  });
});
