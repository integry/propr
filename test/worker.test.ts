import { test, mock, after } from 'node:test';
import assert from 'node:assert';

// Set up environment variables for testing
process.env.NODE_ENV = 'test';
process.env.AI_PROCESSING_TAG = 'AI-processing';
process.env.AI_PRIMARY_TAG = 'AI';
process.env.AI_DONE_TAG = 'AI-done';
process.env.SIMULATED_WORK_MS = '100'; // Fast for testing

// Mock modules
const mockOctokit = {
    request: mock.fn()
};

const mockWorker = {
    on: mock.fn(),
    close: mock.fn(async () => {}),
    processor: null as ((job: unknown) => Promise<unknown>) | null
};

// Mock dependencies
await mock.module('../src/auth/githubAuth.ts', {
    namedExports: {
        getAuthenticatedOctokit: mock.fn(async () => mockOctokit)
    }
});

await mock.module('../src/queue/taskQueue.ts', {
    namedExports: {
        GITHUB_ISSUE_QUEUE_NAME: 'test-queue',
        createWorker: mock.fn((name: string, processor: (job: unknown) => Promise<unknown>) => {
            mockWorker.processor = processor;
            return mockWorker;
        })
    }
});

await mock.module('../src/utils/llmMetrics.ts', {
    namedExports: {
        recordLLMMetrics: mock.fn(async () => {})
    }
});

// Import the worker module
const { processGitHubIssueJob, startWorker } = await import('../src/worker.ts');

interface MockJob {
    id: string;
    name: string;
    data: {
        id?: number;
        number: number;
        title?: string;
        url?: string;
        repoOwner: string;
        repoName: string;
        labels?: string[];
    };
    updateProgress?: ReturnType<typeof mock.fn>;
}

test('processGitHubIssueJob adds processing tag to issue', async () => {
    const mockJob: MockJob = {
        id: 'job-123',
        name: 'processGitHubIssue',
        data: {
            id: 1,
            number: 42,
            title: 'Test Issue',
            url: 'https://github.com/test/repo/issues/42',
            repoOwner: 'test',
            repoName: 'repo',
            labels: ['AI'],
        },
        updateProgress: mock.fn(),
    };

    // Mock GitHub API responses
    mockOctokit.request.mock.mockImplementation(async (endpoint: string, params: { issue_number?: number; labels?: string[] }) => {
        if (endpoint.includes('GET /repos')) {
            return {
                data: {
                    labels: [{ name: 'AI' }]
                }
            };
        }
        if (endpoint.includes('POST') && endpoint.includes('labels')) {
            return { data: {} };
        }
        if (endpoint.includes('POST') && endpoint.includes('comments')) {
            return { data: {} };
        }
        return { data: {} };
    });

    const result = await processGitHubIssueJob(mockJob);

    assert.strictEqual(result.status, 'simulated_processing_complete');
    assert.strictEqual(result.issueNumber, 42);

    // Verify GitHub API calls
    const apiCalls = mockOctokit.request.mock.calls;

    // Should get issue data
    assert.ok(apiCalls.some((call: { arguments: [string, { issue_number?: number }] }) =>
        call.arguments[0].includes('GET /repos') &&
        call.arguments[1].issue_number === 42
    ));

    // Should add processing tag
    assert.ok(apiCalls.some((call: { arguments: [string, { labels?: string[] }] }) =>
        call.arguments[0].includes('POST') &&
        call.arguments[0].includes('labels') &&
        call.arguments[1].labels?.includes('AI-processing')
    ));

    // Should add comment
    assert.ok(apiCalls.some((call: { arguments: [string, unknown] }) =>
        call.arguments[0].includes('POST') &&
        call.arguments[0].includes('comments')
    ));
});

test('processGitHubIssueJob skips issue without primary tag', async () => {
    const mockJob: MockJob = {
        id: 'job-124',
        name: 'processGitHubIssue',
        data: {
            number: 43,
            repoOwner: 'test',
            repoName: 'repo',
        },
        updateProgress: mock.fn(),
    };

    mockOctokit.request.mock.resetCalls();
    mockOctokit.request.mock.mockImplementation(async () => ({
        data: {
            labels: [{ name: 'bug' }] // No AI tag
        }
    }));

    const result = await processGitHubIssueJob(mockJob);

    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.reason, 'Primary tag missing');
});

test('processGitHubIssueJob skips issue with done tag', async () => {
    const mockJob: MockJob = {
        id: 'job-125',
        name: 'processGitHubIssue',
        data: {
            number: 44,
            repoOwner: 'test',
            repoName: 'repo',
        },
        updateProgress: mock.fn(),
    };

    mockOctokit.request.mock.resetCalls();
    mockOctokit.request.mock.mockImplementation(async () => ({
        data: {
            labels: [{ name: 'AI' }, { name: 'AI-done' }]
        }
    }));

    const result = await processGitHubIssueJob(mockJob);

    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.reason, 'Already done');
});

test('processGitHubIssueJob handles already processing issues', async () => {
    const mockJob: MockJob = {
        id: 'job-126',
        name: 'processGitHubIssue',
        data: {
            number: 45,
            repoOwner: 'test',
            repoName: 'repo',
        },
        updateProgress: mock.fn(),
    };

    mockOctokit.request.mock.resetCalls();
    mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
        if (endpoint.includes('GET /repos')) {
            return {
                data: {
                    labels: [{ name: 'AI' }, { name: 'AI-processing' }]
                }
            };
        }
        return { data: {} };
    });

    const result = await processGitHubIssueJob(mockJob);

    assert.strictEqual(result.status, 'simulated_processing_complete');

    // Should not try to add processing tag again
    const labelCalls = mockOctokit.request.mock.calls.filter((call: { arguments: [string, unknown] }) =>
        call.arguments[0].includes('labels')
    );
    assert.strictEqual(labelCalls.length, 0);
});

test('processGitHubIssueJob handles authentication errors', async () => {
    const mockJob: MockJob = {
        id: 'job-127',
        name: 'processGitHubIssue',
        data: {
            number: 46,
            repoOwner: 'test',
            repoName: 'repo',
        },
    };

    // Mock auth failure
    const { getAuthenticatedOctokit } = await import('../src/auth/githubAuth.ts');
    (getAuthenticatedOctokit as ReturnType<typeof mock.fn>).mock.mockImplementationOnce(async () => {
        throw new Error('Auth failed');
    });

    await assert.rejects(
        processGitHubIssueJob(mockJob),
        /Auth failed/
    );
});

test('startWorker creates worker with correct configuration', async () => {
    const { createWorker } = await import('../src/queue/taskQueue.ts');
    (createWorker as ReturnType<typeof mock.fn>).mock.resetCalls();

    const worker = startWorker();

    assert.ok(worker);
    assert.strictEqual((createWorker as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.strictEqual((createWorker as ReturnType<typeof mock.fn>).mock.calls[0].arguments[0], 'test-queue');
    assert.strictEqual(typeof (createWorker as ReturnType<typeof mock.fn>).mock.calls[0].arguments[1], 'function');
});

// Cleanup after tests
after(async () => {
    try {
        const { closeConnection } = await import('@gitfix/core');
        await closeConnection();
    } catch {
        // Ignore cleanup errors
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    setTimeout(() => process.exit(0), 300);
});
