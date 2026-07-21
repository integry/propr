import { after, test, describe, mock } from 'node:test';
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

const { db } = await import('../packages/core/src/db/connection.ts');
const { closeConnection } = await import('../packages/core/src/db/connection.ts');
const { applyAgentsUpdate } = await import('../packages/api/routes/configRoutesAgents.ts');
const {
  resolveClaudeReasoningLevel,
  resolveCodexReasoningLevel,
  resolveRuntimeModelReasoningLevel,
  validateModelReasoningLevel,
  assertReasoningLevelCliVersionSupported
} = await import('../packages/core/src/config/configManagerReasoning.ts');
const { extractSettingSaves } = await import('../packages/api/routes/configSettings.ts');
const { saveSettingsWithRollback } = await import('../packages/api/routes/configRoutesSettings.ts');

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

  test('clamps runtime-only values instead of passing unsupported flags', () => {
    assert.equal(resolveRuntimeModelReasoningLevel('codex', 'ultra'), 'ultra');
    assert.equal(resolveRuntimeModelReasoningLevel('codex', 'ultracode'), 'ultra');
    assert.equal(resolveRuntimeModelReasoningLevel('claude', 'ultracode'), 'ultracode');
    assert.equal(resolveRuntimeModelReasoningLevel('claude', 'ultra'), 'max');
    assert.equal(resolveRuntimeModelReasoningLevel('claude', 'auto'), 'auto');
    assert.equal(resolveRuntimeModelReasoningLevel('opencode', 'high'), null);
  });

  test('exposes per-agent clamping helpers', () => {
    assert.equal(resolveCodexReasoningLevel('ultracode'), 'ultra');
    assert.equal(resolveCodexReasoningLevel('auto'), null);
    assert.equal(resolveClaudeReasoningLevel('ultra'), 'max');
    assert.equal(resolveClaudeReasoningLevel('auto'), 'auto');
  });

  test('rejects reasoning flags for known unsupported CLI versions', () => {
    assert.throws(
      () => assertReasoningLevelCliVersionSupported({
        agentType: 'claude',
        agentAlias: 'old-claude',
        cliVersion: '2.1.67',
        reasoningLevel: 'auto',
      }),
      /requires claude CLI 2\.1\.68 or newer/
    );
    assert.throws(
      () => assertReasoningLevelCliVersionSupported({
        agentType: 'codex',
        agentAlias: 'old-codex',
        cliVersion: '0.143.9',
        reasoningLevel: 'xhigh',
      }),
      /requires codex CLI 0\.144\.0 or newer/
    );
    assert.doesNotThrow(() => assertReasoningLevelCliVersionSupported({
      agentType: 'codex',
      cliVersion: 'latest',
      reasoningLevel: 'xhigh',
    }));
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

  test('accepts cross-agent values during extraction because runtime clamps them', async () => {
    const result = await extractSettingSaves({ model_reasoning_level: 'ultracode' });
    assert.equal(result.error, undefined);
    assert.equal(result.normalized.model_reasoning_level, 'ultracode');
  });

  test('agent updates allow disabling all agents while model_reasoning_level is set', async () => {
    const writes = new Map<string, unknown>();
    const trx = Object.assign(
      ((table: string) => ({
        insert: (row: { key: string; value: string }) => ({
          onConflict: (_column: string) => ({
            merge: async () => {
              assert.equal(table, 'system_configs');
              writes.set(row.key, JSON.parse(row.value));
            }
          })
        })
      })) as unknown as typeof db,
      {
        commit: async () => {},
        rollback: async () => {}
      }
    );
    const transactionMock = mock.method(db, 'transaction', async () => trx as never);

    try {
      const result = await applyAgentsUpdate({
        agents: [
          {
            id: 'old-agent',
            alias: 'old-default',
            type: 'claude',
            enabled: false,
            configPath: '/tmp/claude',
            supportedModels: []
          }
        ],
        publishConfigUpdate: async () => {},
        logActivityHelper: async () => {},
        configStore: {
          loadAgents: async () => [],
          loadSettings: async () => ({
            default_agent_alias: 'old-default',
            keep: 'unchanged',
            model_reasoning_level: 'max'
          }),
          handleSettingsSaveSideEffects: async () => {}
        },
        registry: {
          refresh: async () => {},
          setDefaultAgentAlias: (_alias: string | null) => {}
        }
      });

      assert.equal(result.status, 200);
      assert.deepEqual(writes.get('settings'), { keep: 'unchanged' });
      assert.equal((writes.get('agents') as Array<{ enabled: boolean }>)[0]?.enabled, false);
    } finally {
      transactionMock.mock.restore();
    }
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

  test('passes Claude auto through --effort', () => {
    const args = buildClaudeDockerArgs(claudeConfig, 1000, {
      worktreePath: '/tmp/worktree',
      githubToken: '',
      modelName: 'claude:claude-opus-4-6',
      issueNumber: 42,
      reasoningLevel: 'auto',
    });

    assert.equal(args[args.indexOf('--effort') + 1], 'auto');
  });
});
