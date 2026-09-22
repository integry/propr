import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  CODEX_GOAL_OBJECTIVE_MAX_LENGTH,
  CODEX_GOAL_USER_OBJECTIVE_MAX_LENGTH,
  buildGoalPolicyEnvironment,
  buildNativeGoalCommand,
  buildNativeGoalContext,
  codexGoalPromptValidationError,
  parseGoalCheckpointDeclaration,
} from '../packages/core/src/goals.ts';
import {
  GoalCapabilityProbe,
  antigravityConversationIdentity,
  antigravityHelpSupportsWholeSession,
  claudeHelpSupportsWholeSession,
  claudeHelpSupportsNativeGoal,
  claudeGoalCommandProbeSucceeded,
  claudeSessionIdentity,
  codexHandshakeSupportsNativeGoal,
  codexSchemaSupportsNativeGoal,
  probeGoalCapability,
} from '../packages/core/src/agents/goalCapabilities.ts';
import { buildDockerArgs as buildClaudeDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import { buildCodexAppServerDockerArgs, buildCodexDockerArgs } from '../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.ts';
import { AntigravityAgent } from '../packages/core/src/agents/impl/AntigravityAgent.ts';
import type { Agent, AgentConfig } from '../packages/core/src/agents/types.ts';

let codexConfigPath: string;
before(() => {
  codexConfigPath = mkdtempSync(join(tmpdir(), 'propr-goal-codex-config-'));
});

const baseConfig = (type: AgentConfig['type']): AgentConfig => ({
  id: `${type}-id`,
  type,
  alias: `${type}-test`,
  enabled: true,
  dockerImage: 'propr/agent:test',
  configPath: type === 'codex' ? codexConfigPath : `/tmp/${type}-config`,
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
  try {
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
  } finally {
    if (codexConfigPath) rmSync(codexConfigPath, { recursive: true, force: true });
  }
});

describe('native goal provider contract', () => {
  test('separates the direct goal command from ProPR delivery context', () => {
    const options = {
      objective: 'Ship the dashboard', launchStrategy: 'direct', maxParallelTasks: 3, ultrafix: true,
      checkpointIntervalMinutes: 30,
    } as const;
    const prompt = buildNativeGoalCommand(options);
    const context = buildNativeGoalContext(options);
    assert.equal(prompt, '/goal Ship the dashboard');
    assert.doesNotMatch(prompt, /Agent implements directly/);
    assert.match(context, /Additional ProPR delivery context for the goal above/);
    assert.match(context, /Agent implements directly/);
    assert.match(context, /ProPR creates the draft PR before execution/);
    assert.match(context, /Do not run Git commands/);
    assert.match(context, /approximately every 30 minutes/);
    assert.match(context, /target cadence, not a timer or interruption/);
    assert.match(context, /"checkpointReady":true/);
    assert.match(context, /include and exclude are optional/i);
    assert.match(context, /at most 3 implementation tasks in parallel/);
    assert.match(context, /Ultrafix policy: Enabled/);
    assert.match(context, /ProPR publishes and validates the final checkpoint/);
  });

  test('adds repository visual preview policy and discretionary checkpoint timing to a goal prompt', () => {
    const context = buildNativeGoalContext({
      objective: 'Ship the dashboard',
      launchStrategy: 'direct',
      visualPreviewSettings: {
        enabled: true,
        types: ['image'],
        instructions: 'Capture desktop and mobile dashboard states.',
      },
    });

    assert.match(context, /VISUAL PREVIEW REQUIREMENT/);
    assert.match(context, /Capture desktop and mobile dashboard states/);
    assert.match(context, /Use your discretion about when coherent visual evidence is ready/);
    assert.match(context, /already-open draft PR at checkpoint boundaries/);
  });

  test('parses and validates the agent checkpoint handoff', () => {
    const declaration = parseGoalCheckpointDeclaration([
      'Stable work is ready.',
      '```json',
      '{"checkpointReady":true,"message":"feat(goals): publish stable work","include":["src/a.ts","test/a.test.ts"],"exclude":["src/wip.ts"],"summary":"Implementation and tests are coherent."}',
      '```',
    ].join('\n'));
    assert.deepEqual(declaration, {
      checkpointReady: true,
      message: 'feat(goals): publish stable work',
      include: ['src/a.ts', 'test/a.test.ts'],
      exclude: ['src/wip.ts'],
      summary: 'Implementation and tests are coherent.',
    });
    assert.equal(parseGoalCheckpointDeclaration('Work continues without a checkpoint.'), null);
    assert.deepEqual(
      parseGoalCheckpointDeclaration('{"checkpointReady":true,"message":"","include":["src/a.ts"]}'),
      {
        checkpointReady: true, rejected: true, error: 'Checkpoint message must be a non-empty string of at most 500 characters',
        message: '', include: ['src/a.ts'],
      },
    );
    const overlap = parseGoalCheckpointDeclaration('{"checkpointReady":true,"message":"feat: overlap","include":["src/a.ts"],"exclude":["src/a.ts"]}');
    assert.ok(overlap && 'rejected' in overlap);
    assert.match(overlap.error, /both included and excluded/);
    const unsafePath = parseGoalCheckpointDeclaration('{"checkpointReady":true,"message":"feat: unsafe","include":["../outside.ts"]}');
    assert.ok(unsafePath && 'rejected' in unsafePath);
    assert.match(unsafePath.error, /normalized repository-relative file/);
  });

  test('builds orchestration as agent-owned prompt policy without scheduler state', () => {
    const prompt = buildNativeGoalCommand({ objective: 'Ship the platform' });
    const context = buildNativeGoalContext({
      objective: 'Ship the platform', launchStrategy: 'orchestrate', maxParallelTasks: null, ultrafix: false,
    });
    assert.equal(prompt, '/goal Ship the platform');
    assert.match(context, /Agent orchestrates through ProPR/);
    assert.match(context, /creating GitHub issues/);
    assert.match(context, /epic PR/);
    assert.match(context, /You—not a ProPR planner—own every planning and hierarchy decision/);
    assert.match(context, /No maximum parallel task count was selected/);
    assert.match(context, /Ultrafix policy: Disabled/);
    assert.deepEqual(buildGoalPolicyEnvironment('orchestrate'), {
      PROPR_EXECUTION_MODE: 'goal', PROPR_GOAL_LAUNCH_STRATEGY: 'orchestrate',
    });
  });

  test('adds a one-off stopping rule only to direct tasks', () => {
    const task = buildNativeGoalContext({ objective: 'Fix the typo', kind: 'task', launchStrategy: 'direct' });
    const goal = buildNativeGoalContext({ objective: 'Fix the typo', launchStrategy: 'direct' });
    assert.match(task, /Scope policy — one-off task/);
    assert.match(task, /run the relevant checks, let ProPR publish the result, and then stop/);
    assert.match(task, /propose a plan or goal/);
    assert.doesNotMatch(goal, /one-off task/);
  });

  test('validates the fully rendered Codex prompt with Unicode character semantics', () => {
    const exactObjective = `${'x'.repeat(CODEX_GOAL_USER_OBJECTIVE_MAX_LENGTH - 1)}😀`;
    const exactPrompt = buildNativeGoalCommand({ objective: exactObjective });
    const oversizedPrompt = buildNativeGoalCommand({ objective: `${exactObjective}x` });

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

  test('direct goals expose writable files but reserve Git and GitHub publication for the worker', () => {
    const environment = {
      PROPR_EXECUTION_MODE: 'goal',
      PROPR_GOAL_LAUNCH_STRATEGY: 'direct',
      GH_TOKEN: 'must-not-leak',
    };
    const claude = buildClaudeDockerArgs(baseConfig('claude'), 1000, {
      ...common, executionMode: 'goal', environment,
    });
    const codex = buildCodexAppServerDockerArgs(baseConfig('codex'), {
      ...common, executionMode: 'goal', environment,
    });
    const antigravity = new AntigravityAgent(baseConfig('antigravity')) as unknown as {
      buildDockerArgs(params: typeof common & {
        executionMode: 'goal'; environment: Record<string, string>;
      }): string[];
    };
    const agy = antigravity.buildDockerArgs({ ...common, executionMode: 'goal', environment });

    for (const args of [claude, codex, agy]) {
      assert.ok(args.includes('/tmp/worktree:/home/node/workspace:rw'));
      assert.ok(args.includes('/tmp/worktree/.git:/home/node/workspace/.git:ro'));
      assert.ok(args.includes('/tmp/git-processor:/tmp/git-processor:ro'));
      assert.equal(args.some(argument => argument === 'GH_TOKEN=token'), false);
      assert.equal(args.some(argument => argument === 'GITHUB_TOKEN=token'), false);
      assert.equal(args.some(argument => argument.includes('must-not-leak')), false);
    }
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

  test('recognizes Claude native goal support from offline help and the local /goal command', () => {
    const help = [
      '-p, --print  Print response and exit',
      '-r, --resume [value]  Resume a conversation by session ID',
      '--session-id <uuid>  Use a specific session ID for the conversation',
      '--input-format <format>  Input format (only works with --print)',
      '--output-format <format>  Output format for print mode',
    ].join('\n');
    assert.equal(claudeHelpSupportsNativeGoal(help), true);
    assert.equal(claudeHelpSupportsNativeGoal(help.replace(/--input-format.*\n/, '')), false);
    assert.equal(claudeGoalCommandProbeSucceeded([
      '{"type":"system","subtype":"init","session_id":"s"}',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'No goal set. Usage: `/goal <condition>`' }),
    ].join('\n')), true);
    assert.equal(claudeGoalCommandProbeSucceeded(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }),
    ), false);
    assert.equal(claudeGoalCommandProbeSucceeded('Unknown command: /goal'), false);
  });

  test('capability listing uses offline introspection and never launches provider inference', async () => {
    const schema = JSON.stringify(REQUIRED_GOAL_SCHEMA);
    const help: Record<string, string> = {
      claude: [
        '--print\n--resume [value]\n--session-id <uuid>\n--input-format <format>\n--output-format <format>',
        '===PROPR-CLAUDE-GOAL-PROBE===',
        JSON.stringify({ type: 'result', is_error: false, result: 'No goal set. Usage: `/goal <condition>`' }),
      ].join('\n'),
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
      assert.doesNotMatch(calls[0].args.join(' '), /Reply with|--conversation\s+\S+$/);
      if (type === 'codex') assert.ok(calls[0].args.join(' ').includes('generate-json-schema'));
      else if (type === 'claude') {
        // `/goal` with no condition is a local usage command: no model call.
        assert.match(calls[0].args.join(' '), /claude --help; .*claude -p \/goal --output-format stream-json --verbose --no-session-persistence$/);
        assert.deepEqual(capability.lifecycle, { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' });
        assert.equal(capability.controls.liveInput, true);
      } else {
        assert.doesNotMatch(calls[0].args.join(' '), /\/goal/);
        assert.ok(calls[0].args.includes('--help'));
      }
    }
  });

  test('Claude runtimes without a noninteractive /goal command are not goal capable', async () => {
    const capability = await probeGoalCapability({
      config: baseConfig('claude'), goalCapable: true,
    } as Agent, async () => ({
      stdout: [
        '--print\n--resume [value]\n--session-id <uuid>\n--input-format <format>\n--output-format <format>',
        '===PROPR-CLAUDE-GOAL-PROBE===',
        JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }),
      ].join('\n'),
      stderr: '', exitCode: 0, messageTimestamps: new Map(),
    }));
    assert.equal(capability.goalCapable, false);
    assert.match(capability.reason || '', /noninteractive native \/goal/);
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
