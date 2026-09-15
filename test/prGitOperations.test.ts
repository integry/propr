import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

const calls: Array<{ operation: string; arguments: unknown[] }> = [];

await mock.module('@propr/core', {
    namedExports: {
        createHooklessGit: () => ({ raw: async () => '' }),
        cleanupWorktree: async () => {},
        getRepoUrl: mock.fn((repository: { repoOwner: string; repoName: string }) => {
            calls.push({ operation: 'getRepoUrl', arguments: [repository] });
            return `https://github.com/${repository.repoOwner}/${repository.repoName}.git`;
        }),
        ensureRepoCloned: mock.fn(async (options: Record<string, unknown>) => {
            calls.push({ operation: 'ensureRepoCloned', arguments: [options] });
            return '/tmp/git-processor/clones/contributor/propr';
        }),
        createWorktreeFromExistingBranch: mock.fn(async (...args: unknown[]) => {
            calls.push({ operation: 'createWorktreeFromExistingBranch', arguments: args });
            return { worktreePath: '/tmp/git-processor/worktrees/contributor/propr/followup', branchName: 'feature/fork' };
        }),
        pushBranch: mock.fn(async (...args: unknown[]) => {
            calls.push({ operation: 'pushBranch', arguments: args });
            return { rebased: false };
        }),
    },
});

const { createPullRequestHeadWorktree, pushPullRequestHeadBranch } = await import('../src/jobs/prGitOperations.ts');

const forkTarget = {
    branchName: 'feature/fork',
    repoOwner: 'contributor',
    repoName: 'propr',
    isFork: true,
};

describe('fork PR git operations', () => {
    beforeEach(() => {
        calls.length = 0;
    });

    test('clones and creates the worktree from the PR head repository', async () => {
        const result = await createPullRequestHeadWorktree({
            target: forkTarget,
            authToken: 'installation-token',
            worktreeDirName: 'pr-42-followup',
        });

        assert.equal(result.localRepoPath, '/tmp/git-processor/clones/contributor/propr');
        assert.deepEqual(calls, [
            { operation: 'getRepoUrl', arguments: [{ repoOwner: 'contributor', repoName: 'propr' }] },
            { operation: 'ensureRepoCloned', arguments: [{
                repoUrl: 'https://github.com/contributor/propr.git',
                owner: 'contributor',
                repoName: 'propr',
                authToken: 'installation-token',
            }] },
            { operation: 'createWorktreeFromExistingBranch', arguments: [
                '/tmp/git-processor/clones/contributor/propr',
                'feature/fork',
                { worktreeDirName: 'pr-42-followup', owner: 'contributor', repoName: 'propr' },
            ] },
        ]);
    });

    test('pushes follow-up commits back to the PR head repository and branch', async () => {
        await pushPullRequestHeadBranch({
            worktreePath: '/tmp/git-processor/worktrees/contributor/propr/followup',
            target: forkTarget,
            authToken: 'installation-token',
        });

        assert.deepEqual(calls, [
            { operation: 'getRepoUrl', arguments: [{ repoOwner: 'contributor', repoName: 'propr' }] },
            { operation: 'pushBranch', arguments: [
                '/tmp/git-processor/worktrees/contributor/propr/followup',
                'feature/fork',
                {
                    repoUrl: 'https://github.com/contributor/propr.git',
                    authToken: 'installation-token',
                    rebaseOnNonFastForward: true,
                },
            ] },
        ]);
    });
});
