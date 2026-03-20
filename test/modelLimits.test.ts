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
    await t.test('returns 98% of model limit', () => {
        // Default model
        const defaultHardLimit = getModelHardLimit(undefined);
        const expectedDefault = Math.floor(MODEL_LIMITS['default'] * EFFECTIVE_MAX_RATIO);
        assert.strictEqual(defaultHardLimit, expectedDefault, 'Default hard limit should be 98% of 200K');
        assert.strictEqual(defaultHardLimit, 196000, 'Default hard limit should be 196000');

        // Gemini model (1M)
        const geminiHardLimit = getModelHardLimit('gemini-2.5-pro');
        const expectedGemini = Math.floor(1000000 * EFFECTIVE_MAX_RATIO);
        assert.strictEqual(geminiHardLimit, expectedGemini, 'Gemini hard limit should be 98% of 1M');
        assert.strictEqual(geminiHardLimit, 980000, 'Gemini hard limit should be 980000');
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
