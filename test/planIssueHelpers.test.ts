import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { AgentRegistry, closeConnection } = await import('@propr/core');
const { getLlmLabel } = await import('../packages/api/routes/planIssueHelpers.js');

after(async () => {
  await closeConnection();
});

test('getLlmLabel returns static model labels unchanged', async () => {
  assert.strictEqual(await getLlmLabel('opencode-minimax-m3-free'), 'llm-opencode-minimax-m3-free');
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
        dockerImage: 'propr/agent-opencode:latest',
        configPath: '~/.config/opencode',
        supportedModels: ['opencode-openai/gpt-5.5', 'opencode-go/qwen3.7-max'],
        defaultModel: 'opencode-minimax-m3-free'
      }
    }
  ]);

  try {
    assert.strictEqual(await getLlmLabel('openai/gpt-5.5'), 'llm-opencode:opencode-openai/gpt-5.5');
    assert.strictEqual(await getLlmLabel('opencode-openai/gpt-5.5'), 'llm-opencode:opencode-openai/gpt-5.5');
    assert.strictEqual(await getLlmLabel('opencode-go/qwen3.7-max'), 'llm-opencode:opencode-go/qwen3.7-max');
  } finally {
    ensureInitialized.mock.restore();
    getAllAgents.mock.restore();
  }
});
