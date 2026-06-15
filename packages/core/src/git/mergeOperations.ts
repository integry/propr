import { simpleGit, SimpleGit } from 'simple-git';
import logger from '../utils/logger.js';
import { AI_COMMIT_AUTHOR } from './commitOperations.js';

export type MergeOutcome = 'clean' | 'conflicts' | 'failed';

export interface MergeResult {
    outcome: MergeOutcome;
    conflictedFiles?: string[];
    error?: string;
}

/**
 * Fetches the latest base branch and merges it into the current branch in the worktree.
 * Returns a structured outcome indicating whether the merge was clean, has conflicts, or failed.
 */
export async function mergeBaseIntoBranch(
    worktreePath: string,
    baseBranch: string,
): Promise<MergeResult> {
    const git: SimpleGit = simpleGit({ baseDir: worktreePath });

    try {
        // Fetch the latest base branch
        logger.info({ worktreePath, baseBranch }, 'Fetching latest base branch for merge');
        await git.raw(['fetch', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`, '--prune']);

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
            await git.raw(['merge', `origin/${baseBranch}`, '--no-edit']);
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
                conflictedFiles
            };
        }

        // If merge threw an error but no conflicts detected, it's a genuine failure
        if (mergeError) {
            const errorMessage = mergeError.message || '';
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
        return { outcome: 'clean' };
    } catch (error) {
        const errorMessage = (error as Error).message || 'Unknown error';
        logger.error({ worktreePath, baseBranch, error: errorMessage }, 'Failed to execute merge operation');
        return {
            outcome: 'failed',
            error: errorMessage
        };
    }
}
