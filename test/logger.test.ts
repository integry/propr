import { test } from 'node:test';
import assert from 'node:assert';
import { logger } from '@gitfix/core';

test('Logger exports a pino instance', () => {
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
