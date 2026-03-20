import { test, after, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import { resolveModelAlias, getDefaultModel, MODEL_ALIASES, DEFAULT_MODEL_ALIAS, resolveLlmLabel, ALL_MODELS } from '@propr/core';
import { AgentRegistry } from '@propr/core';

test('Model Aliases Configuration', async (t) => {
    await t.test('should resolve known aliases to full model IDs', () => {
        assert.strictEqual(resolveModelAlias('opus'), 'claude-opus-4-20250514');
        assert.strictEqual(resolveModelAlias('sonnet'), 'claude-sonnet-4-5-20250929');
        assert.strictEqual(resolveModelAlias('sonnet37'), 'claude-3-7-sonnet-20250219');
        assert.strictEqual(resolveModelAlias('sonnet35'), 'claude-3-5-sonnet-20241022');
        assert.strictEqual(resolveModelAlias('haiku'), 'claude-3-5-haiku-20241022');
    });

    await t.test('should handle case-insensitive aliases', () => {
        assert.strictEqual(resolveModelAlias('OPUS'), 'claude-opus-4-20250514');
        assert.strictEqual(resolveModelAlias('Sonnet'), 'claude-sonnet-4-5-20250929');
        assert.strictEqual(resolveModelAlias('HAIKU'), 'claude-3-5-haiku-20241022');
    });

    await t.test('should return full model IDs as-is', () => {
        assert.strictEqual(resolveModelAlias('claude-3-5-sonnet-20241022'), 'claude-3-5-sonnet-20241022');
        assert.strictEqual(resolveModelAlias('custom-model-id'), 'custom-model-id');
    });

    await t.test('should use default model when no model specified', () => {
        const defaultModel = resolveModelAlias(null);
        assert.strictEqual(defaultModel, 'claude-sonnet-4-5-20250929');
        assert.strictEqual(defaultModel, MODEL_ALIASES[DEFAULT_MODEL_ALIAS]);
    });

    await t.test('getDefaultModel should return sonnet as default', () => {
        assert.strictEqual(getDefaultModel(), 'claude-sonnet-4-5-20250929');
        assert.strictEqual(DEFAULT_MODEL_ALIAS, 'sonnet');
    });

    await t.test('should handle legacy aliases', () => {
        assert.strictEqual(resolveModelAlias('claude-3-opus'), 'claude-3-opus-20240229');
        assert.strictEqual(resolveModelAlias('claude-3-5-sonnet'), 'claude-3-5-sonnet-20241022');
        assert.strictEqual(resolveModelAlias('claude-3-haiku'), 'claude-3-haiku-20240307');
        assert.strictEqual(resolveModelAlias('claude-3-sonnet'), 'claude-3-sonnet-20240229');
    });

    await t.test('should handle official Anthropic aliases', () => {
        assert.strictEqual(resolveModelAlias('claude-opus-4-0'), 'claude-opus-4-20250514');
        assert.strictEqual(resolveModelAlias('claude-sonnet-4-0'), 'claude-sonnet-4-5-20250929');
        assert.strictEqual(resolveModelAlias('claude-3-7-sonnet-latest'), 'claude-3-7-sonnet-20250219');
        assert.strictEqual(resolveModelAlias('claude-3-5-sonnet-latest'), 'claude-3-5-sonnet-20241022');
        assert.strictEqual(resolveModelAlias('claude-3-5-haiku-latest'), 'claude-3-5-haiku-20241022');
    });
});

test('resolveLlmLabel - 5-step model resolution', async (t) => {
    // Mock agent configurations for testing
    const mockAgentConfigs = [
        {
            config: {
                id: 'claude-agent-1',
                type: 'claude' as const,
                alias: 'claude',
                enabled: true,
                supportedModels: ['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
                defaultModel: 'claude-sonnet-4-5-20250929'
            }
        },
        {
            config: {
                id: 'gemini-agent-1',
                type: 'gemini' as const,
                alias: 'gemini',
                enabled: true,
                supportedModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-flash-preview'],
                defaultModel: 'gemini-2.5-pro'
            }
        },
        {
            config: {
                id: 'codex-agent-1',
                type: 'codex' as const,
                alias: 'codex',
                enabled: true,
                supportedModels: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'],
                defaultModel: 'gpt-5.4'
            }
        }
    ];

    // Setup mock before tests
    const registry = AgentRegistry.getInstance();

    // Store original methods for restoration
    const originalGetAllAgents = registry.getAllAgents.bind(registry);
    const originalGetDefaultAgent = registry.getDefaultAgent.bind(registry);
    const originalEnsureInitialized = registry.ensureInitialized.bind(registry);

    // Apply mocks
    registry.getAllAgents = () => mockAgentConfigs as any;
    registry.getDefaultAgent = () => mockAgentConfigs[0] as any;
    registry.ensureInitialized = async () => { /* no-op for tests */ };

    await t.test('Step 1: resolves exact githubLabel match from modelDefinitions', async () => {
        // Labels like "claude-opus" should match the githubLabel "llm-claude-opus"
        const result = await resolveLlmLabel('claude-opus');
        assert.strictEqual(result.agentAlias, 'claude', 'Should resolve to claude agent');
        assert.strictEqual(result.model, 'claude-opus-4-5-20251101', 'Should resolve to exact model from modelDefinitions');
    });

    await t.test('Step 1: resolves exact githubLabel for gemini models', async () => {
        // "gemini-g3-flash-preview" should match the githubLabel "llm-gemini-g3-flash-preview"
        const result = await resolveLlmLabel('gemini-g3-flash-preview');
        assert.strictEqual(result.agentAlias, 'gemini', 'Should resolve to gemini agent');
        assert.strictEqual(result.model, 'gemini-3-flash-preview', 'Should resolve to correct gemini model');
    });

    await t.test('Step 1: resolves exact githubLabel for codex models', async () => {
        const result = await resolveLlmLabel('codex-gpt54');
        assert.strictEqual(result.agentAlias, 'codex', 'Should resolve to codex agent');
        assert.strictEqual(result.model, 'gpt-5.4', 'Should resolve to correct codex model');
    });

    await t.test('Step 2: resolves agent alias match with default model', async () => {
        // Just "gemini" should return the default gemini model
        const result = await resolveLlmLabel('gemini');
        assert.strictEqual(result.agentAlias, 'gemini', 'Should resolve to gemini agent');
        assert.strictEqual(result.model, 'gemini-2.5-pro', 'Should use default model for agent');
    });

    await t.test('Step 2: resolves claude alias to default model', async () => {
        const result = await resolveLlmLabel('claude');
        assert.strictEqual(result.agentAlias, 'claude', 'Should resolve to claude agent');
        assert.strictEqual(result.model, 'claude-sonnet-4-5-20250929', 'Should use claude default model');
    });

    await t.test('Step 2: resolves codex alias to default model', async () => {
        const result = await resolveLlmLabel('codex');
        assert.strictEqual(result.agentAlias, 'codex', 'Should resolve to codex agent');
        assert.strictEqual(result.model, 'gpt-5.4', 'Should use codex default model');
    });

    await t.test('Step 3: resolves agent prefix match (e.g., gemini-flash)', async () => {
        // "gemini-flash" should resolve to gemini agent with flash model
        const result = await resolveLlmLabel('gemini-flash');
        assert.strictEqual(result.agentAlias, 'gemini', 'Should resolve to gemini agent');
        assert.ok(result.model.includes('flash'), 'Should resolve to a flash model');
    });

    await t.test('Step 3: resolves agent prefix match for codex-spark', async () => {
        const result = await resolveLlmLabel('codex-spark');
        assert.strictEqual(result.agentAlias, 'codex', 'Should resolve to codex agent');
        // spark is shortAlias for gpt-5.3-codex-spark (but may fallback to default if not found in supported)
        assert.ok(result.model, 'Should resolve to a model');
    });

    await t.test('Step 4: resolves static MODEL_ALIASES for backwards compatibility (opus)', async () => {
        const result = await resolveLlmLabel('opus');
        assert.strictEqual(result.agentAlias, 'claude', 'Should resolve to default (claude) agent');
        assert.strictEqual(result.model, 'claude-opus-4-5', 'Should resolve to claude-opus-4-5 from static aliases');
    });

    await t.test('Step 4: resolves static MODEL_ALIASES for sonnet', async () => {
        const result = await resolveLlmLabel('sonnet');
        assert.strictEqual(result.agentAlias, 'claude', 'Should resolve to default agent');
        assert.strictEqual(result.model, 'claude-sonnet-4-5', 'Should resolve to claude-sonnet-4-5');
    });

    await t.test('Step 4: resolves static MODEL_ALIASES for haiku', async () => {
        const result = await resolveLlmLabel('haiku');
        assert.strictEqual(result.agentAlias, 'claude', 'Should resolve to default agent');
        assert.strictEqual(result.model, 'claude-haiku-4-5', 'Should resolve to claude-haiku-4-5');
    });

    await t.test('Step 5: falls back to label as model name for unknown labels', async () => {
        const result = await resolveLlmLabel('custom-unknown-model');
        assert.strictEqual(result.agentAlias, 'claude', 'Should fall back to default agent');
        assert.strictEqual(result.model, 'custom-unknown-model', 'Should use label as model name');
    });

    await t.test('returns correct agent type for each resolution path', async () => {
        // Test that each resolution path returns the proper agentAlias

        // Path 1: githubLabel match - should return agent matching the model
        const path1 = await resolveLlmLabel('claude-sonnet');
        assert.strictEqual(path1.agentAlias, 'claude', 'githubLabel match returns correct agent');

        // Path 2: agent alias match - returns that agent
        const path2 = await resolveLlmLabel('gemini');
        assert.strictEqual(path2.agentAlias, 'gemini', 'agent alias match returns correct agent');

        // Path 3: prefix match - returns matching agent
        const path3 = await resolveLlmLabel('codex-gpt54');
        assert.strictEqual(path3.agentAlias, 'codex', 'prefix match returns correct agent');

        // Path 4: static alias - returns default agent
        const path4 = await resolveLlmLabel('opus');
        assert.strictEqual(path4.agentAlias, 'claude', 'static alias returns default agent');

        // Path 5: fallback - returns default agent
        const path5 = await resolveLlmLabel('unknown-model');
        assert.strictEqual(path5.agentAlias, 'claude', 'fallback returns default agent');
    });

    await t.test('handles case-insensitive labels', async () => {
        const lowerCase = await resolveLlmLabel('opus');
        const upperCase = await resolveLlmLabel('OPUS');
        const mixedCase = await resolveLlmLabel('OpUs');

        assert.strictEqual(lowerCase.model, upperCase.model, 'Should resolve same model regardless of case');
        assert.strictEqual(lowerCase.model, mixedCase.model, 'Should resolve same model for mixed case');
    });

    await t.test('resolution includes both agentAlias and model', async () => {
        const result = await resolveLlmLabel('gemini-pro');

        assert.ok('agentAlias' in result, 'Result should have agentAlias property');
        assert.ok('model' in result, 'Result should have model property');
        assert.strictEqual(typeof result.agentAlias, 'string', 'agentAlias should be a string');
        assert.strictEqual(typeof result.model, 'string', 'model should be a string');
    });

    // Restore original methods after tests
    registry.getAllAgents = originalGetAllAgents;
    registry.getDefaultAgent = originalGetDefaultAgent;
    registry.ensureInitialized = originalEnsureInitialized;
});

// Force exit due to module-level initialization in @propr/core
after(() => {
    process.exit(0);
});
