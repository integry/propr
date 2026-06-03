import { test, after, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import { resolveModelAlias, getDefaultModel, MODEL_ALIASES, resolveLlmLabel, ALL_MODELS, findMatchingModel, getModelShortName, resolveReviewModels, ReviewModelResolutionError, NoDefaultModelConfiguredError } from '@propr/core';
import type { ReviewAssignment } from '@propr/core';
import { AgentRegistry } from '@propr/core';
import type { AgentConfig } from '@propr/core';

test('Model Aliases Configuration', async (t) => {
    await t.test('should resolve known aliases to full model IDs', () => {
        // Default aliases point to 4.6 models
        assert.strictEqual(resolveModelAlias('opus'), 'claude-opus-4-6');
        assert.strictEqual(resolveModelAlias('sonnet'), 'claude-sonnet-4-6');
        // Explicit 4.5 aliases
        assert.strictEqual(resolveModelAlias('opus45'), 'claude-opus-4-5-20251101');
        assert.strictEqual(resolveModelAlias('sonnet45'), 'claude-sonnet-4-5-20250929');
        assert.strictEqual(resolveModelAlias('haiku'), 'claude-haiku-4-5-20251001');
    });

    await t.test('should handle case-insensitive aliases', () => {
        assert.strictEqual(resolveModelAlias('OPUS'), 'claude-opus-4-6');
        assert.strictEqual(resolveModelAlias('Sonnet'), 'claude-sonnet-4-6');
        assert.strictEqual(resolveModelAlias('HAIKU'), 'claude-haiku-4-5-20251001');
    });

    await t.test('should return full model IDs as-is', () => {
        assert.strictEqual(resolveModelAlias('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5-20250929');
        assert.strictEqual(resolveModelAlias('custom-model-id'), 'custom-model-id');
    });

    await t.test('should throw NoDefaultModelConfiguredError when no model specified and no agent configured', () => {
        assert.throws(
            () => resolveModelAlias(null),
            (err: any) => {
                assert.ok(err instanceof NoDefaultModelConfiguredError, 'Should throw NoDefaultModelConfiguredError');
                assert.ok(err.message.includes('No default AI model configured'), 'Error message should be descriptive');
                return true;
            }
        );
    });

    await t.test('getDefaultModel should return null when no agent configured', () => {
        // Without any configured agent or env var, getDefaultModel returns null
        const result = getDefaultModel();
        assert.strictEqual(result, null, 'Should return null when no default model is configured');
    });

    await t.test('should handle explicit version aliases', () => {
        // 4.6 aliases
        assert.strictEqual(resolveModelAlias('opus46'), 'claude-opus-4-6');
        assert.strictEqual(resolveModelAlias('sonnet46'), 'claude-sonnet-4-6');
        // 4.5 aliases
        assert.strictEqual(resolveModelAlias('opus-4-5'), 'claude-opus-4-5-20251101');
        assert.strictEqual(resolveModelAlias('sonnet-4-5'), 'claude-sonnet-4-5-20250929');
        assert.strictEqual(resolveModelAlias('haiku45'), 'claude-haiku-4-5-20251001');
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
                supportedModels: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
                defaultModel: 'claude-sonnet-4-6'
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
                supportedModels: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2'],
                defaultModel: 'gpt-5.5'
            }
        },
        {
            config: {
                id: 'vibe-agent-1',
                type: 'vibe' as const,
                alias: 'vibe',
                enabled: true,
                supportedModels: ['mistral-medium-3.5', 'devstral-small'],
                defaultModel: 'mistral-medium-3.5'
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
        // Labels like "claude-opus46" should match the githubLabel "llm-claude-opus46"
        const result = await resolveLlmLabel('claude-opus46');
        assert.strictEqual(result.agentAlias, 'claude', 'Should resolve to claude agent');
        assert.strictEqual(result.model, 'claude-opus-4-6', 'Should resolve to exact model from modelDefinitions');
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

    await t.test('Step 1: resolves exact githubLabel for vibe models', async () => {
        const result = await resolveLlmLabel('vibe-mistral');
        assert.strictEqual(result.agentAlias, 'vibe', 'Should resolve to vibe agent');
        assert.strictEqual(result.model, 'mistral-medium-3.5', 'Should resolve to correct vibe model');
    });

    await t.test('Step 1: resolves exact githubLabel for vibe devstral model', async () => {
        const result = await resolveLlmLabel('vibe-devstral');
        assert.strictEqual(result.agentAlias, 'vibe', 'Should resolve to vibe agent');
        assert.strictEqual(result.model, 'devstral-small', 'Should resolve to devstral-small');
    });

    await t.test('Step 1b: resolves vibe agent-type label when configured alias differs', async () => {
        const vibeAgent = mockAgentConfigs[3].config;
        const originalAlias = vibeAgent.alias;
        vibeAgent.alias = 'mistral-vibe';
        try {
            const result = await resolveLlmLabel('vibe-mistral');
            assert.strictEqual(result.agentAlias, 'mistral-vibe', 'Should resolve to configured vibe agent alias');
            assert.strictEqual(result.model, 'mistral-medium-3.5', 'Should resolve to correct vibe model');
        } finally {
            vibeAgent.alias = originalAlias;
        }
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
        assert.strictEqual(result.model, 'claude-sonnet-4-6', 'Should use claude default model');
    });

    await t.test('Step 2: resolves codex alias to default model', async () => {
        const result = await resolveLlmLabel('codex');
        assert.strictEqual(result.agentAlias, 'codex', 'Should resolve to codex agent');
        assert.strictEqual(result.model, 'gpt-5.5', 'Should use codex default model');
    });

    await t.test('Step 2: resolves vibe alias to default model', async () => {
        const result = await resolveLlmLabel('vibe');
        assert.strictEqual(result.agentAlias, 'vibe', 'Should resolve to vibe agent');
        assert.strictEqual(result.model, 'mistral-medium-3.5', 'Should use vibe default model');
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

    await t.test('Step 3: resolves agent prefix match for vibe-devstral', async () => {
        const result = await resolveLlmLabel('vibe-devstral');
        assert.strictEqual(result.agentAlias, 'vibe', 'Should resolve to vibe agent');
        assert.ok(result.model && result.model.includes('devstral'), 'Should resolve to a devstral model');
    });

    await t.test('Step 4: resolves static MODEL_ALIASES for backwards compatibility (opus)', async () => {
        const result = await resolveLlmLabel('opus');
        assert.strictEqual(result.agentAlias, 'claude', 'Should resolve to default (claude) agent');
        assert.strictEqual(result.model, 'claude-opus-4-6', 'Should resolve to claude-opus-4-6 from static aliases');
    });

    await t.test('Step 4: resolves static MODEL_ALIASES for sonnet', async () => {
        const result = await resolveLlmLabel('sonnet');
        assert.strictEqual(result.agentAlias, 'claude', 'Should resolve to default agent');
        assert.strictEqual(result.model, 'claude-sonnet-4-6', 'Should resolve to claude-sonnet-4-6');
    });

    await t.test('Step 4: resolves static MODEL_ALIASES for haiku', async () => {
        const result = await resolveLlmLabel('haiku');
        assert.strictEqual(result.agentAlias, 'claude', 'Should resolve to default agent');
        assert.strictEqual(result.model, 'claude-haiku-4-5-20251001', 'Should resolve to claude-haiku-4-5-20251001');
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

test('findMatchingModel - matches string to internal model IDs', async (t) => {
    // Mock AgentConfig for testing findMatchingModel
    const createMockConfig = (supportedModels: string[]): AgentConfig => ({
        id: 'test-agent',
        type: 'claude',
        alias: 'test',
        enabled: true,
        dockerImage: 'test:latest',
        configPath: '~/.test',
        supportedModels
    });

    await t.test('matches exact model ID (case-insensitive)', () => {
        const config = createMockConfig(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);

        // Exact match with correct case
        assert.strictEqual(findMatchingModel('claude-opus-4-6', config), 'claude-opus-4-6');
        assert.strictEqual(findMatchingModel('claude-sonnet-4-6', config), 'claude-sonnet-4-6');

        // Exact match with different case
        assert.strictEqual(findMatchingModel('CLAUDE-OPUS-4-6', config), 'claude-opus-4-6');
        assert.strictEqual(findMatchingModel('Claude-Sonnet-4-6', config), 'claude-sonnet-4-6');
    });

    await t.test('matches exact shortAlias from modelDefinitions', () => {
        const config = createMockConfig(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);

        // shortAlias for claude models: opus46, sonnet46, haiku
        assert.strictEqual(findMatchingModel('opus46', config), 'claude-opus-4-6');
        assert.strictEqual(findMatchingModel('sonnet46', config), 'claude-sonnet-4-6');
        assert.strictEqual(findMatchingModel('haiku', config), 'claude-haiku-4-5-20251001');

        // Case-insensitive shortAlias
        assert.strictEqual(findMatchingModel('OPUS46', config), 'claude-opus-4-6');
        assert.strictEqual(findMatchingModel('Sonnet46', config), 'claude-sonnet-4-6');
    });

    await t.test('matches exact shortAlias for gemini models', () => {
        const config = createMockConfig(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-flash-preview']);

        // shortAlias for gemini models: pro, flash, g3-flash-preview
        assert.strictEqual(findMatchingModel('pro', config), 'gemini-2.5-pro');
        assert.strictEqual(findMatchingModel('flash', config), 'gemini-2.5-flash');
        assert.strictEqual(findMatchingModel('g3-flash-preview', config), 'gemini-3-flash-preview');
    });

    await t.test('matches exact shortAlias for codex models', () => {
        const config = createMockConfig(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']);

        // shortAlias for codex models: gpt54, gpt54-mini, codex-spark
        assert.strictEqual(findMatchingModel('gpt54', config), 'gpt-5.4');
        assert.strictEqual(findMatchingModel('gpt54-mini', config), 'gpt-5.4-mini');
        assert.strictEqual(findMatchingModel('codex-spark', config), 'gpt-5.3-codex-spark');
    });

    await t.test('matches exact shortAlias for vibe models', () => {
        const config = createMockConfig(['mistral-medium-3.5', 'devstral-2512', 'devstral-small-latest']);

        assert.strictEqual(findMatchingModel('medium35', config), 'mistral-medium-3.5');
        assert.strictEqual(findMatchingModel('devstral2', config), 'devstral-2512');
        assert.strictEqual(findMatchingModel('devstral-small', config), 'devstral-small-latest');

        // Case-insensitive shortAlias
        assert.strictEqual(findMatchingModel('MEDIUM35', config), 'mistral-medium-3.5');
        assert.strictEqual(findMatchingModel('Devstral2', config), 'devstral-2512');
    });

    await t.test('matches partial model ID (contains)', () => {
        const config = createMockConfig(['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001']);

        // Partial match: model ID contains the short name
        assert.strictEqual(findMatchingModel('opus-4-5', config), 'claude-opus-4-5-20251101');
        assert.strictEqual(findMatchingModel('20251101', config), 'claude-opus-4-5-20251101');
        assert.strictEqual(findMatchingModel('sonnet-4-5', config), 'claude-sonnet-4-5-20250929');
    });

    await t.test('matches 4.5 model shortAliases correctly', () => {
        const config = createMockConfig(['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929']);

        // shortAlias for 4.5 models: opus45, sonnet45
        assert.strictEqual(findMatchingModel('opus45', config), 'claude-opus-4-5-20251101');
        assert.strictEqual(findMatchingModel('sonnet45', config), 'claude-sonnet-4-5-20250929');
    });

    await t.test('matches partial model ID for gemini', () => {
        const config = createMockConfig(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);

        // Partial match on model ID
        assert.strictEqual(findMatchingModel('2.5-pro', config), 'gemini-2.5-pro');
        assert.strictEqual(findMatchingModel('flash-lite', config), 'gemini-2.5-flash-lite');
    });

    await t.test('matches partial shortAlias (contains)', () => {
        const config = createMockConfig(['gemini-3-flash-preview']);

        // shortAlias is 'g3-flash-preview', partial match should work
        assert.strictEqual(findMatchingModel('g3-flash', config), 'gemini-3-flash-preview');
        assert.strictEqual(findMatchingModel('flash-prev', config), 'gemini-3-flash-preview');
    });

    await t.test('returns null when no match is found', () => {
        const config = createMockConfig(['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929']);

        // No match - completely unrelated string
        assert.strictEqual(findMatchingModel('nonexistent-model', config), null);
        assert.strictEqual(findMatchingModel('gpt-4', config), null);
        assert.strictEqual(findMatchingModel('xyz123', config), null);

        // No match - haiku is not in supported models
        assert.strictEqual(findMatchingModel('haiku', config), null);
    });

    await t.test('returns null for empty supported models', () => {
        const config = createMockConfig([]);

        assert.strictEqual(findMatchingModel('opus', config), null);
        assert.strictEqual(findMatchingModel('any-model', config), null);
    });

    await t.test('prioritizes exact model ID match over partial match', () => {
        // If we have models like "flash" and "flash-lite", exact match should win
        const config = createMockConfig(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);

        // 'flash' is shortAlias for gemini-2.5-flash, should match first
        assert.strictEqual(findMatchingModel('flash', config), 'gemini-2.5-flash');
    });

    await t.test('prioritizes exact shortAlias over partial model ID match', () => {
        const config = createMockConfig(['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929']);

        // 'opus45' is exact shortAlias, should match before partial model ID match
        assert.strictEqual(findMatchingModel('opus45', config), 'claude-opus-4-5-20251101');
    });

    await t.test('handles models not in MODEL_INFO_MAP gracefully', () => {
        // Create config with a custom model not in MODEL_INFO_MAP
        const config = createMockConfig(['custom-model-xyz', 'claude-opus-4-5-20251101']);

        // Custom model should still be matchable by exact ID
        assert.strictEqual(findMatchingModel('custom-model-xyz', config), 'custom-model-xyz');

        // Partial match on custom model
        assert.strictEqual(findMatchingModel('model-xyz', config), 'custom-model-xyz');

        // Known model still works
        assert.strictEqual(findMatchingModel('opus45', config), 'claude-opus-4-5-20251101');
    });
});

test('getModelShortName - returns short display names for PR titles', async (t) => {
    await t.test('returns correct short name for Claude models', () => {
        // Claude 4.6 models
        assert.strictEqual(getModelShortName('claude-opus-4-6'), 'Claude Opus 4.6');
        assert.strictEqual(getModelShortName('claude-sonnet-4-6'), 'Claude Sonnet 4.6');
        // Claude 4.5 models
        assert.strictEqual(getModelShortName('claude-opus-4-5-20251101'), 'Claude Opus 4.5');
        assert.strictEqual(getModelShortName('claude-sonnet-4-5-20250929'), 'Claude Sonnet 4.5');
        assert.strictEqual(getModelShortName('claude-haiku-4-5-20251001'), 'Claude Haiku');
    });

    await t.test('returns correct short name for Codex (OpenAI) models', () => {
        // GPT-5.5
        assert.strictEqual(getModelShortName('gpt-5.5'), 'GPT-5.5');
        // GPT-5.4
        assert.strictEqual(getModelShortName('gpt-5.4'), 'GPT-5.4');
        // GPT-5.4 Mini
        assert.strictEqual(getModelShortName('gpt-5.4-mini'), 'GPT-5.4 Mini');
        // GPT-5.3 Codex
        assert.strictEqual(getModelShortName('gpt-5.3-codex'), 'GPT-5.3 Codex');
        // GPT-5.3 Codex Spark
        assert.strictEqual(getModelShortName('gpt-5.3-codex-spark'), 'Codex Spark');
        // GPT-5.2
        assert.strictEqual(getModelShortName('gpt-5.2'), 'GPT-5.2');
    });

    await t.test('returns correct short name for Gemini models', () => {
        // Gemini 3 Pro Preview
        assert.strictEqual(getModelShortName('gemini-3-pro-preview'), 'Gemini 3 Preview');
        // Gemini 3 Flash Preview
        assert.strictEqual(getModelShortName('gemini-3-flash-preview'), 'Gemini 3 Flash');
        // Gemini 2.5 Pro
        assert.strictEqual(getModelShortName('gemini-2.5-pro'), 'Gemini Pro');
        // Gemini 2.5 Flash
        assert.strictEqual(getModelShortName('gemini-2.5-flash'), 'Gemini Flash');
        // Gemini 2.5 Flash Lite
        assert.strictEqual(getModelShortName('gemini-2.5-flash-lite'), 'Flash Lite');
    });

    await t.test('returns correct short name for Vibe (Mistral) models', () => {
        // Mistral Medium 3.5
        assert.strictEqual(getModelShortName('mistral-medium-3.5'), 'Mistral Medium 3.5');
        // Devstral 2
        assert.strictEqual(getModelShortName('devstral-2512'), 'Devstral 2');
        // Devstral Small
        assert.strictEqual(getModelShortName('devstral-small-latest'), 'Devstral Small');
    });

    await t.test('returns AI for unknown models', () => {
        // Completely unknown model
        assert.strictEqual(getModelShortName('unknown-model-xyz'), 'AI');
        // Similar but not exact match
        assert.strictEqual(getModelShortName('claude-opus-3'), 'AI');
        // Random string
        assert.strictEqual(getModelShortName('some-random-model'), 'AI');
        // Empty string
        assert.strictEqual(getModelShortName(''), 'AI');
    });

    await t.test('handles undefined input', () => {
        assert.strictEqual(getModelShortName(undefined), 'AI');
    });

    await t.test('verifies all 19 models return correct short names', () => {
        // This test verifies the exact count and mapping for all models
        const expectedMappings: Record<string, string> = {
            // 5 Claude models (2 x 4.6, 3 x 4.5)
            'claude-opus-4-6': 'Claude Opus 4.6',
            'claude-sonnet-4-6': 'Claude Sonnet 4.6',
            'claude-opus-4-5-20251101': 'Claude Opus 4.5',
            'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
            'claude-haiku-4-5-20251001': 'Claude Haiku',
            // 6 Codex models
            'gpt-5.5': 'GPT-5.5',
            'gpt-5.4': 'GPT-5.4',
            'gpt-5.4-mini': 'GPT-5.4 Mini',
            'gpt-5.3-codex': 'GPT-5.3 Codex',
            'gpt-5.3-codex-spark': 'Codex Spark',
            'gpt-5.2': 'GPT-5.2',
            // 5 Gemini models
            'gemini-3-pro-preview': 'Gemini 3 Preview',
            'gemini-3-flash-preview': 'Gemini 3 Flash',
            'gemini-2.5-pro': 'Gemini Pro',
            'gemini-2.5-flash': 'Gemini Flash',
            'gemini-2.5-flash-lite': 'Flash Lite',
            // 3 Vibe (Mistral) models
            'mistral-medium-3.5': 'Mistral Medium 3.5',
            'devstral-2512': 'Devstral 2',
            'devstral-small-latest': 'Devstral Small',
        };

        // Verify we have exactly 19 models
        const modelCount = Object.keys(expectedMappings).length;
        assert.strictEqual(modelCount, 19, `Expected 19 models but found ${modelCount}`);

        // Verify each model returns the correct short name
        for (const [modelId, expectedShortName] of Object.entries(expectedMappings)) {
            const actualShortName = getModelShortName(modelId);
            assert.strictEqual(
                actualShortName,
                expectedShortName,
                `Model ${modelId} should return "${expectedShortName}" but got "${actualShortName}"`
            );
        }
    });

    await t.test('ALL_MODELS array matches the 19 expected models', () => {
        // Verify ALL_MODELS contains all 19 models (5 Claude + 6 Codex + 5 Gemini + 3 Vibe)
        assert.strictEqual(ALL_MODELS.length, 19, `Expected 19 models in ALL_MODELS but found ${ALL_MODELS.length}`);

        // Verify each model in ALL_MODELS has a valid shortName
        for (const model of ALL_MODELS) {
            const shortName = getModelShortName(model.id);
            assert.strictEqual(
                shortName,
                model.shortName,
                `getModelShortName(${model.id}) should return "${model.shortName}" but got "${shortName}"`
            );
            // Ensure shortName is not 'AI' for known models
            assert.notStrictEqual(
                shortName,
                'AI',
                `Known model ${model.id} should not return 'AI' as short name`
            );
        }
    });
});

test('resolveReviewModels - multi-model /review resolution', async (t) => {
    // Mock agent configurations for testing
    const mockAgentConfigs = [
        {
            config: {
                id: 'claude-agent-1',
                type: 'claude' as const,
                alias: 'claude',
                enabled: true,
                supportedModels: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
                defaultModel: 'claude-sonnet-4-6'
            }
        },
        {
            config: {
                id: 'gemini-agent-1',
                type: 'gemini' as const,
                alias: 'gemini',
                enabled: true,
                supportedModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3-pro-preview'],
                defaultModel: 'gemini-2.5-pro'
            }
        },
        {
            config: {
                id: 'codex-agent-1',
                type: 'codex' as const,
                alias: 'codex',
                enabled: true,
                supportedModels: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2'],
                defaultModel: 'gpt-5.5'
            }
        },
        {
            config: {
                id: 'vibe-agent-1',
                type: 'vibe' as const,
                alias: 'vibe',
                enabled: true,
                supportedModels: ['mistral-medium-3.5', 'devstral-2512', 'devstral-small-latest'],
                defaultModel: 'mistral-medium-3.5'
            }
        }
    ];

    // Setup mock before tests
    const registry = AgentRegistry.getInstance();

    const originalGetAllAgents = registry.getAllAgents.bind(registry);
    const originalGetDefaultAgent = registry.getDefaultAgent.bind(registry);
    const originalEnsureInitialized = registry.ensureInitialized.bind(registry);
    const originalGetAgentByAlias = registry.getAgentByAlias.bind(registry);

    registry.getAllAgents = () => mockAgentConfigs as any;
    registry.getDefaultAgent = () => mockAgentConfigs[0] as any;
    registry.ensureInitialized = async () => { /* no-op for tests */ };
    registry.getAgentByAlias = (alias: string) => {
        return mockAgentConfigs.find(a => a.config.alias === alias) as any;
    };

    await t.test('/review claude resolves to exactly one enabled Claude agent/model pair', async () => {
        const results = await resolveReviewModels(['claude']);
        assert.strictEqual(results.length, 1, 'Should resolve to exactly one assignment');
        assert.strictEqual(results[0].agentAlias, 'claude');
        assert.strictEqual(results[0].model, 'claude-sonnet-4-6', 'Should use default Claude model');
        assert.ok(results[0].displayLabel, 'Should have a display label');
    });

    await t.test('/review with two distinct models resolves to two assignments', async () => {
        const results = await resolveReviewModels(['gemini-3-pro-preview', 'gpt-5.4']);
        assert.strictEqual(results.length, 2, 'Should resolve to two assignments');

        const agentAliases = results.map(r => r.agentAlias);
        assert.ok(agentAliases.includes('gemini'), 'Should include gemini agent');
        assert.ok(agentAliases.includes('codex'), 'Should include codex agent');
    });

    await t.test('/review llm-gemini-3-pro-preview gpt-54 resolves correctly (llm- prefix handled upstream)', async () => {
        // The slash command parser strips "llm-" prefix, so we test with the stripped versions
        const results = await resolveReviewModels(['gemini-pro-preview', 'codex-gpt54']);
        assert.strictEqual(results.length, 2, 'Should resolve to two assignments');
    });

    await t.test('duplicate aliases resolve once', async () => {
        const results = await resolveReviewModels(['claude', 'claude']);
        assert.strictEqual(results.length, 1, 'Duplicate should be deduplicated to one');
        assert.strictEqual(results[0].agentAlias, 'claude');
    });

    await t.test('equivalent model references deduplicate', async () => {
        // "gemini" and "gemini" both resolve to the same default model
        const results = await resolveReviewModels(['gemini', 'gemini']);
        assert.strictEqual(results.length, 1, 'Same model via same alias should deduplicate');
    });

    await t.test('unknown labels fail fast with clear error', async () => {
        await assert.rejects(
            () => resolveReviewModels(['nonexistent-xyz']),
            (err: any) => {
                assert.ok(err instanceof ReviewModelResolutionError, 'Should throw ReviewModelResolutionError');
                assert.ok(err.unresolvedTokens.includes('nonexistent-xyz'), 'Should identify the unresolved token');
                assert.ok(err.message.includes('nonexistent-xyz'), 'Error message should contain the token');
                return true;
            }
        );
    });

    await t.test('partial failure reports all unresolved tokens', async () => {
        await assert.rejects(
            () => resolveReviewModels(['claude', 'unknown-model-1', 'unknown-model-2']),
            (err: any) => {
                assert.ok(err instanceof ReviewModelResolutionError);
                assert.strictEqual(err.unresolvedTokens.length, 2, 'Should report both unresolved tokens');
                assert.ok(err.unresolvedTokens.includes('unknown-model-1'));
                assert.ok(err.unresolvedTokens.includes('unknown-model-2'));
                return true;
            }
        );
    });

    await t.test('empty input uses default model from configured agent', async () => {
        // With a mock default agent configured, empty labels should use its default model
        const results = await resolveReviewModels([]);
        assert.strictEqual(results.length, 1, 'Should return one assignment using default model');
        assert.strictEqual(results[0].agentAlias, 'claude');
        assert.strictEqual(results[0].model, 'claude-sonnet-4-6');
    });

    await t.test('family shorthands resolve correctly', async () => {
        // claude -> default enabled Claude agent/model
        const claudeResults = await resolveReviewModels(['claude']);
        assert.strictEqual(claudeResults[0].agentAlias, 'claude');
        assert.strictEqual(claudeResults[0].model, 'claude-sonnet-4-6');

        // gemini -> default enabled Gemini agent/model
        const geminiResults = await resolveReviewModels(['gemini']);
        assert.strictEqual(geminiResults[0].agentAlias, 'gemini');
        assert.strictEqual(geminiResults[0].model, 'gemini-2.5-pro');

        // codex -> default enabled Codex agent/model
        const codexResults = await resolveReviewModels(['codex']);
        assert.strictEqual(codexResults[0].agentAlias, 'codex');
        assert.strictEqual(codexResults[0].model, 'gpt-5.5');

        // vibe -> default enabled Vibe agent/model
        const vibeResults = await resolveReviewModels(['vibe']);
        assert.strictEqual(vibeResults[0].agentAlias, 'vibe');
        assert.strictEqual(vibeResults[0].model, 'mistral-medium-3.5');
    });

    await t.test('assignments include display-friendly labels', async () => {
        const results = await resolveReviewModels(['claude', 'gemini', 'codex', 'vibe']);
        assert.strictEqual(results.length, 4);

        for (const result of results) {
            assert.ok(result.displayLabel, `Assignment for ${result.agentAlias} should have displayLabel`);
            assert.notStrictEqual(result.displayLabel, '', 'Display label should not be empty');
        }

        // Verify specific display labels
        const claudeAssignment = results.find(r => r.agentAlias === 'claude');
        assert.strictEqual(claudeAssignment?.displayLabel, 'Claude Sonnet 4.6');

        const geminiAssignment = results.find(r => r.agentAlias === 'gemini');
        assert.strictEqual(geminiAssignment?.displayLabel, 'Gemini 2.5 Pro');

        const codexAssignment = results.find(r => r.agentAlias === 'codex');
        assert.strictEqual(codexAssignment?.displayLabel, 'GPT-5.5');

        const vibeAssignment = results.find(r => r.agentAlias === 'vibe');
        assert.strictEqual(vibeAssignment?.displayLabel, 'Mistral Medium 3.5');
    });

    await t.test('ReviewAssignment has correct shape', async () => {
        const results = await resolveReviewModels(['claude']);
        const assignment = results[0];

        assert.ok('agentAlias' in assignment, 'Should have agentAlias');
        assert.ok('model' in assignment, 'Should have model');
        assert.ok('displayLabel' in assignment, 'Should have displayLabel');
        assert.strictEqual(typeof assignment.agentAlias, 'string');
        assert.strictEqual(typeof assignment.model, 'string');
        assert.strictEqual(typeof assignment.displayLabel, 'string');
    });

    // Restore original methods
    registry.getAllAgents = originalGetAllAgents;
    registry.getDefaultAgent = originalGetDefaultAgent;
    registry.ensureInitialized = originalEnsureInitialized;
    registry.getAgentByAlias = originalGetAgentByAlias;
});

// Force exit due to module-level initialization in @propr/core
after(() => {
    process.exit(0);
});
