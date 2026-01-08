import { test, after } from 'node:test';
import assert from 'node:assert';

// Set test environment before any imports
process.env.NODE_ENV = 'test';
process.env.GITHUB_REPOS_TO_MONITOR = 'test-owner/test-repo';
process.env.AI_PRIMARY_TAG = 'AI';
process.env.AI_EXCLUDE_TAGS_PROCESSING = 'AI-processing';
process.env.AI_DONE_TAG = 'AI-done';
process.env.MODEL_LABEL_PATTERN = '^llm-claude-(.+)$';
process.env.DEFAULT_CLAUDE_MODEL = 'claude-3-5-sonnet-20240620';

// Use dynamic import
let fetchIssuesForRepo: typeof import('@gitfix/core').fetchIssuesForRepo;
let processDetectedIssue: typeof import('@gitfix/core').processDetectedIssue;

// First test initializes the module
test('fetchIssuesForRepo is exported from @gitfix/core', async () => {
    const coreModule = await import('@gitfix/core');
    fetchIssuesForRepo = coreModule.fetchIssuesForRepo;
    processDetectedIssue = coreModule.processDetectedIssue;

    assert.strictEqual(typeof fetchIssuesForRepo, 'function');
    assert.strictEqual(typeof processDetectedIssue, 'function');
});

test('fetchIssuesForRepo handles invalid repository format', async () => {
    const mockOctokit = { paginate: async () => [] };
    const invalidRepo = 'invalid-format';

    const issues = await fetchIssuesForRepo(mockOctokit, invalidRepo, 'test-correlation-id');
    assert.deepStrictEqual(issues, []);
});

test('fetchIssuesForRepo handles API errors gracefully', async () => {
    const mockOctokit = {
        paginate: async () => {
            const error = new Error('API Error') as Error & { status: number };
            error.status = 500;
            throw error;
        }
    };

    const issues = await fetchIssuesForRepo(mockOctokit, 'owner/repo', 'test-correlation-id');
    assert.deepStrictEqual(issues, []);
});

test('fetchIssuesForRepo handles rate limit errors', async () => {
    const mockOctokit = {
        paginate: async () => {
            const error = new Error('API rate limit exceeded') as Error & { status: number };
            error.status = 403;
            throw error;
        }
    };

    const issues = await fetchIssuesForRepo(mockOctokit, 'owner/repo', 'test-correlation-id');
    assert.deepStrictEqual(issues, []);
});

test('DetectedIssue interface has expected structure', async () => {
    // Test that the expected DetectedIssue structure can be created
    const validDetectedIssue = {
        id: 123,
        number: 1,
        title: 'Test Issue',
        url: 'https://github.com/owner/repo/issues/1',
        repoOwner: 'owner',
        repoName: 'repo',
        labels: ['AI', 'bug'],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z'
    };

    assert.strictEqual(validDetectedIssue.id, 123);
    assert.strictEqual(validDetectedIssue.number, 1);
    assert.strictEqual(validDetectedIssue.repoOwner, 'owner');
    assert.strictEqual(validDetectedIssue.repoName, 'repo');
    assert.ok(Array.isArray(validDetectedIssue.labels));
});

test('config exports required functions', async () => {
    const coreModule = await import('@gitfix/core');

    assert.strictEqual(typeof coreModule.getPrimaryProcessingLabels, 'function');
    assert.strictEqual(typeof coreModule.loadPrimaryProcessingLabelsFromConfig, 'function');
    assert.strictEqual(typeof coreModule.loadReposFromConfig, 'function');
});

test('configLoader returns arrays', async () => {
    const { getPrimaryProcessingLabels, getUserWhitelist } = await import('@gitfix/core');

    const labels = getPrimaryProcessingLabels();
    const whitelist = getUserWhitelist();

    assert.ok(Array.isArray(labels));
    assert.ok(Array.isArray(whitelist));
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
    await new Promise(resolve => setTimeout(resolve, 50));
});
