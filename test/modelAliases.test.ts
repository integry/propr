import { test, after } from 'node:test';
import assert from 'node:assert';

// Set test environment before imports
process.env.NODE_ENV = 'test';

// Dynamic imports
let resolveModelAlias: typeof import('@gitfix/core').resolveModelAlias;
let getDefaultModel: typeof import('@gitfix/core').getDefaultModel;
let MODEL_ALIASES: typeof import('@gitfix/core').MODEL_ALIASES;
let DEFAULT_MODEL_ALIAS: typeof import('@gitfix/core').DEFAULT_MODEL_ALIAS;

test('Model Aliases Configuration', async (t) => {
    // Load modules dynamically
    const coreModule = await import('@gitfix/core');
    resolveModelAlias = coreModule.resolveModelAlias;
    getDefaultModel = coreModule.getDefaultModel;
    MODEL_ALIASES = coreModule.MODEL_ALIASES;
    DEFAULT_MODEL_ALIAS = coreModule.DEFAULT_MODEL_ALIAS;

    await t.test('should resolve known aliases to full model IDs', () => {
        // Updated to match current simplified model aliases
        assert.strictEqual(resolveModelAlias('opus'), 'claude-opus-4-5');
        assert.strictEqual(resolveModelAlias('sonnet'), 'claude-sonnet-4-5');
        assert.strictEqual(resolveModelAlias('haiku'), 'claude-haiku-4-5');
    });

    await t.test('should handle case-insensitive aliases', () => {
        assert.strictEqual(resolveModelAlias('OPUS'), 'claude-opus-4-5');
        assert.strictEqual(resolveModelAlias('Sonnet'), 'claude-sonnet-4-5');
        assert.strictEqual(resolveModelAlias('HAIKU'), 'claude-haiku-4-5');
    });

    await t.test('should return full model IDs as-is', () => {
        assert.strictEqual(resolveModelAlias('claude-3-5-sonnet-20241022'), 'claude-3-5-sonnet-20241022');
        assert.strictEqual(resolveModelAlias('custom-model-id'), 'custom-model-id');
    });

    await t.test('should use default model when no model specified', () => {
        const defaultModel = resolveModelAlias(null);
        assert.strictEqual(defaultModel, 'claude-sonnet-4-5');
        assert.strictEqual(defaultModel, MODEL_ALIASES[DEFAULT_MODEL_ALIAS]);
    });

    await t.test('getDefaultModel should return sonnet as default', () => {
        assert.strictEqual(getDefaultModel(), 'claude-sonnet-4-5');
        assert.strictEqual(DEFAULT_MODEL_ALIAS, 'sonnet');
    });

    await t.test('should handle extended aliases', () => {
        // Extended aliases for Claude 4.5 family
        assert.strictEqual(resolveModelAlias('opus4'), 'claude-opus-4-5');
        assert.strictEqual(resolveModelAlias('sonnet4'), 'claude-sonnet-4-5');
        assert.strictEqual(resolveModelAlias('haiku45'), 'claude-haiku-4-5');
        assert.strictEqual(resolveModelAlias('claude-opus'), 'claude-opus-4-5');
        assert.strictEqual(resolveModelAlias('claude-sonnet'), 'claude-sonnet-4-5');
        assert.strictEqual(resolveModelAlias('claude-haiku'), 'claude-haiku-4-5');
    });

    await t.test('should handle official Anthropic style aliases', () => {
        assert.strictEqual(resolveModelAlias('claude-opus-4-0'), 'claude-opus-4-5');
        assert.strictEqual(resolveModelAlias('claude-sonnet-4-0'), 'claude-sonnet-4-5');
        assert.strictEqual(resolveModelAlias('claude-haiku-4-0'), 'claude-haiku-4-5');
    });
});

// Cleanup after tests
after(async () => {
    try {
        const {
            closeConnection,
            hasDbResources,
            shutdownQueue,
            hasQueueResources,
            closeAnalysisRedis,
            hasAnalysisRedisResources,
            closeStateManager
        } = await import('@gitfix/core');

        if (hasDbResources()) {
            await closeConnection();
        }

        if (hasQueueResources()) {
            await shutdownQueue();
        }

        if (hasAnalysisRedisResources()) {
            await closeAnalysisRedis();
        }

        await closeStateManager();
    } catch {
        // Ignore cleanup errors
    }
    await new Promise(resolve => setTimeout(resolve, 50));
});
