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
import { setupAuthenticatedRemote, ensureBranchAndPush, pushBranch, redactAuthenticatedGitUrl } from './repoBranching.js';
import { commitChanges } from './commitOperations.js';
import { detectDefaultBranch, getRepoConfigKey, listRepositoryBranchConfigurations } from './branchConfig.js';
import { ensureSeedCommitIfEmpty } from './seedCommit.js';
import { fetchLatestChanges, FetchLatestChangesOptions, FetchLatestChangesResult } from './fetchOperations.js';

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

interface UpdateExistingRepoParams {
    localRepoPath: string;
    opts: EnsureRepoClonedOptions;
}

async function updateExistingRepo({ localRepoPath, opts }: UpdateExistingRepoParams): Promise<void> {
    const { repoUrl, owner, repoName, authToken, baseBranch } = opts;
    logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Repository exists locally. Validating and fetching updates...');

    // Add to safe.directory BEFORE any git operations on this path
    try {
        await simpleGit().raw(['config', '--global', '--add', 'safe.directory', localRepoPath]);
    } catch {
        // Non-fatal - continue anyway, the directory might already be safe
    }

    try {
        const git: SimpleGit = simpleGit(localRepoPath);
        if (!await git.checkIsRepo()) throw new Error('Directory exists but is not a valid git repository');
        await configureGcWorktreePrune(git);
        await setupAuthenticatedRemote(git, repoUrl, authToken);
        await git.fetch(['origin', '--prune']);
    } catch (gitError) {
        const errorMessage = (gitError as Error).message;
        if (await hasActiveWorktrees(localRepoPath)) {
            logger.error({ repo: `${owner}/${repoName}`, path: localRepoPath, error: errorMessage }, 'Git repository has issues but has active worktrees - cannot remove and re-clone.');
            throw new Error(`Repository ${owner}/${repoName} is corrupted but has active worktrees: ${errorMessage}`);
        }
        logger.warn({ repo: `${owner}/${repoName}`, path: localRepoPath, error: errorMessage }, 'Git repository is corrupted or invalid. Removing and re-cloning...');
        await fs.remove(localRepoPath);
        await ensureRepoClonedInternal(opts);
        return;
    }

    const git: SimpleGit = simpleGit(localRepoPath);
    // Treat 'HEAD' as unspecified - use default branch detection
    const effectiveBranch = baseBranch && baseBranch !== 'HEAD' ? baseBranch : undefined;
    let targetBranch = effectiveBranch || 'main';
    const wasEmpty = await ensureSeedCommitIfEmpty(git, { localRepoPath, owner, repoName, defaultBranch: targetBranch, authToken, repoUrl });

    if (!wasEmpty) {
        if (!effectiveBranch) targetBranch = await detectDefaultBranch(git, owner, repoName);
        try {
            await git.checkout(targetBranch);
            logger.info({ repo: `${owner}/${repoName}`, branch: targetBranch, isBaseBranch: !!baseBranch }, 'Checked out target branch');
        } catch (checkoutError) {
            logger.warn({ repo: `${owner}/${repoName}`, branch: targetBranch, error: (checkoutError as Error).message }, 'Failed to checkout target branch');
        }
    }
    logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath, wasEmpty }, 'Repository updated successfully');
}

async function cloneNewRepo({ localRepoPath, opts }: UpdateExistingRepoParams): Promise<void> {
    const { repoUrl, owner, repoName, authToken, baseBranch } = opts;
    logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Cloning repository...');

    if (await fs.pathExists(localRepoPath)) {
        logger.warn({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Directory exists without .git folder - removing before clone');
        await fs.remove(localRepoPath);
    }
    await fs.ensureDir(localRepoPath);

    const cloneOptions: string[] = [];
    if (GIT_SHALLOW_CLONE_DEPTH) cloneOptions.push(`--depth=${GIT_SHALLOW_CLONE_DEPTH}`);
    // Skip --branch flag when baseBranch is 'HEAD' since it's not a valid branch name
    // and git will use the remote's default branch automatically
    if (baseBranch && baseBranch !== 'HEAD') cloneOptions.push(`--branch=${baseBranch}`);

    const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);
    try {
        await simpleGit().clone(authenticatedUrl, localRepoPath, cloneOptions);
    } catch (error) {
        throw new Error(redactAuthenticatedGitUrl((error as Error).message));
    }

    const repoGit: SimpleGit = simpleGit(localRepoPath);
    await configureGcWorktreePrune(repoGit);

    // Treat 'HEAD' as unspecified - use default branch detection
    const effectiveBranch = baseBranch && baseBranch !== 'HEAD' ? baseBranch : undefined;
    let targetBranch = effectiveBranch || 'main';
    const wasEmpty = await ensureSeedCommitIfEmpty(repoGit, { localRepoPath, owner, repoName, defaultBranch: targetBranch, authToken, repoUrl });

    if (!wasEmpty) {
        try {
            await repoGit.raw(['remote', 'set-head', 'origin', '--auto']);
        } catch {
            // Non-fatal
        }
        if (!effectiveBranch) targetBranch = await detectDefaultBranch(repoGit, owner, repoName);
        try {
            await repoGit.checkout(targetBranch);
            logger.info({ repo: `${owner}/${repoName}`, branch: targetBranch, isBaseBranch: !!effectiveBranch }, 'Checked out target branch after clone');
        } catch (checkoutError) {
            logger.warn({ repo: `${owner}/${repoName}`, branch: targetBranch, error: (checkoutError as Error).message }, 'Failed to checkout target branch after clone');
        }
    }
    logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath, shallow: !!GIT_SHALLOW_CLONE_DEPTH, baseBranch: effectiveBranch || 'default', wasEmpty }, 'Repository cloned successfully');
}

async function ensureRepoClonedInternal(opts: EnsureRepoClonedOptions): Promise<string> {
    const { owner, repoName } = opts;
    const localRepoPath = await getRepoPath(owner, repoName);

    try {
        if (await fs.pathExists(path.join(localRepoPath, ".git"))) {
            await updateExistingRepo({ localRepoPath, opts });
        } else {
            await cloneNewRepo({ localRepoPath, opts });
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
        // Use explicit refspec to ensure remote tracking ref is updated
        // Simple `git fetch origin <branch>` may only update FETCH_HEAD without
        // updating refs/remotes/origin/<branch> in some git configurations
        try {
            await git.raw(['fetch', 'origin', `+refs/heads/${resolvedBaseBranch}:refs/remotes/origin/${resolvedBaseBranch}`, '--prune']);
            logger.debug({ baseBranch: resolvedBaseBranch }, 'Fetched latest changes for base branch with explicit refspec');
        } catch (fetchError) {
            const fetchErrorMessage = (fetchError as Error).message;
            // Check if this is an empty repository error (no branches exist)
            // This shouldn't happen normally since ensureRepoCloned creates seed commits for empty repos
            if (fetchErrorMessage.includes("couldn't find remote ref") || fetchErrorMessage.includes('does not appear to be a git repository')) {
                logger.warn({ repo: `${owner}/${repoName}`, branch: resolvedBaseBranch, error: fetchErrorMessage }, 'Repository appears to be empty - seed commit may have failed');
                throw new Error(`Repository ${owner}/${repoName} appears to be empty or the branch '${resolvedBaseBranch}' does not exist. The system attempted to initialize it but may have failed. Please check if the repository was properly seeded.`);
            }
            throw fetchError;
        }

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

export { cleanupWorktree, cleanupExpiredWorktrees, safePruneWorktrees, createWorktreeFromExistingBranch, ensureBranchAndPush, pushBranch, commitChanges, detectDefaultBranch, getRepoConfigKey, listRepositoryBranchConfigurations };
export { fetchLatestChanges };
export type { FetchLatestChangesOptions, FetchLatestChangesResult };
export type { CommitResult } from './commitOperations.js';
