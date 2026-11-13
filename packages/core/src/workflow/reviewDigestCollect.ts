import { getCommitChanges, getWorktreeChanges } from '../services/worktreeMonitorService.js';
import logger from '../utils/logger.js';
import type { RepositoryValidationResult } from './repositoryValidationResult.js';
import { buildReviewDigest, type ReviewConfig, type ReviewDigest } from './reviewDigest.js';

/**
 * Read a run's diff from its worktree and build the review digest. The diff is
 * the worktree against `comparisonRef` (the task's starting commit), or one
 * commit's changes. Never throws: a diff that cannot be read means no digest.
 */
export async function collectReviewDigest(options: {
    worktreePath: string;
    comparisonRef?: string;
    commitHash?: string;
    validation?: RepositoryValidationResult | null;
    review?: ReviewConfig;
}): Promise<ReviewDigest | null> {
    const { worktreePath, comparisonRef, commitHash } = options;
    try {
        const changes = comparisonRef ? await getWorktreeChanges(worktreePath, comparisonRef)
            : commitHash ? await getCommitChanges(worktreePath, commitHash) : [];
        return buildReviewDigest(changes, options.validation, options.review);
    } catch (error) {
        logger.warn({ worktreePath, error: (error as Error).message }, 'Could not build the review digest');
        return null;
    }
}
