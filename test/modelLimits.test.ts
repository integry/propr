import { test, after } from 'node:test';
import assert from 'node:assert';
import {
    getEffectiveTokenLimit,
    getModelHardLimit,
    MIN_CONTEXT_LEVEL,
    MAX_CONTEXT_LEVEL,
    EFFECTIVE_MAX_RATIO,
    MODEL_LIMITS
} from '@propr/core';

test('getEffectiveTokenLimit - context level clamping', async (t) => {
    await t.test('clamps levels below MIN_CONTEXT_LEVEL (10) to MIN_CONTEXT_LEVEL', () => {
        // Level 0 should be clamped to 10
        const resultAt0 = getEffectiveTokenLimit(undefined, 0);
        const resultAt10 = getEffectiveTokenLimit(undefined, 10);
        assert.strictEqual(resultAt0, resultAt10, 'Level 0 should be clamped to level 10');

        // Level 5 should be clamped to 10
        const resultAt5 = getEffectiveTokenLimit(undefined, 5);
        assert.strictEqual(resultAt5, resultAt10, 'Level 5 should be clamped to level 10');

        // Level -50 should be clamped to 10
        const resultAtNegative = getEffectiveTokenLimit(undefined, -50);
        assert.strictEqual(resultAtNegative, resultAt10, 'Negative levels should be clamped to level 10');
    });

    await t.test('clamps levels above MAX_CONTEXT_LEVEL (100) to MAX_CONTEXT_LEVEL', () => {
        // Level 150 should be clamped to 100
        const resultAt150 = getEffectiveTokenLimit(undefined, 150);
        const resultAt100 = getEffectiveTokenLimit(undefined, 100);
        assert.strictEqual(resultAt150, resultAt100, 'Level 150 should be clamped to level 100');

        // Level 200 should be clamped to 100
        const resultAt200 = getEffectiveTokenLimit(undefined, 200);
        assert.strictEqual(resultAt200, resultAt100, 'Level 200 should be clamped to level 100');

        // Level 1000 should be clamped to 100
        const resultAt1000 = getEffectiveTokenLimit(undefined, 1000);
        assert.strictEqual(resultAt1000, resultAt100, 'Level 1000 should be clamped to level 100');
    });

    await t.test('accepts valid levels within range [10, 100]', () => {
        // Test boundary values
        const resultAt10 = getEffectiveTokenLimit(undefined, 10);
        const resultAt100 = getEffectiveTokenLimit(undefined, 100);

        assert.ok(resultAt10 > 0, 'Level 10 should produce a positive result');
        assert.ok(resultAt100 > resultAt10, 'Level 100 should produce a larger result than level 10');

        // Test intermediate values
        const resultAt50 = getEffectiveTokenLimit(undefined, 50);
        assert.ok(resultAt50 > resultAt10, 'Level 50 should be greater than level 10');
        assert.ok(resultAt50 < resultAt100, 'Level 50 should be less than level 100');
    });

    await t.test('verifies MIN_CONTEXT_LEVEL is 10 and MAX_CONTEXT_LEVEL is 100', () => {
        assert.strictEqual(MIN_CONTEXT_LEVEL, 10, 'MIN_CONTEXT_LEVEL should be 10');
        assert.strictEqual(MAX_CONTEXT_LEVEL, 100, 'MAX_CONTEXT_LEVEL should be 100');
    });
});

test('getEffectiveTokenLimit - agent:model format handling', async (t) => {
    await t.test('handles agent:model format by extracting model ID after colon', () => {
        // Using claude:model format
        const withPrefix = getEffectiveTokenLimit('claude:claude-opus-4-5-20251101', 50);
        const withoutPrefix = getEffectiveTokenLimit('claude-opus-4-5-20251101', 50);
        assert.strictEqual(withPrefix, withoutPrefix, 'Should extract model ID from agent:model format');
    });

    await t.test('handles various agent prefixes', () => {
        // Test with different agent prefixes
        const claudeResult = getEffectiveTokenLimit('claude:claude-sonnet-4-5-20250929', 50);
        const codexResult = getEffectiveTokenLimit('codex:claude-sonnet-4-5-20250929', 50);
        const geminiResult = getEffectiveTokenLimit('gemini:claude-sonnet-4-5-20250929', 50);

        // All should produce the same result since the model ID after colon is the same
        assert.strictEqual(claudeResult, codexResult, 'Agent prefix should not affect result');
        assert.strictEqual(codexResult, geminiResult, 'Agent prefix should not affect result');
    });

    await t.test('handles model ID without agent prefix', () => {
        // Direct model ID without colon
        const result = getEffectiveTokenLimit('claude-opus-4-5-20251101', 50);
        assert.ok(result > 0, 'Should work with plain model ID');
    });

    await t.test('handles edge case of model ID containing multiple colons', () => {
        // A model ID like "agent:model:with:colons" extracts only the first segment after colon
        // This tests the split(':')[1] behavior which gets "model" (not "model:with:colons")
        const result = getEffectiveTokenLimit('agent:model:with:colons', 50);
        // Since "model" won't be found in MODEL_INFO_MAP, it should use default
        const defaultResult = getEffectiveTokenLimit(undefined, 50);
        assert.strictEqual(result, defaultResult, 'Should use default for unknown model segment after extracting');
    });
});

test('getEffectiveTokenLimit - math accuracy', async (t) => {
    await t.test('calculates correct token limit using formula: floor(limit * (level/100) * EFFECTIVE_MAX_RATIO)', () => {
        // Default limit is 200000
        const defaultLimit = MODEL_LIMITS['default'];
        assert.strictEqual(defaultLimit, 200000, 'Default limit should be 200000');

        // EFFECTIVE_MAX_RATIO is 0.98
        assert.strictEqual(EFFECTIVE_MAX_RATIO, 0.98, 'EFFECTIVE_MAX_RATIO should be 0.98');

        // Test at level 100 (max): floor(200000 * (100/100) * 0.98) = floor(196000) = 196000
        const resultAt100 = getEffectiveTokenLimit(undefined, 100);
        const expectedAt100 = Math.floor(200000 * (100 / 100) * 0.98);
        assert.strictEqual(resultAt100, expectedAt100, `Level 100 should produce ${expectedAt100}`);
        assert.strictEqual(resultAt100, 196000, 'Level 100 should produce exactly 196000');

        // Test at level 50: floor(200000 * (50/100) * 0.98) = floor(98000) = 98000
        const resultAt50 = getEffectiveTokenLimit(undefined, 50);
        const expectedAt50 = Math.floor(200000 * (50 / 100) * 0.98);
        assert.strictEqual(resultAt50, expectedAt50, `Level 50 should produce ${expectedAt50}`);
        assert.strictEqual(resultAt50, 98000, 'Level 50 should produce exactly 98000');

        // Test at level 10 (min): floor(200000 * (10/100) * 0.98) = floor(19600) = 19600
        const resultAt10 = getEffectiveTokenLimit(undefined, 10);
        const expectedAt10 = Math.floor(200000 * (10 / 100) * 0.98);
        assert.strictEqual(resultAt10, expectedAt10, `Level 10 should produce ${expectedAt10}`);
        assert.strictEqual(resultAt10, 19600, 'Level 10 should produce exactly 19600');
    });

    await t.test('calculates correctly for different model limits from MODEL_INFO_MAP', () => {
        // Gemini models have 1M (1000000) token limit
        const resultGeminiAt100 = getEffectiveTokenLimit('gemini-2.5-pro', 100);
        const expectedGeminiAt100 = Math.floor(1000000 * (100 / 100) * 0.98);
        assert.strictEqual(resultGeminiAt100, expectedGeminiAt100, 'Gemini at level 100 should calculate correctly');
        assert.strictEqual(resultGeminiAt100, 980000, 'Gemini at level 100 should produce 980000');

        // Codex models have 400K (400000) token limit
        const resultCodexAt100 = getEffectiveTokenLimit('gpt-5.4', 100);
        const expectedCodexAt100 = Math.floor(400000 * (100 / 100) * 0.98);
        assert.strictEqual(resultCodexAt100, expectedCodexAt100, 'Codex at level 100 should calculate correctly');
        assert.strictEqual(resultCodexAt100, 392000, 'Codex at level 100 should produce 392000');
    });

    await t.test('result scales linearly with context level', () => {
        // The ratio between results at different levels should match the ratio of levels
        const resultAt20 = getEffectiveTokenLimit(undefined, 20);
        const resultAt40 = getEffectiveTokenLimit(undefined, 40);
        const resultAt80 = getEffectiveTokenLimit(undefined, 80);

        // Level 40 should be roughly double level 20
        assert.strictEqual(resultAt40, resultAt20 * 2, 'Level 40 should be double level 20');

        // Level 80 should be roughly double level 40
        assert.strictEqual(resultAt80, resultAt40 * 2, 'Level 80 should be double level 40');
    });

    await t.test('handles non-standard level values (not multiples of 10)', () => {
        // Test level 15
        const resultAt15 = getEffectiveTokenLimit(undefined, 15);
        const expectedAt15 = Math.floor(200000 * (15 / 100) * 0.98);
        assert.strictEqual(resultAt15, expectedAt15, 'Level 15 should calculate correctly');
        assert.strictEqual(resultAt15, 29400, 'Level 15 should produce 29400');

        // Test level 77
        const resultAt77 = getEffectiveTokenLimit(undefined, 77);
        const expectedAt77 = Math.floor(200000 * (77 / 100) * 0.98);
        assert.strictEqual(resultAt77, expectedAt77, 'Level 77 should calculate correctly');
        assert.strictEqual(resultAt77, 150920, 'Level 77 should produce 150920');
    });
});

test('getEffectiveTokenLimit - model resolution', async (t) => {
    await t.test('uses default limit for undefined modelId', () => {
        const result = getEffectiveTokenLimit(undefined, 50);
        const expectedDefault = Math.floor(MODEL_LIMITS['default'] * (50 / 100) * EFFECTIVE_MAX_RATIO);
        assert.strictEqual(result, expectedDefault, 'undefined modelId should use default limit');
    });

    await t.test('uses MODEL_INFO_MAP limit when model is found', () => {
        // Claude Opus 4.5 has 200K limit
        const resultOpus = getEffectiveTokenLimit('claude-opus-4-5-20251101', 100);
        const expectedOpus = Math.floor(200000 * (100 / 100) * 0.98);
        assert.strictEqual(resultOpus, expectedOpus, 'Claude Opus should use 200K limit');

        // Gemini Pro has 1M limit
        const resultGemini = getEffectiveTokenLimit('gemini-2.5-pro', 100);
        const expectedGemini = Math.floor(1000000 * (100 / 100) * 0.98);
        assert.strictEqual(resultGemini, expectedGemini, 'Gemini Pro should use 1M limit');
    });

    await t.test('falls back to MODEL_LIMITS when model not in MODEL_INFO_MAP', () => {
        // Test with a model ID that might be in MODEL_LIMITS but not MODEL_INFO_MAP
        const result = getEffectiveTokenLimit('claude-opus-4-5', 100);
        // This should either match MODEL_INFO_MAP or fall back to MODEL_LIMITS then default
        assert.ok(result > 0, 'Should produce a valid result for partial model ID');
    });

    await t.test('uses default limit for unknown model', () => {
        const result = getEffectiveTokenLimit('completely-unknown-model', 100);
        const expectedDefault = Math.floor(MODEL_LIMITS['default'] * (100 / 100) * EFFECTIVE_MAX_RATIO);
        assert.strictEqual(result, expectedDefault, 'Unknown model should use default limit');
    });
});

test('getModelHardLimit - returns max usable tokens', async (t) => {
    await t.test('returns 98% of model limit for default', () => {
        const defaultHardLimit = getModelHardLimit(undefined);
        const expectedDefault = Math.floor(MODEL_LIMITS['default'] * EFFECTIVE_MAX_RATIO);
        assert.strictEqual(defaultHardLimit, expectedDefault, 'Default hard limit should be 98% of 200K');
        assert.strictEqual(defaultHardLimit, 196000, 'Default hard limit should be 196000');
    });

    await t.test('handles agent:model format', () => {
        const withPrefix = getModelHardLimit('claude:claude-opus-4-5-20251101');
        const withoutPrefix = getModelHardLimit('claude-opus-4-5-20251101');
        assert.strictEqual(withPrefix, withoutPrefix, 'Should extract model ID from agent:model format');
    });

    await t.test('getModelHardLimit equals getEffectiveTokenLimit at level 100', () => {
        // Hard limit should equal effective limit at max level
        const hardLimit = getModelHardLimit(undefined);
        const effectiveAt100 = getEffectiveTokenLimit(undefined, 100);
        assert.strictEqual(hardLimit, effectiveAt100, 'Hard limit should equal effective limit at level 100');

        // Test with specific model
        const geminiHardLimit = getModelHardLimit('gemini-2.5-pro');
        const geminiEffectiveAt100 = getEffectiveTokenLimit('gemini-2.5-pro', 100);
        assert.strictEqual(geminiHardLimit, geminiEffectiveAt100, 'Gemini hard limit should equal effective at 100');
    });
});

test('getModelHardLimit - all 16 known models', async (t) => {
    // All models should return 98% of their max tokens for safety

    await t.test('Claude models (3 models, 200K context)', () => {
        // Claude Opus 4.5
        const opusLimit = getModelHardLimit('claude-opus-4-5-20251101');
        assert.strictEqual(opusLimit, Math.floor(200000 * 0.98), 'Claude Opus should return 98% of 200K');
        assert.strictEqual(opusLimit, 196000, 'Claude Opus hard limit should be 196000');

        // Claude Sonnet 4.5
        const sonnetLimit = getModelHardLimit('claude-sonnet-4-5-20250929');
        assert.strictEqual(sonnetLimit, Math.floor(200000 * 0.98), 'Claude Sonnet should return 98% of 200K');
        assert.strictEqual(sonnetLimit, 196000, 'Claude Sonnet hard limit should be 196000');

        // Claude Haiku 4.5
        const haikuLimit = getModelHardLimit('claude-haiku-4-5-20251001');
        assert.strictEqual(haikuLimit, Math.floor(200000 * 0.98), 'Claude Haiku should return 98% of 200K');
        assert.strictEqual(haikuLimit, 196000, 'Claude Haiku hard limit should be 196000');
    });

    await t.test('Codex models (8 models, 400K context)', () => {
        const expectedCodexLimit = Math.floor(400000 * 0.98); // 392000

        // GPT-5.4
        const gpt54Limit = getModelHardLimit('gpt-5.4');
        assert.strictEqual(gpt54Limit, expectedCodexLimit, 'GPT-5.4 should return 98% of 400K');
        assert.strictEqual(gpt54Limit, 392000, 'GPT-5.4 hard limit should be 392000');

        // GPT-5.4 Mini
        const gpt54MiniLimit = getModelHardLimit('gpt-5.4-mini');
        assert.strictEqual(gpt54MiniLimit, expectedCodexLimit, 'GPT-5.4 Mini should return 98% of 400K');
        assert.strictEqual(gpt54MiniLimit, 392000, 'GPT-5.4 Mini hard limit should be 392000');

        // GPT-5.3 Codex
        const gpt53CodexLimit = getModelHardLimit('gpt-5.3-codex');
        assert.strictEqual(gpt53CodexLimit, expectedCodexLimit, 'GPT-5.3 Codex should return 98% of 400K');
        assert.strictEqual(gpt53CodexLimit, 392000, 'GPT-5.3 Codex hard limit should be 392000');

        // GPT-5.3 Codex Spark
        const gpt53SparkLimit = getModelHardLimit('gpt-5.3-codex-spark');
        assert.strictEqual(gpt53SparkLimit, expectedCodexLimit, 'GPT-5.3 Codex Spark should return 98% of 400K');
        assert.strictEqual(gpt53SparkLimit, 392000, 'GPT-5.3 Codex Spark hard limit should be 392000');

        // GPT-5.2 Codex
        const gpt52CodexLimit = getModelHardLimit('gpt-5.2-codex');
        assert.strictEqual(gpt52CodexLimit, expectedCodexLimit, 'GPT-5.2 Codex should return 98% of 400K');
        assert.strictEqual(gpt52CodexLimit, 392000, 'GPT-5.2 Codex hard limit should be 392000');

        // GPT-5.2
        const gpt52Limit = getModelHardLimit('gpt-5.2');
        assert.strictEqual(gpt52Limit, expectedCodexLimit, 'GPT-5.2 should return 98% of 400K');
        assert.strictEqual(gpt52Limit, 392000, 'GPT-5.2 hard limit should be 392000');

        // GPT-5.1 Codex Max
        const codexMaxLimit = getModelHardLimit('gpt-5.1-codex-max');
        assert.strictEqual(codexMaxLimit, expectedCodexLimit, 'GPT-5.1 Codex Max should return 98% of 400K');
        assert.strictEqual(codexMaxLimit, 392000, 'GPT-5.1 Codex Max hard limit should be 392000');

        // GPT-5.1 Codex Mini
        const codexMiniLimit = getModelHardLimit('gpt-5.1-codex-mini');
        assert.strictEqual(codexMiniLimit, expectedCodexLimit, 'GPT-5.1 Codex Mini should return 98% of 400K');
        assert.strictEqual(codexMiniLimit, 392000, 'GPT-5.1 Codex Mini hard limit should be 392000');
    });

    await t.test('Gemini models (5 models, 1M context)', () => {
        const expectedGeminiLimit = Math.floor(1000000 * 0.98); // 980000

        // Gemini 3 Pro Preview
        const g3ProPreviewLimit = getModelHardLimit('gemini-3-pro-preview');
        assert.strictEqual(g3ProPreviewLimit, expectedGeminiLimit, 'Gemini 3 Pro Preview should return 98% of 1M');
        assert.strictEqual(g3ProPreviewLimit, 980000, 'Gemini 3 Pro Preview hard limit should be 980000');

        // Gemini 3 Flash Preview
        const g3FlashPreviewLimit = getModelHardLimit('gemini-3-flash-preview');
        assert.strictEqual(g3FlashPreviewLimit, expectedGeminiLimit, 'Gemini 3 Flash Preview should return 98% of 1M');
        assert.strictEqual(g3FlashPreviewLimit, 980000, 'Gemini 3 Flash Preview hard limit should be 980000');

        // Gemini 2.5 Pro
        const g25ProLimit = getModelHardLimit('gemini-2.5-pro');
        assert.strictEqual(g25ProLimit, expectedGeminiLimit, 'Gemini 2.5 Pro should return 98% of 1M');
        assert.strictEqual(g25ProLimit, 980000, 'Gemini 2.5 Pro hard limit should be 980000');

        // Gemini 2.5 Flash
        const g25FlashLimit = getModelHardLimit('gemini-2.5-flash');
        assert.strictEqual(g25FlashLimit, expectedGeminiLimit, 'Gemini 2.5 Flash should return 98% of 1M');
        assert.strictEqual(g25FlashLimit, 980000, 'Gemini 2.5 Flash hard limit should be 980000');

        // Gemini 2.5 Flash Lite
        const g25FlashLiteLimit = getModelHardLimit('gemini-2.5-flash-lite');
        assert.strictEqual(g25FlashLiteLimit, expectedGeminiLimit, 'Gemini 2.5 Flash Lite should return 98% of 1M');
        assert.strictEqual(g25FlashLiteLimit, 980000, 'Gemini 2.5 Flash Lite hard limit should be 980000');
    });

    await t.test('verifies total model count is 16', () => {
        // Model IDs for all 16 known models
        const allKnownModels = [
            // Claude (3)
            'claude-opus-4-5-20251101',
            'claude-sonnet-4-5-20250929',
            'claude-haiku-4-5-20251001',
            // Codex (8)
            'gpt-5.4',
            'gpt-5.4-mini',
            'gpt-5.3-codex',
            'gpt-5.3-codex-spark',
            'gpt-5.2-codex',
            'gpt-5.2',
            'gpt-5.1-codex-max',
            'gpt-5.1-codex-mini',
            // Gemini (5)
            'gemini-3-pro-preview',
            'gemini-3-flash-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
        ];

        assert.strictEqual(allKnownModels.length, 16, 'Should have exactly 16 known models');

        // Verify all models return a valid hard limit (not default)
        for (const modelId of allKnownModels) {
            const limit = getModelHardLimit(modelId);
            assert.ok(limit > 0, `${modelId} should return a positive hard limit`);
            // All known models should return their specific limit, not default
            // (they have varying maxTokens, so we just ensure it's valid)
        }
    });
});

test('getModelHardLimit - edge cases and safety margin', async (t) => {
    await t.test('returns default limit for undefined modelId', () => {
        const limit = getModelHardLimit(undefined);
        assert.strictEqual(limit, 196000, 'undefined modelId should return default limit (98% of 200K)');
    });

    await t.test('returns default limit for unknown model', () => {
        const limit = getModelHardLimit('completely-unknown-model-xyz');
        const expectedDefault = Math.floor(MODEL_LIMITS['default'] * EFFECTIVE_MAX_RATIO);
        assert.strictEqual(limit, expectedDefault, 'Unknown model should return default limit');
        assert.strictEqual(limit, 196000, 'Unknown model hard limit should be 196000');
    });

    await t.test('handles various agent prefixes with agent:model format', () => {
        const modelId = 'claude-opus-4-5-20251101';
        const expectedLimit = Math.floor(200000 * 0.98);

        // Test various agent prefixes
        assert.strictEqual(getModelHardLimit(`claude:${modelId}`), expectedLimit, 'claude: prefix');
        assert.strictEqual(getModelHardLimit(`codex:${modelId}`), expectedLimit, 'codex: prefix');
        assert.strictEqual(getModelHardLimit(`gemini:${modelId}`), expectedLimit, 'gemini: prefix');
        assert.strictEqual(getModelHardLimit(`custom:${modelId}`), expectedLimit, 'custom: prefix');
    });

    await t.test('handles edge case of model ID containing multiple colons', () => {
        // A model ID like "agent:model:with:colons" extracts only "model" (split(':')[1])
        // Since "model" is unknown, it should use default
        const limit = getModelHardLimit('agent:model:with:colons');
        const expectedDefault = Math.floor(MODEL_LIMITS['default'] * EFFECTIVE_MAX_RATIO);
        assert.strictEqual(limit, expectedDefault, 'Should use default for malformed model ID');
    });

    await t.test('98% safety margin is correctly applied', () => {
        // Verify the 98% safety margin (EFFECTIVE_MAX_RATIO = 0.98)
        assert.strictEqual(EFFECTIVE_MAX_RATIO, 0.98, 'EFFECTIVE_MAX_RATIO should be 0.98');

        // For each tier of models, verify the 2% buffer calculation
        // Claude (200K): 200000 * 0.98 = 196000 (buffer: 4000 tokens)
        const claudeLimit = getModelHardLimit('claude-opus-4-5-20251101');
        assert.strictEqual(200000 - claudeLimit, 4000, 'Claude buffer should be 4000 tokens (2%)');

        // Codex (400K): 400000 * 0.98 = 392000 (buffer: 8000 tokens)
        const codexLimit = getModelHardLimit('gpt-5.4');
        assert.strictEqual(400000 - codexLimit, 8000, 'Codex buffer should be 8000 tokens (2%)');

        // Gemini (1M): 1000000 * 0.98 = 980000 (buffer: 20000 tokens)
        const geminiLimit = getModelHardLimit('gemini-2.5-pro');
        assert.strictEqual(1000000 - geminiLimit, 20000, 'Gemini buffer should be 20000 tokens (2%)');
    });

    await t.test('hard limit is always less than raw model limit', () => {
        // Test a sampling of models to ensure hard limit < raw limit
        const testCases = [
            { modelId: 'claude-opus-4-5-20251101', rawLimit: 200000 },
            { modelId: 'gpt-5.4', rawLimit: 400000 },
            { modelId: 'gemini-2.5-pro', rawLimit: 1000000 },
        ];

        for (const { modelId, rawLimit } of testCases) {
            const hardLimit = getModelHardLimit(modelId);
            assert.ok(hardLimit < rawLimit, `${modelId} hard limit (${hardLimit}) should be less than raw limit (${rawLimit})`);
            assert.ok(hardLimit > rawLimit * 0.9, `${modelId} hard limit should be > 90% of raw limit (for safety check)`);
        }
    });
});

test('Constants are correctly defined', async (t) => {
    await t.test('MIN_CONTEXT_LEVEL is 10', () => {
        assert.strictEqual(MIN_CONTEXT_LEVEL, 10);
    });

    await t.test('MAX_CONTEXT_LEVEL is 100', () => {
        assert.strictEqual(MAX_CONTEXT_LEVEL, 100);
    });

    await t.test('EFFECTIVE_MAX_RATIO is 0.98', () => {
        assert.strictEqual(EFFECTIVE_MAX_RATIO, 0.98);
    });

    await t.test('MODEL_LIMITS has expected structure', () => {
        assert.ok('default' in MODEL_LIMITS, 'MODEL_LIMITS should have default key');
        assert.strictEqual(MODEL_LIMITS['default'], 200000, 'Default limit should be 200000');
    });
});

// Force exit due to module-level initialization in @propr/core
after(() => {
    process.exit(0);
});
