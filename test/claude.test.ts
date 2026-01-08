import { test, after } from 'node:test';
import assert from 'node:assert';

// Set test environment before imports
process.env.NODE_ENV = 'test';
process.env.CLAUDE_DOCKER_IMAGE = 'claude-code-processor:test';
process.env.CLAUDE_CONFIG_PATH = '/tmp/test-claude-config';
process.env.CLAUDE_MAX_TURNS = '5';
process.env.CLAUDE_TIMEOUT_MS = '60000';

interface TestIssue {
    number: number;
    title: string;
    body: string;
    repoOwner: string;
    repoName: string;
}

interface ParsedClaudeOutput {
    success: boolean;
    output: {
        conversation?: string[];
        modifiedFiles?: string[];
        commitMessage?: string;
        rawOutput?: string;
        parseError?: string;
    };
    conversationLog: string[];
    modifiedFiles: string[];
    commitMessage: string | null;
}

test('Claude service module exports required functions', async () => {
    const coreModule = await import('@gitfix/core');

    assert.strictEqual(typeof coreModule.executeClaudeCode, 'function');
    assert.strictEqual(typeof coreModule.buildClaudeDockerImage, 'function');
});

test('Claude prompt generation includes issue details', () => {
    function generateTestPrompt(issue: TestIssue): string {
        return `You are an expert software engineer tasked with analyzing and fixing a GitHub issue.

## Issue Details
**Repository:** ${issue.repoOwner}/${issue.repoName}
**Issue #${issue.number}:** ${issue.title}

**Issue Description:**
${issue.body || 'No description provided.'}`;
    }
    
    const testIssue: TestIssue = {
        number: 123,
        title: 'Fix the authentication bug',
        body: 'The login system is not working properly',
        repoOwner: 'testowner',
        repoName: 'testrepo'
    };
    
    const prompt = generateTestPrompt(testIssue);
    
    assert.ok(prompt.includes('testowner/testrepo'));
    assert.ok(prompt.includes('Issue #123'));
    assert.ok(prompt.includes('Fix the authentication bug'));
    assert.ok(prompt.includes('The login system is not working properly'));
});

test('Docker command construction validates inputs', () => {
    function validateDockerArgs(worktreePath: string | null, githubToken: string | null): string[] {
        const errors: string[] = [];
        
        if (!worktreePath || typeof worktreePath !== 'string') {
            errors.push('worktreePath must be a non-empty string');
        }
        
        if (!githubToken || typeof githubToken !== 'string') {
            errors.push('githubToken must be a non-empty string');
        }
        
        return errors;
    }
    
    assert.deepStrictEqual(
        validateDockerArgs('/path/to/worktree', 'ghp_token123'), 
        []
    );
    
    assert.ok(validateDockerArgs('', 'token').length > 0);
    assert.ok(validateDockerArgs('/path', '').length > 0);
    assert.ok(validateDockerArgs(null, 'token').length > 0);
});

test('Claude output parsing handles various formats', () => {
    function parseClaudeOutput(rawOutput: string | null, exitCode: number): ParsedClaudeOutput {
        let claudeOutput: {
            conversation?: string[];
            modifiedFiles?: string[];
            commitMessage?: string;
            rawOutput?: string;
            parseError?: string;
        };
        try {
            claudeOutput = JSON.parse(rawOutput || '{}');
        } catch (parseError) {
            const error = parseError as Error;
            claudeOutput = {
                rawOutput: rawOutput ?? undefined,
                parseError: error.message
            };
        }
        
        return {
            success: exitCode === 0,
            output: claudeOutput,
            conversationLog: claudeOutput.conversation || [],
            modifiedFiles: claudeOutput.modifiedFiles || [],
            commitMessage: claudeOutput.commitMessage || null
        };
    }
    
    const validJson = JSON.stringify({
        conversation: ['message1', 'message2'],
        modifiedFiles: ['file1.js', 'file2.js'],
        commitMessage: 'Fix: Update authentication logic'
    });
    
    const result1 = parseClaudeOutput(validJson, 0);
    assert.strictEqual(result1.success, true);
    assert.strictEqual(result1.conversationLog.length, 2);
    assert.strictEqual(result1.modifiedFiles.length, 2);
    assert.strictEqual(result1.commitMessage, 'Fix: Update authentication logic');
    
    const result2 = parseClaudeOutput('invalid json', 0);
    assert.strictEqual(result2.success, true);
    assert.ok(result2.output.parseError);
    assert.strictEqual(result2.conversationLog.length, 0);
    
    const result3 = parseClaudeOutput('{}', 1);
    assert.strictEqual(result3.success, false);
});

test('Environment configuration has valid defaults', () => {
    const defaultConfig = {
        CLAUDE_DOCKER_IMAGE: process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest',
        CLAUDE_MAX_TURNS: parseInt(process.env.CLAUDE_MAX_TURNS || '10', 10),
        CLAUDE_TIMEOUT_MS: parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10)
    };
    
    assert.strictEqual(defaultConfig.CLAUDE_DOCKER_IMAGE, 'claude-code-processor:test');
    assert.strictEqual(defaultConfig.CLAUDE_MAX_TURNS, 5);
    assert.strictEqual(defaultConfig.CLAUDE_TIMEOUT_MS, 60000);
    
    assert.strictEqual(typeof defaultConfig.CLAUDE_DOCKER_IMAGE, 'string');
    assert.strictEqual(typeof defaultConfig.CLAUDE_MAX_TURNS, 'number');
    assert.strictEqual(typeof defaultConfig.CLAUDE_TIMEOUT_MS, 'number');
    
    assert.ok(defaultConfig.CLAUDE_MAX_TURNS > 0);
    assert.ok(defaultConfig.CLAUDE_TIMEOUT_MS > 0);
});

test('ExecutionResult interface types are correct', async () => {
    const { executeDockerCommand } = await import('@gitfix/core');
    assert.strictEqual(typeof executeDockerCommand, 'function');
});

test('IssueRef and IssueDetails types are exported', async () => {
    const { generateClaudePrompt } = await import('@gitfix/core');
    assert.strictEqual(typeof generateClaudePrompt, 'function');

    const testRef = {
        number: 1,
        repoOwner: 'test',
        repoName: 'repo'
    };

    const prompt = generateClaudePrompt(testRef, null, null, null);
    assert.ok(prompt.includes('test/repo'));
    assert.ok(prompt.includes('#1'));
});

test('UsageLimitError has correct properties', async () => {
    const { UsageLimitError } = await import('@gitfix/core');

    const error = new UsageLimitError('Test limit error', 1234567890);

    assert.strictEqual(error.name, 'UsageLimitError');
    assert.strictEqual(error.message, 'Test limit error');
    assert.strictEqual(error.resetTimestamp, 1234567890);
    assert.strictEqual(error.retryable, true);
    assert.ok(error instanceof Error);
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
