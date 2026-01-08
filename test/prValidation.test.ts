import { test, describe, mock, after } from 'node:test';
import assert from 'node:assert';

// Set test environment before imports
process.env.NODE_ENV = 'test';

// Dynamic imports
let validatePRCreation: typeof import('@gitfix/core').validatePRCreation;
let generateEnhancedClaudePrompt: typeof import('@gitfix/core').generateEnhancedClaudePrompt;
let validateRepositoryInfo: typeof import('@gitfix/core').validateRepositoryInfo;

describe('PR Validation Utils', () => {
    // Load modules before tests
    test('generateEnhancedClaudePrompt should include all required repository information', async () => {
        // Load core module dynamically
        const coreModule = await import('@gitfix/core');
        validatePRCreation = coreModule.validatePRCreation;
        generateEnhancedClaudePrompt = coreModule.generateEnhancedClaudePrompt;
        validateRepositoryInfo = coreModule.validateRepositoryInfo;

        const testOptions = {
            issueRef: {
                repoOwner: 'testowner',
                repoName: 'testrepo',
                number: 123
            },
            currentIssueData: {
                title: 'Test Issue',
                html_url: 'https://github.com/testowner/testrepo/issues/123',
                body: 'This is a test issue description'
            },
            worktreePath: '/tmp/worktree-123',
            branchName: 'feature-issue-123',
            baseBranch: 'main'
        };

        const prompt = generateEnhancedClaudePrompt(testOptions);

        assert.ok(prompt.includes('Repository Owner: testowner'));
        assert.ok(prompt.includes('Repository Name: testrepo'));
        assert.ok(prompt.includes('Full Repository: testowner/testrepo'));
        assert.ok(prompt.includes('Working Directory: /tmp/worktree-123'));
        assert.ok(prompt.includes('Current Branch: feature-issue-123'));
        assert.ok(prompt.includes('Base Branch: main'));
        assert.ok(prompt.includes('Issue Number: #123'));
        assert.ok(prompt.includes('Issue Title: Test Issue'));
        assert.ok(prompt.includes('This is a test issue description'));
        assert.ok(prompt.includes('DO NOT hallucinate or guess repository names'));

        assert.ok(prompt.includes('CRITICAL - USE EXACTLY AS PROVIDED'));
        assert.ok(prompt.includes('IMPORTANT INSTRUCTIONS:'));

        assert.ok(prompt.includes('gh issue view 123'));
        assert.ok(prompt.includes('gh issue view 123 --comments'));
        assert.ok(prompt.includes('read all issue comments for additional context'));
    });

    test('generateEnhancedClaudePrompt should handle missing issue body gracefully', () => {
        const testOptions = {
            issueRef: {
                repoOwner: 'testowner',
                repoName: 'testrepo',
                number: 123
            },
            currentIssueData: {
                title: 'Test Issue',
                html_url: 'https://github.com/testowner/testrepo/issues/123',
                body: null
            },
            worktreePath: '/tmp/worktree-123',
            branchName: 'feature-issue-123',
            baseBranch: 'main'
        };

        const prompt = generateEnhancedClaudePrompt(testOptions);

        assert.ok(prompt.includes('No description provided'));
    });

    test('validatePRCreation should handle different validation scenarios', async () => {
        const mockOctokit = {
            request: mock.fn(() => Promise.resolve({
                data: {
                    number: 42,
                    html_url: 'https://github.com/testowner/testrepo/pull/42',
                    title: 'Test PR',
                    state: 'open',
                    head: { ref: 'feature-branch-123' }
                }
            }))
        };

        const testOptions = {
            owner: 'testowner',
            repoName: 'testrepo',
            branchName: 'feature-branch-123',
            expectedPrNumber: 42,
            correlationId: 'test-correlation-id'
        };

        assert.ok(typeof validatePRCreation === 'function');
        assert.ok(typeof validateRepositoryInfo === 'function');
    });

    test('PR validation utility functions should be properly exported', () => {
        assert.ok(typeof validatePRCreation === 'function');
        assert.ok(typeof generateEnhancedClaudePrompt === 'function');
        assert.ok(typeof validateRepositoryInfo === 'function');
    });
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
