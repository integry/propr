import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { calculateDelay } from '../packages/core/src/utils/retryHandler.js';
import type { RetryConfig } from '../packages/core/src/utils/retryHandler.js';

/**
 * Unit tests for calculateDelay function
 *
 * The calculateDelay function implements exponential backoff with optional jitter:
 * - Base formula: baseDelay * exponentialBase^attempt
 * - Caps at maxDelay
 * - Optional jitter: ±25% of the calculated delay
 * - Returns non-negative values
 */
describe('calculateDelay', () => {
    const baseConfig: RetryConfig = {
        maxAttempts: 3,
        baseDelay: 1000,
        maxDelay: 30000,
        exponentialBase: 2,
        jitter: false,
        retryableErrors: []
    };

    describe('exponential backoff calculation', () => {
        test('calculates correct delay for attempt 0', () => {
            const delay = calculateDelay(0, baseConfig);
            // 1000 * 2^0 = 1000
            assert.strictEqual(delay, 1000);
        });

        test('calculates correct delay for attempt 1', () => {
            const delay = calculateDelay(1, baseConfig);
            // 1000 * 2^1 = 2000
            assert.strictEqual(delay, 2000);
        });

        test('calculates correct delay for attempt 2', () => {
            const delay = calculateDelay(2, baseConfig);
            // 1000 * 2^2 = 4000
            assert.strictEqual(delay, 4000);
        });

        test('calculates correct delay for attempt 3', () => {
            const delay = calculateDelay(3, baseConfig);
            // 1000 * 2^3 = 8000
            assert.strictEqual(delay, 8000);
        });

        test('calculates correct delay with different base delay', () => {
            const config: RetryConfig = { ...baseConfig, baseDelay: 500 };
            const delay = calculateDelay(2, config);
            // 500 * 2^2 = 2000
            assert.strictEqual(delay, 2000);
        });

        test('calculates correct delay with different exponential base', () => {
            const config: RetryConfig = { ...baseConfig, exponentialBase: 3 };
            const delay = calculateDelay(2, config);
            // 1000 * 3^2 = 9000
            assert.strictEqual(delay, 9000);
        });

        test('handles exponential base of 1 (linear backoff)', () => {
            const config: RetryConfig = { ...baseConfig, exponentialBase: 1 };
            const delay0 = calculateDelay(0, config);
            const delay1 = calculateDelay(1, config);
            const delay2 = calculateDelay(2, config);
            // 1000 * 1^n = 1000 for all attempts
            assert.strictEqual(delay0, 1000);
            assert.strictEqual(delay1, 1000);
            assert.strictEqual(delay2, 1000);
        });
    });

    describe('maxDelay capping', () => {
        test('caps delay at maxDelay when exponential delay exceeds it', () => {
            const config: RetryConfig = { ...baseConfig, maxDelay: 5000 };
            // 1000 * 2^3 = 8000, should be capped at 5000
            const delay = calculateDelay(3, config);
            assert.strictEqual(delay, 5000);
        });

        test('does not cap delay when below maxDelay', () => {
            const config: RetryConfig = { ...baseConfig, maxDelay: 10000 };
            // 1000 * 2^2 = 4000, below maxDelay
            const delay = calculateDelay(2, config);
            assert.strictEqual(delay, 4000);
        });

        test('returns maxDelay for very high attempt numbers', () => {
            const config: RetryConfig = { ...baseConfig, maxDelay: 30000 };
            // 1000 * 2^10 = 1024000, should be capped at 30000
            const delay = calculateDelay(10, config);
            assert.strictEqual(delay, 30000);
        });

        test('caps at maxDelay when delay equals maxDelay exactly', () => {
            const config: RetryConfig = { ...baseConfig, baseDelay: 1000, maxDelay: 4000, exponentialBase: 2 };
            // 1000 * 2^2 = 4000 = maxDelay
            const delay = calculateDelay(2, config);
            assert.strictEqual(delay, 4000);
        });
    });

    describe('jitter application', () => {
        test('applies jitter when enabled', () => {
            const config: RetryConfig = { ...baseConfig, jitter: true };
            const delays: number[] = [];

            // Run multiple times to verify randomness
            for (let i = 0; i < 100; i++) {
                delays.push(calculateDelay(1, config));
            }

            // Base delay for attempt 1: 1000 * 2^1 = 2000
            // Jitter is ±25%, so delay should be between 1500 and 2500
            const minExpected = 2000 - (2000 * 0.25);
            const maxExpected = 2000 + (2000 * 0.25);

            // All delays should be within the jitter range
            for (const delay of delays) {
                assert.ok(delay >= minExpected, `Delay ${delay} should be >= ${minExpected}`);
                assert.ok(delay <= maxExpected, `Delay ${delay} should be <= ${maxExpected}`);
            }

            // Verify there's variation (jitter is actually applied)
            const uniqueDelays = new Set(delays);
            assert.ok(uniqueDelays.size > 1, 'Jitter should produce variation in delays');
        });

        test('does not apply jitter when disabled', () => {
            const config: RetryConfig = { ...baseConfig, jitter: false };
            const delays: number[] = [];

            for (let i = 0; i < 10; i++) {
                delays.push(calculateDelay(1, config));
            }

            // All delays should be exactly the same
            const uniqueDelays = new Set(delays);
            assert.strictEqual(uniqueDelays.size, 1, 'Without jitter, all delays should be identical');
            assert.strictEqual(delays[0], 2000);
        });

        test('jitter respects maxDelay capping', () => {
            const config: RetryConfig = { ...baseConfig, maxDelay: 5000, jitter: true };
            const delays: number[] = [];

            // Attempt 3: 1000 * 2^3 = 8000, capped to 5000
            // With jitter: 5000 ±25% = [3750, 6250]
            for (let i = 0; i < 100; i++) {
                delays.push(calculateDelay(3, config));
            }

            const minExpected = 5000 - (5000 * 0.25);
            const maxExpected = 5000 + (5000 * 0.25);

            for (const delay of delays) {
                assert.ok(delay >= minExpected, `Delay ${delay} should be >= ${minExpected}`);
                assert.ok(delay <= maxExpected, `Delay ${delay} should be <= ${maxExpected}`);
            }
        });
    });

    describe('non-negative output guarantee', () => {
        test('never returns negative delay', () => {
            const config: RetryConfig = { ...baseConfig, jitter: true };

            for (let i = 0; i < 100; i++) {
                const delay = calculateDelay(0, config);
                assert.ok(delay >= 0, `Delay should never be negative, got ${delay}`);
            }
        });

        test('returns non-negative for very small base delay with jitter', () => {
            const config: RetryConfig = { ...baseConfig, baseDelay: 10, jitter: true };

            for (let i = 0; i < 100; i++) {
                const delay = calculateDelay(0, config);
                assert.ok(delay >= 0, `Delay should never be negative, got ${delay}`);
            }
        });

        test('handles zero base delay', () => {
            const config: RetryConfig = { ...baseConfig, baseDelay: 0, jitter: false };
            const delay = calculateDelay(5, config);
            assert.strictEqual(delay, 0);
        });

        test('handles zero base delay with jitter', () => {
            const config: RetryConfig = { ...baseConfig, baseDelay: 0, jitter: true };
            const delay = calculateDelay(5, config);
            // 0 * 2^5 = 0, jitter on 0 is still 0
            assert.strictEqual(delay, 0);
        });
    });

    describe('edge cases', () => {
        test('handles attempt 0 correctly', () => {
            const delay = calculateDelay(0, baseConfig);
            // 1000 * 2^0 = 1000
            assert.strictEqual(delay, 1000);
        });

        test('handles large attempt numbers without overflow', () => {
            const config: RetryConfig = { ...baseConfig, maxDelay: 60000 };
            const delay = calculateDelay(50, config);
            // Should be capped at maxDelay regardless of attempt number
            assert.strictEqual(delay, 60000);
        });

        test('handles very large maxDelay', () => {
            const config: RetryConfig = { ...baseConfig, maxDelay: Number.MAX_SAFE_INTEGER };
            const delay = calculateDelay(10, config);
            // 1000 * 2^10 = 1024000
            assert.strictEqual(delay, 1024000);
        });

        test('handles fractional exponential base', () => {
            const config: RetryConfig = { ...baseConfig, exponentialBase: 1.5 };
            const delay = calculateDelay(2, config);
            // 1000 * 1.5^2 = 2250
            assert.strictEqual(delay, 2250);
        });

        test('handles small fractional exponential base', () => {
            const config: RetryConfig = { ...baseConfig, exponentialBase: 0.5 };
            const delay0 = calculateDelay(0, config);
            const delay1 = calculateDelay(1, config);
            const delay2 = calculateDelay(2, config);
            // 1000 * 0.5^0 = 1000
            // 1000 * 0.5^1 = 500
            // 1000 * 0.5^2 = 250
            assert.strictEqual(delay0, 1000);
            assert.strictEqual(delay1, 500);
            assert.strictEqual(delay2, 250);
        });
    });

    describe('predefined configurations', () => {
        test('works with github API config values', () => {
            const config: RetryConfig = {
                maxAttempts: 3,
                baseDelay: 2000,
                maxDelay: 30000,
                exponentialBase: 2,
                jitter: false,
                retryableErrors: []
            };

            const delay0 = calculateDelay(0, config);
            const delay1 = calculateDelay(1, config);
            const delay2 = calculateDelay(2, config);

            assert.strictEqual(delay0, 2000);  // 2000 * 2^0
            assert.strictEqual(delay1, 4000);  // 2000 * 2^1
            assert.strictEqual(delay2, 8000);  // 2000 * 2^2
        });

        test('works with redis config values', () => {
            const config: RetryConfig = {
                maxAttempts: 5,
                baseDelay: 500,
                maxDelay: 5000,
                exponentialBase: 2,
                jitter: false,
                retryableErrors: []
            };

            const delay0 = calculateDelay(0, config);
            const delay1 = calculateDelay(1, config);
            const delay2 = calculateDelay(2, config);
            const delay3 = calculateDelay(3, config);
            const delay4 = calculateDelay(4, config);

            assert.strictEqual(delay0, 500);   // 500 * 2^0
            assert.strictEqual(delay1, 1000);  // 500 * 2^1
            assert.strictEqual(delay2, 2000);  // 500 * 2^2
            assert.strictEqual(delay3, 4000);  // 500 * 2^3
            assert.strictEqual(delay4, 5000);  // 500 * 2^4 = 8000, capped at 5000
        });
    });
});

// Force exit due to module-level initialization in @propr/core
after(() => {
    process.exit(0);
});
