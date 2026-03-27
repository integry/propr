import { test, describe } from 'node:test';
import assert from 'node:assert';

// Import the helpers directly (no external dependencies needed)
import {
    buildConflictResolutionPrompt,
    buildMergeConflictCommitMessage,
    buildMergeConflictComment,
    mergeConflictJobToCommentJob,
} from '../src/jobs/mergeConflictHelpers.js';

describe('buildConflictResolutionPrompt', () => {
    test('includes all conflicted files in the prompt', () => {
        const prompt = buildConflictResolutionPrompt({
            pullRequestNumber: 42,
            baseBranch: 'main',
            headBranch: 'feature-branch',
            conflictedFiles: ['src/index.ts', 'src/utils.ts'],
            worktreeInfo: { worktreePath: '/tmp/worktree/test', branchName: 'feature-branch' },
            repoOwner: 'test-owner',
            repoName: 'test-repo',
        });

        assert.ok(prompt.includes('#42'));
        assert.ok(prompt.includes('`main`'));
        assert.ok(prompt.includes('`feature-branch`'));
        assert.ok(prompt.includes('`src/index.ts`'));
        assert.ok(prompt.includes('`src/utils.ts`'));
        assert.ok(prompt.includes('/tmp/worktree/test'));
        assert.ok(prompt.includes('test-owner/test-repo'));
        assert.ok(prompt.includes('DO NOT commit'));
        assert.ok(prompt.includes('conflict markers'));
    });

    test('instructs agent to preserve PR intent', () => {
        const prompt = buildConflictResolutionPrompt({
            pullRequestNumber: 10,
            baseBranch: 'develop',
            headBranch: 'fix-bug',
            conflictedFiles: ['file.ts'],
            worktreeInfo: { worktreePath: '/tmp/wt', branchName: 'fix-bug' },
            repoOwner: 'owner',
            repoName: 'repo',
        });

        assert.ok(prompt.includes('intent of the PR'));
        assert.ok(prompt.includes("PR's intent"));
        assert.ok(prompt.includes('conflict markers'));
    });
});

describe('buildMergeConflictCommitMessage', () => {
    test('clean merge message', () => {
        const msg = buildMergeConflictCommitMessage({
            baseBranch: 'main',
            headBranch: 'feature',
            pullRequestNumber: 5,
            wasCleanMerge: true,
        });

        assert.ok(msg.startsWith('merge: merge main into feature'));
        assert.ok(msg.includes('clean merge'));
        assert.ok(msg.includes('#5'));
        assert.ok(!msg.includes('Model:'));
    });

    test('conflict resolution message includes files and model', () => {
        const msg = buildMergeConflictCommitMessage({
            baseBranch: 'main',
            headBranch: 'feature',
            pullRequestNumber: 5,
            conflictedFiles: ['a.ts', 'b.ts'],
            model: 'claude-sonnet-4-20250514',
            wasCleanMerge: false,
        });

        assert.ok(msg.startsWith('merge: resolve conflicts'));
        assert.ok(msg.includes('- a.ts'));
        assert.ok(msg.includes('- b.ts'));
        assert.ok(msg.includes('#5'));
        assert.ok(msg.includes('claude-sonnet-4-20250514'));
    });
});

describe('buildMergeConflictComment', () => {
    test('clean merge comment', () => {
        const comment = buildMergeConflictComment({
            wasCleanMerge: true,
            commitHash: 'abc1234567890',
            baseBranch: 'main',
            headBranch: 'feature',
        });

        assert.ok(comment.includes('🔀'));
        assert.ok(comment.includes('Auto-merged'));
        assert.ok(comment.includes('`main`'));
        assert.ok(comment.includes('`feature`'));
        assert.ok(comment.includes('abc1234'));
        assert.ok(comment.includes('clean merge'));
        assert.ok(comment.includes('without invoking an AI agent'));
        assert.ok(comment.includes('System-triggered'));
    });

    test('conflict resolution comment includes files and model', () => {
        const comment = buildMergeConflictComment({
            wasCleanMerge: false,
            commitHash: 'def456789',
            baseBranch: 'main',
            headBranch: 'feature',
            conflictedFiles: ['src/app.ts', 'src/config.ts'],
            model: 'claude-sonnet-4-20250514',
            executionTimeMs: 125000,
            taskUrl: 'https://gitfix.dev/tasks/test-123',
        });

        assert.ok(comment.includes('Resolved merge conflicts'));
        assert.ok(comment.includes('def4567'));
        assert.ok(comment.includes('`src/app.ts`'));
        assert.ok(comment.includes('`src/config.ts`'));
        assert.ok(comment.includes('claude-sonnet-4-20250514'));
        assert.ok(comment.includes('2m 5s'));
        assert.ok(comment.includes('https://gitfix.dev/tasks/test-123'));
        assert.ok(comment.includes('System-triggered'));
    });

    test('conflict resolution comment without optional fields', () => {
        const comment = buildMergeConflictComment({
            wasCleanMerge: false,
            commitHash: 'aaa111',
            baseBranch: 'main',
            headBranch: 'fix',
        });

        assert.ok(comment.includes('Resolved merge conflicts'));
        assert.ok(!comment.includes('Resolved Conflicts'));  // no file list section
        assert.ok(comment.includes('System-triggered'));
    });
});

describe('mergeConflictJobToCommentJob', () => {
    test('converts merge conflict job data to comment job data', () => {
        const result = mergeConflictJobToCommentJob({
            pullRequestNumber: 42,
            repoOwner: 'test-owner',
            repoName: 'test-repo',
            headBranch: 'feature',
            baseBranch: 'main',
            headSha: 'abc123',
            baseSha: 'def456',
            triggerSource: 'push',
            correlationId: 'corr-1',
        });

        assert.strictEqual(result.pullRequestNumber, 42);
        assert.strictEqual(result.repoOwner, 'test-owner');
        assert.strictEqual(result.repoName, 'test-repo');
        assert.strictEqual(result.branchName, 'feature');
        assert.strictEqual(result.correlationId, 'corr-1');
        assert.strictEqual(result.systemAction, 'auto_resolve_merge_conflicts');
        assert.deepStrictEqual(result.autoResolveContext, {
            baseBranch: 'main',
            headBranch: 'feature',
            headSha: 'abc123',
            baseSha: 'def456',
            triggerSource: 'push',
        });
    });
});
