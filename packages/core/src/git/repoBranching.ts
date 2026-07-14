import { simpleGit, SimpleGit } from 'simple-git';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';

interface InstallationAuth {
    token: string;
}

export function redactAuthenticatedGitUrl(message: string): string {
    return message
        .replace(/https:\/\/x-access-token:[^@\s'"]+@github\.com\//g, 'https://x-access-token:[REDACTED]@github.com/')
        .replace(/\b(?:ghs|ghp|gho|ghu|ghr|github_pat)_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_TOKEN]');
}

export async function setupAuthenticatedRemote(git: SimpleGit, repoUrl: string, authToken: string): Promise<void> {
    const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);
    try {
        await git.remote(['set-url', 'origin', authenticatedUrl]);
    } catch (error) {
        throw new Error(redactAuthenticatedGitUrl((error as Error).message));
    }
}

interface EnsureBranchAndPushOptions {
    repoUrl?: string;
    authToken?: string;
    tokenRefreshFn?: () => Promise<string>;
    correlationId?: string;
}

export async function ensureBranchAndPush(worktreePath: string, branchName: string, baseBranch: string, options: EnsureBranchAndPushOptions = {}): Promise<void> {
    const { repoUrl, authToken, tokenRefreshFn, correlationId } = options;

    const pushOperation = async (currentToken: string | undefined): Promise<void> => {
        const git: SimpleGit = simpleGit({ baseDir: worktreePath });

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
                const changedFiles = diffResult.trim().split('\n').filter((f: string) => f);
                logger.info({ branchName, baseBranch, changedFiles: changedFiles.length }, 'Changes detected, proceeding with push');
            }
        } catch (diffError) {
            logger.debug({ error: (diffError as Error).message }, 'Could not check diff, proceeding anyway');
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
                    if (tokenRefreshFn && ((error as Error).message.includes('Authentication failed') || (error as Error).message.includes('Invalid username or token'))) {
                        logger.info({ correlationId, worktreePath, branchName }, 'Authentication error detected, attempting to refresh token');

                        try {
                            const refreshedToken = await tokenRefreshFn();
                            if (refreshedToken && refreshedToken !== currentToken) {
                                currentToken = refreshedToken;
                                logger.info({ correlationId }, 'Token refreshed successfully, retrying push');
                            }
                        } catch (refreshError) {
                            logger.error({ correlationId, error: (refreshError as Error).message }, 'Failed to refresh token');
                        }
                    }
                    throw error;
                }
            },
            { ...retryConfigs.gitPush, correlationId },
            `Git push for branch ${branchName}`
        );

    } catch (error) {
        logger.error({ error: (error as Error).message, branchName, baseBranch, worktreePath }, 'Failed to ensure branch and push');
        throw error;
    }
}

interface PushBranchOptions {
    repoUrl?: string;
    authToken?: string;
    remote?: string;
    rebaseOnNonFastForward?: boolean;
}

export interface PushBranchResult {
    rebased: boolean;
    commitHash?: string;
}

function isAuthenticationError(error: unknown): boolean {
    const message = (error as Error).message || '';
    return message.includes('Authentication failed') || message.includes('Invalid username or token');
}

function isNonFastForwardPushError(error: unknown): boolean {
    const message = (error as Error).message || '';
    return message.includes('[rejected] (fetch first)')
        || message.includes('non-fast-forward')
        || message.includes('Updates were rejected because the remote contains work that you do not');
}

async function getHeadCommitHash(git: SimpleGit): Promise<string | undefined> {
    try {
        return (await git.revparse(['HEAD'])).trim();
    } catch {
        return undefined;
    }
}

export async function pushBranch(worktreePath: string, branchName: string, options: PushBranchOptions = {}): Promise<PushBranchResult> {
    const { repoUrl, authToken, remote = 'origin', rebaseOnNonFastForward = false } = options;

    const git = simpleGit({ baseDir: worktreePath });

    const performPush = async (token: string | undefined): Promise<void> => {
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
            logger.warn({ error: (branchCheckError as Error).message }, 'Failed to verify current branch, proceeding with push anyway');
        }

        await git.push([remote, branchName, '--set-upstream']);
    };

    const rebaseOntoRemoteAndPush = async (token: string | undefined, originalError: unknown): Promise<PushBranchResult> => {
        logger.info({ worktreePath, branchName, remote }, 'Push rejected because remote branch advanced; rebasing local work onto latest remote head');

        try {
            await git.raw(['fetch', remote, `+refs/heads/${branchName}:refs/remotes/${remote}/${branchName}`]);
            await git.raw(['rebase', `${remote}/${branchName}`]);
        } catch (rebaseError) {
            try {
                await git.raw(['rebase', '--abort']);
            } catch {
                // Ignore abort failures; the rebase error below is the actionable failure.
            }
            const originalMessage = redactAuthenticatedGitUrl((originalError as Error).message || '');
            const rebaseMessage = redactAuthenticatedGitUrl((rebaseError as Error).message || '');
            throw new Error(`Push was rejected because ${remote}/${branchName} advanced, and automatic rebase failed.\n\nOriginal push error:\n${originalMessage}\n\nRebase error:\n${rebaseMessage}`);
        }

        await performPush(token);
        const commitHash = await getHeadCommitHash(git);
        logger.info({ worktreePath, branchName, remote, commitHash }, 'Branch pushed to remote successfully after rebase');
        return { rebased: true, commitHash };
    };

    try {
        await performPush(authToken);
        logger.info({ worktreePath, branchName, remote }, 'Branch pushed to remote successfully');
        return { rebased: false, commitHash: await getHeadCommitHash(git) };
    } catch (error) {
        if (isNonFastForwardPushError(error) && rebaseOnNonFastForward) {
            try {
                return await rebaseOntoRemoteAndPush(authToken, error);
            } catch (retryError) {
                handleError(retryError, `Failed to push branch ${branchName} from worktree ${worktreePath} after rebase`);
                throw retryError;
            }
        }

        if (isAuthenticationError(error)) {
            logger.info({ worktreePath, branchName }, 'Authentication error detected, attempting to refresh token');
            try {
                const freshOctokit = await getAuthenticatedOctokit();
                const freshAuth = await (freshOctokit as unknown as { auth: (opts: { type: string }) => Promise<InstallationAuth> }).auth({ type: "installation" });
                try {
                    await performPush(freshAuth.token);
                } catch (retryError) {
                    if (isNonFastForwardPushError(retryError) && rebaseOnNonFastForward) {
                        return await rebaseOntoRemoteAndPush(freshAuth.token, retryError);
                    }
                    throw retryError;
                }
                logger.info({ worktreePath, branchName, remote }, 'Branch pushed to remote successfully after token refresh');
                return { rebased: false, commitHash: await getHeadCommitHash(git) };
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
