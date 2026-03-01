/**
 * Git branch operations for the planning service.
 */

import { simpleGit } from 'simple-git';
import logger from '../../utils/logger.js';
import { BranchNotFoundError } from './planningErrors.js';
import type { MinimalLogger } from './planningTypes.js';

/**
 * Checkout a specific branch in a repository.
 * Fetches from origin first, then checks out the branch.
 */
export async function checkoutBranch(repoPath: string, branch: string): Promise<void> {
  const git = simpleGit(repoPath);
  try {
    await git.fetch(['origin', '--prune']);
  } catch (e) {
    logger.warn({ repoPath, branch, error: (e as Error).message }, 'Failed to fetch');
  }

  try {
    const branchExists = await git.raw(['rev-parse', '--verify', `origin/${branch}`]).then(() => true).catch(() => false);
    if (!branchExists) {
      const localExists = await git.raw(['rev-parse', '--verify', branch]).then(() => true).catch(() => false);
      if (!localExists) throw new BranchNotFoundError(branch);
    }
    await git.checkout(branch);
    try {
      await git.pull('origin', branch);
    } catch {
      logger.debug({ repoPath, branch }, 'Pull failed, using local');
    }
  } catch (error) {
    if (error instanceof BranchNotFoundError) throw error;
    throw new BranchNotFoundError(branch);
  }
}

/**
 * Checkout the base branch for a worktree, handling errors gracefully.
 */
export async function checkoutBaseBranch(
  worktreePath: string,
  baseBranch: string | undefined,
  correlatedLogger: MinimalLogger
): Promise<void> {
  if (!baseBranch) return;
  try {
    await checkoutBranch(worktreePath, baseBranch);
    correlatedLogger.info({ baseBranch, worktreePath }, 'Checked out configured base branch');
  } catch (error) {
    if (error instanceof BranchNotFoundError) {
      // Branch doesn't exist - repo might be empty or branch not created yet
      // Continue with whatever state the worktree is in
      correlatedLogger.warn({ baseBranch, worktreePath }, 'Base branch not found (repo may be empty), continuing with current state');
    } else {
      correlatedLogger.warn({ baseBranch, error: (error as Error).message }, 'Failed to checkout base branch');
    }
  }
}
