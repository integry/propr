import type { Logger } from 'pino';
import { createWorktreeFromExistingBranch, ensureGitRepository, ensureRepoCloned, getRepoUrl } from '@propr/core';
import type { WorktreeInfo } from '@propr/core';

export async function createTitleGenerationWorktree(options: {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    branchName: string;
    githubToken: string;
    purpose: string;
    correlatedLogger: Logger;
}): Promise<{ localRepoPath: string; worktreeInfo: WorktreeInfo }> {
    const { repoOwner, repoName, pullRequestNumber, branchName, githubToken, purpose, correlatedLogger } = options;
    await ensureGitRepository(correlatedLogger);
    const repoUrl = getRepoUrl({ repoOwner, repoName });
    const localRepoPath = await ensureRepoCloned({ repoUrl, owner: repoOwner, repoName, authToken: githubToken });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const worktreeInfo = await createWorktreeFromExistingBranch(localRepoPath, branchName, {
        worktreeDirName: `pr-${pullRequestNumber}-${purpose}-${timestamp}`,
        owner: repoOwner,
        repoName,
    });
    correlatedLogger.info({ worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName }, 'Created worktree for PR title generation');
    return { localRepoPath, worktreeInfo };
}
