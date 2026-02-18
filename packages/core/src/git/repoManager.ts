import { simpleGit, SimpleGit } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import { Octokit } from '@octokit/core';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import {
    cleanupWorktree,
    cleanupExpiredWorktrees,
    safePruneWorktrees,
    setupWorktreePermissions,
    addToSafeDirectories,
    getWorktreePath
} from './worktreeOperations.js';
import { cleanupExistingBranch, createWorktreeFromExistingBranch } from './worktreeCreation.js';
import { setupAuthenticatedRemote, ensureBranchAndPush, pushBranch } from './repoBranching.js';
import { commitChanges } from './commitOperations.js';
import { detectDefaultBranch, getRepoConfigKey, listRepositoryBranchConfigurations } from './branchConfig.js';

const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || "/tmp/git-processor/clones";
const GIT_SHALLOW_CLONE_DEPTH = process.env.GIT_SHALLOW_CLONE_DEPTH ? parseInt(process.env.GIT_SHALLOW_CLONE_DEPTH) : undefined;

async function getRepoPath(owner: string, repoName: string): Promise<string> {
    return path.join(CLONES_BASE_PATH, owner, repoName);
}

/**
 * Check if a repository has active worktrees that would prevent re-cloning.
 */
async function hasActiveWorktrees(localRepoPath: string): Promise<boolean> {
    const worktreesDir = path.join(localRepoPath, '.git', 'worktrees');
    try {
        if (await fs.pathExists(worktreesDir)) {
            const entries = await fs.readdir(worktreesDir);
            return entries.length > 0;
        }
        return false;
    } catch {
        // If we can't check, assume there might be active worktrees
        return true;
    }
}

export interface EnsureRepoClonedOptions {
    repoUrl: string;
    owner: string;
    repoName: string;
    authToken: string;
    baseBranch?: string;
}

export async function ensureRepoCloned(options: EnsureRepoClonedOptions): Promise<string> {
    return ensureRepoClonedInternal(options);
}

/**
 * Configure git gc globally to not prune worktree metadata younger than 24 hours.
 * This prevents race conditions where concurrent operations might cause
 * gc to prune metadata for actively running tasks.
 * Uses --global so it applies to all repos including existing ones.
 */
let gcWorktreePruneConfigured = false;
async function configureGcWorktreePrune(git: SimpleGit): Promise<void> {
    if (gcWorktreePruneConfigured) return;
    try {
        await git.raw(['config', '--global', 'gc.worktreePruneExpire', '24.hours.ago']);
        gcWorktreePruneConfigured = true;
        logger.info('Set global gc.worktreePruneExpire to 24 hours');
    } catch (configError) {
        logger.warn({ error: (configError as Error).message }, 'Failed to set gc.worktreePruneExpire');
    }
}

async function ensureRepoClonedInternal(opts: EnsureRepoClonedOptions): Promise<string> {
    const { repoUrl, owner, repoName, authToken, baseBranch } = opts;
    const localRepoPath = await getRepoPath(owner, repoName);

    try {
        if (await fs.pathExists(path.join(localRepoPath, ".git"))) {
            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Repository exists locally. Validating and fetching updates...');

            // Add to safe.directory BEFORE any git operations on this path
            // This prevents "dubious ownership" errors in containerized environments
            // Use simpleGit() without a path so the command runs regardless of directory ownership
            try {
                await simpleGit().raw(['config', '--global', '--add', 'safe.directory', localRepoPath]);
            } catch {
                // Non-fatal - continue anyway, the directory might already be safe
            }

            try {
                const git: SimpleGit = simpleGit(localRepoPath);
                const isRepo = await git.checkIsRepo();

                if (!isRepo) throw new Error('Directory exists but is not a valid git repository');

                await configureGcWorktreePrune(git);
                await setupAuthenticatedRemote(git, repoUrl, authToken);
                await git.fetch(['origin', '--prune']);
            } catch (gitError) {
                const errorMessage = (gitError as Error).message;

                // Check if there are active worktrees before removing the clone
                // Removing the clone would delete .git/worktrees and break any running tasks
                if (await hasActiveWorktrees(localRepoPath)) {
                    const worktreesDir = path.join(localRepoPath, '.git', 'worktrees');
                    logger.error({
                        repo: `${owner}/${repoName}`,
                        path: localRepoPath,
                        error: errorMessage,
                        worktreesDir
                    }, 'Git repository has issues but has active worktrees - cannot remove and re-clone. Throwing error instead.');
                    throw new Error(`Repository ${owner}/${repoName} is corrupted but has active worktrees: ${errorMessage}`);
                }

                logger.warn({ repo: `${owner}/${repoName}`, path: localRepoPath, error: errorMessage }, 'Git repository is corrupted or invalid. Removing and re-cloning...');
                await fs.remove(localRepoPath);
                return ensureRepoClonedInternal(opts);
            }

            const git: SimpleGit = simpleGit(localRepoPath);
            // Use specified baseBranch if provided, otherwise detect default branch
            let targetBranch = baseBranch;
            if (!targetBranch) {
                targetBranch = await detectDefaultBranch(git, owner, repoName);
            }

            try {
                await git.checkout(targetBranch);
                logger.info({ repo: `${owner}/${repoName}`, branch: targetBranch, isBaseBranch: !!baseBranch }, 'Checked out target branch in main repository');
            } catch (checkoutError) {
                logger.warn({ repo: `${owner}/${repoName}`, branch: targetBranch, error: (checkoutError as Error).message }, 'Failed to checkout target branch, continuing anyway');
            }

            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Repository updated successfully');

        } else {
            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Cloning repository...');

            // If the directory exists but has no .git folder (e.g., from a failed clone),
            // we need to remove it first because git clone fails on non-empty directories
            if (await fs.pathExists(localRepoPath)) {
                logger.warn({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Directory exists without .git folder - removing before clone');
                await fs.remove(localRepoPath);
            }
            await fs.ensureDir(localRepoPath);

            const cloneOptions: string[] = [];
            if (GIT_SHALLOW_CLONE_DEPTH) cloneOptions.push(`--depth=${GIT_SHALLOW_CLONE_DEPTH}`);
            // Clone specific branch if baseBranch is specified
            if (baseBranch) cloneOptions.push(`--branch=${baseBranch}`);

            const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);

            const git: SimpleGit = simpleGit();
            await git.clone(authenticatedUrl, localRepoPath, cloneOptions);

            const repoGit: SimpleGit = simpleGit(localRepoPath);
            await configureGcWorktreePrune(repoGit);
            try {
                await repoGit.raw(['remote', 'set-head', 'origin', '--auto']);
                logger.debug({ repo: `${owner}/${repoName}` }, 'Set remote HEAD to auto-detect default branch');
            } catch (headError) {
                logger.debug({ repo: `${owner}/${repoName}`, error: (headError as Error).message }, 'Failed to set remote HEAD, continuing anyway');
            }

            // Use specified baseBranch if provided, otherwise detect default branch
            let targetBranch = baseBranch;
            if (!targetBranch) {
                targetBranch = await detectDefaultBranch(repoGit, owner, repoName);
            }

            try {
                await repoGit.checkout(targetBranch);
                logger.info({ repo: `${owner}/${repoName}`, branch: targetBranch, isBaseBranch: !!baseBranch }, 'Checked out target branch in main repository after clone');
            } catch (checkoutError) {
                logger.warn({ repo: `${owner}/${repoName}`, branch: targetBranch, error: (checkoutError as Error).message }, 'Failed to checkout target branch after clone, continuing anyway');
            }

            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath, shallow: !!GIT_SHALLOW_CLONE_DEPTH, baseBranch: baseBranch || 'default' }, 'Repository cloned successfully');
        }

        return localRepoPath;

    } catch (error) {
        handleError(error, `Failed to clone/fetch repository ${owner}/${repoName}`);
        throw error;
    }
}

interface IssueInfo {
    issueId: number | string;
    issueTitle: string;
    owner: string;
    repoName: string;
}

interface CreateWorktreeOptions {
    baseBranch?: string | null;
    octokit?: InstanceType<typeof Octokit> | null;
    modelName?: string | null;
}

export interface WorktreeResult {
    worktreePath: string;
    branchName: string;
}

export type WorktreeInfo = WorktreeResult;

export async function createWorktreeForIssue(localRepoPath: string, issueInfo: IssueInfo, options: CreateWorktreeOptions = {}): Promise<WorktreeResult> {
    const { issueId, issueTitle, owner, repoName } = issueInfo;
    const { baseBranch = null, octokit = null, modelName = null } = options;

    const sanitizedTitle = issueTitle.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 25);
    const randomString = Math.random().toString(36).substring(2, 5);
    const now = new Date();
    const shortTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

    const branchModelPrefix = modelName ? `${modelName}-` : '';
    const branchName = `${issueId}/${branchModelPrefix}${sanitizedTitle}-${shortTimestamp}-${randomString}`;
    const modelSuffix = modelName ? `-${modelName}` : '';
    const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelSuffix}-${randomString}`;
    const worktreePath = getWorktreePath(owner, repoName, worktreeDirName);

    try {
        const git: SimpleGit = simpleGit(localRepoPath);

        if (await fs.pathExists(worktreePath)) {
            logger.warn({ worktreePath, issueId }, 'Worktree path already exists. Removing existing worktree...');
            await cleanupWorktree(localRepoPath, worktreePath, branchName);
        }

        await fs.ensureDir(path.dirname(worktreePath));

        let resolvedBaseBranch = baseBranch;
        if (!resolvedBaseBranch) {
            resolvedBaseBranch = await detectDefaultBranch(git, owner, repoName, octokit);
            logger.info({ repo: `${owner}/${repoName}`, detectedBranch: resolvedBaseBranch }, 'Auto-detected default branch');
        } else {
            try {
                await git.revparse([`origin/${resolvedBaseBranch}`]);
                logger.info({ repo: `${owner}/${repoName}`, specifiedBranch: resolvedBaseBranch }, 'Using specified base branch');
            } catch (branchError) {
                logger.warn({ repo: `${owner}/${repoName}`, specifiedBranch: resolvedBaseBranch, error: (branchError as Error).message }, 'Specified branch not found, detecting default branch');
                resolvedBaseBranch = await detectDefaultBranch(git, owner, repoName, octokit);
            }
        }

        logger.info({ localRepoPath, worktreePath, branchName, baseBranch: resolvedBaseBranch, issueId }, 'Creating Git worktree...');

        // NOTE: Removed `git worktree prune` here - it was causing race conditions
        // when multiple tasks run concurrently on the same repo. The prune could
        // delete worktree metadata for actively running tasks. Prune is still
        // called during cleanup in worktreeOperations.ts after task completion.

        await cleanupExistingBranch(git, branchName);
        await git.fetch('origin', resolvedBaseBranch);
        logger.debug({ baseBranch: resolvedBaseBranch }, 'Fetched latest changes for base branch');

        await git.raw(['worktree', 'add', worktreePath, '-b', branchName, `origin/${resolvedBaseBranch}`]);
        await setupWorktreePermissions(worktreePath, branchName, issueId);
        await addToSafeDirectories(git, worktreePath, localRepoPath, { branchName, issueId });

        logger.info({ worktreePath, branchName, issueId }, 'Git worktree created successfully');

        return { worktreePath, branchName };

    } catch (error) {
        handleError(error, `Failed to create worktree for issue ${issueId}`);
        throw error;
    }
}

interface IssueRef {
    repoOwner: string;
    repoName: string;
}

export function getRepoUrl(issue: IssueRef): string {
    return `https://github.com/${issue.repoOwner}/${issue.repoName}.git`;
}

export interface FetchLatestChangesOptions {
    owner: string;
    repoName: string;
    authToken: string;
    branch?: string;
}

export interface FetchLatestChangesResult {
    success: boolean;
    repoPath: string;
    error?: string;
}

/**
 * Helper function to reset the current branch to match the remote.
 * Returns true if reset was successful, false otherwise.
 */
async function resetCurrentBranchToRemote(
    git: SimpleGit,
    owner: string,
    repoName: string
): Promise<boolean> {
    const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
    if (!currentBranch || currentBranch.trim() === 'HEAD') {
        return false;
    }

    const branchName = currentBranch.trim();
    try {
        const remoteHash = await git.revparse([`origin/${branchName}`]);
        await git.reset(['--hard', `origin/${branchName}`]);
        const newHead = await git.revparse(['HEAD']);
        logger.info(
            { repo: `${owner}/${repoName}`, branch: branchName, commitHash: newHead.trim(), remoteHash: remoteHash.trim() },
            'Reset local branch to match remote'
        );
        return true;
    } catch {
        // Remote branch doesn't exist, skip reset
        logger.debug(
            { repo: `${owner}/${repoName}`, branch: branchName },
            'No remote tracking branch found, skipping reset'
        );
        return false;
    }
}

/**
 * Fetch latest changes from the remote repository for a specific branch.
 * This function should be called before indexing to ensure the local copy is up-to-date.
 *
 * @param options - Configuration options for fetching
 * @returns Result indicating success/failure and the repository path
 */
export async function fetchLatestChanges(options: FetchLatestChangesOptions): Promise<FetchLatestChangesResult> {
    const { owner, repoName, authToken, branch } = options;
    const localRepoPath = await getRepoPath(owner, repoName);

    try {
        // Check if repo exists locally
        if (!await fs.pathExists(path.join(localRepoPath, ".git"))) {
            logger.warn(
                { repo: `${owner}/${repoName}`, path: localRepoPath },
                'Repository does not exist locally, cannot fetch. Will be cloned on next ensureRepoCloned call.'
            );
            return { success: false, repoPath: localRepoPath, error: 'Repository not cloned yet' };
        }

        const git: SimpleGit = simpleGit(localRepoPath);

        // Validate it's a proper git repository
        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
            logger.warn(
                { repo: `${owner}/${repoName}`, path: localRepoPath },
                'Directory exists but is not a valid git repository'
            );
            return { success: false, repoPath: localRepoPath, error: 'Not a valid git repository' };
        }

        // Set up authenticated remote
        const repoUrl = `https://github.com/${owner}/${repoName}.git`;
        await setupAuthenticatedRemote(git, repoUrl, authToken);

        // Fetch latest changes
        if (branch && branch !== 'HEAD') {
            // Fetch specific branch
            logger.info(
                { repo: `${owner}/${repoName}`, branch },
                'Fetching latest changes for specific branch...'
            );
            await git.fetch(['origin', branch, '--prune']);

            // Also reset local branch to match remote to ensure we have latest code
            try {
                await git.checkout(branch);
                await git.reset(['--hard', `origin/${branch}`]);
                const newHead = await git.revparse(['HEAD']);
                logger.info(
                    { repo: `${owner}/${repoName}`, branch, commitHash: newHead.trim() },
                    'Reset local branch to match remote'
                );
            } catch (resetError) {
                // Non-fatal: branch checkout/reset may fail if local state is unusual
                logger.warn(
                    { repo: `${owner}/${repoName}`, branch, error: (resetError as Error).message },
                    'Could not reset local branch to remote, continuing with fetched refs'
                );
            }
        } else {
            // Fetch all branches
            logger.info(
                { repo: `${owner}/${repoName}` },
                'Fetching latest changes from origin...'
            );
            await git.fetch(['origin', '--prune']);

            // Also reset current branch to match remote to ensure we have latest code
            try {
                await resetCurrentBranchToRemote(git, owner, repoName);
            } catch (resetError) {
                // Non-fatal: reset may fail if local state is unusual
                logger.warn(
                    { repo: `${owner}/${repoName}`, error: (resetError as Error).message },
                    'Could not reset local branch to remote, continuing with fetched refs'
                );
            }
        }

        logger.info(
            { repo: `${owner}/${repoName}`, branch: branch || 'all', path: localRepoPath },
            'Successfully fetched latest changes'
        );

        return { success: true, repoPath: localRepoPath };
    } catch (error) {
        const errorMessage = (error as Error).message;
        logger.warn(
            { repo: `${owner}/${repoName}`, branch, error: errorMessage },
            'Failed to fetch latest changes, will continue with existing local state'
        );
        return { success: false, repoPath: localRepoPath, error: errorMessage };
    }
}

export { cleanupWorktree, cleanupExpiredWorktrees, safePruneWorktrees, createWorktreeFromExistingBranch, ensureBranchAndPush, pushBranch, commitChanges, detectDefaultBranch, getRepoConfigKey, listRepositoryBranchConfigurations };
export type { CommitResult } from './commitOperations.js';
