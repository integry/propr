import { SimpleGit } from 'simple-git';
import logger from '../utils/logger.js';
import { AI_COMMIT_AUTHOR } from './commitOperations.js';
import { redactAuthenticatedGitUrl } from './redactGitUrl.js';
import { createHooklessGit } from './hooklessGit.js';

export type MergeOutcome = 'clean' | 'conflicts' | 'failed';

export interface MergeResult {
    outcome: MergeOutcome;
    baseCommit?: string;
    conflictedFiles?: string[];
    error?: string;
}

/**
 * Ensures a requested base commit is reachable from the worktree's HEAD.
 */
export async function assertCommitIsAncestor(
    worktreePath: string,
    ancestorCommit: string,
): Promise<void> {
    const git: SimpleGit = createHooklessGit(worktreePath);

    try {
        // simple-git's raw task can treat `merge-base --is-ancestor` exit 1 as
        // an empty successful result because Git writes no stderr. Compare the
        // actual merge base instead so a non-ancestor cannot be missed.
        const mergeBase = (await git.raw(['merge-base', ancestorCommit, 'HEAD'])).trim();
        if (mergeBase !== ancestorCommit) {
            throw new Error(`merge base was ${mergeBase || 'not found'}`);
        }
    } catch (error) {
        logger.error({
            worktreePath,
            ancestorCommit,
            error: (error as Error).message,
        }, 'Requested base commit is not incorporated into HEAD');
        throw new Error(`Requested base commit ${ancestorCommit} is not incorporated into HEAD`);
    }
}

export interface MergeBaseIntoBranchOptions {
    /** Repository that owns the base branch. Required when the worktree was created
     * from a fork: the fork's own `origin/<baseBranch>` is a different branch that
     * merely shares the name, so the base must be fetched from the base repository. */
    baseRepoUrl?: string;
    /** Installation token for `baseRepoUrl`; omit for public base repositories. */
    authToken?: string;
}

/**
 * Fetches the latest base branch and merges it into the current branch in the worktree.
 * Returns a structured outcome indicating whether the merge was clean, has conflicts, or failed.
 */
export async function mergeBaseIntoBranch(
    worktreePath: string,
    baseBranch: string,
    options: MergeBaseIntoBranchOptions = {},
): Promise<MergeResult> {
    const git: SimpleGit = createHooklessGit(worktreePath);
    // A fork worktree keeps its own origin, so the base is fetched from the base
    // repository into a namespace that cannot collide with the fork's branches.
    const baseRemote = options.baseRepoUrl && options.authToken
        ? options.baseRepoUrl.replace('https://', `https://x-access-token:${options.authToken}@`)
        : options.baseRepoUrl ?? 'origin';
    const baseRef = options.baseRepoUrl
        ? `refs/remotes/propr-base/${baseBranch}`
        : `refs/remotes/origin/${baseBranch}`;

    try {
        // Fetch the latest base branch
        logger.info({ worktreePath, baseBranch, baseRepoUrl: options.baseRepoUrl }, 'Fetching latest base branch for merge');
        await git.raw(['fetch', baseRemote, `+refs/heads/${baseBranch}:${baseRef}`, '--prune']);
        const baseCommit = (await git.raw([
            'rev-parse',
            '--verify',
            `${baseRef}^{commit}`,
        ])).trim();
        if (!baseCommit) {
            throw new Error(`Failed to resolve fetched base branch ${baseRef}`);
        }

        // Configure merge author
        try {
            await git.raw(['config', 'user.name', AI_COMMIT_AUTHOR.name]);
            await git.raw(['config', 'user.email', AI_COMMIT_AUTHOR.email]);
        } catch (configError) {
            logger.warn({ error: (configError as Error).message }, 'Failed to set git config for merge, continuing');
        }

        // Attempt the merge
        logger.info({ worktreePath, baseBranch }, 'Merging base branch into current branch');
        let mergeError: Error | null = null;
        try {
            await git.raw(['merge', baseRef, '--no-edit']);
        } catch (err) {
            mergeError = err as Error;
        }

        // ALWAYS check git status for conflicts - don't rely solely on exception messages
        // simple-git may not always throw when merge has conflicts
        const status = await git.status();
        const conflictedFiles = status.conflicted || [];

        if (conflictedFiles.length > 0) {
            logger.info({
                worktreePath,
                baseBranch,
                conflictedFiles,
                conflictCount: conflictedFiles.length,
                hadMergeError: !!mergeError
            }, 'Merge resulted in conflicts');

            return {
                outcome: 'conflicts',
                baseCommit,
                conflictedFiles
            };
        }

        // If merge threw an error but no conflicts detected, it's a genuine failure
        if (mergeError) {
            const errorMessage = redactAuthenticatedGitUrl(mergeError.message || '');
            logger.error({ worktreePath, baseBranch, error: errorMessage }, 'Merge failed unexpectedly');

            // Abort the failed merge to leave worktree in a clean state
            try {
                await git.raw(['merge', '--abort']);
            } catch {
                // Ignore abort errors
            }

            return {
                outcome: 'failed',
                error: errorMessage
            };
        }

        logger.info({ worktreePath, baseBranch }, 'Merge completed cleanly');
        return { outcome: 'clean', baseCommit };
    } catch (error) {
        const errorMessage = redactAuthenticatedGitUrl((error as Error).message || 'Unknown error');
        logger.error({ worktreePath, baseBranch, error: errorMessage }, 'Failed to execute merge operation');
        return {
            outcome: 'failed',
            error: errorMessage
        };
    }
}
