import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { AgentRegistry, resolveAgentFromLabels, resolveAgentFromSetting, getDefaultAgentResolution } from '@gitfix/core';
import type { ResolvedAgent } from '@gitfix/core';

test('Agent Selector', async (t) => {
    beforeEach(() => {
        // Reset the singleton for each test by accessing the private instance
        // @ts-expect-error - accessing private static for testing
        AgentRegistry.instance = undefined;
    });

    await t.test('resolveAgentFromLabels - returns null when no llm-* label present', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const result = resolveAgentFromLabels(['bug', 'enhancement', 'priority-high']);
        assert.strictEqual(result, null, 'Should return null when no llm-* label');
    });

    await t.test('resolveAgentFromLabels - returns null for unknown agent alias', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const result = resolveAgentFromLabels(['llm-unknown-agent', 'bug']);
        assert.strictEqual(result, null, 'Should return null for unknown agent');
    });

    await t.test('resolveAgentFromLabels - resolves default agent with exact alias match', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        // With default setup, there should be a 'default' agent
        const result = resolveAgentFromLabels(['llm-default', 'bug']);

        assert.ok(result !== null, 'Should resolve agent');
        assert.strictEqual(result!.agent.config.alias, 'default', 'Should match default agent');
        assert.ok(result!.model, 'Should have a model');
    });

    await t.test('resolveAgentFromLabels - handles model-* override', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const result = resolveAgentFromLabels(['llm-default', 'model-opus', 'bug']);

        assert.ok(result !== null, 'Should resolve agent');
        assert.strictEqual(result!.agent.config.alias, 'default', 'Should match default agent');
        // Model should contain 'opus' if it's in supported models
        if (result!.agent.config.supportedModels.some(m => m.toLowerCase().includes('opus'))) {
            assert.ok(result!.model.toLowerCase().includes('opus'), 'Should have opus model');
        }
    });

    await t.test('resolveAgentFromLabels - falls back to default model for unsupported model-* override', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const result = resolveAgentFromLabels(['llm-default', 'model-nonexistent-xyz']);

        assert.ok(result !== null, 'Should resolve agent');
        // Should still have a model (the default one)
        assert.ok(result!.model, 'Should have a model even with invalid override');
    });

    await t.test('resolveAgentFromSetting - returns null for empty setting', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const result = resolveAgentFromSetting('');
        assert.strictEqual(result, null, 'Should return null for empty setting');
    });

    await t.test('resolveAgentFromSetting - returns null for unknown alias', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const result = resolveAgentFromSetting('unknown-agent:some-model');
        assert.strictEqual(result, null, 'Should return null for unknown alias');
    });

    await t.test('resolveAgentFromSetting - resolves alias only (uses default model)', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const result = resolveAgentFromSetting('default');

        assert.ok(result !== null, 'Should resolve agent');
        assert.strictEqual(result!.agent.config.alias, 'default', 'Should match default agent');
        // Should use agent's default model
        const expectedModel = result!.agent.config.defaultModel || result!.agent.config.supportedModels[0];
        assert.strictEqual(result!.model, expectedModel, 'Should use agent default model');
    });

    await t.test('resolveAgentFromSetting - resolves alias:model format', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        // Get the default agent's first supported model for testing
        const defaultAgent = registry.getDefaultAgent();
        assert.ok(defaultAgent, 'Should have default agent');

        const testModel = defaultAgent!.config.supportedModels[0];
        const result = resolveAgentFromSetting(`default:${testModel}`);

        assert.ok(result !== null, 'Should resolve agent');
        assert.strictEqual(result!.agent.config.alias, 'default', 'Should match default agent');
        assert.strictEqual(result!.model, testModel, 'Should use specified model');
    });

    await t.test('resolveAgentFromSetting - handles partial model match in alias:model format', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        // Try with a short model name that might match (e.g., 'opus' matching 'claude-opus-4-5')
        const result = resolveAgentFromSetting('default:opus');

        if (result) {
            // If resolved, check if model contains opus
            const hasOpusModel = result.agent.config.supportedModels.some(m =>
                m.toLowerCase().includes('opus')
            );
            if (hasOpusModel) {
                assert.ok(
                    result.model.toLowerCase().includes('opus'),
                    'Should resolve partial model name to full model'
                );
            }
        }
        // If no opus model supported, this test just passes
    });

    await t.test('getDefaultAgentResolution - returns default agent', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const result = getDefaultAgentResolution();

        assert.ok(result !== null, 'Should return default agent resolution');
        assert.ok(result!.agent, 'Should have agent');
        assert.ok(result!.model, 'Should have model');
        assert.strictEqual(result!.agent.config.alias, 'default', 'Should be default agent');
    });

    await t.test('getDefaultAgentResolution - uses agent default model', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const result = getDefaultAgentResolution();

        assert.ok(result !== null, 'Should return default agent resolution');

        const expectedModel = result!.agent.config.defaultModel || result!.agent.config.supportedModels[0];
        assert.strictEqual(result!.model, expectedModel, 'Should use agent default or first supported model');
    });
});

test('Agent Selector Label Parsing Patterns', async (t) => {
    beforeEach(() => {
        // @ts-expect-error - accessing private static for testing
        AgentRegistry.instance = undefined;
    });

    await t.test('handles multiple llm-* labels - uses first one', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        // When multiple llm-* labels exist, should use the first found
        const result = resolveAgentFromLabels(['llm-default', 'llm-other', 'bug']);

        assert.ok(result !== null, 'Should resolve with first llm-* label');
        assert.strictEqual(result!.agent.config.alias, 'default', 'Should use first matching label');
    });

    await t.test('ignores non-llm labels completely', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const result = resolveAgentFromLabels(['bug', 'llm-default', 'priority', 'model-opus']);

        assert.ok(result !== null, 'Should resolve agent from llm-default');
        assert.strictEqual(result!.agent.config.alias, 'default');
    });
});

test('Integration: Agent Selector with AgentRegistry', async (t) => {
    beforeEach(() => {
        // @ts-expect-error - accessing private static for testing
        AgentRegistry.instance = undefined;
    });

    await t.test('selector works with freshly initialized registry', async () => {
        const registry = AgentRegistry.getInstance();

        // Don't call refresh - let resolveAgentFromLabels work with uninitialized registry
        // The selector should still work because it gets a registry instance

        await registry.ensureInitialized();

        const result = resolveAgentFromLabels(['llm-default']);
        assert.ok(result !== null, 'Should work with initialized registry');
    });

    await t.test('selector returns consistent results across calls', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const result1 = resolveAgentFromLabels(['llm-default', 'model-opus']);
        const result2 = resolveAgentFromLabels(['llm-default', 'model-opus']);

        assert.ok(result1 !== null && result2 !== null, 'Both should resolve');
        assert.strictEqual(result1!.agent.config.alias, result2!.agent.config.alias, 'Agent alias should be consistent');
        assert.strictEqual(result1!.model, result2!.model, 'Model should be consistent');
    });
});
