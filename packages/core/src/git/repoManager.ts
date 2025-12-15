import { simpleGit, SimpleGit } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import { Octokit } from '@octokit/core';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import {
    cleanupWorktree,
    cleanupExpiredWorktrees,
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

export async function ensureRepoCloned(repoUrl: string, owner: string, repoName: string, authToken: string): Promise<string> {
    const localRepoPath = await getRepoPath(owner, repoName);

    try {
        if (await fs.pathExists(path.join(localRepoPath, ".git"))) {
            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Repository exists locally. Validating and fetching updates...');

            try {
                const git: SimpleGit = simpleGit(localRepoPath);
                const isRepo = await git.checkIsRepo();

                if (!isRepo) throw new Error('Directory exists but is not a valid git repository');

                await setupAuthenticatedRemote(git, repoUrl, authToken);
                await git.fetch(['origin', '--prune']);
            } catch (gitError) {
                logger.warn({ repo: `${owner}/${repoName}`, path: localRepoPath, error: (gitError as Error).message }, 'Git repository is corrupted or invalid. Removing and re-cloning...');
                await fs.remove(localRepoPath);
                return ensureRepoCloned(repoUrl, owner, repoName, authToken);
            }

            const git: SimpleGit = simpleGit(localRepoPath);
            const defaultBranch = await detectDefaultBranch(git, owner, repoName);

            try {
                await git.checkout(defaultBranch);
                logger.info({ repo: `${owner}/${repoName}`, defaultBranch }, 'Checked out default branch in main repository');
            } catch (checkoutError) {
                logger.warn({ repo: `${owner}/${repoName}`, defaultBranch, error: (checkoutError as Error).message }, 'Failed to checkout default branch, continuing anyway');
            }

            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Repository updated successfully');

        } else {
            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Cloning repository...');

            await fs.ensureDir(localRepoPath);

            const cloneOptions: string[] = [];
            if (GIT_SHALLOW_CLONE_DEPTH) cloneOptions.push(`--depth=${GIT_SHALLOW_CLONE_DEPTH}`);

            const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);

            const git: SimpleGit = simpleGit();
            await git.clone(authenticatedUrl, localRepoPath, cloneOptions);

            const repoGit: SimpleGit = simpleGit(localRepoPath);
            try {
                await repoGit.raw(['remote', 'set-head', 'origin', '--auto']);
                logger.debug({ repo: `${owner}/${repoName}` }, 'Set remote HEAD to auto-detect default branch');
            } catch (headError) {
                logger.debug({ repo: `${owner}/${repoName}`, error: (headError as Error).message }, 'Failed to set remote HEAD, continuing anyway');
            }

            const defaultBranch = await detectDefaultBranch(repoGit, owner, repoName);

            try {
                await repoGit.checkout(defaultBranch);
                logger.info({ repo: `${owner}/${repoName}`, defaultBranch }, 'Checked out default branch in main repository after clone');
            } catch (checkoutError) {
                logger.warn({ repo: `${owner}/${repoName}`, defaultBranch, error: (checkoutError as Error).message }, 'Failed to checkout default branch after clone, continuing anyway');
            }

            logger.info({ repo: `${owner}/${repoName}`, path: localRepoPath, shallow: !!GIT_SHALLOW_CLONE_DEPTH }, 'Repository cloned successfully');
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

    // Sanitize model name for branch (replace invalid chars)
    const sanitizedModel = modelName
        ? modelName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
        : '';

    // New branch format: {issue}/{model}-{slug}-{timestamp}-{suffix}
    // If no model, fall back to: {issue}/ai-{slug}-{timestamp}-{suffix}
    const branchName = sanitizedModel
        ? `${issueId}/${sanitizedModel}-${sanitizedTitle}-${shortTimestamp}-${randomString}`
        : `${issueId}/ai-${sanitizedTitle}-${shortTimestamp}-${randomString}`;
    const modelDirSuffix = sanitizedModel ? `-${sanitizedModel}` : '';
    const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelDirSuffix}-${randomString}`;
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

        try {
            await git.raw(['worktree', 'prune']);
            logger.debug('Pruned stale worktree references');
        } catch (pruneError) {
            logger.debug({ error: (pruneError as Error).message }, 'Failed to prune worktrees, continuing');
        }

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

export { cleanupWorktree, cleanupExpiredWorktrees, createWorktreeFromExistingBranch, ensureBranchAndPush, pushBranch, commitChanges, detectDefaultBranch, getRepoConfigKey, listRepositoryBranchConfigurations };
export type { CommitResult } from './commitOperations.js';
