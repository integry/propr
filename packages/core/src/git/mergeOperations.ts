import { simpleGit, SimpleGit } from 'simple-git';
import logger from '../utils/logger.js';

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
    options?: { authToken?: string; repoUrl?: string }
): Promise<MergeResult> {
    const git: SimpleGit = simpleGit({ baseDir: worktreePath });

    try {
        // Fetch the latest base branch
        logger.info({ worktreePath, baseBranch }, 'Fetching latest base branch for merge');
        await git.raw(['fetch', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`, '--prune']);

        // Configure merge author
        try {
            await git.raw(['config', 'user.name', 'Claude Code']);
            await git.raw(['config', 'user.email', 'claude-code@anthropic.com']);
        } catch (configError) {
            logger.warn({ error: (configError as Error).message }, 'Failed to set git config for merge, continuing');
        }

        // Attempt the merge
        logger.info({ worktreePath, baseBranch }, 'Merging base branch into current branch');
        try {
            await git.raw(['merge', `origin/${baseBranch}`, '--no-edit']);

            logger.info({ worktreePath, baseBranch }, 'Merge completed cleanly');
            return { outcome: 'clean' };
        } catch (mergeError) {
            const errorMessage = (mergeError as Error).message || '';

            // Check if the error is due to merge conflicts
            if (errorMessage.includes('CONFLICT') || errorMessage.includes('Automatic merge failed')) {
                // Get the list of conflicted files
                const status = await git.status();
                const conflictedFiles = status.conflicted || [];

                logger.info({
                    worktreePath,
                    baseBranch,
                    conflictedFiles,
                    conflictCount: conflictedFiles.length
                }, 'Merge resulted in conflicts');

                return {
                    outcome: 'conflicts',
                    conflictedFiles
                };
            }

            // Not a conflict error - this is a genuine failure
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
    } catch (error) {
        const errorMessage = (error as Error).message || 'Unknown error';
        logger.error({ worktreePath, baseBranch, error: errorMessage }, 'Failed to execute merge operation');
        return {
            outcome: 'failed',
            error: errorMessage
        };
    }
}
