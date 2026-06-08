import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { AgentRegistry, resolveLlmLabel, buildDynamicLlmLabel, closeConnection } = await import('@propr/core');

after(async () => {
  await closeConnection();
});

test('hashed dynamic labels round-trip through resolveLlmLabel', async () => {
  const registry = AgentRegistry.getInstance();

  const longModel = 'opencode-provider-with-an-extremely-long-name/model-with-an-extremely-long-name';
  const mockAgentConfigs = [
    { config: { id: 'claude-agent-1', type: 'claude' as const, alias: 'claude', enabled: true, supportedModels: ['claude-sonnet-4-6'], defaultModel: 'claude-sonnet-4-6' } },
    { config: { id: 'opencode-agent-1', type: 'opencode' as const, alias: 'opencode', enabled: true, supportedModels: ['opencode-minimax-m3-free', 'opencode-openai/gpt-5.5', longModel] } }
  ];

  const originalGetAllAgents = registry.getAllAgents.bind(registry);
  const originalGetDefaultAgent = registry.getDefaultAgent.bind(registry);
  const originalEnsureInitialized = registry.ensureInitialized.bind(registry);
  const originalGetAgentByAlias = registry.getAgentByAlias.bind(registry);

  registry.getAllAgents = () => mockAgentConfigs as any;
  registry.getDefaultAgent = () => mockAgentConfigs[0] as any;
  registry.ensureInitialized = async () => {};
  registry.getAgentByAlias = (alias: string) => mockAgentConfigs.find(a => a.config.alias === alias) as any;

  try {
    const label = buildDynamicLlmLabel('opencode', longModel);
    assert.ok(label.length <= 50, `Label should fit in 50 chars, got ${label.length}`);
    assert.match(label, /^llm-opencode:/, 'Should start with llm-opencode:');

    // Strip llm- prefix as resolveLlmLabel expects
    const stripped = label.replace(/^llm-/, '');
    const result = await resolveLlmLabel(stripped);
    assert.strictEqual(result.agentAlias, 'opencode', 'Should resolve to opencode agent');
    assert.strictEqual(result.model, longModel, 'Should recover the original long model ID via hash');

    // Test with a long agent alias that exceeds the label budget
    const longAlias = 'my-custom-opencode-agent-with-a-very-long-name';
    const longAliasLabel = buildDynamicLlmLabel(longAlias, 'opencode-openai/gpt-5.5');
    assert.ok(longAliasLabel.length <= 50, `Long alias label should fit in 50 chars, got ${longAliasLabel.length}`);
    assert.match(longAliasLabel, /^llm-/, 'Should start with llm-');

    // Short model with short alias should produce non-hashed label
    const shortLabel = buildDynamicLlmLabel('opencode', 'opencode-openai/gpt-5.5');
    assert.ok(shortLabel.length <= 50, `Short label should fit in 50 chars, got ${shortLabel.length}`);
    const shortStripped = shortLabel.replace(/^llm-/, '');
    const shortResult = await resolveLlmLabel(shortStripped);
    assert.strictEqual(shortResult.agentAlias, 'opencode', 'Short label should resolve to opencode agent');
    assert.strictEqual(shortResult.model, 'opencode-openai/gpt-5.5', 'Short label should resolve to correct model');
  } finally {
    registry.getAllAgents = originalGetAllAgents;
    registry.getDefaultAgent = originalGetDefaultAgent;
    registry.ensureInitialized = originalEnsureInitialized;
    registry.getAgentByAlias = originalGetAgentByAlias;
  }
});
