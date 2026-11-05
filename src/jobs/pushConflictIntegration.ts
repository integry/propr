import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { performConflictResolution } from '@propr/core';
import type { WorkerStateManager, WorktreeInfo } from '@propr/core';
import { AI_COMMIT_AUTHOR } from './commitAuthor.js';
import { createAgentConflictResolver } from './mergeConflictAgentRunner.js';
import type { PullRequestPublication } from './prPublication.js';

export { isRebaseConflictPushError } from './prGitOperations.js';

export interface PushConflictIntegrationOptions {
    publication: PullRequestPublication;
    worktreeInfo: WorktreeInfo;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    getGithubToken: () => Promise<string>;
    stateManager: WorkerStateManager;
    taskId: string;
    correlationId: string;
    correlatedLogger: Logger;
    redisClient: Redis;
    /**
     * Records the merge commit as the durable committed checkpoint before it is
     * pushed, so a worker that dies after the push is not held later as
     * recorded_commit_mismatch against the original commit.
     */
    checkpointCommit?: (commitHash: string) => Promise<void>;
}

/**
 * Integrates commits pushed to the PR branch while a follow-up ran, instead of
 * failing the follow-up and rerunning its whole implementation: the remote
 * branch is merged into the finished work, the agent resolves the conflicts
 * (markers are verified), and the merge is pushed without rebasing. Returns
 * null when the conflicts could not be resolved; the local merge is then
 * aborted and the caller falls back to push salvage with the original HEAD.
 * If the push fails after the merge is committed, it throws with HEAD and the
 * handoff checkpoint at the merge SHA: salvage preserves that merge, including
 * both histories, rather than resetting to the original follow-up commit.
 */
export async function integrateRemoteAndPush(options: PushConflictIntegrationOptions, worktreePath: string): Promise<{ commitHash?: string } | null> {
    const { publication, pullRequestNumber, correlatedLogger } = options;
    const branchName = publication.target.branchName;
    const remoteBranch = `origin/${branchName}`;
    correlatedLogger.info({ pullRequestNumber, branchName }, 'Push conflicted with commits pushed while the follow-up ran; merging them in and resolving conflicts with the agent');
    const githubToken = await options.getGithubToken();
    const { resolveConflicts } = await createAgentConflictResolver({
        worktreeInfo: options.worktreeInfo, pullRequestNumber, repoOwner: options.repoOwner, repoName: options.repoName,
        baseBranch: remoteBranch, headBranch: branchName, githubToken,
        stateManager: options.stateManager, taskId: options.taskId, correlationId: options.correlationId,
        correlatedLogger, redisClient: options.redisClient,
    });
    const outcome = await performConflictResolution({
        worktreePath,
        // The head's own remote branch: the commits that made the push non-fast-forward.
        baseBranch: branchName,
        branchName,
        // The fetch of the moved branch runs with the installation token, like the merge-conflict job's.
        merge: { authToken: githubToken },
        resolveConflicts,
        author: AI_COMMIT_AUTHOR,
        commitMessage: ({ conflictedFiles }) => [
            `Merge ${remoteBranch} into ${branchName}`,
            '',
            `Integrates commits pushed to #${pullRequestNumber} while this follow-up ran.`,
            ...(conflictedFiles.length ? ['', 'Resolved conflicts in:', ...conflictedFiles.map(file => `- ${file}`)] : []),
        ].join('\n'),
        // A rebase would replay the commits and drop the merge that proves the remote was incorporated.
        push: async ({ worktreePath: path, headSha }) => {
            await options.checkpointCommit?.(headSha);
            return publication.push(path, undefined, { rebaseOnNonFastForward: false });
        },
    });
    if (outcome.status === 'resolved' || outcome.status === 'clean') {
        correlatedLogger.info({ pullRequestNumber, branchName, commitHash: outcome.headSha, conflictedFiles: outcome.conflictedFiles },
            'Integrated the moved PR branch and pushed the follow-up');
        return { commitHash: outcome.headSha };
    }
    correlatedLogger.warn({ pullRequestNumber, branchName, status: outcome.status }, 'Could not integrate the moved PR branch; falling back to push salvage');
    return null;
}
