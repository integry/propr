import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { calculateDelay, isRetryableError } from '../packages/core/src/utils/retryHandler.js';
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

/**
 * Unit tests for isRetryableError function
 *
 * The isRetryableError function determines if an error should trigger a retry:
 * - Checks if error.code is in the retryableErrors list
 * - Checks if error.status is a retryable HTTP status (429, 500, 502, 503, 504)
 * - Checks error message/toString against retryable patterns
 */
describe('isRetryableError', () => {
    const baseConfig: RetryConfig = {
        maxAttempts: 3,
        baseDelay: 1000,
        maxDelay: 30000,
        exponentialBase: 2,
        jitter: false,
        retryableErrors: [
            'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
            'NETWORK_ERROR', 'API_RATE_LIMIT', 'TEMPORARY_FAILURE'
        ]
    };

    describe('error code matching', () => {
        test('returns true for ECONNRESET error code', () => {
            const error = { code: 'ECONNRESET', message: 'Connection reset' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for ECONNREFUSED error code', () => {
            const error = { code: 'ECONNREFUSED', message: 'Connection refused' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for ETIMEDOUT error code', () => {
            const error = { code: 'ETIMEDOUT', message: 'Connection timed out' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for ENOTFOUND error code', () => {
            const error = { code: 'ENOTFOUND', message: 'DNS lookup failed' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for NETWORK_ERROR error code', () => {
            const error = { code: 'NETWORK_ERROR', message: 'Network error' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for API_RATE_LIMIT error code', () => {
            const error = { code: 'API_RATE_LIMIT', message: 'Rate limited' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for TEMPORARY_FAILURE error code', () => {
            const error = { code: 'TEMPORARY_FAILURE', message: 'Temporary failure' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns false for error code not in retryableErrors list', () => {
            const error = { code: 'ENOENT', message: 'File not found' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('returns false for EPERM error code', () => {
            const error = { code: 'EPERM', message: 'Permission denied' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('respects custom retryableErrors configuration', () => {
            const customConfig: RetryConfig = {
                ...baseConfig,
                retryableErrors: ['CUSTOM_ERROR']
            };
            const error = { code: 'CUSTOM_ERROR', message: 'Custom error' };
            assert.strictEqual(isRetryableError(error, customConfig), true);
        });

        test('returns false when error code is not in custom retryableErrors', () => {
            const customConfig: RetryConfig = {
                ...baseConfig,
                retryableErrors: ['CUSTOM_ERROR']
            };
            const error = { code: 'ECONNRESET', message: 'Connection reset' };
            assert.strictEqual(isRetryableError(error, customConfig), false);
        });
    });

    describe('HTTP status code handling', () => {
        test('returns true for 429 Too Many Requests', () => {
            const error = { status: 429, message: 'Too Many Requests' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for 500 Internal Server Error', () => {
            const error = { status: 500, message: 'Internal Server Error' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for 502 Bad Gateway', () => {
            const error = { status: 502, message: 'Bad Gateway' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for 503 Service Unavailable', () => {
            const error = { status: 503, message: 'Service Unavailable' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for 504 Gateway Timeout', () => {
            const error = { status: 504, message: 'Gateway Timeout' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns false for 400 Bad Request', () => {
            const error = { status: 400, message: 'Bad Request' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('returns false for 401 Unauthorized', () => {
            const error = { status: 401, message: 'Unauthorized' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('returns false for 403 Forbidden', () => {
            const error = { status: 403, message: 'Forbidden' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('returns false for 404 Not Found', () => {
            const error = { status: 404, message: 'Not Found' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('returns false for 422 Unprocessable Entity', () => {
            const error = { status: 422, message: 'Unprocessable Entity' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('returns false for 200 OK (success status)', () => {
            const error = { status: 200, message: 'OK' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('returns false for 201 Created (success status)', () => {
            const error = { status: 201, message: 'Created' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('returns false for 301 Moved Permanently', () => {
            const error = { status: 301, message: 'Moved Permanently' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });
    });

    describe('error message pattern matching', () => {
        test('returns true for rate limit messages', () => {
            const error = new Error('API rate limit exceeded');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for rate limit messages (case insensitive)', () => {
            const error = new Error('Rate Limit exceeded');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for timeout messages', () => {
            const error = new Error('Request timeout');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for network error messages', () => {
            const error = new Error('Network error occurred');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for connection error messages', () => {
            const error = new Error('Connection failed');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for temporary error messages', () => {
            const error = new Error('Temporary error, please retry');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for "try again" messages', () => {
            const error = new Error('Please try again later');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for authentication failed messages', () => {
            const error = new Error('Authentication failed');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for invalid username or token messages', () => {
            const error = new Error('Invalid username or token provided');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for credentials error messages', () => {
            const error = new Error('Invalid credentials');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for server unavailable messages', () => {
            const error = new Error('Server is currently unavailable');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for "no server available" messages', () => {
            const error = new Error('No server is available');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for service unavailable messages', () => {
            const error = new Error('Service unavailable');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for bad gateway messages', () => {
            const error = new Error('Bad gateway response');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for GitHub API propagation delay messages', () => {
            const error = new Error('Could not resolve to a node with the given global ID');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns true for unprocessable node messages', () => {
            const error = new Error('Unprocessable node data');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns false for generic error without retryable patterns', () => {
            const error = new Error('Something went wrong');
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('returns false for file not found errors', () => {
            const error = new Error('File not found');
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('returns false for syntax errors', () => {
            const error = new Error('Syntax error in configuration');
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('returns false for validation errors', () => {
            const error = new Error('Validation failed: invalid input');
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });
    });

    describe('error toString matching', () => {
        test('matches patterns in error toString output', () => {
            const error = {
                message: 'Some error',
                toString: () => 'Error: Connection refused by server'
            };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('matches network pattern in toString', () => {
            const error = {
                message: '',
                toString: () => 'NetworkError: Failed to fetch'
            };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });
    });

    describe('edge cases', () => {
        test('handles null error gracefully', () => {
            assert.strictEqual(isRetryableError(null, baseConfig), false);
        });

        test('handles undefined error gracefully', () => {
            assert.strictEqual(isRetryableError(undefined, baseConfig), false);
        });

        test('handles error with no properties', () => {
            const error = {};
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('handles error with undefined message', () => {
            const error = { code: undefined, status: undefined, message: undefined };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('handles error with empty message', () => {
            const error = { message: '' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('prioritizes error code over status', () => {
            // If code matches, returns true even if status would be non-retryable
            const error = { code: 'ECONNRESET', status: 404, message: 'Error' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('falls back to status when code does not match', () => {
            const error = { code: 'UNKNOWN', status: 503, message: 'Service Unavailable' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('handles actual Error instance', () => {
            const error = new Error('Connection timeout occurred');
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('handles Error with code property', () => {
            const error = new Error('Connection reset');
            (error as Error & { code: string }).code = 'ECONNRESET';
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('handles empty retryableErrors configuration', () => {
            const customConfig: RetryConfig = {
                ...baseConfig,
                retryableErrors: []
            };
            const error = { code: 'ECONNRESET', message: 'Connection reset' };
            // Should still return true based on message pattern
            assert.strictEqual(isRetryableError(error, customConfig), true);
        });

        test('handles string thrown as error', () => {
            const error = 'Network connection failed';
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('returns false for non-matching string error', () => {
            const error = 'Invalid parameter provided';
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });
    });

    describe('network error scenarios (acceptance criteria)', () => {
        test('retries ECONNRESET network error', () => {
            const error = { code: 'ECONNRESET' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('retries ECONNREFUSED network error', () => {
            const error = { code: 'ECONNREFUSED' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('retries ETIMEDOUT network error', () => {
            const error = { code: 'ETIMEDOUT' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('retries ENOTFOUND DNS error', () => {
            const error = { code: 'ENOTFOUND' };
            assert.strictEqual(isRetryableError(error, baseConfig), true);
        });

        test('does not retry 404 Not Found', () => {
            const error = { status: 404, message: 'Not Found' };
            assert.strictEqual(isRetryableError(error, baseConfig), false);
        });

        test('handles API status codes correctly - retryable statuses', () => {
            const retryableStatuses = [429, 500, 502, 503, 504];
            for (const status of retryableStatuses) {
                const error = { status, message: `HTTP ${status}` };
                assert.strictEqual(
                    isRetryableError(error, baseConfig),
                    true,
                    `Status ${status} should be retryable`
                );
            }
        });

        test('handles API status codes correctly - non-retryable statuses', () => {
            const nonRetryableStatuses = [400, 401, 403, 404, 405, 409, 422];
            for (const status of nonRetryableStatuses) {
                const error = { status, message: `HTTP ${status}` };
                assert.strictEqual(
                    isRetryableError(error, baseConfig),
                    false,
                    `Status ${status} should not be retryable`
                );
            }
        });
    });
});

// Force exit due to module-level initialization in @propr/core
after(() => {
    process.exit(0);
});
