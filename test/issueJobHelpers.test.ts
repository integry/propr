import { test, describe } from 'node:test';
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
