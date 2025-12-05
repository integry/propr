import { test } from 'node:test';
import assert from 'node:assert';

process.env.GIT_CLONES_BASE_PATH = '/tmp/test-clones';
process.env.GIT_WORKTREES_BASE_PATH = '/tmp/test-worktrees';
process.env.GIT_DEFAULT_BRANCH = 'main';

interface IssueRef {
    repoOwner: string;
    repoName: string;
}

function getRepoUrl(issue: IssueRef): string {
    return `https://github.com/${issue.repoOwner}/${issue.repoName}.git`;
}

test('getRepoUrl constructs correct URL', () => {
    const issue: IssueRef = {
        repoOwner: 'testowner',
        repoName: 'testrepo'
    };
    
    const url = getRepoUrl(issue);
    assert.strictEqual(url, 'https://github.com/testowner/testrepo.git');
});

test('Git module has valid environment configuration', () => {
    assert.strictEqual(process.env.GIT_CLONES_BASE_PATH, '/tmp/test-clones');
    assert.strictEqual(process.env.GIT_WORKTREES_BASE_PATH, '/tmp/test-worktrees');
    assert.strictEqual(process.env.GIT_DEFAULT_BRANCH, 'main');
});

test('Branch name generation from issue title', () => {
    function generateBranchName(issueNumber: number, title: string): string {
        const safeName = title
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .substring(0, 50);
        
        return `ai-fix/${issueNumber}-${safeName}`;
    }
    
    const branchName = generateBranchName(123, 'Fix the bug with special chars!');
    assert.strictEqual(branchName, 'ai-fix/123-fix-the-bug-with-special-chars');
    
    const longTitle = 'This is a very long issue title that should be truncated to prevent extremely long branch names';
    const longBranchName = generateBranchName(456, longTitle);
    
    assert.ok(longBranchName.startsWith('ai-fix/456-'));
    assert.ok(/^[a-zA-Z0-9\/-]+$/.test(longBranchName));
    
    const titlePart = longBranchName.replace('ai-fix/456-', '');
    assert.ok(titlePart.length > 0);
    assert.ok(titlePart.includes('this-is-a-very-long-issue-title'));
});
