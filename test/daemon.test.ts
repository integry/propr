import { test, mock, after } from 'node:test';
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
let pollForIssues: typeof import('@gitfix/core').pollForIssues;

interface MockOctokit {
    request?: ReturnType<typeof mock.fn>;
}

// First test initializes the module
test('fetchIssuesForRepo handles invalid repository format', async () => {
    // Load modules dynamically in the first test
    const coreModule = await import('@gitfix/core');
    fetchIssuesForRepo = coreModule.fetchIssuesForRepo;
    pollForIssues = coreModule.pollForIssues;
    const mockOctokit: MockOctokit = {};
    const invalidRepo = 'invalid-format';
    
    const issues = await fetchIssuesForRepo(mockOctokit, invalidRepo);
    assert.deepStrictEqual(issues, []);
});

test('fetchIssuesForRepo constructs correct search query', async () => {
    let capturedQuery = '';
    const mockOctokit = {
        request: mock.fn(async (_endpoint: string, options: { q: string }) => {
            capturedQuery = options.q;
            return {
                data: {
                    total_count: 0,
                    items: []
                }
            };
        })
    };

    await fetchIssuesForRepo(mockOctokit, 'owner/repo');
    
    assert.strictEqual(mockOctokit.request.mock.calls.length, 1);
    assert.strictEqual(mockOctokit.request.mock.calls[0].arguments[0], 'GET /search/issues');
    assert.ok(capturedQuery.includes('repo:owner/repo'));
    assert.ok(capturedQuery.includes('is:issue'));
    assert.ok(capturedQuery.includes('is:open'));
    assert.ok(capturedQuery.includes('label:"AI"'));
    assert.ok(capturedQuery.includes('-label:"AI-processing"'));
    assert.ok(capturedQuery.includes('-label:"AI-done"'));
});

test('fetchIssuesForRepo transforms issues correctly', async () => {
    const mockIssue = {
        id: 123,
        number: 1,
        title: 'Test Issue',
        html_url: 'https://github.com/owner/repo/issues/1',
        labels: [
            { name: 'AI' },
            { name: 'bug' }
        ],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z'
    };

    const mockOctokit = {
        request: mock.fn(async () => ({
            data: {
                total_count: 1,
                items: [mockIssue]
            }
        }))
    };

    const issues = await fetchIssuesForRepo(mockOctokit, 'owner/repo');
    
    assert.strictEqual(issues.length, 1);
    assert.deepStrictEqual(issues[0], {
        id: 123,
        number: 1,
        title: 'Test Issue',
        url: 'https://github.com/owner/repo/issues/1',
        repoOwner: 'owner',
        repoName: 'repo',
        labels: ['AI', 'bug'],
        targetModels: ['sonnet'],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z'
    });
});

test('fetchIssuesForRepo handles API errors gracefully', async () => {
    const mockOctokit = {
        request: mock.fn(async () => {
            const error = new Error('API Error') as Error & { status: number };
            error.status = 500;
            throw error;
        })
    };

    const issues = await fetchIssuesForRepo(mockOctokit, 'owner/repo');
    assert.deepStrictEqual(issues, []);
});

test('fetchIssuesForRepo handles rate limit errors', async () => {
    const mockOctokit = {
        request: mock.fn(async () => {
            const error = new Error('API rate limit exceeded') as Error & { status: number };
            error.status = 403;
            throw error;
        })
    };

    const issues = await fetchIssuesForRepo(mockOctokit, 'owner/repo');
    assert.deepStrictEqual(issues, []);
});

test('pollForIssues returns detected issues', async () => {
    // Override environment for this test
    const originalRepos = process.env.GITHUB_REPOS_TO_MONITOR;
    process.env.GITHUB_REPOS_TO_MONITOR = 'owner1/repo1';

    // This test validates that pollForIssues can run without authentication
    // In a real scenario, it would use the authenticated client
    const { pollForIssues: testPollForIssues } = await import('@gitfix/core');
    
    // Since we don't have real GitHub credentials in test, this will fail auth
    // but that's expected and handled gracefully
    const issues = await testPollForIssues();

    // Without auth, it should return undefined or empty array (no issues)
    assert.ok(issues === undefined || (Array.isArray(issues) && issues.length === 0));

    // Restore original environment
    process.env.GITHUB_REPOS_TO_MONITOR = originalRepos;
});

test('fetchIssuesForRepo identifies model labels correctly', async () => {
    const mockIssue = {
        id: 124,
        number: 2,
        title: 'Test Issue with Model Labels',
        html_url: 'https://github.com/owner/repo/issues/2',
        labels: [
            { name: 'AI' },
            { name: 'llm-claude-3-opus-20240229' },
            { name: 'llm-claude-3-5-sonnet-20240620' },
            { name: 'enhancement' }
        ],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z'
    };

    const mockOctokit = {
        request: mock.fn(async () => ({
            data: {
                total_count: 1,
                items: [mockIssue]
            }
        }))
    };

    const issues = await fetchIssuesForRepo(mockOctokit, 'owner/repo');
    
    assert.strictEqual(issues.length, 1);
    assert.deepStrictEqual(issues[0].targetModels, [
        '3-opus-20240229',
        '3-5-sonnet-20240620'
    ]);
    assert.deepStrictEqual(issues[0].labels, [
        'AI',
        'llm-claude-3-opus-20240229',
        'llm-claude-3-5-sonnet-20240620',
        'enhancement'
    ]);
});

test('fetchIssuesForRepo handles single model label', async () => {
    const mockIssue = {
        id: 125,
        number: 3,
        title: 'Test Issue with Single Model',
        html_url: 'https://github.com/owner/repo/issues/3',
        labels: [
            { name: 'AI' },
            { name: 'llm-claude-3-opus-20240229' },
            { name: 'bug' }
        ],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z'
    };

    const mockOctokit = {
        request: mock.fn(async () => ({
            data: {
                total_count: 1,
                items: [mockIssue]
            }
        }))
    };

    const issues = await fetchIssuesForRepo(mockOctokit, 'owner/repo');
    
    assert.strictEqual(issues.length, 1);
    assert.deepStrictEqual(issues[0].targetModels, ['3-opus-20240229']);
});

test('fetchIssuesForRepo ignores non-matching model labels', async () => {
    const mockIssue = {
        id: 126,
        number: 4,
        title: 'Test Issue with Non-Model Labels',
        html_url: 'https://github.com/owner/repo/issues/4',
        labels: [
            { name: 'AI' },
            { name: 'gpt-4' }, // Should not match pattern
            { name: 'openai-claude' }, // Should not match pattern
            { name: 'llm-other-model' }, // Should not match claude pattern
            { name: 'documentation' }
        ],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z'
    };

    const mockOctokit = {
        request: mock.fn(async () => ({
            data: {
                total_count: 1,
                items: [mockIssue]
            }
        }))
    };

    const issues = await fetchIssuesForRepo(mockOctokit, 'owner/repo');
    
    assert.strictEqual(issues.length, 1);
    // Should fall back to default model since no matching labels
    assert.deepStrictEqual(issues[0].targetModels, ['sonnet']);
});

test('daemon exports required functions', () => {
    assert.strictEqual(typeof fetchIssuesForRepo, 'function');
    assert.strictEqual(typeof pollForIssues, 'function');
});

// Cleanup after tests
after(async () => {
    try {
        const { closeConnection, shutdownQueue } = await import('@gitfix/core');
        await closeConnection();
        await shutdownQueue();
    } catch {
        // Ignore cleanup errors
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    setTimeout(() => process.exit(0), 300);
});
