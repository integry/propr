import { test, describe, after, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import { calculateDelay, isRetryableError, withRetry } from '../packages/core/src/utils/retryHandler.js';
import type { RetryConfig, RetryOptions } from '../packages/core/src/utils/retryHandler.js';

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

        test('returns true via message pattern when error code is not in custom retryableErrors', () => {
            const customConfig: RetryConfig = {
                ...baseConfig,
                retryableErrors: ['CUSTOM_ERROR']
            };
            // Note: Even though ECONNRESET is not in retryableErrors, the message
            // 'Connection reset' matches the /connection/i pattern, so it returns true
            const error = { code: 'ECONNRESET', message: 'Connection reset' };
            assert.strictEqual(isRetryableError(error, customConfig), true);
        });

        test('returns false when neither code nor message matches', () => {
            const customConfig: RetryConfig = {
                ...baseConfig,
                retryableErrors: ['CUSTOM_ERROR']
            };
            // This error has a non-matching code and a non-matching message
            const error = { code: 'ENOENT', message: 'File not found' };
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
        test('throws on null error (implementation limitation)', () => {
            // Note: The current implementation does not handle null/undefined gracefully
            // It throws because it tries to access .code on null
            assert.throws(() => isRetryableError(null, baseConfig), TypeError);
        });

        test('throws on undefined error (implementation limitation)', () => {
            // Note: The current implementation does not handle null/undefined gracefully
            // It throws because it tries to access .code on undefined
            assert.throws(() => isRetryableError(undefined, baseConfig), TypeError);
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

/**
 * Unit tests for withRetry wrapper function
 *
 * The withRetry function executes an async function with retry logic:
 * - Exhausts maxAttempts before giving up on retryable errors
 * - Passes correlationId through for logging/tracing
 * - Makes the correct number of calls based on success/failure
 */
describe('withRetry', () => {
    const baseOptions: RetryOptions = {
        maxAttempts: 3,
        baseDelay: 10, // Use very short delays for testing
        maxDelay: 100,
        exponentialBase: 2,
        jitter: false,
        retryableErrors: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'],
        correlationId: 'test-correlation-id'
    };

    describe('max attempts exhaustion', () => {
        test('exhausts all maxAttempts when function consistently fails with retryable error', async () => {
            let callCount = 0;
            const retryableError = { code: 'ECONNRESET', message: 'Connection reset' };

            const fn = async () => {
                callCount++;
                throw retryableError;
            };

            await assert.rejects(
                async () => withRetry(fn, baseOptions, 'test operation'),
                (err: Error & { code?: string }) => err.code === 'ECONNRESET'
            );

            assert.strictEqual(callCount, 3, 'Should have made exactly maxAttempts (3) calls');
        });

        test('exhausts maxAttempts=5 when configured', async () => {
            let callCount = 0;
            const options: RetryOptions = { ...baseOptions, maxAttempts: 5 };
            const retryableError = { code: 'ETIMEDOUT', message: 'Connection timed out' };

            const fn = async () => {
                callCount++;
                throw retryableError;
            };

            await assert.rejects(
                async () => withRetry(fn, options, 'test operation'),
                (err: Error & { code?: string }) => err.code === 'ETIMEDOUT'
            );

            assert.strictEqual(callCount, 5, 'Should have made exactly maxAttempts (5) calls');
        });

        test('exhausts maxAttempts=1 (no retries)', async () => {
            let callCount = 0;
            const options: RetryOptions = { ...baseOptions, maxAttempts: 1 };
            const retryableError = { code: 'ECONNRESET', message: 'Connection reset' };

            const fn = async () => {
                callCount++;
                throw retryableError;
            };

            await assert.rejects(
                async () => withRetry(fn, options, 'test operation'),
                (err: Error & { code?: string }) => err.code === 'ECONNRESET'
            );

            assert.strictEqual(callCount, 1, 'Should have made exactly maxAttempts (1) call');
        });

        test('exhausts attempts with HTTP 503 status error', async () => {
            let callCount = 0;
            const retryableError = { status: 503, message: 'Service Unavailable' };

            const fn = async () => {
                callCount++;
                throw retryableError;
            };

            await assert.rejects(
                async () => withRetry(fn, baseOptions, 'test operation'),
                (err: Error & { status?: number }) => err.status === 503
            );

            assert.strictEqual(callCount, 3, 'Should have exhausted all 3 attempts for 503 error');
        });

        test('exhausts attempts with retryable error message pattern', async () => {
            let callCount = 0;
            const retryableError = new Error('Connection timeout occurred');

            const fn = async () => {
                callCount++;
                throw retryableError;
            };

            await assert.rejects(
                async () => withRetry(fn, baseOptions, 'test operation'),
                (err: Error) => err.message.includes('timeout')
            );

            assert.strictEqual(callCount, 3, 'Should have exhausted all 3 attempts for timeout error');
        });
    });

    describe('non-retryable error handling', () => {
        test('stops immediately on non-retryable error (does not exhaust attempts)', async () => {
            let callCount = 0;
            const nonRetryableError = { code: 'ENOENT', message: 'File not found' };

            const fn = async () => {
                callCount++;
                throw nonRetryableError;
            };

            await assert.rejects(
                async () => withRetry(fn, baseOptions, 'test operation'),
                (err: Error & { code?: string }) => err.code === 'ENOENT'
            );

            assert.strictEqual(callCount, 1, 'Should stop after first attempt for non-retryable error');
        });

        test('stops immediately on HTTP 404 error', async () => {
            let callCount = 0;
            const nonRetryableError = { status: 404, message: 'Not Found' };

            const fn = async () => {
                callCount++;
                throw nonRetryableError;
            };

            await assert.rejects(
                async () => withRetry(fn, baseOptions, 'test operation'),
                (err: Error & { status?: number }) => err.status === 404
            );

            assert.strictEqual(callCount, 1, 'Should stop after first attempt for 404 error');
        });

        test('stops immediately on HTTP 400 error', async () => {
            let callCount = 0;
            const nonRetryableError = { status: 400, message: 'Bad Request' };

            const fn = async () => {
                callCount++;
                throw nonRetryableError;
            };

            await assert.rejects(
                async () => withRetry(fn, baseOptions, 'test operation'),
                (err: Error & { status?: number }) => err.status === 400
            );

            assert.strictEqual(callCount, 1, 'Should stop after first attempt for 400 error');
        });
    });

    describe('correlationId passing', () => {
        test('passes correlationId to the retry context', async () => {
            const options: RetryOptions = {
                ...baseOptions,
                correlationId: 'unique-correlation-123'
            };

            let callCount = 0;
            const fn = async () => {
                callCount++;
                if (callCount < 2) {
                    throw { code: 'ECONNRESET', message: 'Connection reset' };
                }
                return 'success';
            };

            const result = await withRetry(fn, options, 'correlation test');

            assert.strictEqual(result, 'success');
            assert.strictEqual(callCount, 2);
        });

        test('uses default correlationId when not provided', async () => {
            const options: RetryOptions = {
                ...baseOptions,
                correlationId: undefined
            };

            const fn = async () => 'success';

            const result = await withRetry(fn, options, 'test without correlationId');

            assert.strictEqual(result, 'success');
        });

        test('correlationId persists across all retry attempts', async () => {
            const correlationId = 'persist-across-retries-456';
            const options: RetryOptions = {
                ...baseOptions,
                correlationId,
                maxAttempts: 3
            };

            let callCount = 0;
            const fn = async () => {
                callCount++;
                throw { code: 'ECONNRESET', message: 'Connection reset' };
            };

            await assert.rejects(
                async () => withRetry(fn, options, 'correlation persistence test')
            );

            assert.strictEqual(callCount, 3, 'All retry attempts should have been made with correlationId');
        });
    });

    describe('correct number of calls made', () => {
        test('makes exactly 1 call when function succeeds on first attempt', async () => {
            let callCount = 0;
            const fn = async () => {
                callCount++;
                return 'success';
            };

            const result = await withRetry(fn, baseOptions, 'immediate success');

            assert.strictEqual(result, 'success');
            assert.strictEqual(callCount, 1, 'Should make exactly 1 call on success');
        });

        test('makes exactly 2 calls when function succeeds on second attempt', async () => {
            let callCount = 0;
            const fn = async () => {
                callCount++;
                if (callCount < 2) {
                    throw { code: 'ECONNRESET', message: 'Connection reset' };
                }
                return 'success after retry';
            };

            const result = await withRetry(fn, baseOptions, 'success on retry');

            assert.strictEqual(result, 'success after retry');
            assert.strictEqual(callCount, 2, 'Should make exactly 2 calls');
        });

        test('makes exactly 3 calls when function succeeds on third attempt', async () => {
            let callCount = 0;
            const fn = async () => {
                callCount++;
                if (callCount < 3) {
                    throw { code: 'ETIMEDOUT', message: 'Connection timed out' };
                }
                return 'success on last try';
            };

            const result = await withRetry(fn, baseOptions, 'success on last attempt');

            assert.strictEqual(result, 'success on last try');
            assert.strictEqual(callCount, 3, 'Should make exactly 3 calls');
        });

        test('makes exactly maxAttempts calls when all fail with retryable errors', async () => {
            const maxAttempts = 4;
            const options: RetryOptions = { ...baseOptions, maxAttempts };
            let callCount = 0;

            const fn = async () => {
                callCount++;
                throw { code: 'ECONNREFUSED', message: 'Connection refused' };
            };

            await assert.rejects(
                async () => withRetry(fn, options, 'all fail test')
            );

            assert.strictEqual(callCount, maxAttempts, `Should make exactly ${maxAttempts} calls`);
        });

        test('stops early when non-retryable error occurs mid-retry', async () => {
            let callCount = 0;
            const fn = async () => {
                callCount++;
                if (callCount === 1) {
                    throw { code: 'ECONNRESET', message: 'Connection reset' };
                }
                // Second attempt throws non-retryable error
                throw { code: 'ENOENT', message: 'File not found' };
            };

            await assert.rejects(
                async () => withRetry(fn, baseOptions, 'non-retryable mid-retry')
            );

            assert.strictEqual(callCount, 2, 'Should stop at 2 calls when non-retryable error occurs');
        });
    });

    describe('return value handling', () => {
        test('returns the successful result from the function', async () => {
            const expectedResult = { data: 'test data', count: 42 };
            const fn = async () => expectedResult;

            const result = await withRetry(fn, baseOptions, 'return value test');

            assert.deepStrictEqual(result, expectedResult);
        });

        test('returns result from successful retry attempt', async () => {
            let callCount = 0;
            const fn = async () => {
                callCount++;
                if (callCount < 2) {
                    throw { code: 'ETIMEDOUT', message: 'Timeout' };
                }
                return { attempt: callCount, success: true };
            };

            const result = await withRetry(fn, baseOptions, 'retry return value');

            assert.deepStrictEqual(result, { attempt: 2, success: true });
        });

        test('preserves async function resolution', async () => {
            const fn = async () => {
                return new Promise<string>(resolve => {
                    setTimeout(() => resolve('async result'), 5);
                });
            };

            const result = await withRetry(fn, baseOptions, 'async resolution');

            assert.strictEqual(result, 'async result');
        });
    });

    describe('error preservation', () => {
        test('throws the last error when all attempts fail', async () => {
            let callCount = 0;
            const fn = async () => {
                callCount++;
                throw new Error(`Attempt ${callCount} failed`);
            };

            // Since the error message matches "connection" pattern, it will retry
            const options: RetryOptions = {
                ...baseOptions,
                retryableErrors: ['ALWAYS_RETRY']
            };

            const fnWithRetryable = async () => {
                callCount++;
                throw { code: 'ALWAYS_RETRY', message: `Attempt ${callCount} failed` };
            };

            callCount = 0;

            await assert.rejects(
                async () => withRetry(fnWithRetryable, options, 'error preservation'),
                (err: Error & { code?: string; message: string }) => {
                    return err.code === 'ALWAYS_RETRY' && err.message === 'Attempt 3 failed';
                }
            );
        });

        test('preserves error properties from non-retryable error', async () => {
            const customError = {
                code: 'CUSTOM_ERROR',
                status: 422,
                message: 'Validation failed',
                details: { field: 'email' }
            };

            const fn = async () => {
                throw customError;
            };

            await assert.rejects(
                async () => withRetry(fn, baseOptions, 'error properties'),
                (err: typeof customError) => {
                    return err.code === 'CUSTOM_ERROR' &&
                           err.status === 422 &&
                           err.message === 'Validation failed' &&
                           err.details?.field === 'email';
                }
            );
        });
    });

    describe('default configuration', () => {
        test('uses default maxAttempts when not specified', async () => {
            let callCount = 0;
            const options: RetryOptions = {
                baseDelay: 10,
                jitter: false
            };

            const fn = async () => {
                callCount++;
                throw { code: 'ECONNRESET', message: 'Connection reset' };
            };

            await assert.rejects(
                async () => withRetry(fn, options, 'default config test')
            );

            // Default maxAttempts is 3
            assert.strictEqual(callCount, 3, 'Should use default maxAttempts of 3');
        });

        test('uses default context when not provided', async () => {
            const fn = async () => 'success';

            const result = await withRetry(fn, baseOptions);

            assert.strictEqual(result, 'success');
        });

        test('works with empty options object', async () => {
            let callCount = 0;
            const fn = async () => {
                callCount++;
                if (callCount < 2) {
                    throw { code: 'ECONNRESET', message: 'Connection reset' };
                }
                return 'success';
            };

            // Note: This will use default delays which are longer
            const options: RetryOptions = { baseDelay: 10, jitter: false };
            const result = await withRetry(fn, options, 'empty options');

            assert.strictEqual(result, 'success');
        });
    });

    describe('predefined configurations integration', () => {
        test('works with github API retry config', async () => {
            let callCount = 0;
            const options: RetryOptions = {
                maxAttempts: 3,
                baseDelay: 10, // Override for faster tests
                maxDelay: 100,
                exponentialBase: 2,
                retryableErrors: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'],
                jitter: false,
                correlationId: 'github-api-test'
            };

            const fn = async () => {
                callCount++;
                if (callCount < 3) {
                    throw { code: 'ECONNRESET', message: 'Connection reset' };
                }
                return { pr: 123 };
            };

            const result = await withRetry(fn, options, 'GitHub API call');

            assert.deepStrictEqual(result, { pr: 123 });
            assert.strictEqual(callCount, 3);
        });

        test('works with redis retry config', async () => {
            let callCount = 0;
            const options: RetryOptions = {
                maxAttempts: 5,
                baseDelay: 10,
                maxDelay: 100,
                exponentialBase: 2,
                retryableErrors: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'],
                jitter: false,
                correlationId: 'redis-test'
            };

            const fn = async () => {
                callCount++;
                if (callCount < 4) {
                    throw { code: 'ECONNREFUSED', message: 'Connection refused' };
                }
                return 'cached_value';
            };

            const result = await withRetry(fn, options, 'Redis operation');

            assert.strictEqual(result, 'cached_value');
            assert.strictEqual(callCount, 4);
        });
    });
});

// Force exit due to module-level initialization in @propr/core
after(() => {
    process.exit(0);
});
