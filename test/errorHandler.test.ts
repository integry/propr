import { test, after } from 'node:test';
import assert from 'node:assert';

// Set test environment before imports
process.env.NODE_ENV = 'test';

// Use dynamic import to avoid module initialization issues
let handleError: typeof import('@gitfix/core').handleError;
let withErrorHandling: typeof import('@gitfix/core').withErrorHandling;
let safeAsync: typeof import('@gitfix/core').safeAsync;

test('handleError logs errors without throwing', async () => {
    // Load modules dynamically
    const coreModule = await import('@gitfix/core');
    handleError = coreModule.handleError;
    withErrorHandling = coreModule.withErrorHandling;
    safeAsync = coreModule.safeAsync;

    const testError = new Error('Test error');
    assert.doesNotThrow(() => {
        handleError(testError, 'test context', {});
    });
});

test('withErrorHandling wraps async functions', async () => {
    const successFn = async (...args: unknown[]): Promise<unknown> => {
        const value = args[0] as number;
        return value * 2;
    };
    const wrapped = withErrorHandling(successFn, 'test');

    const result = await wrapped(5);
    assert.strictEqual(result, 10);
});

test('withErrorHandling handles errors', async () => {
    const errorFn = async (): Promise<unknown> => {
        throw new Error('Test error');
    };
    const wrapped = withErrorHandling(errorFn, 'test');

    await assert.rejects(wrapped(), /Test error/);
});

test('safeAsync returns default value on error', async () => {
    const errorFn = async (): Promise<string> => {
        throw new Error('Test error');
    };
    const safe = safeAsync(errorFn, 'default');

    const result = await safe();
    assert.strictEqual(result, 'default');
});

test('safeAsync returns result on success', async () => {
    const successFn = async (value: number): Promise<number> => value * 2;
    const safe = safeAsync(successFn, 0);

    const result = await safe(5);
    assert.strictEqual(result, 10);
});

// Cleanup after tests
after(async () => {
    try {
        const { closeConnection, shutdownQueue, hasQueueResources } = await import('@gitfix/core');
        await closeConnection();
        if (hasQueueResources()) {
            await shutdownQueue();
        }
    } catch {
        // Ignore cleanup errors
    }
    await new Promise(resolve => setTimeout(resolve, 50));
});
