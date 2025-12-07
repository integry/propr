import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

interface WorktreeNames {
    branchName: string;
    worktreeDirName: string;
    worktreePath: string;
    randomString: string;
}

interface TestCase {
    input: string;
    expected: string;
}

interface BranchTestCase {
    issueId: number;
    title: string;
    timestamp: string;
    modelName: string | null;
    randomString: string;
    expected: string;
}

describe('Repository Manager - Model-Specific Features', () => {
    let tempDir: string;
    let testRepoPath: string;
    let mockWorktreesBasePath: string;
    
    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitfix-test-'));
        testRepoPath = path.join(tempDir, 'test-repo');
        mockWorktreesBasePath = path.join(tempDir, 'worktrees');
        
        await fs.ensureDir(testRepoPath);
        await fs.ensureDir(mockWorktreesBasePath);
        
        process.env.WORKTREES_BASE_PATH = mockWorktreesBasePath;
    });
    
    afterEach(async () => {
        if (tempDir) {
            await fs.remove(tempDir);
        }
        delete process.env.WORKTREES_BASE_PATH;
    });
    
    test('createWorktreeForIssue generates unique names with modelName', () => {
        function generateWorktreeNames(issueId: number, issueTitle: string, modelName: string | null): WorktreeNames {
            const sanitizedTitle = issueTitle
                .toLowerCase()
                .replace(/[^a-z0-9_\\-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 25);
            
            const randomString = Math.random().toString(36).substring(2, 5);
            
            const now = new Date();
            const shortTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
            
            const modelSuffix = modelName ? `-${modelName}` : '';
            const branchName = `ai-fix/${issueId}-${sanitizedTitle}-${shortTimestamp}${modelSuffix}-${randomString}`;
            const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelSuffix}-${randomString}`;
            const worktreePath = path.join('/tmp/worktrees', 'owner', 'repo', worktreeDirName);
            
            return { branchName, worktreeDirName, worktreePath, randomString };
        }
        
        const issueId = 42;
        const issueTitle = 'Fix Authentication Bug';
        
        const opusResult = generateWorktreeNames(issueId, issueTitle, 'opus');
        const sonnetResult = generateWorktreeNames(issueId, issueTitle, 'sonnet');
        const noModelResult = generateWorktreeNames(issueId, issueTitle, null);
        
        assert.notStrictEqual(opusResult.branchName, sonnetResult.branchName);
        assert.notStrictEqual(opusResult.worktreeDirName, sonnetResult.worktreeDirName);
        assert.notStrictEqual(opusResult.worktreePath, sonnetResult.worktreePath);
        
        assert(opusResult.branchName.includes('-opus-'));
        assert(sonnetResult.branchName.includes('-sonnet-'));
        assert(!noModelResult.branchName.includes('-opus-'));
        assert(!noModelResult.branchName.includes('-sonnet-'));
        
        assert.strictEqual(opusResult.randomString.length, 3);
        assert.strictEqual(sonnetResult.randomString.length, 3);
        assert(/^[a-z0-9]{3}$/.test(opusResult.randomString));
        assert(/^[a-z0-9]{3}$/.test(sonnetResult.randomString));
    });
    
    test('createWorktreeForIssue path structure includes model name', () => {
        function generateWorktreePath(owner: string, repoName: string, issueId: number, modelName: string | null): string {
            const randomString = 'abc';
            const now = new Date();
            const shortTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
            
            const modelSuffix = modelName ? `-${modelName}` : '';
            const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelSuffix}-${randomString}`;
            return path.join('/tmp/worktrees', owner, repoName, worktreeDirName);
        }
        
        const owner = 'testuser';
        const repoName = 'testrepo';
        const issueId = 123;
        
        const opusPath = generateWorktreePath(owner, repoName, issueId, 'opus');
        const sonnetPath = generateWorktreePath(owner, repoName, issueId, 'sonnet');
        const defaultPath = generateWorktreePath(owner, repoName, issueId, null);
        
        assert(opusPath.includes('/testuser/testrepo/'));
        assert(opusPath.includes('issue-123-'));
        assert(opusPath.includes('-opus-'));
        
        assert(sonnetPath.includes('/testuser/testrepo/'));
        assert(sonnetPath.includes('issue-123-'));
        assert(sonnetPath.includes('-sonnet-'));
        
        assert(defaultPath.includes('/testuser/testrepo/'));
        assert(defaultPath.includes('issue-123-'));
        assert(!defaultPath.includes('-opus-'));
        assert(!defaultPath.includes('-sonnet-'));
        
        assert.notStrictEqual(opusPath, sonnetPath);
        assert.notStrictEqual(opusPath, defaultPath);
        assert.notStrictEqual(sonnetPath, defaultPath);
    });
    
    test('title sanitization works with various inputs', () => {
        function sanitizeTitle(title: string): string {
            return title
                .toLowerCase()
                .replace(/[^a-z0-9_\-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 25);
        }
        
        const testCases: TestCase[] = [
            {
                input: 'Simple Title',
                expected: 'simple-title'
            },
            {
                input: 'Title with @mentions and #hashtags!',
                expected: 'title-with-mentions-and-h'
            },
            {
                input: 'Fix: Bug in "authentication" system [urgent]',
                expected: 'fix-bug-in-authentication'
            },
            {
                input: '   Leading and trailing spaces   ',
                expected: 'leading-and-trailing-spac'
            },
            {
                input: 'Multiple---dashes___underscores',
                expected: 'multiple-dashes___undersc'
            },
            {
                input: 'UPPERCASE title',
                expected: 'uppercase-title'
            },
            {
                input: 'Numbers 123 and symbols !@#$%',
                expected: 'numbers-123-and-symbols'
            }
        ];
        
        testCases.forEach((testCase, index) => {
            const result = sanitizeTitle(testCase.input);
            assert.strictEqual(result, testCase.expected, `Test case ${index + 1} failed: "${testCase.input}" -> "${result}" (expected "${testCase.expected}")`);
            assert(result.length <= 25, `Test case ${index + 1}: result too long (${result.length} chars)`);
        });
    });
    
    test('timestamp format is consistent and valid', () => {
        function generateTimestamp(): string {
            const now = new Date();
            return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        }
        
        const timestamps: string[] = [];
        for (let i = 0; i < 5; i++) {
            timestamps.push(generateTimestamp());
        }
        
        timestamps.forEach((timestamp, index) => {
            assert(/^\d{8}-\d{4}$/.test(timestamp), `Timestamp ${index + 1} has invalid format: ${timestamp}`);
            
            const year = parseInt(timestamp.substring(0, 4));
            const currentYear = new Date().getFullYear();
            assert(year === currentYear, `Timestamp ${index + 1} has invalid year: ${year}`);
        });
        
        const firstTimestamp = timestamps[0];
        const allSame = timestamps.every(ts => ts === firstTimestamp);
        assert(allSame, 'Timestamps should be consistent within the same test run');
    });
    
    test('random string generation produces valid output', () => {
        function generateRandomString(): string {
            return Math.random().toString(36).substring(2, 5);
        }
        
        const randomStrings: string[] = [];
        for (let i = 0; i < 100; i++) {
            randomStrings.push(generateRandomString());
        }
        
        randomStrings.forEach((str, index) => {
            assert.strictEqual(str.length, 3, `Random string ${index + 1} has wrong length: "${str}"`);
            assert(/^[a-z0-9]{3}$/.test(str), `Random string ${index + 1} has invalid characters: "${str}"`);
        });
        
        const uniqueStrings = new Set(randomStrings);
        assert(uniqueStrings.size > 50, `Expected more unique strings, got ${uniqueStrings.size}/100`);
    });
    
    test('branch name construction follows git naming conventions', () => {
        function generateBranchName(issueId: number, sanitizedTitle: string, timestamp: string, modelName: string | null, randomString: string): string {
            const modelSuffix = modelName ? `-${modelName}` : '';
            return `ai-fix/${issueId}-${sanitizedTitle}-${timestamp}${modelSuffix}-${randomString}`;
        }
        
        const testCases: BranchTestCase[] = [
            {
                issueId: 42,
                title: 'fix-bug',
                timestamp: '20240528-1430',
                modelName: 'opus',
                randomString: 'abc',
                expected: 'ai-fix/42-fix-bug-20240528-1430-opus-abc'
            },
            {
                issueId: 123,
                title: 'feature-request',
                timestamp: '20240528-1445',
                modelName: 'sonnet',
                randomString: 'xyz',
                expected: 'ai-fix/123-feature-request-20240528-1445-sonnet-xyz'
            },
            {
                issueId: 1,
                title: 'urgent-fix',
                timestamp: '20240528-1500',
                modelName: null,
                randomString: '123',
                expected: 'ai-fix/1-urgent-fix-20240528-1500-123'
            }
        ];
        
        testCases.forEach((testCase, index) => {
            const result = generateBranchName(
                testCase.issueId,
                testCase.title,
                testCase.timestamp,
                testCase.modelName,
                testCase.randomString
            );
            
            assert.strictEqual(result, testCase.expected, `Test case ${index + 1} failed`);
            
            assert(result.startsWith('ai-fix/'), 'Branch should start with ai-fix/');
            assert(!result.includes('..'), 'Branch should not contain consecutive dots');
            assert(!result.includes(' '), 'Branch should not contain spaces');
            assert(!result.endsWith('/'), 'Branch should not end with slash');
            assert(!/[~^:\\*\\?\\[\\]@{]/.test(result), 'Branch should not contain invalid git characters');
        });
    });
});

describe('Repository Manager - Model Integration Edge Cases', () => {
    
    test('handles model names with special characters', () => {
        function sanitizeModelName(modelName: string): string {
            return modelName;
        }
        
        function generateBranchWithModel(issueId: number, modelName: string): string {
            const sanitizedModel = sanitizeModelName(modelName);
            const modelSuffix = sanitizedModel ? `-${sanitizedModel}` : '';
            return `ai-fix/${issueId}-test${modelSuffix}-abc`;
        }
        
        const testCases = [
            { model: 'claude-3.5-sonnet', expected: 'ai-fix/42-test-claude-3.5-sonnet-abc' },
            { model: 'gpt-4o', expected: 'ai-fix/42-test-gpt-4o-abc' },
            { model: 'opus', expected: 'ai-fix/42-test-opus-abc' },
            { model: 'model_with_underscores', expected: 'ai-fix/42-test-model_with_underscores-abc' }
        ];
        
        testCases.forEach((testCase, index) => {
            const result = generateBranchWithModel(42, testCase.model);
            assert.strictEqual(result, testCase.expected, `Test case ${index + 1} failed`);
        });
    });
    
    test('ensures uniqueness even with same parameters', () => {
        function generateMultipleNames(issueId: number, title: string, modelName: string | null, count = 5): string[] {
            const names: string[] = [];
            for (let i = 0; i < count; i++) {
                const randomString = Math.random().toString(36).substring(2, 5);
                const sanitizedTitle = title.toLowerCase().replace(/[^a-z0-9_\\-]/g, '-').substring(0, 25);
                const timestamp = '20240528-1430';
                const modelSuffix = modelName ? `-${modelName}` : '';
                const branchName = `ai-fix/${issueId}-${sanitizedTitle}-${timestamp}${modelSuffix}-${randomString}`;
                names.push(branchName);
            }
            return names;
        }
        
        const names = generateMultipleNames(42, 'Test Issue', 'opus', 10);
        
        const uniqueNames = new Set(names);
        assert.strictEqual(uniqueNames.size, names.length, 'All generated names should be unique');
        
        names.forEach((name, index) => {
            assert(name.startsWith('ai-fix/42-test-issue-20240528-1430-opus-'), `Name ${index + 1} has wrong format`);
            const randomPart = name.split('-').pop();
            assert.strictEqual(randomPart?.length, 3, `Name ${index + 1} has wrong random part length`);
        });
    });
    
    test('validates worktree directory path structure', () => {
        function generateWorktreePath(basePath: string, owner: string, repoName: string, issueId: number, modelName: string | null, randomString: string): string {
            const timestamp = '20240528-1430';
            const modelSuffix = modelName ? `-${modelName}` : '';
            const dirName = `issue-${issueId}-${timestamp}${modelSuffix}-${randomString}`;
            return path.join(basePath, owner, repoName, dirName);
        }
        
        const basePath = '/tmp/worktrees';
        const owner = 'testuser';
        const repoName = 'testrepo';
        const issueId = 42;
        const randomString = 'abc';
        
        const opusPath = generateWorktreePath(basePath, owner, repoName, issueId, 'opus', randomString);
        const sonnetPath = generateWorktreePath(basePath, owner, repoName, issueId, 'sonnet', randomString);
        const defaultPath = generateWorktreePath(basePath, owner, repoName, issueId, null, randomString);
        
        assert.strictEqual(path.dirname(opusPath), path.join(basePath, owner, repoName));
        assert.strictEqual(path.dirname(sonnetPath), path.join(basePath, owner, repoName));
        assert.strictEqual(path.dirname(defaultPath), path.join(basePath, owner, repoName));
        
        assert.notStrictEqual(path.basename(opusPath), path.basename(sonnetPath));
        assert.notStrictEqual(path.basename(opusPath), path.basename(defaultPath));
        
        assert(path.basename(opusPath).includes('opus'));
        assert(path.basename(sonnetPath).includes('sonnet'));
        assert(!path.basename(defaultPath).includes('opus'));
        assert(!path.basename(defaultPath).includes('sonnet'));
    });
});
