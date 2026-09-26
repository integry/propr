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
    /** Commit the live PR head advertises. Requiring it proves the checked-out branch
     * is the PR's own branch rather than a same-named branch in another repository. */
    requiredHeadSha?: string;
}

async function containsCommit(worktreePath: string, commit: string): Promise<boolean> {
    try {
        const mergeBase = await createHooklessGit(worktreePath).raw(['merge-base', commit, 'HEAD']);
        return mergeBase.trim() === commit.toLowerCase();
    } catch {
        return false;
    }
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
    const discardAndFail = async (message: string) => {
        await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName);
        throw new Error(message);
    };
    if (options.requiredHeadSha && !await containsCommit(worktreeInfo.worktreePath, options.requiredHeadSha)) {
        await discardAndFail(`Prepared ${target.repoOwner}/${target.repoName} branch ${target.branchName} does not contain the pull request head ${options.requiredHeadSha}`);
    }
    if (options.checkpointBaseline && !await containsCommit(worktreeInfo.worktreePath, options.checkpointBaseline)) {
        // A fresh clone may no longer contain a head captured before a force push.
        // Require its history before implementation can create checkpointable work.
        await discardAndFail('PR head no longer contains the captured checkpoint baseline; retry preparation before implementation');
    }
    return { localRepoPath, worktreeInfo };
}

interface PushPullRequestHeadBranchOptions {
    worktreePath: string;
    target: PullRequestGitTarget;
    authToken: string;
    /** Rebasing replays commits individually, which would drop a merge commit, so
     * callers that publish a merge keep the non-fast-forward rejection instead. */
    rebaseOnNonFastForward?: boolean;
}

export async function pushPullRequestHeadBranch(options: PushPullRequestHeadBranchOptions) {
    const { worktreePath, target, authToken, rebaseOnNonFastForward = true } = options;
    const repoUrl = getRepoUrl({ repoOwner: target.repoOwner, repoName: target.repoName });
    return pushBranch(worktreePath, target.branchName, {
        repoUrl,
        authToken,
        rebaseOnNonFastForward,
    });
}
