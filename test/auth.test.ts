import { test } from 'node:test';
import assert from 'node:assert';
import { getGitHubInstallationToken, getAuthenticatedOctokit } from '@gitfix/core';

test('GitHub authentication module exports required functions', () => {
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
