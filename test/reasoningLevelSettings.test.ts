import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_REASONING_LEVELS,
  CODEX_REASONING_LEVELS,
  REASONING_LEVELS,
  getReasoningLevelsForAgentType,
  isReasoningLevelSupportedByAgentType,
} from '@propr/shared';
import { parseSettingValue } from '../packages/cli/src/api/settings.ts';
import { CodexAgent } from '../packages/core/src/agents/impl/CodexAgent.ts';
import { buildDockerArgs as buildClaudeDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import type { AgentConfig } from '../packages/core/src/agents/types.ts';

process.env.PROPR_DEMO_MODE = 'true';

const { closeConnection } = await import('../packages/core/src/db/connection.ts');
const {
  resolveRuntimeModelReasoningLevel,
  validateModelReasoningLevel,
  validateModelReasoningLevelForAgentType
} = await import('../packages/core/src/config/configManagerReasoning.ts');
const { extractSettingSaves } = await import('../packages/api/routes/configSettings.ts');
const { saveSettingsWithRollback } = await import('../packages/api/routes/configRoutesSettings.ts');
const { applyAgentsUpdate } = await import('../packages/api/routes/configRoutesAgents.ts');

after(async () => {
  await closeConnection();
});

describe('shared reasoning level vocabulary', () => {
  test('defines all accepted values and agent subsets', () => {
    assert.deepEqual(REASONING_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode', 'auto']);
    assert.deepEqual(CODEX_REASONING_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.deepEqual(CLAUDE_REASONING_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto']);
    assert.deepEqual(getReasoningLevelsForAgentType('codex'), CODEX_REASONING_LEVELS);
    assert.deepEqual(getReasoningLevelsForAgentType('claude'), CLAUDE_REASONING_LEVELS);
    assert.deepEqual(getReasoningLevelsForAgentType('opencode'), []);
    assert.equal(isReasoningLevelSupportedByAgentType('codex', 'ultra'), true);
    assert.equal(isReasoningLevelSupportedByAgentType('codex', 'ultracode'), false);
    assert.equal(isReasoningLevelSupportedByAgentType('claude', 'ultracode'), true);
  });
});

describe('CLI model_reasoning_level parsing', () => {
  for (const level of REASONING_LEVELS) {
    test(`accepts ${level}`, () => {
      assert.equal(parseSettingValue('model_reasoning_level', level), level);
    });
  }

  test('normalizes case before saving', () => {
    assert.equal(parseSettingValue('model_reasoning_level', 'ULTRACODE'), 'ultracode');
  });

  test('clears with empty string', () => {
    assert.equal(parseSettingValue('model_reasoning_level', ''), '');
  });

  test('rejects invalid values before API calls', () => {
    assert.throws(
      () => parseSettingValue('model_reasoning_level', 'bogus'),
      /model_reasoning_level: must be one of: low, medium, high, xhigh, max, ultra, ultracode, auto, or an empty string/
    );
  });
});

describe('API model_reasoning_level extraction', () => {
  for (const level of REASONING_LEVELS) {
    test(`extracts ${level}`, async () => {
      const result = await extractSettingSaves({ model_reasoning_level: level });
      assert.equal(result.error, undefined);
      assert.deepEqual(result.saves, [{ name: 'model_reasoning_level' }]);
      assert.equal(result.normalized.model_reasoning_level, level);
    });
  }

  test('normalizes uppercase API payloads', async () => {
    const result = await extractSettingSaves({ model_reasoning_level: 'ULTRACODE' });
    assert.equal(result.error, undefined);
    assert.equal(result.normalized.model_reasoning_level, 'ultracode');
  });

  test('rejects invalid API payloads', async () => {
    const result = await extractSettingSaves({ model_reasoning_level: 'bogus' });
    assert.match(result.error ?? '', /model_reasoning_level must be one of/);
    assert.deepEqual(result.saves, []);
  });
});

describe('core model_reasoning_level validation', () => {
  test('accepts all values plus agent default', () => {
    for (const level of ['', ...REASONING_LEVELS]) {
      assert.deepEqual(validateModelReasoningLevel(level), { valid: true, value: level });
    }
  });

  test('normalizes mixed-case levels', () => {
    assert.deepEqual(validateModelReasoningLevel('XHIGH'), { valid: true, value: 'xhigh' });
  });

  test('rejects invalid and whitespace-only values', () => {
    assert.deepEqual(validateModelReasoningLevel('bogus').valid, false);
    const whitespaceResult = validateModelReasoningLevel('   ');
    assert.equal(whitespaceResult.valid, false);
    assert.match((whitespaceResult as { valid: false; error: string }).error, /whitespace-only/);
  });

  test('validates values against agent-compatible subsets', () => {
    assert.deepEqual(validateModelReasoningLevelForAgentType('ultra', 'codex'), { valid: true, value: 'ultra' });
    assert.deepEqual(validateModelReasoningLevelForAgentType('ultracode', 'claude'), { valid: true, value: 'ultracode' });
    assert.equal(validateModelReasoningLevelForAgentType('ultracode', 'codex').valid, false);
    assert.equal(validateModelReasoningLevelForAgentType('ultra', 'claude').valid, false);
    assert.equal(validateModelReasoningLevelForAgentType('high', 'opencode').valid, false);
  });

  test('filters runtime-only values instead of passing unsupported flags', () => {
    assert.equal(resolveRuntimeModelReasoningLevel('codex', 'ultra'), 'ultra');
    assert.equal(resolveRuntimeModelReasoningLevel('codex', 'ultracode'), null);
    assert.equal(resolveRuntimeModelReasoningLevel('claude', 'ultracode'), 'ultracode');
    assert.equal(resolveRuntimeModelReasoningLevel('claude', 'auto'), null);
    assert.equal(resolveRuntimeModelReasoningLevel('opencode', 'high'), null);
  });
});

describe('settings save rollback path for model_reasoning_level', () => {
  test('invalid values return 400 before any transaction starts', async () => {
    let published = false;
    const result = await saveSettingsWithRollback({
      settings: {
        worker_concurrency: 10,
        model_reasoning_level: 'bogus',
      },
      publishConfigUpdate: async () => {
        published = true;
      },
    });

    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /model_reasoning_level must be one of/);
    assert.equal(published, false);
  });

  test('rejects reasoning levels incompatible with the default implementation agent', async () => {
    const result = await saveSettingsWithRollback({
      settings: {
        default_agent_alias: 'codex',
        model_reasoning_level: 'ultracode',
      },
      configStore: {
        handleSettingsSaveSideEffects: () => undefined,
        loadSettings: async () => ({ default_agent_alias: 'codex' }),
        loadSettingsRecord: async () => ({ default_agent_alias: 'codex' }),
        loadAgents: async () => [{
          id: 'codex',
          type: 'codex',
          alias: 'codex',
          enabled: true,
          dockerImage: 'propr/agent:latest',
          configPath: '~/.codex',
          supportedModels: ['gpt-5.5'],
          defaultModel: 'gpt-5.5',
        }],
      },
      publishConfigUpdate: async () => undefined,
    });

    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /not supported by codex agents/);
  });

  test('rejects agent default changes that would make the saved reasoning level incompatible', async () => {
    const agents = [{
      id: 'claude',
      type: 'claude',
      alias: 'claude',
      enabled: true,
      dockerImage: 'propr/agent:latest',
      configPath: '~/.claude',
      supportedModels: ['claude-opus-4-6'],
      defaultModel: 'claude-opus-4-6',
    }] as AgentConfig[];
    const result = await applyAgentsUpdate({
      agents,
      processedAgents: agents,
      configStore: {
        handleSettingsSaveSideEffects: () => undefined,
        loadAgents: async () => [],
        loadSettings: async () => ({ default_agent_alias: 'claude' }),
        loadModelReasoningLevel: async () => 'ultra',
      },
      registry: {
        refresh: async () => undefined,
        setDefaultAgentAlias: () => undefined,
      },
      publishConfigUpdate: async () => undefined,
      logActivityHelper: async () => undefined,
    });

    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /not supported by claude agents/);
  });
});

describe('agent runtime reasoning level wiring', () => {
  const codexConfig: AgentConfig = {
    id: 'codex',
    type: 'codex',
    alias: 'codex',
    enabled: true,
    dockerImage: 'propr/agent:latest',
    configPath: '~/.codex',
    supportedModels: ['gpt-5.5'],
    defaultModel: 'gpt-5.5',
  };
  const claudeConfig: AgentConfig = {
    id: 'claude',
    type: 'claude',
    alias: 'claude',
    enabled: true,
    dockerImage: 'propr/agent:latest',
    configPath: '~/.claude',
    supportedModels: ['claude-opus-4-6'],
    defaultModel: 'claude-opus-4-6',
  };

  test('passes Codex reasoning level through model_reasoning_effort config', () => {
    const args = (new CodexAgent(codexConfig) as unknown as {
      buildDockerArgs(params: {
        worktreePath: string;
        githubToken: string;
        modelName?: string;
        issueNumber: number;
        reasoningLevel?: string;
      }): string[];
    }).buildDockerArgs({
      worktreePath: '/tmp/worktree',
      githubToken: '',
      modelName: 'codex:gpt-5.5',
      issueNumber: 42,
      reasoningLevel: 'xhigh',
    });

    const configIndexes = args
      .map((arg, index) => arg === '--config' ? index : -1)
      .filter(index => index >= 0);
    assert.ok(configIndexes.some(index => args[index + 1] === 'model_reasoning_effort="xhigh"'));
  });

  test('passes Claude reasoning level through --effort', () => {
    const args = buildClaudeDockerArgs(claudeConfig, 1000, {
      worktreePath: '/tmp/worktree',
      githubToken: '',
      modelName: 'claude:claude-opus-4-6',
      issueNumber: 42,
      reasoningLevel: 'ultracode',
    });

    assert.equal(args[args.indexOf('--effort') + 1], 'ultracode');
  });
});
