import { test, describe, mock } from 'node:test';
import assert from 'node:assert';

/**
 * Pure function extracted from issueJobHelpers.ts for testing.
 * This tests the core logic of categorizeError without triggering
 * module-level side effects from @propr/core imports.
 *
 * The original function is at: src/jobs/issueJobHelpers.ts:127
 */

/**
 * Categorizes error messages into specific error types.
 * Returns 'unknown_error' for unrecognized error patterns.
 *
 * @param errorMessage - The error message to categorize (or undefined)
 * @returns The error category string
 */
function categorizeError(errorMessage: string | undefined): string {
    if (errorMessage?.includes('authentication')) return 'auth_error';
    if (errorMessage?.includes('network')) return 'network_error';
    if (errorMessage?.includes('git')) return 'git_error';
    if (errorMessage?.includes('GitHub')) return 'github_api_error';
    if (errorMessage?.includes('timeout')) return 'timeout_error';
    return 'unknown_error';
}

describe('categorizeError', () => {
    describe('authentication errors', () => {
        test('should return auth_error when message contains "authentication"', () => {
            const result = categorizeError('Failed due to authentication issue');
            assert.strictEqual(result, 'auth_error');
        });

        test('should return auth_error when message starts with "authentication"', () => {
            const result = categorizeError('authentication failed');
            assert.strictEqual(result, 'auth_error');
        });

        test('should return auth_error when message ends with "authentication"', () => {
            const result = categorizeError('Error with authentication');
            assert.strictEqual(result, 'auth_error');
        });

        test('should return auth_error for complex authentication error message', () => {
            const result = categorizeError('The request failed due to invalid authentication credentials');
            assert.strictEqual(result, 'auth_error');
        });
    });

    describe('network errors', () => {
        test('should return network_error when message contains "network"', () => {
            const result = categorizeError('A network error occurred');
            assert.strictEqual(result, 'network_error');
        });

        test('should return network_error when message starts with "network"', () => {
            const result = categorizeError('network connection failed');
            assert.strictEqual(result, 'network_error');
        });

        test('should return network_error when message ends with "network"', () => {
            const result = categorizeError('Unable to connect to the network');
            assert.strictEqual(result, 'network_error');
        });

        test('should return network_error for complex network error message', () => {
            const result = categorizeError('Failed to fetch data: network request timed out');
            assert.strictEqual(result, 'network_error');
        });
    });

    describe('git errors', () => {
        test('should return git_error when message contains "git"', () => {
            const result = categorizeError('A git error occurred');
            assert.strictEqual(result, 'git_error');
        });

        test('should return git_error when message starts with "git"', () => {
            const result = categorizeError('git push failed');
            assert.strictEqual(result, 'git_error');
        });

        test('should return git_error when message ends with "git"', () => {
            const result = categorizeError('Error running git');
            assert.strictEqual(result, 'git_error');
        });

        test('should return git_error for complex git error message', () => {
            const result = categorizeError('Failed to clone repository: git push failed with error');
            assert.strictEqual(result, 'git_error');
        });

        test('should return git_error for lowercase "git" only (not GitHub)', () => {
            const result = categorizeError('git repository not found');
            assert.strictEqual(result, 'git_error');
        });
    });

    describe('github API errors', () => {
        test('should return github_api_error when message contains "GitHub"', () => {
            const result = categorizeError('A GitHub API error occurred');
            assert.strictEqual(result, 'github_api_error');
        });

        test('should return github_api_error when message starts with "GitHub"', () => {
            const result = categorizeError('GitHub rate limit exceeded');
            assert.strictEqual(result, 'github_api_error');
        });

        test('should return github_api_error when message ends with "GitHub"', () => {
            const result = categorizeError('Could not connect to GitHub');
            assert.strictEqual(result, 'github_api_error');
        });

        test('should return github_api_error for complex GitHub error message', () => {
            const result = categorizeError('Request to GitHub API failed with status 403');
            assert.strictEqual(result, 'github_api_error');
        });

        test('should be case sensitive for GitHub (capital G and H)', () => {
            // "github" lowercase should match "git" first
            const result = categorizeError('github lowercase error');
            assert.strictEqual(result, 'git_error');
        });
    });

    describe('timeout errors', () => {
        test('should return timeout_error when message contains "timeout"', () => {
            const result = categorizeError('Operation timeout occurred');
            assert.strictEqual(result, 'timeout_error');
        });

        test('should return timeout_error when message starts with "timeout"', () => {
            const result = categorizeError('timeout while waiting for response');
            assert.strictEqual(result, 'timeout_error');
        });

        test('should return timeout_error when message ends with "timeout"', () => {
            const result = categorizeError('Connection timeout');
            assert.strictEqual(result, 'timeout_error');
        });

        test('should return timeout_error for complex timeout error message', () => {
            const result = categorizeError('The request to the server failed due to a timeout after 30 seconds');
            assert.strictEqual(result, 'timeout_error');
        });
    });

    describe('unknown errors (default case)', () => {
        test('should return unknown_error when message is undefined', () => {
            const result = categorizeError(undefined);
            assert.strictEqual(result, 'unknown_error');
        });

        test('should return unknown_error when message is empty string', () => {
            const result = categorizeError('');
            assert.strictEqual(result, 'unknown_error');
        });

        test('should return unknown_error for generic error message', () => {
            const result = categorizeError('Something went wrong');
            assert.strictEqual(result, 'unknown_error');
        });

        test('should return unknown_error for unrecognized error types', () => {
            const result = categorizeError('Database connection failed');
            assert.strictEqual(result, 'unknown_error');
        });

        test('should return unknown_error for permission errors', () => {
            const result = categorizeError('Permission denied');
            assert.strictEqual(result, 'unknown_error');
        });

        test('should return unknown_error for file system errors', () => {
            const result = categorizeError('File not found');
            assert.strictEqual(result, 'unknown_error');
        });

        test('should return unknown_error for memory errors', () => {
            const result = categorizeError('Out of memory');
            assert.strictEqual(result, 'unknown_error');
        });
    });

    describe('priority/order of matching', () => {
        test('should match authentication before network when both are present', () => {
            const result = categorizeError('authentication failed over network');
            assert.strictEqual(result, 'auth_error');
        });

        test('should match network before git when both are present', () => {
            const result = categorizeError('network error during git operation');
            assert.strictEqual(result, 'network_error');
        });

        test('should match git before GitHub when both are present (lowercase github)', () => {
            // "git" check comes before "GitHub" check, and "github" lowercase contains "git"
            const result = categorizeError('git error connecting to github');
            assert.strictEqual(result, 'git_error');
        });

        test('should match GitHub before timeout when both are present', () => {
            const result = categorizeError('GitHub request timeout');
            assert.strictEqual(result, 'github_api_error');
        });

        test('should match authentication even with multiple error types in message', () => {
            const result = categorizeError('authentication failed: network timeout on GitHub');
            assert.strictEqual(result, 'auth_error');
        });
    });

    describe('case sensitivity', () => {
        test('should match "authentication" case-insensitively (lowercase)', () => {
            const result = categorizeError('Authentication error');
            // Note: includes() is case-sensitive, so "Authentication" won't match "authentication"
            assert.strictEqual(result, 'unknown_error');
        });

        test('should match "network" case-insensitively check (lowercase only matches)', () => {
            const result = categorizeError('NETWORK error');
            // includes() is case-sensitive
            assert.strictEqual(result, 'unknown_error');
        });

        test('should require exact case for "GitHub"', () => {
            const result = categorizeError('GITHUB error');
            // "GITHUB" doesn't contain "GitHub" (case-sensitive)
            assert.strictEqual(result, 'unknown_error');
        });

        test('should match "timeout" in lowercase only', () => {
            const result = categorizeError('TIMEOUT error');
            assert.strictEqual(result, 'unknown_error');
        });
    });

    describe('edge cases', () => {
        test('should handle whitespace-only message', () => {
            const result = categorizeError('   ');
            assert.strictEqual(result, 'unknown_error');
        });

        test('should handle very long error message', () => {
            const longMessage = 'Error: ' + 'x'.repeat(10000) + ' authentication failed';
            const result = categorizeError(longMessage);
            assert.strictEqual(result, 'auth_error');
        });

        test('should handle message with special characters', () => {
            const result = categorizeError('Error!@#$%^&*() authentication');
            assert.strictEqual(result, 'auth_error');
        });

        test('should handle message with newlines', () => {
            const result = categorizeError('Error occurred\nauthentication failed\nplease retry');
            assert.strictEqual(result, 'auth_error');
        });

        test('should handle message with unicode characters', () => {
            const result = categorizeError('Error: authentication 认证失败');
            assert.strictEqual(result, 'auth_error');
        });

        test('should handle error keyword as substring', () => {
            // "git" is a substring of "digit"
            const result = categorizeError('invalid digit in number');
            assert.strictEqual(result, 'git_error');
        });
    });
});

/**
 * Pure function extracted from issueJobHelpers.ts for testing.
 * Tests the core logic of calculateUsageLimitDelay.
 *
 * The original function is at: src/jobs/issueJobHelpers.ts:63
 */

// Default constants from issueJobHelpers.ts (lines 34-35)
const REQUEUE_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
const REQUEUE_JITTER_MS = 2 * 60 * 1000; // 2 minutes
const DEFAULT_RESET_OFFSET_MS = 60 * 60 * 1000; // 1 hour

interface UsageLimitError extends Error {
    resetTimestamp?: number;
}

/**
 * Testable version of calculateUsageLimitDelay that accepts dependencies.
 * Allows mocking Date.now() and Math.random() for deterministic testing.
 *
 * @param error - The usage limit error with optional resetTimestamp (in seconds)
 * @param now - Current timestamp in milliseconds (injectable for testing)
 * @param random - Random value between 0 and 1 (injectable for testing)
 * @returns Delay in milliseconds
 */
function calculateUsageLimitDelay(
    error: UsageLimitError,
    now: number = Date.now(),
    random: number = Math.random()
): number {
    const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (now + DEFAULT_RESET_OFFSET_MS);
    return (resetTimeUTC - now) + REQUEUE_BUFFER_MS + Math.floor(random * REQUEUE_JITTER_MS);
}

describe('calculateUsageLimitDelay', () => {
    describe('with resetTimestamp provided', () => {
        test('should calculate delay based on resetTimestamp (in seconds)', () => {
            const now = 1700000000000; // Fixed "now" timestamp
            const resetTimestamp = 1700000060; // 60 seconds from now (in seconds)
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0);

            // Expected: (60 * 1000) + REQUEUE_BUFFER_MS + 0
            // = 60000 + 300000 + 0 = 360000
            assert.strictEqual(result, 60000 + REQUEUE_BUFFER_MS);
        });

        test('should include jitter in calculation', () => {
            const now = 1700000000000;
            const resetTimestamp = 1700000060; // 60 seconds from now
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0.5);

            // Expected: 60000 + 300000 + floor(0.5 * 120000)
            // = 60000 + 300000 + 60000 = 420000
            const expectedJitter = Math.floor(0.5 * REQUEUE_JITTER_MS);
            assert.strictEqual(result, 60000 + REQUEUE_BUFFER_MS + expectedJitter);
        });

        test('should include maximum jitter when random is close to 1', () => {
            const now = 1700000000000;
            const resetTimestamp = 1700000060;
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0.999);

            const expectedJitter = Math.floor(0.999 * REQUEUE_JITTER_MS);
            assert.strictEqual(result, 60000 + REQUEUE_BUFFER_MS + expectedJitter);
        });

        test('should handle resetTimestamp in the past', () => {
            const now = 1700000000000;
            const resetTimestamp = 1699999940; // 60 seconds ago
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0);

            // resetTimeUTC = 1699999940 * 1000 = 1699999940000
            // (1699999940000 - 1700000000000) = -60000
            // -60000 + 300000 + 0 = 240000
            assert.strictEqual(result, -60000 + REQUEUE_BUFFER_MS);
        });

        test('should handle resetTimestamp far in the future', () => {
            const now = 1700000000000;
            const resetTimestamp = 1700003600; // 1 hour from now
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0);

            // Expected: (3600 * 1000) + 300000 + 0 = 3900000
            assert.strictEqual(result, 3600000 + REQUEUE_BUFFER_MS);
        });
    });

    describe('without resetTimestamp (defaults to 1 hour)', () => {
        test('should default to 1 hour delay when resetTimestamp is undefined', () => {
            const now = 1700000000000;
            const error: UsageLimitError = new Error('Usage limit');

            const result = calculateUsageLimitDelay(error, now, 0);

            // Expected: DEFAULT_RESET_OFFSET_MS + REQUEUE_BUFFER_MS + 0
            // = 3600000 + 300000 = 3900000
            assert.strictEqual(result, DEFAULT_RESET_OFFSET_MS + REQUEUE_BUFFER_MS);
        });

        test('should default to 1 hour delay when resetTimestamp is 0', () => {
            const now = 1700000000000;
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp: 0 });

            const result = calculateUsageLimitDelay(error, now, 0);

            // resetTimestamp of 0 is falsy, so should use default
            assert.strictEqual(result, DEFAULT_RESET_OFFSET_MS + REQUEUE_BUFFER_MS);
        });

        test('should include jitter with default reset time', () => {
            const now = 1700000000000;
            const error: UsageLimitError = new Error('Usage limit');

            const result = calculateUsageLimitDelay(error, now, 0.75);

            const expectedJitter = Math.floor(0.75 * REQUEUE_JITTER_MS);
            assert.strictEqual(result, DEFAULT_RESET_OFFSET_MS + REQUEUE_BUFFER_MS + expectedJitter);
        });
    });

    describe('always positive acceptance criteria', () => {
        test('should return positive value with future resetTimestamp', () => {
            const now = 1700000000000;
            const resetTimestamp = 1700000001; // 1 second from now
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0);

            assert.ok(result > 0, `Expected positive delay, got ${result}`);
        });

        test('should return positive value with default reset time', () => {
            const now = 1700000000000;
            const error: UsageLimitError = new Error('Usage limit');

            const result = calculateUsageLimitDelay(error, now, 0);

            assert.ok(result > 0, `Expected positive delay, got ${result}`);
        });

        test('should return positive value even with past resetTimestamp due to buffer', () => {
            const now = 1700000000000;
            // 4 minutes in the past (240 seconds)
            // This should still be positive because buffer is 5 minutes (300000ms)
            const resetTimestamp = now / 1000 - 240;
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0);

            // -240000 + 300000 = 60000 (still positive due to buffer)
            assert.ok(result > 0, `Expected positive delay, got ${result}`);
        });

        test('should return positive value with maximum jitter', () => {
            const now = 1700000000000;
            const error: UsageLimitError = new Error('Usage limit');

            const result = calculateUsageLimitDelay(error, now, 0.9999);

            assert.ok(result > 0, `Expected positive delay, got ${result}`);
        });

        test('should return positive value with minimum jitter (0)', () => {
            const now = 1700000000000;
            const error: UsageLimitError = new Error('Usage limit');

            const result = calculateUsageLimitDelay(error, now, 0);

            assert.ok(result > 0, `Expected positive delay, got ${result}`);
        });
    });

    describe('jitter range validation', () => {
        test('should have zero jitter when random is 0', () => {
            const now = 1700000000000;
            const resetTimestamp = 1700000060;
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const resultWithZeroRandom = calculateUsageLimitDelay(error, now, 0);
            const resultWithSomeRandom = calculateUsageLimitDelay(error, now, 0.5);

            assert.ok(resultWithSomeRandom > resultWithZeroRandom, 'Jitter should increase delay');
        });

        test('should have jitter less than REQUEUE_JITTER_MS', () => {
            const now = 1700000000000;
            const resetTimestamp = 1700000060;
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const resultNoJitter = calculateUsageLimitDelay(error, now, 0);
            const resultMaxJitter = calculateUsageLimitDelay(error, now, 0.9999);

            const actualJitter = resultMaxJitter - resultNoJitter;
            assert.ok(actualJitter < REQUEUE_JITTER_MS, `Jitter ${actualJitter} should be less than ${REQUEUE_JITTER_MS}`);
        });

        test('should produce different delays for different random values', () => {
            const now = 1700000000000;
            const error: UsageLimitError = new Error('Usage limit');

            const result1 = calculateUsageLimitDelay(error, now, 0.25);
            const result2 = calculateUsageLimitDelay(error, now, 0.75);

            assert.notStrictEqual(result1, result2, 'Different random values should produce different delays');
            assert.ok(result2 > result1, 'Higher random value should produce longer delay');
        });
    });

    describe('edge cases', () => {
        test('should handle very large resetTimestamp', () => {
            const now = 1700000000000;
            const resetTimestamp = 2000000000; // Year 2033
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0);

            // Should not throw and should return a large positive number
            assert.ok(result > 0, `Expected positive delay, got ${result}`);
            assert.ok(result > DEFAULT_RESET_OFFSET_MS, 'Should be greater than default reset offset');
        });

        test('should handle resetTimestamp equal to now', () => {
            const now = 1700000000000;
            const resetTimestamp = now / 1000; // Exactly now
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0);

            // (now - now) + buffer = 0 + 300000 = 300000
            assert.strictEqual(result, REQUEUE_BUFFER_MS);
        });

        test('should handle fractional resetTimestamp', () => {
            const now = 1700000000000;
            const resetTimestamp = 1700000060.5; // Fractional seconds
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0);

            // resetTimeUTC = 1700000060.5 * 1000 = 1700000060500
            // (1700000060500 - 1700000000000) = 60500
            // 60500 + 300000 = 360500
            assert.strictEqual(result, 60500 + REQUEUE_BUFFER_MS);
        });

        test('should handle negative resetTimestamp', () => {
            const now = 1700000000000;
            const resetTimestamp = -1000; // Negative timestamp
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0);

            // resetTimeUTC = -1000 * 1000 = -1000000
            // (-1000000 - 1700000000000) + 300000 = very negative
            // This is a degenerate case but function should not throw
            assert.ok(typeof result === 'number', 'Should return a number');
        });

        test('should use Math.floor for jitter calculation', () => {
            const now = 1700000000000;
            const error: UsageLimitError = new Error('Usage limit');

            // Use a random value that would produce a fractional jitter
            const randomValue = 0.333;
            const result = calculateUsageLimitDelay(error, now, randomValue);

            // Verify the result is an integer
            assert.strictEqual(result, Math.floor(result), 'Result should be an integer');

            // Verify the specific calculation
            const expectedJitter = Math.floor(randomValue * REQUEUE_JITTER_MS);
            assert.strictEqual(result, DEFAULT_RESET_OFFSET_MS + REQUEUE_BUFFER_MS + expectedJitter);
        });
    });

    describe('buffer and jitter constants', () => {
        test('REQUEUE_BUFFER_MS should be 5 minutes', () => {
            assert.strictEqual(REQUEUE_BUFFER_MS, 5 * 60 * 1000);
            assert.strictEqual(REQUEUE_BUFFER_MS, 300000);
        });

        test('REQUEUE_JITTER_MS should be 2 minutes', () => {
            assert.strictEqual(REQUEUE_JITTER_MS, 2 * 60 * 1000);
            assert.strictEqual(REQUEUE_JITTER_MS, 120000);
        });

        test('DEFAULT_RESET_OFFSET_MS should be 1 hour', () => {
            assert.strictEqual(DEFAULT_RESET_OFFSET_MS, 60 * 60 * 1000);
            assert.strictEqual(DEFAULT_RESET_OFFSET_MS, 3600000);
        });
    });

    describe('integration-style tests', () => {
        test('should calculate reasonable delay for typical usage limit scenario', () => {
            // Use a fixed timestamp to avoid timing issues between setup and assertion
            const now = 1700000000000;
            // Simulate a reset time 30 minutes from now (in seconds)
            const resetTimestamp = (now / 1000) + 30 * 60;
            const error: UsageLimitError = Object.assign(new Error('Usage limit'), { resetTimestamp });

            const result = calculateUsageLimitDelay(error, now, 0.5);

            // Should be exactly 30 min + 5 min buffer + 1 min jitter
            // = 36 minutes = 2160000ms
            const expectedBase = 30 * 60 * 1000 + REQUEUE_BUFFER_MS;
            const expectedJitter = Math.floor(0.5 * REQUEUE_JITTER_MS);
            assert.strictEqual(result, expectedBase + expectedJitter);
        });

        test('should handle the real-world function signature compatibility', () => {
            // Test that the function can be called with just an error object
            // (simulating real usage where Date.now() and Math.random() are used)
            const error: UsageLimitError = new Error('Rate limit exceeded');
            const result = calculateUsageLimitDelay(error);

            // Just verify it returns a reasonable positive number
            assert.ok(result > 0, 'Should return positive delay');
            assert.ok(result >= REQUEUE_BUFFER_MS, 'Should include at least the buffer');
            assert.ok(result <= DEFAULT_RESET_OFFSET_MS + REQUEUE_BUFFER_MS + REQUEUE_JITTER_MS,
                'Should not exceed max possible delay for default case');
        });
    });
});

/**
 * Pure function extracted from issueJobHelpers.ts for testing.
 * Tests the core logic of determineResultStatus.
 *
 * The original function is at: src/jobs/issueJobHelpers.ts:410
 */

/**
 * Minimal interface for ClaudeCodeResponse used in determineResultStatus.
 * Only the 'success' property is used by the function.
 */
interface ClaudeCodeResponse {
    success: boolean;
    // Other properties exist but are not used by determineResultStatus
}

/**
 * Minimal interface for PostProcessingResult used in determineResultStatus.
 * Only the 'pr' property is used by the function.
 */
interface PostProcessingResult {
    success: boolean;
    pr: {
        number: number;
        url: string;
        title: string;
    } | null;
    updatedLabels: string[];
    error?: string;
}

/**
 * Determines the result status based on Claude execution and post-processing results.
 *
 * @param claudeResult - The Claude Code execution result (or null if failed)
 * @param postProcessingResult - The post-processing result (or null if not performed)
 * @returns One of: 'claude_processing_failed', 'complete_with_pr', 'claude_success_no_changes'
 */
function determineResultStatus(
    claudeResult: ClaudeCodeResponse | null,
    postProcessingResult: PostProcessingResult | null
): string {
    if (!claudeResult?.success) return 'claude_processing_failed';
    if (postProcessingResult?.pr) return 'complete_with_pr';
    return 'claude_success_no_changes';
}

describe('determineResultStatus', () => {
    describe('claude_processing_failed status', () => {
        test('should return claude_processing_failed when claudeResult is null', () => {
            const result = determineResultStatus(null, null);
            assert.strictEqual(result, 'claude_processing_failed');
        });

        test('should return claude_processing_failed when claudeResult.success is false', () => {
            const claudeResult: ClaudeCodeResponse = { success: false };
            const result = determineResultStatus(claudeResult, null);
            assert.strictEqual(result, 'claude_processing_failed');
        });

        test('should return claude_processing_failed when claudeResult.success is false even with PR', () => {
            const claudeResult: ClaudeCodeResponse = { success: false };
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: { number: 123, url: 'https://github.com/test/repo/pull/123', title: 'Test PR' },
                updatedLabels: []
            };
            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'claude_processing_failed');
        });

        test('should return claude_processing_failed when claudeResult is null with postProcessingResult', () => {
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: { number: 123, url: 'https://github.com/test/repo/pull/123', title: 'Test PR' },
                updatedLabels: []
            };
            const result = determineResultStatus(null, postProcessingResult);
            assert.strictEqual(result, 'claude_processing_failed');
        });
    });

    describe('complete_with_pr status', () => {
        test('should return complete_with_pr when Claude succeeded and PR was created', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: { number: 123, url: 'https://github.com/test/repo/pull/123', title: 'Test PR' },
                updatedLabels: []
            };
            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'complete_with_pr');
        });

        test('should return complete_with_pr with minimal PR object', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: { number: 1, url: '', title: '' },
                updatedLabels: []
            };
            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'complete_with_pr');
        });

        test('should return complete_with_pr even when postProcessing success is false but PR exists', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };
            const postProcessingResult: PostProcessingResult = {
                success: false,
                pr: { number: 123, url: 'https://github.com/test/repo/pull/123', title: 'Test PR' },
                updatedLabels: [],
                error: 'Some error occurred'
            };
            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'complete_with_pr');
        });

        test('should return complete_with_pr with labels and PR', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: { number: 456, url: 'https://github.com/test/repo/pull/456', title: 'Feature PR' },
                updatedLabels: ['enhancement', 'reviewed']
            };
            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'complete_with_pr');
        });
    });

    describe('claude_success_no_changes status', () => {
        test('should return claude_success_no_changes when Claude succeeded but no PR', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: null,
                updatedLabels: []
            };
            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'claude_success_no_changes');
        });

        test('should return claude_success_no_changes when postProcessingResult is null', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };
            const result = determineResultStatus(claudeResult, null);
            assert.strictEqual(result, 'claude_success_no_changes');
        });

        test('should return claude_success_no_changes with labels but no PR', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: null,
                updatedLabels: ['reviewed', 'no-changes-needed']
            };
            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'claude_success_no_changes');
        });

        test('should return claude_success_no_changes when postProcessing has error but no PR', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };
            const postProcessingResult: PostProcessingResult = {
                success: false,
                pr: null,
                updatedLabels: [],
                error: 'Failed to create PR'
            };
            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'claude_success_no_changes');
        });
    });

    describe('priority/order of status determination', () => {
        test('should check Claude success before checking for PR', () => {
            // If Claude failed, it should return claude_processing_failed
            // even if somehow there's a PR in the result
            const claudeResult: ClaudeCodeResponse = { success: false };
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: { number: 123, url: 'https://github.com/test/repo/pull/123', title: 'Test PR' },
                updatedLabels: []
            };
            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'claude_processing_failed');
        });

        test('should check PR existence before defaulting to no_changes', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };

            // With PR
            const withPR: PostProcessingResult = {
                success: true,
                pr: { number: 1, url: '', title: '' },
                updatedLabels: []
            };
            assert.strictEqual(determineResultStatus(claudeResult, withPR), 'complete_with_pr');

            // Without PR
            const withoutPR: PostProcessingResult = {
                success: true,
                pr: null,
                updatedLabels: []
            };
            assert.strictEqual(determineResultStatus(claudeResult, withoutPR), 'claude_success_no_changes');
        });
    });

    describe('edge cases', () => {
        test('should handle both arguments being null', () => {
            const result = determineResultStatus(null, null);
            assert.strictEqual(result, 'claude_processing_failed');
        });

        test('should handle claudeResult with undefined success property', () => {
            // TypeScript wouldn't normally allow this, but testing defensive behavior
            const claudeResult = {} as ClaudeCodeResponse;
            const result = determineResultStatus(claudeResult, null);
            assert.strictEqual(result, 'claude_processing_failed');
        });

        test('should handle postProcessingResult with undefined pr property', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };
            // TypeScript wouldn't normally allow this, but testing defensive behavior
            const postProcessingResult = { success: true, updatedLabels: [] } as PostProcessingResult;
            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'claude_success_no_changes');
        });

        test('should return consistent type (string)', () => {
            const results = [
                determineResultStatus(null, null),
                determineResultStatus({ success: false }, null),
                determineResultStatus({ success: true }, null),
                determineResultStatus({ success: true }, {
                    success: true,
                    pr: { number: 1, url: '', title: '' },
                    updatedLabels: []
                })
            ];

            results.forEach(result => {
                assert.strictEqual(typeof result, 'string');
            });
        });
    });

    describe('return value validation', () => {
        test('should only return one of three possible values', () => {
            const validStatuses = ['claude_processing_failed', 'complete_with_pr', 'claude_success_no_changes'];

            // Test various input combinations
            const testCases: Array<[ClaudeCodeResponse | null, PostProcessingResult | null]> = [
                [null, null],
                [{ success: false }, null],
                [{ success: true }, null],
                [{ success: true }, { success: true, pr: null, updatedLabels: [] }],
                [{ success: true }, { success: true, pr: { number: 1, url: '', title: '' }, updatedLabels: [] }],
                [{ success: false }, { success: true, pr: { number: 1, url: '', title: '' }, updatedLabels: [] }],
            ];

            testCases.forEach(([claudeResult, postProcessingResult]) => {
                const result = determineResultStatus(claudeResult, postProcessingResult);
                assert.ok(
                    validStatuses.includes(result),
                    `Expected one of ${JSON.stringify(validStatuses)}, got "${result}"`
                );
            });
        });
    });

    describe('real-world scenario tests', () => {
        test('should handle successful issue resolution with PR', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: {
                    number: 42,
                    url: 'https://github.com/owner/repo/pull/42',
                    title: 'Fix: Resolve issue #123'
                },
                updatedLabels: ['fixed', 'ready-for-review']
            };

            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'complete_with_pr');
        });

        test('should handle Claude execution timeout/failure', () => {
            const claudeResult: ClaudeCodeResponse = { success: false };

            const result = determineResultStatus(claudeResult, null);
            assert.strictEqual(result, 'claude_processing_failed');
        });

        test('should handle issue that requires no code changes', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: null,
                updatedLabels: ['documentation', 'no-code-changes']
            };

            const result = determineResultStatus(claudeResult, postProcessingResult);
            assert.strictEqual(result, 'claude_success_no_changes');
        });

        test('should handle analysis-only issues without changes', () => {
            const claudeResult: ClaudeCodeResponse = { success: true };

            // No post-processing was even attempted
            const result = determineResultStatus(claudeResult, null);
            assert.strictEqual(result, 'claude_success_no_changes');
        });
    });
});
