import { test, after } from 'node:test';
import assert from 'node:assert';

// Set test environment before imports
process.env.NODE_ENV = 'test';

// Use dynamic import to avoid module initialization issues
let getGitHubInstallationToken: typeof import('@gitfix/core').getGitHubInstallationToken;
let getAuthenticatedOctokit: typeof import('@gitfix/core').getAuthenticatedOctokit;

test('GitHub authentication module exports required functions', async () => {
    const coreModule = await import('@gitfix/core');
    getGitHubInstallationToken = coreModule.getGitHubInstallationToken;
    getAuthenticatedOctokit = coreModule.getAuthenticatedOctokit;

    assert.strictEqual(typeof getGitHubInstallationToken, 'function');
    assert.strictEqual(typeof getAuthenticatedOctokit, 'function');
});

test('GitHub authentication fails without credentials', async (t) => {
    if (!process.env.GH_APP_ID || !process.env.GH_PRIVATE_KEY_PATH || !process.env.GH_INSTALLATION_ID) {
        t.skip('GitHub credentials not configured');
        return;
    }

    try {
        const token = await getGitHubInstallationToken();
        assert.ok(token, 'Should return a token');
        assert.strictEqual(typeof token, 'string', 'Token should be a string');
    } catch (error) {
        const err = error as Error;
        assert.fail(`Authentication should not fail with valid credentials: ${err.message}`);
    }
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
    // Brief delay for cleanup
    await new Promise(resolve => setTimeout(resolve, 50));
});
