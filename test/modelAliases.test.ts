import { test, after } from 'node:test';
import assert from 'node:assert';
import { resolveModelAlias, getDefaultModel, MODEL_ALIASES, DEFAULT_MODEL_ALIAS } from '@gitfix/core';

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

// Force exit due to module-level initialization in @gitfix/core
after(() => {
    process.exit(0);
});
