import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { AgentRegistry, closeConnection } = await import('@propr/core');
const { getLlmLabel } = await import('../packages/api/routes/planIssueHelpers.js');

after(async () => {
  await closeConnection();
});

test('getLlmLabel returns static model labels unchanged', async () => {
  assert.strictEqual(await getLlmLabel('opencode-deepseek-v4-flash-free'), 'llm-opencode-deepseek-v4-flash-free');
});

test('getLlmLabel uses the configured agent alias for static model labels', async () => {
  const registry = AgentRegistry.getInstance();
  const ensureInitialized = mock.method(registry, 'ensureInitialized', async () => undefined);
  const getAgentByAlias = mock.method(registry, 'getAgentByAlias', (alias: string) => alias === 'codex2'
    ? {
        config: {
          id: 'codex-agent-2',
          type: 'codex',
          alias: 'codex2',
          enabled: true,
          dockerImage: 'propr/codex:latest',
          configPath: '~/.codex',
          supportedModels: ['gpt-5.6-sol'],
          defaultModel: 'gpt-5.6-sol'
        }
      }
    : undefined);

  try {
    assert.strictEqual(
      await getLlmLabel('gpt-5.6-sol', 'codex2'),
      'llm-codex2-gpt56-sol'
    );
  } finally {
    ensureInitialized.mock.restore();
    getAgentByAlias.mock.restore();
  }
});

test('getLlmLabel emits explicit dynamic labels for configured OpenCode provider models', async () => {
  const registry = AgentRegistry.getInstance();
  const ensureInitialized = mock.method(registry, 'ensureInitialized', async () => undefined);
  const getAllAgents = mock.method(registry, 'getAllAgents', () => [
    {
      config: {
        id: 'opencode-agent-test',
        type: 'opencode',
        alias: 'opencode',
        enabled: true,
        dockerImage: 'propr/agent:latest',
        configPath: '~/.config/opencode',
        supportedModels: ['opencode-openai/gpt-5.5', 'opencode-go/qwen3.7-max'],
        defaultModel: 'opencode-deepseek-v4-flash-free'
      }
    }
  ]);

  try {
    assert.strictEqual(await getLlmLabel('openai/gpt-5.5'), 'llm-opencode~opencode-openai/gpt-5.5');
    assert.strictEqual(await getLlmLabel('opencode-openai/gpt-5.5'), 'llm-opencode~opencode-openai/gpt-5.5');
    assert.strictEqual(await getLlmLabel('opencode-go/qwen3.7-max'), 'llm-opencode~opencode-go/qwen3.7-max');
  } finally {
    ensureInitialized.mock.restore();
    getAllAgents.mock.restore();
  }
});

test('getLlmLabel hashes long dynamic labels to fit GitHub limits', async () => {
  const registry = AgentRegistry.getInstance();
  const ensureInitialized = mock.method(registry, 'ensureInitialized', async () => undefined);
  const longModel = 'opencode-provider-with-an-extremely-long-name/model-with-an-extremely-long-name';
  const getAllAgents = mock.method(registry, 'getAllAgents', () => [
    {
      config: {
        id: 'opencode-agent-test',
        type: 'opencode',
        alias: 'opencode',
        enabled: true,
        dockerImage: 'propr/agent:latest',
        configPath: '~/.config/opencode',
        supportedModels: [longModel],
        defaultModel: 'opencode-deepseek-v4-flash-free'
      }
    }
  ]);

  try {
    const label = await getLlmLabel(longModel);
    assert.ok(label);
    assert.ok(label.length <= 50);
    assert.match(label, /^llm-opencode~/);
  } finally {
    ensureInitialized.mock.restore();
    getAllAgents.mock.restore();
  }
});
