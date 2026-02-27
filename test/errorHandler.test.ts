import { test, after } from 'node:test';
import assert from 'node:assert';
import { handleError, withErrorHandling, safeAsync } from '@propr/core';

test('handleError logs errors without throwing', () => {
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

// Force exit due to module-level initialization in @propr/core
after(() => {
    process.exit(0);
});
