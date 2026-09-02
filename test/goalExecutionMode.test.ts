import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import {
  CODEX_GOAL_OBJECTIVE_MAX_LENGTH,
  buildGoalPolicyEnvironment,
  buildNativeGoalCommand,
  codexGoalPromptValidationError,
} from '../packages/core/src/goals.ts';
import {
  GoalCapabilityProbe,
  antigravityConversationIdentity,
  antigravityHelpSupportsWholeSession,
  claudeHelpSupportsWholeSession,
  claudeSessionIdentity,
  codexHandshakeSupportsNativeGoal,
  codexSchemaSupportsNativeGoal,
  probeGoalCapability,
} from '../packages/core/src/agents/goalCapabilities.ts';
import { buildDockerArgs as buildClaudeDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import { buildCodexAppServerDockerArgs, buildCodexDockerArgs } from '../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.ts';
import { AntigravityAgent } from '../packages/core/src/agents/impl/AntigravityAgent.ts';
import type { Agent, AgentConfig } from '../packages/core/src/agents/types.ts';

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

  test('validates the fully rendered Codex prompt with Unicode character semantics', () => {
    const fixedPrompt = buildNativeGoalCommand({ objective: '', launchStrategy: 'direct' });
    const objectiveLength = CODEX_GOAL_OBJECTIVE_MAX_LENGTH - Array.from(fixedPrompt).length;
    const exactObjective = `${'x'.repeat(objectiveLength - 1)}😀`;
    const exactPrompt = buildNativeGoalCommand({ objective: exactObjective, launchStrategy: 'direct' });
    const oversizedPrompt = buildNativeGoalCommand({ objective: `${exactObjective}x`, launchStrategy: 'direct' });

    assert.equal(Array.from(exactPrompt).length, CODEX_GOAL_OBJECTIVE_MAX_LENGTH);
    assert.equal(codexGoalPromptValidationError(exactPrompt), null);
    assert.match(codexGoalPromptValidationError(oversizedPrompt) || '', /Final Codex goal prompt/);
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

  test('recognizes the pinned Codex experimental schema only when every goal method is present', () => {
    const pinnedSchema = readFileSync(
      new URL('./fixtures/codex-0.151.0-client-request-goal-schema.json', import.meta.url),
      'utf8',
    );
    assert.equal(codexSchemaSupportsNativeGoal(pinnedSchema), true);
    assert.equal(codexSchemaSupportsNativeGoal(JSON.stringify({
      anyOf: JSON.parse(pinnedSchema).anyOf.slice(0, 2),
    })), false);
    assert.equal(codexSchemaSupportsNativeGoal('not json'), false);
  });

  test('recognizes Claude and Antigravity whole-session CLI options without authentication', () => {
    assert.equal(claudeHelpSupportsWholeSession([
      '-p, --print  Print response and exit',
      '-r, --resume [value]  Resume a conversation by session ID',
      '--output-format <format>  Output format for print mode',
      '--no-session-persistence  Disable session persistence',
    ].join('\n')), true);
    assert.equal(claudeHelpSupportsWholeSession('--print\n--output-format <format>\n--no-session-persistence'), false);
    assert.equal(antigravityHelpSupportsWholeSession([
      '--print  Run a single prompt non-interactively',
      '--conversation  Resume a previous conversation by ID',
      '--output-format  Output format for print mode',
      '--disable-slash-commands  Disable slash command expansion',
    ].join('\n')), true);
    assert.equal(antigravityHelpSupportsWholeSession('--print\n--output-format'), false);
  });

  test('capability listing uses offline introspection and never launches provider inference', async () => {
    const schema = JSON.stringify(REQUIRED_GOAL_SCHEMA);
    const help: Record<string, string> = {
      claude: '--print\n--resume [value]\n--output-format <format>\n--no-session-persistence',
      antigravity: '--print\n--conversation <id>\n--output-format <format>\n--disable-slash-commands',
    };
    for (const type of ['codex', 'claude', 'antigravity'] as const) {
      const calls: Array<{ args: string[]; stdinData?: string }> = [];
      const capability = await probeGoalCapability({
        config: baseConfig(type), goalCapable: true,
      } as Agent, async (_command, args, options) => {
        calls.push({ args, stdinData: options?.stdinData });
        return {
          stdout: type === 'codex' ? schema : help[type], stderr: '', exitCode: 0,
          messageTimestamps: new Map(),
        };
      });
      assert.equal(capability.goalCapable, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].stdinData, undefined);
      assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--network'), calls[0].args.indexOf('--network') + 2), ['--network', 'none']);
      assert.equal(calls[0].args.includes('-v'), false, 'introspection must not read mounted credentials');
      assert.equal(calls[0].args.includes('--model'), false);
      assert.doesNotMatch(calls[0].args.join(' '), /\/goal|Reply with|--conversation\s+\S+$/);
      assert.ok(type === 'codex' ? calls[0].args.join(' ').includes('generate-json-schema') : calls[0].args.includes('--help'));
    }
  });

  test('unsupported capability results expire and can be explicitly rechecked', async () => {
    let now = 1_000;
    let probes = 0;
    const agent = { config: baseConfig('claude'), goalCapable: true } as Agent;
    const capabilityProbe = new GoalCapabilityProbe(100, () => now, async current => {
      probes += 1;
      return {
        agentId: current.config.id, agentAlias: current.config.alias, agentType: current.config.type,
        goalCapable: probes > 1, lifecycle: null,
        controls: { liveInput: false, inputAtBoundary: false, modelAtBoundary: false, pauseAtBoundary: false },
        ...(probes > 1 ? {} : { reason: 'Temporary introspection failure' }),
      };
    });
    assert.equal((await capabilityProbe.getAll([agent]))[0].goalCapable, false);
    assert.equal((await capabilityProbe.getAll([agent]))[0].goalCapable, false);
    assert.equal(probes, 1);
    now += 101;
    assert.equal((await capabilityProbe.getAll([agent]))[0].goalCapable, true);
    assert.equal(probes, 2);
    await capabilityProbe.getAll([agent]);
    assert.equal(probes, 2, 'successful results remain cached until registry refresh or a forced recheck');
    await capabilityProbe.getAll([agent], { force: true });
    assert.equal(probes, 3);
  });
});

const REQUIRED_GOAL_SCHEMA = { anyOf: [
  { properties: { method: { enum: ['thread/goal/set'] } } },
  { properties: { method: { enum: ['thread/goal/get'] } } },
  { properties: { method: { enum: ['thread/goal/clear'] } } },
] };
