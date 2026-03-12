import { simpleGit, SimpleGit } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { setupAuthenticatedRemote } from './repoBranching.js';

const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || "/tmp/git-processor/clones";

async function getRepoPath(owner: string, repoName: string): Promise<string> {
    return path.join(CLONES_BASE_PATH, owner, repoName);
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

async function resetCurrentBranchToRemote(git: SimpleGit, owner: string, repoName: string): Promise<boolean> {
    const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
    if (!currentBranch || currentBranch.trim() === 'HEAD') return false;

    const branchName = currentBranch.trim();
    try {
        const remoteHash = await git.revparse([`origin/${branchName}`]);
        await git.reset(['--hard', `origin/${branchName}`]);
        const newHead = await git.revparse(['HEAD']);
        logger.info({ repo: `${owner}/${repoName}`, branch: branchName, commitHash: newHead.trim(), remoteHash: remoteHash.trim() }, 'Reset local branch to match remote');
        return true;
    } catch {
        logger.debug({ repo: `${owner}/${repoName}`, branch: branchName }, 'No remote tracking branch found, skipping reset');
        return false;
    }
}

async function fetchSpecificBranch(git: SimpleGit, owner: string, repoName: string, branch: string): Promise<void> {
    logger.info({ repo: `${owner}/${repoName}`, branch }, 'Fetching latest changes for specific branch...');
    await git.fetch(['origin', branch, '--prune']);
    try {
        await git.checkout(branch);
        await git.reset(['--hard', `origin/${branch}`]);
        const newHead = await git.revparse(['HEAD']);
        logger.info({ repo: `${owner}/${repoName}`, branch, commitHash: newHead.trim() }, 'Reset local branch to match remote');
    } catch (resetError) {
        logger.warn({ repo: `${owner}/${repoName}`, branch, error: (resetError as Error).message }, 'Could not reset local branch to remote, continuing with fetched refs');
    }
}

async function fetchAllBranches(git: SimpleGit, owner: string, repoName: string): Promise<void> {
    logger.info({ repo: `${owner}/${repoName}` }, 'Fetching latest changes from origin...');
    await git.fetch(['origin', '--prune']);
    try {
        await resetCurrentBranchToRemote(git, owner, repoName);
    } catch (resetError) {
        logger.warn({ repo: `${owner}/${repoName}`, error: (resetError as Error).message }, 'Could not reset local branch to remote, continuing with fetched refs');
    }
}

/**
 * Fetch latest changes from the remote repository for a specific branch.
 * This function should be called before indexing to ensure the local copy is up-to-date.
 */
export async function fetchLatestChanges(options: FetchLatestChangesOptions): Promise<FetchLatestChangesResult> {
    const { owner, repoName, authToken, branch } = options;
    const localRepoPath = await getRepoPath(owner, repoName);

    try {
        if (!await fs.pathExists(path.join(localRepoPath, ".git"))) {
            logger.warn({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Repository does not exist locally, cannot fetch.');
            return { success: false, repoPath: localRepoPath, error: 'Repository not cloned yet' };
        }

        const git: SimpleGit = simpleGit(localRepoPath);
        if (!await git.checkIsRepo()) {
            logger.warn({ repo: `${owner}/${repoName}`, path: localRepoPath }, 'Directory exists but is not a valid git repository');
            return { success: false, repoPath: localRepoPath, error: 'Not a valid git repository' };
        }

        const repoUrl = `https://github.com/${owner}/${repoName}.git`;
        await setupAuthenticatedRemote(git, repoUrl, authToken);

        if (branch && branch !== 'HEAD') {
            await fetchSpecificBranch(git, owner, repoName, branch);
        } else {
            await fetchAllBranches(git, owner, repoName);
        }

        logger.info({ repo: `${owner}/${repoName}`, branch: branch || 'all', path: localRepoPath }, 'Successfully fetched latest changes');
        return { success: true, repoPath: localRepoPath };
    } catch (error) {
        const errorMessage = (error as Error).message;
        logger.warn({ repo: `${owner}/${repoName}`, branch, error: errorMessage }, 'Failed to fetch latest changes');
        return { success: false, repoPath: localRepoPath, error: errorMessage };
    }
}
