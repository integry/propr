import {
    cleanupWorktree,
    createHooklessGit,
    createWorktreeFromExistingBranch,
    ensureRepoCloned,
    getRepoUrl,
    pushBranch,
} from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import type { PullRequestGitTarget } from './prGitTarget.js';
export { resolvePullRequestGitTarget } from './prGitTarget.js';
export type { PullRequestGitTarget, PullRequestHead } from './prGitTarget.js';

interface CreatePullRequestHeadWorktreeOptions {
    target: PullRequestGitTarget;
    authToken: string;
    worktreeDirName: string;
    checkpointBaseline?: string;
}

export async function createPullRequestHeadWorktree(
    options: CreatePullRequestHeadWorktreeOptions,
): Promise<{ localRepoPath: string; worktreeInfo: WorktreeInfo }> {
    const { target, authToken, worktreeDirName } = options;
    const repoUrl = getRepoUrl({ repoOwner: target.repoOwner, repoName: target.repoName });
    const localRepoPath = await ensureRepoCloned({
        repoUrl,
        owner: target.repoOwner,
        repoName: target.repoName,
        authToken,
    });
    const worktreeInfo = await createWorktreeFromExistingBranch(localRepoPath, target.branchName, {
        worktreeDirName,
        owner: target.repoOwner,
        repoName: target.repoName,
    });
    if (options.checkpointBaseline) {
        try {
            // A fresh clone may no longer contain a head captured before a force push.
            // Require its history before implementation can create checkpointable work.
            const mergeBase = await createHooklessGit(worktreeInfo.worktreePath).raw([
                'merge-base', options.checkpointBaseline, 'HEAD',
            ]);
            if (mergeBase.trim() !== options.checkpointBaseline.toLowerCase()) {
                throw new Error('Captured contribution is not an ancestor of the prepared head');
            }
        } catch (error) {
            await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName);
            throw new Error('PR head no longer contains the captured checkpoint baseline; retry preparation before implementation', { cause: error });
        }
    }
    return { localRepoPath, worktreeInfo };
}

interface PushPullRequestHeadBranchOptions {
    worktreePath: string;
    target: PullRequestGitTarget;
    authToken: string;
}

export async function pushPullRequestHeadBranch(options: PushPullRequestHeadBranchOptions) {
    const { worktreePath, target, authToken } = options;
    const repoUrl = getRepoUrl({ repoOwner: target.repoOwner, repoName: target.repoName });
    return pushBranch(worktreePath, target.branchName, {
        repoUrl,
        authToken,
        rebaseOnNonFastForward: true,
    });
}
