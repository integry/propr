import { test, describe, mock } from 'node:test';
import assert from 'node:assert';

/**
 * Unit tests for ensureEpicPR function
 *
 * These tests validate:
 * - Creates branch, label, and PR successfully
 * - Handles branch exists (422 error)
 * - Handles label exists (422 error)
 * - Handles PR already exists (422 error)
 * - Handles 422 "No commits between" error
 * - Error handling for various failure scenarios
 */

// ========== Setup Mocks Before Imports ==========

// Mock Octokit used by all ensureEpicPR tests
const mockOctokit = {
    request: mock.fn()
};

// Mock logger
const mockLogger = {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
    withCorrelation: mock.fn(() => ({
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
        debug: mock.fn(),
    })),
};

// Mock GitHub auth - must happen before importing the module
await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: {
        getAuthenticatedOctokit: mock.fn(async () => mockOctokit),
    }
});

// Mock logger - must happen before importing the module
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: mockLogger
});

// Now import ensureEpicPR after mocking dependencies
const { ensureEpicPR } = await import('../packages/core/src/services/epicPRService.js');

// ========== Helper Functions ==========

// Helper to reset all mocks between tests
function resetMocks(): void {
    mockOctokit.request.mock.resetCalls();
}

// Helper to create a standard mock implementation for successful flow
function createSuccessfulMockImplementation(options: {
    baseSha?: string;
    prNumber?: number;
    prUrl?: string;
} = {}): (endpoint: string, params?: Record<string, unknown>) => Promise<{ data: unknown }> {
    const {
        baseSha = 'abc123sha',
        prNumber = 42,
        prUrl = 'https://github.com/test-owner/test-repo/pull/42'
    } = options;

    return async (endpoint: string) => {
        if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
            return { data: { object: { sha: baseSha } } };
        }
        if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
            return { data: { ref: 'refs/heads/test-branch' } };
        }
        if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
            return { data: { name: 'base-test-branch', color: '0e8a16' } };
        }
        if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
            return { data: { number: prNumber, html_url: prUrl } };
        }
        return { data: {} };
    };
}

// ========== Tests ==========

describe('ensureEpicPR', () => {

    describe('successful creation flow', () => {

        test('creates branch, label, and PR successfully', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(createSuccessfulMockImplementation({
                baseSha: 'base-sha-123',
                prNumber: 100,
                prUrl: 'https://github.com/owner/repo/pull/100'
            }));

            const result = await ensureEpicPR({
                owner: 'test-owner',
                repoName: 'test-repo',
                firstIssueId: 800,
                planName: 'Test Plan',
                baseBranch: 'main'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.prNumber, 100);
            assert.strictEqual(result.prUrl, 'https://github.com/owner/repo/pull/100');
            assert.ok(result.branchName, 'Should have branchName');
            assert.ok(result.labelName, 'Should have labelName');
            assert.ok(result.branchName!.startsWith('800-epic-'), `Branch name should start with 800-epic-: ${result.branchName}`);
            assert.ok(result.labelName!.startsWith('base-800-epic-'), `Label name should start with base-800-epic-: ${result.labelName}`);
        });

        test('returns correct branch and label names', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(createSuccessfulMockImplementation());

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 123,
                planName: 'Feature Update'
            });

            assert.strictEqual(result.success, true);
            assert.match(result.branchName!, /^123-epic-feature-update-[a-z0-9]{3}$/);
            assert.match(result.labelName!, /^base-123-epic-feature-update-[a-z0-9]{3}$/);
        });

        test('uses main as default base branch', async () => {
            resetMocks();
            let capturedBaseBranch: string | undefined;
            mockOctokit.request.mock.mockImplementation(async (endpoint: string, params?: Record<string, unknown>) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    capturedBaseBranch = (params as { ref: string })?.ref;
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    return { data: { ref: 'refs/heads/test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    return { data: { name: 'base-test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    return { data: { number: 1, html_url: 'https://github.com/o/r/pull/1' } };
                }
                return { data: {} };
            });

            await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test'
            });

            assert.strictEqual(capturedBaseBranch, 'heads/main');
        });

        test('uses custom base branch when provided', async () => {
            resetMocks();
            let capturedBaseBranch: string | undefined;
            mockOctokit.request.mock.mockImplementation(async (endpoint: string, params?: Record<string, unknown>) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    capturedBaseBranch = (params as { ref: string })?.ref;
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    return { data: { ref: 'refs/heads/test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    return { data: { name: 'base-test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    return { data: { number: 1, html_url: 'https://github.com/o/r/pull/1' } };
                }
                return { data: {} };
            });

            await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test',
                baseBranch: 'develop'
            });

            assert.strictEqual(capturedBaseBranch, 'heads/develop');
        });

        test('creates PR as draft', async () => {
            resetMocks();
            let capturedDraft: boolean | undefined;
            mockOctokit.request.mock.mockImplementation(async (endpoint: string, params?: Record<string, unknown>) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    return { data: { ref: 'refs/heads/test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    return { data: { name: 'base-test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    capturedDraft = (params as { draft: boolean })?.draft;
                    return { data: { number: 1, html_url: 'https://github.com/o/r/pull/1' } };
                }
                return { data: {} };
            });

            await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test'
            });

            assert.strictEqual(capturedDraft, true);
        });

        test('falls back to non-draft PR when drafts are not supported', async () => {
            resetMocks();
            const draftAttempts: boolean[] = [];
            mockOctokit.request.mock.mockImplementation(async (endpoint: string, params?: Record<string, unknown>) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    return { data: { ref: 'refs/heads/test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    return { data: { name: 'base-test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    const draft = (params as { draft: boolean })?.draft;
                    draftAttempts.push(draft);
                    if (draft === true) {
                        const err = new Error('Draft pull requests are not supported in this repository.') as Error & { status: number };
                        err.status = 422;
                        throw err;
                    }
                    return { data: { number: 7, html_url: 'https://github.com/o/r/pull/7' } };
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test'
            });

            assert.deepStrictEqual(draftAttempts, [true, false], 'Should try draft first, then retry without draft');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.prNumber, 7);
        });

        test('creates PR with correct title', async () => {
            resetMocks();
            let capturedTitle: string | undefined;
            mockOctokit.request.mock.mockImplementation(async (endpoint: string, params?: Record<string, unknown>) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    return { data: { ref: 'refs/heads/test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    return { data: { name: 'base-test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    capturedTitle = (params as { title: string })?.title;
                    return { data: { number: 1, html_url: 'https://github.com/o/r/pull/1' } };
                }
                return { data: {} };
            });

            await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'My Amazing Feature'
            });

            assert.strictEqual(capturedTitle, '[Epic] My Amazing Feature');
        });

    });

    describe('handles branch already exists (422)', () => {

        test('continues when branch already exists', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    const error = new Error('Reference already exists') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    return { data: { name: 'base-test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    return { data: { number: 50, html_url: 'https://github.com/o/r/pull/50' } };
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test Plan'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.prNumber, 50);
            assert.ok(result.branchName, 'Should have branchName even if branch existed');
            assert.ok(result.labelName, 'Should have labelName');
        });

        test('fails on non-422 branch creation error', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    const error = new Error('Server error') as Error & { status: number };
                    error.status = 500;
                    throw error;
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test Plan'
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.error, 'Should have error message');
        });

    });

    describe('handles label already exists (422)', () => {

        test('continues when label already exists', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    return { data: { ref: 'refs/heads/test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    const error = new Error('already_exists') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    return { data: { number: 60, html_url: 'https://github.com/o/r/pull/60' } };
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test Plan'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.prNumber, 60);
        });

        test('fails on non-422 label creation error', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    return { data: { ref: 'refs/heads/test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    const error = new Error('Forbidden') as Error & { status: number };
                    error.status = 403;
                    throw error;
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test Plan'
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.error, 'Should have error message');
        });

    });

    describe('handles PR already exists (422)', () => {

        test('finds existing PR when PR creation fails with "already exists"', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    return { data: { ref: 'refs/heads/test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    return { data: { name: 'base-test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    const error = new Error('A pull request already exists for owner:123-epic') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                if (endpoint.includes('GET /repos') && endpoint.includes('pulls')) {
                    return {
                        data: [
                            { number: 99, html_url: 'https://github.com/owner/repo/pull/99' }
                        ]
                    };
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 123,
                planName: 'Test Plan'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.prNumber, 99);
            assert.strictEqual(result.prUrl, 'https://github.com/owner/repo/pull/99');
        });

        test('fails when PR already exists but cannot find existing PR', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    return { data: { ref: 'refs/heads/test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    return { data: { name: 'base-test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    const error = new Error('A pull request already exists') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                if (endpoint.includes('GET /repos') && endpoint.includes('pulls')) {
                    return { data: [] }; // No PRs found
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 123,
                planName: 'Test Plan'
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('no existing PR found') || result.error?.includes('Epic PR creation failed'),
                `Error should mention PR not found: ${result.error}`);
        });

    });

    describe('handles 422 "No commits between" error', () => {

        test('returns success without PR when no commits between branches', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    return { data: { ref: 'refs/heads/test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    return { data: { name: 'base-test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    const error = new Error('No commits between main and 123-epic-test-plan-abc') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 123,
                planName: 'Test Plan'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.prNumber, undefined, 'prNumber should be undefined');
            assert.strictEqual(result.prUrl, undefined, 'prUrl should be undefined');
            assert.ok(result.branchName, 'Should have branchName');
            assert.ok(result.labelName, 'Should have labelName');
        });

        test('branch and label are ready for future commits', async () => {
            resetMocks();
            let branchCreated = false;
            let labelCreated = false;

            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    branchCreated = true;
                    return { data: { ref: 'refs/heads/test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    labelCreated = true;
                    return { data: { name: 'base-test-branch' } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    const error = new Error('No commits between main and epic-branch') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 456,
                planName: 'Future Feature'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(branchCreated, true, 'Branch should have been created');
            assert.strictEqual(labelCreated, true, 'Label should have been created');
        });

    });

    describe('error handling', () => {

        test('returns failure when getting base branch SHA fails', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    throw new Error('Branch not found');
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test'
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('Branch not found') || result.error?.includes('not found'),
                `Error should mention branch not found: ${result.error}`);
        });

        test('returns failure with error message on general error', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async () => {
                throw new Error('Unexpected API error');
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test'
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.error, 'Should have error message');
            assert.ok(result.error!.length > 0, 'Error message should not be empty');
        });

        test('handles network timeout errors', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async () => {
                const error = new Error('Request timeout') as Error & { code: string };
                error.code = 'ETIMEDOUT';
                throw error;
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test'
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.error, 'Should have error message');
        });

    });

    describe('correlation ID support', () => {

        test('works with correlation ID', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(createSuccessfulMockImplementation());

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test',
                correlationId: 'test-correlation-123'
            });

            assert.strictEqual(result.success, true);
        });

        test('works without correlation ID', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(createSuccessfulMockImplementation());

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 1,
                planName: 'Test'
                // No correlationId
            });

            assert.strictEqual(result.success, true);
        });

    });

    describe('integration scenarios', () => {

        test('handles both branch and label already existing', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    const error = new Error('Reference already exists') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    const error = new Error('already_exists') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    return { data: { number: 77, html_url: 'https://github.com/o/r/pull/77' } };
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 500,
                planName: 'Existing Setup'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.prNumber, 77);
        });

        test('handles branch exists, label exists, and PR exists', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    const error = new Error('Reference already exists') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    const error = new Error('already_exists') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    const error = new Error('A pull request already exists') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                if (endpoint.includes('GET /repos') && endpoint.includes('pulls')) {
                    return {
                        data: [
                            { number: 88, html_url: 'https://github.com/owner/repo/pull/88' }
                        ]
                    };
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 600,
                planName: 'Full Existing Setup'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.prNumber, 88);
            assert.strictEqual(result.prUrl, 'https://github.com/owner/repo/pull/88');
        });

        test('handles branch exists, label exists, and no commits between branches', async () => {
            resetMocks();
            mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
                if (endpoint.includes('GET /repos') && endpoint.includes('git/ref')) {
                    return { data: { object: { sha: 'sha123' } } };
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('git/refs')) {
                    const error = new Error('Reference already exists') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('labels')) {
                    const error = new Error('already_exists') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                if (endpoint.includes('POST /repos') && endpoint.includes('pulls')) {
                    const error = new Error('No commits between main and branch') as Error & { status: number };
                    error.status = 422;
                    throw error;
                }
                return { data: {} };
            });

            const result = await ensureEpicPR({
                owner: 'owner',
                repoName: 'repo',
                firstIssueId: 700,
                planName: 'Ready for Commits'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.prNumber, undefined);
            assert.strictEqual(result.prUrl, undefined);
            assert.ok(result.branchName);
            assert.ok(result.labelName);
        });

    });

});
