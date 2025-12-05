import simpleGit from 'simple-git';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';

export async function setupAuthenticatedRemote(git, repoUrl, authToken) {
    const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);
    await git.remote(['set-url', 'origin', authenticatedUrl]);
}

export async function ensureBranchAndPush(worktreePath, branchName, baseBranch, options = {}) {
    const { repoUrl, authToken, tokenRefreshFn, correlationId } = options;

    const pushOperation = async (currentToken) => {
        const git = simpleGit({ baseDir: worktreePath });

        if (repoUrl && currentToken) await setupAuthenticatedRemote(git, repoUrl, currentToken);

        logger.info({ worktreePath, branchName, baseBranch }, 'Ensuring branch is properly set up and pushed...');

        const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
        const actualBranch = currentBranch.trim();

        if (actualBranch !== branchName) {
            logger.warn({ worktreePath, currentBranch: actualBranch, expectedBranch: branchName }, 'Branch mismatch detected, attempting to checkout correct branch');

            const branches = await git.branchLocal();
            logger.debug({ worktreePath, branchName, branchExists: branches.all.includes(branchName), localBranches: branches.all, currentBranch: branches.current }, 'Checking local branches before checkout');

            await git.checkout(branchName);

            const newBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
            const checkedOutBranch = newBranch.trim();
            logger.info({ worktreePath, previousBranch: actualBranch, newBranch: checkedOutBranch, expectedBranch: branchName, checkoutSuccess: checkedOutBranch === branchName }, 'Branch checkout completed');

            if (checkedOutBranch !== branchName) {
                throw new Error(`Failed to checkout branch '${branchName}', still on '${checkedOutBranch}'`);
            }
        }

        try {
            const diffResult = await git.raw(['diff', '--name-only', `origin/${baseBranch}...HEAD`]);
            if (!diffResult.trim()) {
                logger.warn({ branchName, baseBranch }, 'No changes detected between branch and base');
            } else {
                const changedFiles = diffResult.trim().split('\n').filter(f => f);
                logger.info({ branchName, baseBranch, changedFiles: changedFiles.length }, 'Changes detected, proceeding with push');
            }
        } catch (diffError) {
            logger.debug({ error: diffError.message }, 'Could not check diff, proceeding anyway');
        }

        await git.push(['--set-upstream', 'origin', branchName]);
        logger.info({ branchName, baseBranch, worktreePath }, 'Branch successfully pushed to remote');
    };

    try {
        let currentToken = authToken;

        await withRetry(
            async () => {
                try {
                    await pushOperation(currentToken);
                } catch (error) {
                    if (tokenRefreshFn && (error.message.includes('Authentication failed') || error.message.includes('Invalid username or token'))) {
                        logger.info({ correlationId, worktreePath, branchName }, 'Authentication error detected, attempting to refresh token');

                        try {
                            const refreshedToken = await tokenRefreshFn();
                            if (refreshedToken && refreshedToken !== currentToken) {
                                currentToken = refreshedToken;
                                logger.info({ correlationId }, 'Token refreshed successfully, retrying push');
                            }
                        } catch (refreshError) {
                            logger.error({ correlationId, error: refreshError.message }, 'Failed to refresh token');
                        }
                    }
                    throw error;
                }
            },
            { ...retryConfigs.gitPush, correlationId },
            `Git push for branch ${branchName}`
        );

    } catch (error) {
        logger.error({ error: error.message, branchName, baseBranch, worktreePath }, 'Failed to ensure branch and push');
        throw error;
    }
}

export async function pushBranch(worktreePath, branchName, options = {}) {
    const { repoUrl, authToken, remote = 'origin' } = options;

    const git = simpleGit({ baseDir: worktreePath });

    const performPush = async (token) => {
        if (repoUrl && token) await setupAuthenticatedRemote(git, repoUrl, token);

        try {
            const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
            logger.debug({ worktreePath, currentBranch: currentBranch.trim(), expectedBranch: branchName }, 'Current branch in worktree');

            if (currentBranch.trim() !== branchName) {
                logger.warn({ worktreePath, currentBranch: currentBranch.trim(), expectedBranch: branchName }, 'Branch mismatch detected, attempting to checkout correct branch');

                const branches = await git.branchLocal();
                logger.debug({ worktreePath, branchName, branchExists: branches.all.includes(branchName), localBranches: branches.all, currentBranch: branches.current }, 'Checking local branches before checkout');

                await git.checkout(branchName);

                const newBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
                logger.info({ worktreePath, previousBranch: currentBranch.trim(), newBranch: newBranch.trim(), expectedBranch: branchName, checkoutSuccess: newBranch.trim() === branchName }, 'Branch checkout completed');
            }
        } catch (branchCheckError) {
            logger.warn({ error: branchCheckError.message }, 'Failed to verify current branch, proceeding with push anyway');
        }

        await git.push([remote, branchName, '--set-upstream']);
    };

    try {
        await performPush(authToken);
        logger.info({ worktreePath, branchName, remote }, 'Branch pushed to remote successfully');
    } catch (error) {
        if (error.message && (error.message.includes('Authentication failed') || error.message.includes('Invalid username or token'))) {
            logger.info({ worktreePath, branchName }, 'Authentication error detected, attempting to refresh token');
            try {
                const freshOctokit = await getAuthenticatedOctokit();
                const freshAuth = await freshOctokit.auth({ type: "installation" });
                await performPush(freshAuth.token);
                logger.info({ worktreePath, branchName, remote }, 'Branch pushed to remote successfully after token refresh');
            } catch (retryError) {
                handleError(retryError, `Failed to push branch ${branchName} from worktree ${worktreePath} after token refresh`);
                throw retryError;
            }
        } else {
            handleError(error, `Failed to push branch ${branchName} from worktree ${worktreePath}`);
            throw error;
        }
    }
}
