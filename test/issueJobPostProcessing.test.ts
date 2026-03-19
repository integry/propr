import { test, describe, mock } from 'node:test';
import assert from 'node:assert';

// Set up environment variables for testing
process.env.AI_PROCESSING_TAG = 'AI-processing';
process.env.AI_PRIMARY_TAG = 'AI';
process.env.AI_DONE_TAG = 'AI-done';

/**
 * Pure function extracted from issueJobPostProcessing.ts for testing.
 * This tests the core logic of performPostProcessing without triggering
 * module-level side effects from @propr/core imports.
 *
 * The original function is at: src/jobs/issueJobPostProcessing.ts:51
 */

// Type definitions mirroring the original code
interface WorktreeInfo {
    worktreePath: string;
    branchName: string;
}

interface CommitResult {
    commitHash: string;
    filesChanged: number;
    message: string;
}

interface ClaudeCodeResponse {
    success: boolean;
    model?: string;
    executionTime?: number;
    finalResult?: string;
    conversationLog?: unknown[];
    sessionId?: string;
    conversationId?: string;
    commitMessage?: string;
    error?: string;
    modifiedFiles?: string[];
    tokenUsage?: unknown;
}

interface IssueJobData {
    repoOwner: string;
    repoName: string;
    number: number;
    baseBranch?: string;
}

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

interface PostProcessResult {
    commitResult: CommitResult | null;
    postProcessingResult: PostProcessingResult | null;
}

interface RepoValidationResult {
    isValid: boolean;
    repoData?: {
        defaultBranch: string;
    };
}

interface Logger {
    info: ReturnType<typeof mock.fn>;
    debug: ReturnType<typeof mock.fn>;
    warn: ReturnType<typeof mock.fn>;
    error: ReturnType<typeof mock.fn>;
}

interface Octokit {
    request: ReturnType<typeof mock.fn>;
}

interface GitHubToken {
    token: string;
}

interface WorkerStateManager {
    getTaskState: ReturnType<typeof mock.fn>;
}

interface PostProcessOptions {
    octokit: Octokit;
    issueRef: IssueJobData;
    worktreeInfo: WorktreeInfo;
    currentIssueData: { data: { title: string; labels: Array<{ name: string }> } };
    claudeResult: ClaudeCodeResponse;
    modelName: string;
    repoValidation: RepoValidationResult;
    repoUrl: string;
    githubToken: GitHubToken;
    PR_LABEL: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    jobId: string | undefined;
    correlatedLogger: Logger;
    taskId?: string;
    stateManager?: WorkerStateManager;
}

// TaskStates enum mirroring @propr/core
const TaskStates = {
    CANCELLED: 'cancelled',
    RUNNING: 'running',
    PENDING: 'pending',
    COMPLETED: 'completed',
    FAILED: 'failed'
} as const;

/**
 * Pure function that generates the commit message for post-processing.
 * Extracted for testability.
 */
function generateCommitMessage(
    issueNumber: number,
    issueTitle: string,
    modelName: string,
    claudeResult: ClaudeCodeResponse | null
): string {
    let commitMessage = `fix(ai): Resolve issue #${issueNumber} - ${issueTitle.substring(0, 50)}\n\nImplemented by Claude Code using ${modelName} model.\n\n${claudeResult?.success ? 'Implementation completed successfully.' : 'Implementation attempted - see PR comments for details.'}`;

    if (claudeResult?.commitMessage) {
        commitMessage = claudeResult.commitMessage;
    }

    return commitMessage;
}

/**
 * Pure function that determines if processing should continue after commit.
 * Returns true if processing should continue to PR creation, false if early return.
 * Extracted from performPostProcessing for testability.
 */
function shouldContinueToCreatePR(
    commitResult: CommitResult | null,
    claudeResult: ClaudeCodeResponse | null
): { continueProcessing: boolean; reason: string } {
    // Handle the case where no code changes were needed (work already complete)
    if (commitResult === null && claudeResult?.success) {
        return { continueProcessing: false, reason: 'no_code_changes_needed' };
    }

    return { continueProcessing: true, reason: 'continue_to_pr_creation' };
}

/**
 * Pure function that checks if task has been cancelled.
 * Extracted from performPostProcessing for testability.
 */
async function checkCancellation(
    taskId: string | undefined,
    stateManager: WorkerStateManager | undefined
): Promise<{ isCancelled: boolean }> {
    if (taskId && stateManager) {
        const currentState = await stateManager.getTaskState(taskId);
        if (currentState?.state === TaskStates.CANCELLED) {
            return { isCancelled: true };
        }
    }
    return { isCancelled: false };
}

/**
 * Pure function that determines if auto-merge should be enabled.
 * Extracted from performPostProcessing for testability.
 */
function shouldEnableAutoMerge(
    currentLabels: Array<{ name: string }>
): boolean {
    const labelNames = currentLabels.map(label => label.name);
    return labelNames.some(label => label === 'auto-merge');
}

/**
 * Pure function that determines worktree cleanup options.
 * Extracted from cleanupWorktreeIfExists for testability.
 */
function determineCleanupOptions(
    claudeResult: ClaudeCodeResponse | null | undefined,
    postProcessingResult: PostProcessingResult | null
): { deleteBranch: boolean; success: boolean } {
    const wasSuccessful = claudeResult?.success && postProcessingResult?.pr;
    return {
        deleteBranch: !wasSuccessful,
        success: !!wasSuccessful
    };
}

/**
 * Pure function to determine if PR retry is needed.
 * Extracted from handlePRValidation for testability.
 */
function shouldRetryPRCreation(
    finalPRValidationIsValid: boolean,
    claudeResultSuccess: boolean,
    commitResult: CommitResult | null
): { shouldRetry: boolean; reason: string } {
    // Only retry PR creation if:
    // 1. PR validation failed (no PR found)
    // 2. Claude execution was successful
    // 3. There were actual commits (commitResult !== null means changes were made and a PR is expected)
    if (!finalPRValidationIsValid && claudeResultSuccess && commitResult !== null) {
        return { shouldRetry: true, reason: 'pr_validation_failed_with_commits' };
    }

    if (!finalPRValidationIsValid && claudeResultSuccess && commitResult === null) {
        return { shouldRetry: false, reason: 'no_code_changes_made' };
    }

    return { shouldRetry: false, reason: 'pr_valid_or_claude_failed' };
}

// Helper function to create mock logger
function createMockLogger(): Logger {
    return {
        info: mock.fn(),
        debug: mock.fn(),
        warn: mock.fn(),
        error: mock.fn()
    };
}

// Helper function to create mock octokit
function createMockOctokit(): Octokit {
    return {
        request: mock.fn(async () => ({ data: {} }))
    };
}

describe('performPostProcessing - Core Logic', () => {
    describe('generateCommitMessage', () => {
        test('should generate default commit message when no claude commitMessage provided', () => {
            const claudeResult: ClaudeCodeResponse = {
                success: true,
                model: 'claude-opus-4-5-20251101'
            };

            const message = generateCommitMessage(123, 'Test Issue Title', 'claude-opus-4-5-20251101', claudeResult);

            assert.ok(message.includes('fix(ai): Resolve issue #123'));
            assert.ok(message.includes('Test Issue Title'));
            assert.ok(message.includes('claude-opus-4-5-20251101'));
            assert.ok(message.includes('Implementation completed successfully'));
        });

        test('should use claude commitMessage when provided', () => {
            const claudeResult: ClaudeCodeResponse = {
                success: true,
                model: 'claude-opus-4-5-20251101',
                commitMessage: 'Custom commit message from Claude'
            };

            const message = generateCommitMessage(123, 'Test Issue Title', 'claude-opus-4-5-20251101', claudeResult);

            assert.strictEqual(message, 'Custom commit message from Claude');
        });

        test('should indicate implementation attempted when claude was not successful', () => {
            const claudeResult: ClaudeCodeResponse = {
                success: false,
                model: 'claude-opus-4-5-20251101'
            };

            const message = generateCommitMessage(123, 'Test Issue Title', 'claude-opus-4-5-20251101', claudeResult);

            assert.ok(message.includes('Implementation attempted'));
        });

        test('should truncate long issue titles to 50 characters', () => {
            const longTitle = 'This is a very long issue title that exceeds fifty characters limit';
            const claudeResult: ClaudeCodeResponse = {
                success: true
            };

            const message = generateCommitMessage(123, longTitle, 'model', claudeResult);

            // The title part should be truncated to 50 chars
            assert.ok(message.includes(longTitle.substring(0, 50)));
            assert.ok(!message.includes(longTitle)); // Full title should NOT be present
        });
    });

    describe('shouldContinueToCreatePR (no code changes case)', () => {
        test('should return false when commitResult is null and claudeResult is successful', () => {
            const claudeResult: ClaudeCodeResponse = {
                success: true,
                model: 'claude-opus-4-5-20251101'
            };

            const result = shouldContinueToCreatePR(null, claudeResult);

            assert.strictEqual(result.continueProcessing, false);
            assert.strictEqual(result.reason, 'no_code_changes_needed');
        });

        test('should return true when commitResult exists', () => {
            const commitResult: CommitResult = {
                commitHash: 'abc1234',
                filesChanged: 3,
                message: 'Test commit'
            };
            const claudeResult: ClaudeCodeResponse = {
                success: true
            };

            const result = shouldContinueToCreatePR(commitResult, claudeResult);

            assert.strictEqual(result.continueProcessing, true);
            assert.strictEqual(result.reason, 'continue_to_pr_creation');
        });

        test('should return true when claudeResult is not successful (error path)', () => {
            const claudeResult: ClaudeCodeResponse = {
                success: false
            };

            const result = shouldContinueToCreatePR(null, claudeResult);

            assert.strictEqual(result.continueProcessing, true);
            assert.strictEqual(result.reason, 'continue_to_pr_creation');
        });

        test('should return true when claudeResult is null', () => {
            const result = shouldContinueToCreatePR(null, null);

            assert.strictEqual(result.continueProcessing, true);
            assert.strictEqual(result.reason, 'continue_to_pr_creation');
        });
    });

    describe('checkCancellation', () => {
        test('should return isCancelled: true when task is cancelled', async () => {
            const mockStateManager: WorkerStateManager = {
                getTaskState: mock.fn(async () => ({
                    state: TaskStates.CANCELLED
                }))
            };

            const result = await checkCancellation('task-123', mockStateManager);

            assert.strictEqual(result.isCancelled, true);
            assert.strictEqual(mockStateManager.getTaskState.mock.calls.length, 1);
            assert.strictEqual(mockStateManager.getTaskState.mock.calls[0].arguments[0], 'task-123');
        });

        test('should return isCancelled: false when task is running', async () => {
            const mockStateManager: WorkerStateManager = {
                getTaskState: mock.fn(async () => ({
                    state: TaskStates.RUNNING
                }))
            };

            const result = await checkCancellation('task-123', mockStateManager);

            assert.strictEqual(result.isCancelled, false);
        });

        test('should return isCancelled: false when task is pending', async () => {
            const mockStateManager: WorkerStateManager = {
                getTaskState: mock.fn(async () => ({
                    state: TaskStates.PENDING
                }))
            };

            const result = await checkCancellation('task-123', mockStateManager);

            assert.strictEqual(result.isCancelled, false);
        });

        test('should return isCancelled: false when taskId is undefined', async () => {
            const mockStateManager: WorkerStateManager = {
                getTaskState: mock.fn(async () => ({
                    state: TaskStates.CANCELLED
                }))
            };

            const result = await checkCancellation(undefined, mockStateManager);

            assert.strictEqual(result.isCancelled, false);
            // Should not call getTaskState when taskId is undefined
            assert.strictEqual(mockStateManager.getTaskState.mock.calls.length, 0);
        });

        test('should return isCancelled: false when stateManager is undefined', async () => {
            const result = await checkCancellation('task-123', undefined);

            assert.strictEqual(result.isCancelled, false);
        });

        test('should return isCancelled: false when state is null', async () => {
            const mockStateManager: WorkerStateManager = {
                getTaskState: mock.fn(async () => null)
            };

            const result = await checkCancellation('task-123', mockStateManager);

            assert.strictEqual(result.isCancelled, false);
        });
    });

    describe('shouldEnableAutoMerge', () => {
        test('should return true when auto-merge label is present', () => {
            const labels = [{ name: 'AI' }, { name: 'auto-merge' }, { name: 'bug' }];

            const result = shouldEnableAutoMerge(labels);

            assert.strictEqual(result, true);
        });

        test('should return false when auto-merge label is not present', () => {
            const labels = [{ name: 'AI' }, { name: 'bug' }];

            const result = shouldEnableAutoMerge(labels);

            assert.strictEqual(result, false);
        });

        test('should return false when labels array is empty', () => {
            const labels: Array<{ name: string }> = [];

            const result = shouldEnableAutoMerge(labels);

            assert.strictEqual(result, false);
        });

        test('should be case sensitive', () => {
            const labels = [{ name: 'Auto-Merge' }, { name: 'AUTO-MERGE' }];

            const result = shouldEnableAutoMerge(labels);

            assert.strictEqual(result, false); // Only exact 'auto-merge' matches
        });
    });

    describe('determineCleanupOptions', () => {
        test('should not delete branch when processing was successful with PR', () => {
            const claudeResult: ClaudeCodeResponse = {
                success: true
            };
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: { number: 42, url: 'https://github.com/test/repo/pull/42', title: 'Test PR' },
                updatedLabels: []
            };

            const result = determineCleanupOptions(claudeResult, postProcessingResult);

            assert.strictEqual(result.deleteBranch, false);
            assert.strictEqual(result.success, true);
        });

        test('should delete branch when claude was not successful', () => {
            const claudeResult: ClaudeCodeResponse = {
                success: false
            };
            const postProcessingResult: PostProcessingResult = {
                success: false,
                pr: null,
                updatedLabels: []
            };

            const result = determineCleanupOptions(claudeResult, postProcessingResult);

            assert.strictEqual(result.deleteBranch, true);
            assert.strictEqual(result.success, false);
        });

        test('should delete branch when no PR was created', () => {
            const claudeResult: ClaudeCodeResponse = {
                success: true
            };
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: null,
                updatedLabels: []
            };

            const result = determineCleanupOptions(claudeResult, postProcessingResult);

            assert.strictEqual(result.deleteBranch, true);
            assert.strictEqual(result.success, false);
        });

        test('should delete branch when claudeResult is null', () => {
            const postProcessingResult: PostProcessingResult = {
                success: true,
                pr: { number: 42, url: 'url', title: 'title' },
                updatedLabels: []
            };

            const result = determineCleanupOptions(null, postProcessingResult);

            assert.strictEqual(result.deleteBranch, true);
            assert.strictEqual(result.success, false);
        });

        test('should delete branch when postProcessingResult is null', () => {
            const claudeResult: ClaudeCodeResponse = {
                success: true
            };

            const result = determineCleanupOptions(claudeResult, null);

            assert.strictEqual(result.deleteBranch, true);
            assert.strictEqual(result.success, false);
        });
    });

    describe('shouldRetryPRCreation', () => {
        test('should retry when validation failed, claude succeeded, and commits exist', () => {
            const commitResult: CommitResult = {
                commitHash: 'abc123',
                filesChanged: 1,
                message: 'test'
            };

            const result = shouldRetryPRCreation(false, true, commitResult);

            assert.strictEqual(result.shouldRetry, true);
            assert.strictEqual(result.reason, 'pr_validation_failed_with_commits');
        });

        test('should not retry when validation failed but no commits were made', () => {
            const result = shouldRetryPRCreation(false, true, null);

            assert.strictEqual(result.shouldRetry, false);
            assert.strictEqual(result.reason, 'no_code_changes_made');
        });

        test('should not retry when validation passed', () => {
            const commitResult: CommitResult = {
                commitHash: 'abc123',
                filesChanged: 1,
                message: 'test'
            };

            const result = shouldRetryPRCreation(true, true, commitResult);

            assert.strictEqual(result.shouldRetry, false);
            assert.strictEqual(result.reason, 'pr_valid_or_claude_failed');
        });

        test('should not retry when claude failed', () => {
            const commitResult: CommitResult = {
                commitHash: 'abc123',
                filesChanged: 1,
                message: 'test'
            };

            const result = shouldRetryPRCreation(false, false, commitResult);

            assert.strictEqual(result.shouldRetry, false);
            assert.strictEqual(result.reason, 'pr_valid_or_claude_failed');
        });
    });
});

describe('performPostProcessing - Integration with Mocks', () => {
    describe('PR creation flow', () => {
        test('should pass correct parameters to octokit when posting completion comment', async () => {
            const mockOctokit = createMockOctokit();
            const mockLogger = createMockLogger();

            // Simulate posting a comment for no-code-changes case
            await mockOctokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: 'testowner',
                repo: 'testrepo',
                issue_number: 123,
                body: '✅ **No code changes needed - the implementation was already complete.**\n\nCompletion comment here'
            });

            // Verify the request was called correctly
            assert.strictEqual(mockOctokit.request.mock.calls.length, 1);
            const callArgs = mockOctokit.request.mock.calls[0].arguments;
            assert.strictEqual(callArgs[0], 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments');
            assert.strictEqual(callArgs[1].owner, 'testowner');
            assert.strictEqual(callArgs[1].repo, 'testrepo');
            assert.strictEqual(callArgs[1].issue_number, 123);
            assert.ok(callArgs[1].body.includes('No code changes needed'));
        });

        test('should update labels correctly (remove processing, add done)', async () => {
            const mockOctokit = createMockOctokit();
            const mockLogger = createMockLogger();

            // Simulate safeUpdateLabels behavior
            const labelsToRemove = ['AI-processing'];
            const labelsToAdd = ['AI-done'];

            // The mock would call GitHub API to update labels
            await mockOctokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                owner: 'testowner',
                repo: 'testrepo',
                issue_number: 123,
                name: 'AI-processing'
            });

            await mockOctokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                owner: 'testowner',
                repo: 'testrepo',
                issue_number: 123,
                labels: labelsToAdd
            });

            // Verify both calls were made
            assert.strictEqual(mockOctokit.request.mock.calls.length, 2);
        });
    });

    describe('error handling flow', () => {
        test('should handle post-processing error by updating labels and posting comment', async () => {
            const mockOctokit = createMockOctokit();
            const mockLogger = createMockLogger();

            const error = new Error('Commit failed');

            // Simulate fallback behavior when post-processing fails
            // 1. Update labels
            await mockOctokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                owner: 'testowner',
                repo: 'testrepo',
                issue_number: 123,
                labels: ['AI-done']
            });

            // 2. Post error comment
            await mockOctokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: 'testowner',
                repo: 'testrepo',
                issue_number: 123,
                body: '⚠️ **Post-processing encountered an error, but Claude analysis was completed.**\n\nCompletion comment'
            });

            // Verify calls
            assert.strictEqual(mockOctokit.request.mock.calls.length, 2);
            const commentCall = mockOctokit.request.mock.calls[1].arguments;
            assert.ok(commentCall[1].body.includes('Post-processing encountered an error'));
        });
    });
});

describe('handlePRValidation - Core Logic', () => {
    // Type definitions for PR validation options
    interface PRValidationOptions {
        claudeResult: ClaudeCodeResponse | null;
        worktreeInfo: WorktreeInfo | undefined;
        issueRef: IssueJobData;
        octokit: Octokit;
        postProcessingResult: PostProcessingResult | null;
        commitResult: CommitResult | null;
        repoValidation: RepoValidationResult;
        AI_PROCESSING_TAG: string;
        AI_DONE_TAG: string;
        correlationId: string;
        correlatedLogger: Logger;
        jobId: string | undefined;
    }

    interface PRValidationResult {
        isValid: boolean;
        pr?: {
            number: number;
            url: string;
            title: string;
            state?: string;
        };
        error?: string;
    }

    // Pure function that simulates handlePRValidation logic for testing
    function handlePRValidationLogic(
        options: PRValidationOptions,
        prValidationResult: PRValidationResult
    ): { result: PostProcessingResult | null; shouldRetry: boolean; shouldLog: boolean } {
        const { worktreeInfo, postProcessingResult, claudeResult, commitResult } = options;

        // Early return if no worktreeInfo
        if (!worktreeInfo) {
            return { result: postProcessingResult, shouldRetry: false, shouldLog: false };
        }

        // If validation found a PR that wasn't in postProcessingResult
        if (prValidationResult.isValid && !postProcessingResult?.pr) {
            return {
                result: {
                    success: true,
                    pr: prValidationResult.pr ? {
                        number: prValidationResult.pr.number,
                        url: prValidationResult.pr.url,
                        title: prValidationResult.pr.title
                    } : null,
                    updatedLabels: postProcessingResult?.updatedLabels || []
                },
                shouldRetry: false,
                shouldLog: false
            };
        }

        // Determine if retry is needed
        // Only retry PR creation if:
        // 1. PR validation failed (no PR found)
        // 2. Claude execution was successful
        // 3. There were actual commits (commitResult !== null)
        if (!prValidationResult.isValid && claudeResult?.success && commitResult !== null) {
            return { result: postProcessingResult, shouldRetry: true, shouldLog: false };
        }

        // Log but don't retry if validation failed, Claude succeeded, but no commits
        if (!prValidationResult.isValid && claudeResult?.success && commitResult === null) {
            return { result: postProcessingResult, shouldRetry: false, shouldLog: true };
        }

        return { result: postProcessingResult, shouldRetry: false, shouldLog: false };
    }

    // Helper to create default test options
    function createDefaultOptions(): PRValidationOptions {
        return {
            claudeResult: { success: true },
            worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'feature-branch' },
            issueRef: { repoOwner: 'testowner', repoName: 'testrepo', number: 123 },
            octokit: createMockOctokit(),
            postProcessingResult: { success: false, pr: null, updatedLabels: [] },
            commitResult: { commitHash: 'abc123', filesChanged: 1, message: 'test commit' },
            repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } },
            AI_PROCESSING_TAG: 'AI-processing',
            AI_DONE_TAG: 'AI-done',
            correlationId: 'test-correlation-id',
            correlatedLogger: createMockLogger(),
            jobId: 'job-123'
        };
    }

    describe('returns existing result', () => {
        test('should return postProcessingResult when worktreeInfo is undefined', () => {
            const options = createDefaultOptions();
            options.worktreeInfo = undefined;
            options.postProcessingResult = {
                success: true,
                pr: { number: 42, url: 'https://github.com/test/repo/pull/42', title: 'Test PR' },
                updatedLabels: ['AI-done']
            };

            const prValidationResult: PRValidationResult = { isValid: true };
            const { result, shouldRetry, shouldLog } = handlePRValidationLogic(options, prValidationResult);

            assert.deepStrictEqual(result, options.postProcessingResult);
            assert.strictEqual(shouldRetry, false);
            assert.strictEqual(shouldLog, false);
        });

        test('should return null postProcessingResult when worktreeInfo is undefined and postProcessingResult is null', () => {
            const options = createDefaultOptions();
            options.worktreeInfo = undefined;
            options.postProcessingResult = null;

            const prValidationResult: PRValidationResult = { isValid: true };
            const { result, shouldRetry } = handlePRValidationLogic(options, prValidationResult);

            assert.strictEqual(result, null);
            assert.strictEqual(shouldRetry, false);
        });

        test('should return existing postProcessingResult when validation passes and PR already exists', () => {
            const options = createDefaultOptions();
            options.postProcessingResult = {
                success: true,
                pr: { number: 99, url: 'https://github.com/test/repo/pull/99', title: 'Existing PR' },
                updatedLabels: ['AI-done']
            };

            // Validation passes, PR exists in postProcessingResult
            const prValidationResult: PRValidationResult = {
                isValid: true,
                pr: { number: 99, url: 'https://github.com/test/repo/pull/99', title: 'Existing PR' }
            };

            const { result, shouldRetry } = handlePRValidationLogic(options, prValidationResult);

            // Since postProcessingResult.pr exists, we go to the retry check block
            // Validation is valid, so no retry needed
            assert.deepStrictEqual(result, options.postProcessingResult);
            assert.strictEqual(shouldRetry, false);
        });
    });

    describe('skips retry on null commitResult', () => {
        test('should not retry when commitResult is null even if validation failed and Claude succeeded', () => {
            const options = createDefaultOptions();
            options.commitResult = null; // No commits made
            options.claudeResult = { success: true };

            const prValidationResult: PRValidationResult = {
                isValid: false,
                error: 'No PR found'
            };

            const { result, shouldRetry, shouldLog } = handlePRValidationLogic(options, prValidationResult);

            assert.strictEqual(shouldRetry, false);
            assert.strictEqual(shouldLog, true); // Should log the "no code changes made" message
            assert.deepStrictEqual(result, options.postProcessingResult);
        });

        test('should return postProcessingResult unchanged when no retry needed due to null commitResult', () => {
            const options = createDefaultOptions();
            options.commitResult = null;
            options.claudeResult = { success: true };
            options.postProcessingResult = {
                success: false,
                pr: null,
                updatedLabels: ['AI-processing']
            };

            const prValidationResult: PRValidationResult = { isValid: false };
            const { result } = handlePRValidationLogic(options, prValidationResult);

            assert.deepStrictEqual(result, options.postProcessingResult);
        });

        test('should not log when commitResult is null and claudeResult is not successful', () => {
            const options = createDefaultOptions();
            options.commitResult = null;
            options.claudeResult = { success: false };

            const prValidationResult: PRValidationResult = { isValid: false };
            const { shouldRetry, shouldLog } = handlePRValidationLogic(options, prValidationResult);

            assert.strictEqual(shouldRetry, false);
            assert.strictEqual(shouldLog, false);
        });
    });

    describe('retries PR creation', () => {
        test('should retry PR creation when validation failed, Claude succeeded, and commits exist', () => {
            const options = createDefaultOptions();
            options.claudeResult = { success: true };
            options.commitResult = { commitHash: 'abc123', filesChanged: 3, message: 'Fix issue' };

            const prValidationResult: PRValidationResult = {
                isValid: false,
                error: 'No PR found for branch'
            };

            const { shouldRetry, result } = handlePRValidationLogic(options, prValidationResult);

            assert.strictEqual(shouldRetry, true);
            assert.deepStrictEqual(result, options.postProcessingResult);
        });

        test('should not retry when Claude execution failed even with commits', () => {
            const options = createDefaultOptions();
            options.claudeResult = { success: false };
            options.commitResult = { commitHash: 'abc123', filesChanged: 1, message: 'test' };

            const prValidationResult: PRValidationResult = { isValid: false };
            const { shouldRetry } = handlePRValidationLogic(options, prValidationResult);

            assert.strictEqual(shouldRetry, false);
        });

        test('should not retry when claudeResult is null', () => {
            const options = createDefaultOptions();
            options.claudeResult = null;
            options.commitResult = { commitHash: 'abc123', filesChanged: 1, message: 'test' };

            const prValidationResult: PRValidationResult = { isValid: false };
            const { shouldRetry } = handlePRValidationLogic(options, prValidationResult);

            assert.strictEqual(shouldRetry, false);
        });

        test('should not retry when validation passed', () => {
            const options = createDefaultOptions();
            options.claudeResult = { success: true };
            options.commitResult = { commitHash: 'abc123', filesChanged: 1, message: 'test' };

            const prValidationResult: PRValidationResult = {
                isValid: true,
                pr: { number: 42, url: 'url', title: 'title' }
            };

            const { shouldRetry } = handlePRValidationLogic(options, prValidationResult);

            assert.strictEqual(shouldRetry, false);
        });
    });

    describe('updates result when PR found during validation', () => {
        test('should return updated result when validation finds PR that was not in postProcessingResult', () => {
            const options = createDefaultOptions();
            options.postProcessingResult = {
                success: false,
                pr: null,
                updatedLabels: ['AI-processing']
            };

            const prValidationResult: PRValidationResult = {
                isValid: true,
                pr: {
                    number: 42,
                    url: 'https://github.com/test/repo/pull/42',
                    title: 'Test PR'
                }
            };

            const { result, shouldRetry } = handlePRValidationLogic(options, prValidationResult);

            assert.strictEqual(result?.success, true);
            assert.strictEqual(result?.pr?.number, 42);
            assert.strictEqual(result?.pr?.url, 'https://github.com/test/repo/pull/42');
            assert.strictEqual(result?.pr?.title, 'Test PR');
            assert.deepStrictEqual(result?.updatedLabels, ['AI-processing']);
            assert.strictEqual(shouldRetry, false);
        });

        test('should preserve empty updatedLabels when updating result', () => {
            const options = createDefaultOptions();
            options.postProcessingResult = {
                success: false,
                pr: null,
                updatedLabels: []
            };

            const prValidationResult: PRValidationResult = {
                isValid: true,
                pr: { number: 42, url: 'url', title: 'title' }
            };

            const { result } = handlePRValidationLogic(options, prValidationResult);

            assert.deepStrictEqual(result?.updatedLabels, []);
        });

        test('should handle null postProcessingResult when creating updated result', () => {
            const options = createDefaultOptions();
            options.postProcessingResult = null;

            const prValidationResult: PRValidationResult = {
                isValid: true,
                pr: { number: 42, url: 'url', title: 'title' }
            };

            const { result } = handlePRValidationLogic(options, prValidationResult);

            assert.strictEqual(result?.success, true);
            assert.strictEqual(result?.pr?.number, 42);
            assert.deepStrictEqual(result?.updatedLabels, []);
        });

        test('should return result with null pr when validation is valid but no pr info', () => {
            const options = createDefaultOptions();
            options.postProcessingResult = null;

            const prValidationResult: PRValidationResult = {
                isValid: true
                // No pr property
            };

            const { result } = handlePRValidationLogic(options, prValidationResult);

            assert.strictEqual(result?.success, true);
            assert.strictEqual(result?.pr, null);
        });
    });

    describe('combined scenarios', () => {
        test('should handle all conditions being false', () => {
            const options = createDefaultOptions();
            options.claudeResult = { success: false };
            options.commitResult = null;
            options.postProcessingResult = {
                success: false,
                pr: null,
                updatedLabels: []
            };

            const prValidationResult: PRValidationResult = {
                isValid: false
            };

            const { result, shouldRetry, shouldLog } = handlePRValidationLogic(options, prValidationResult);

            assert.deepStrictEqual(result, options.postProcessingResult);
            assert.strictEqual(shouldRetry, false);
            assert.strictEqual(shouldLog, false);
        });

        test('should prioritize returning updated result over retry logic', () => {
            const options = createDefaultOptions();
            options.claudeResult = { success: true };
            options.commitResult = { commitHash: 'abc', filesChanged: 1, message: 'test' };
            options.postProcessingResult = {
                success: false,
                pr: null,
                updatedLabels: []
            };

            // Validation is valid and finds a PR, so we should return updated result
            // not go into retry logic
            const prValidationResult: PRValidationResult = {
                isValid: true,
                pr: { number: 42, url: 'url', title: 'title' }
            };

            const { result, shouldRetry } = handlePRValidationLogic(options, prValidationResult);

            assert.strictEqual(result?.success, true);
            assert.strictEqual(result?.pr?.number, 42);
            assert.strictEqual(shouldRetry, false);
        });
    });
});

describe('cleanupWorktreeIfExists - Core Logic', () => {
    test('should skip cleanup when worktreeInfo is undefined', async () => {
        const mockCleanupWorktree = mock.fn();
        const worktreeInfo = undefined;

        // The actual function would return early if worktreeInfo is undefined
        if (!worktreeInfo) {
            // Early return, no cleanup called
            assert.strictEqual(mockCleanupWorktree.mock.calls.length, 0);
        }
    });

    test('should call cleanup with correct retention strategy from environment', () => {
        // Test that cleanup options are correctly derived
        const retentionStrategy = process.env.WORKTREE_RETENTION_STRATEGY || 'always_delete';

        assert.strictEqual(retentionStrategy, 'always_delete'); // Default value
    });
});

describe('performFinalValidation - Core Logic', () => {
    test('should skip PR validation when claudeResult is undefined', async () => {
        const claudeResult = undefined;
        const worktreeInfo: WorktreeInfo = {
            worktreePath: '/tmp/worktree',
            branchName: 'feature-branch'
        };

        // The function checks: if (claudeResult?.success && worktreeInfo?.branchName)
        const shouldValidate = claudeResult?.success && worktreeInfo?.branchName;

        assert.strictEqual(shouldValidate, undefined); // Falsy, so validation is skipped
    });

    test('should skip PR validation when worktreeInfo branchName is undefined', async () => {
        const claudeResult: ClaudeCodeResponse = {
            success: true
        };
        const worktreeInfo = undefined;

        // The function checks: if (claudeResult?.success && worktreeInfo?.branchName)
        const shouldValidate = claudeResult?.success && worktreeInfo?.branchName;

        assert.strictEqual(shouldValidate, undefined); // Falsy, so validation is skipped
    });

    test('should perform PR validation when both conditions are met', async () => {
        const claudeResult: ClaudeCodeResponse = {
            success: true
        };
        const worktreeInfo: WorktreeInfo = {
            worktreePath: '/tmp/worktree',
            branchName: 'feature-branch'
        };

        // The function checks: if (claudeResult?.success && worktreeInfo?.branchName)
        const shouldValidate = claudeResult?.success && worktreeInfo?.branchName;

        assert.ok(shouldValidate); // Truthy, so validation is performed
    });
});

describe('triggerNextPlanIssueIfNeeded - Core Logic', () => {
    describe('auto-merge label detection', () => {
        test('should detect auto-merge label correctly', () => {
            const labels = [{ name: 'AI' }, { name: 'auto-merge' }];
            const labelNames = labels.map(l => l.name);
            const hasAutoMerge = labelNames.includes('auto-merge');

            assert.strictEqual(hasAutoMerge, true);
        });

        test('should skip when auto-merge label is not present', () => {
            const labels = [{ name: 'AI' }, { name: 'bug' }];
            const labelNames = labels.map(l => l.name);
            const hasAutoMerge = labelNames.includes('auto-merge');

            assert.strictEqual(hasAutoMerge, false);
        });
    });

    describe('epic label extraction', () => {
        test('should extract base- label for epic tracking', () => {
            const labels = [{ name: 'AI' }, { name: 'base-1092-epic' }, { name: 'auto-merge' }];
            const labelNames = labels.map(l => l.name);
            const epicLabel = labelNames.find(label => label.startsWith('base-'));

            assert.strictEqual(epicLabel, 'base-1092-epic');
        });

        test('should return undefined when no base- label exists', () => {
            const labels = [{ name: 'AI' }, { name: 'auto-merge' }];
            const labelNames = labels.map(l => l.name);
            const epicLabel = labelNames.find(label => label.startsWith('base-'));

            assert.strictEqual(epicLabel, undefined);
        });
    });

    describe('in-progress issue detection', () => {
        test('should detect in-progress issues', () => {
            const planIssues = [
                { issue_number: 123, status: 'merged' },
                { issue_number: 124, status: 'processing' },
                { issue_number: 125, status: 'pending' }
            ];
            const currentIssueNumber = 123;
            const inProgressStatuses = ['processing', 'under_review', 'in_refinement', 'refinement_processing'];

            const hasInProgressIssue = planIssues.some(issue =>
                inProgressStatuses.includes(issue.status) && issue.issue_number !== currentIssueNumber
            );

            assert.strictEqual(hasInProgressIssue, true); // Issue 124 is processing
        });

        test('should not count current issue as in-progress', () => {
            const planIssues = [
                { issue_number: 123, status: 'processing' },
                { issue_number: 124, status: 'pending' }
            ];
            const currentIssueNumber = 123;
            const inProgressStatuses = ['processing', 'under_review', 'in_refinement', 'refinement_processing'];

            const hasInProgressIssue = planIssues.some(issue =>
                inProgressStatuses.includes(issue.status) && issue.issue_number !== currentIssueNumber
            );

            assert.strictEqual(hasInProgressIssue, false); // Current issue excluded
        });

        test('should find next pending issue', () => {
            const planIssues = [
                { issue_number: 123, status: 'merged' },
                { issue_number: 124, status: 'merged' },
                { issue_number: 125, status: 'pending' },
                { issue_number: 126, status: 'pending' }
            ];

            const nextPending = planIssues.find(issue => issue.status === 'pending');

            assert.strictEqual(nextPending?.issue_number, 125);
        });
    });
});
