import { test, after } from 'node:test';
import assert from 'node:assert';

// Set test environment before imports
process.env.NODE_ENV = 'test';

// Dynamic import
let logger: typeof import('@gitfix/core').logger;

test('Logger exports a pino instance', async () => {
    // Load logger dynamically
    const coreModule = await import('@gitfix/core');
    logger = coreModule.logger;

    assert.ok(logger);
    assert.strictEqual(typeof logger.info, 'function');
    assert.strictEqual(typeof logger.error, 'function');
    assert.strictEqual(typeof logger.debug, 'function');
    assert.strictEqual(typeof logger.warn, 'function');
});

test('Logger can log messages without errors', () => {
    assert.doesNotThrow(() => {
        logger.info('Test info message');
        logger.error('Test error message');
        logger.debug('Test debug message');
        logger.warn('Test warning message');
    });
});

test('Logger can log objects', () => {
    assert.doesNotThrow(() => {
        logger.info({ data: 'test' }, 'Test message with object');
        logger.error({ error: new Error('Test error') }, 'Error with context');
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
            closeStateManager,
            hasStateManagerResources
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

        if (hasStateManagerResources()) {
            await closeStateManager();
        }
    } catch {
        // Ignore cleanup errors
    }
    await new Promise(resolve => setTimeout(resolve, 50));
});
