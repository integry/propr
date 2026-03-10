import { simpleGit, SimpleGit } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import {
    cleanupWorktree,
    setupWorktreePermissions,
    addToSafeDirectories,
    verifyWorktreeCreation,
    setupWorktreeRemote,
    getWorktreePath
} from './worktreeOperations.js';

async function removeWorktreeForBranch(git: SimpleGit, worktreeLines: string[], branchName: string): Promise<void> {
    for (let i = 0; i < worktreeLines.length; i++) {
        const line = worktreeLines[i];
        if (!line.startsWith('worktree ')) continue;

        const wtPath = line.substring('worktree '.length);
        const branchLine = worktreeLines[i + 1];
        const isBranchMatch = branchLine &&
            branchLine.startsWith('branch ') &&
            branchLine.substring('branch refs/heads/'.length) === branchName;

        if (isBranchMatch) {
            logger.info({ worktreePath: wtPath, branchName }, 'Removing existing worktree for branch');
            try {
                await git.raw(['worktree', 'remove', wtPath, '--force']);
            } catch (removeError) {
                logger.warn({ worktreePath: wtPath, error: (removeError as Error).message }, 'Failed to remove existing worktree');
            }
        }
    }
}

export async function cleanupExistingBranch(git: SimpleGit, branchName: string): Promise<void> {
    try {
        await git.revparse([branchName]);
        logger.info({ branchName }, 'Branch already exists, will delete and recreate');

        try {
            const worktreeList = await git.raw(['worktree', 'list', '--porcelain']);
            const worktreeLines = worktreeList.split('\n');
            await removeWorktreeForBranch(git, worktreeLines, branchName);
        } catch (listError) {
            logger.debug({ error: (listError as Error).message }, 'Failed to list worktrees');
        }

        try {
            await git.branch(['-D', branchName]);
            logger.info({ branchName }, 'Deleted existing branch');
        } catch (deleteError) {
            logger.warn({ branchName, error: (deleteError as Error).message }, 'Failed to delete existing branch, continuing anyway');
        }
    } catch {
        logger.debug({ branchName }, 'Branch does not exist, will create new one');
    }
}

async function handleExistingWorktreePath(worktreePath: string, localRepoPath: string, branchName: string): Promise<void> {
    logger.warn({ worktreePath, branchName }, 'Worktree path already exists. Checking if it\'s a valid worktree...');

    const gitPath = path.join(worktreePath, '.git');
    let isProperWorktree = false;

    if (await fs.pathExists(gitPath)) {
        const stats = await fs.stat(gitPath);
        isProperWorktree = stats.isFile();
    }

    if (!isProperWorktree) {
        logger.warn({ worktreePath, gitPath, isDirectory: await fs.pathExists(gitPath) ? (await fs.stat(gitPath)).isDirectory() : false }, 'Not a proper worktree, removing directory directly');
        await fs.remove(worktreePath);
    } else {
        await cleanupWorktree(localRepoPath, worktreePath, branchName);
    }

    if (await fs.pathExists(worktreePath)) {
        logger.warn({ worktreePath }, 'Directory still exists after cleanup, forcing removal');
        await fs.remove(worktreePath);
    }
}

async function handleWorktreeConflict(git: SimpleGit, error: Error, worktreePath: string, branchName: string): Promise<void> {
    logger.error({ branchName, error: error.message }, 'Branch is already checked out in another worktree');

    const match = error.message.match(/worktree at '([^']+)'/);
    if (match) {
        const existingWorktreePath = match[1];
        logger.info({ branchName, existingWorktreePath, newWorktreePath: worktreePath }, 'Attempting to remove existing worktree to allow new one');

        try {
            await git.raw(['worktree', 'remove', existingWorktreePath, '--force']);
            logger.info({ existingWorktreePath }, 'Successfully removed existing worktree');

            const worktreeAddResult = await git.raw(['worktree', 'add', '-B', branchName, worktreePath, `origin/${branchName}`]);
            logger.info({ branchName, worktreePath, gitOutput: worktreeAddResult.trim() }, 'Successfully created worktree after removing existing one');
        } catch (retryError) {
            logger.error({ branchName, existingWorktreePath, error: (retryError as Error).message }, 'Failed to handle existing worktree conflict');
            throw new Error(`Cannot create worktree: branch '${branchName}' is locked by another worktree`);
        }
    } else {
        throw new Error(`Cannot create worktree: branch '${branchName}' is already checked out elsewhere`);
    }
}

async function handleImproperWorktree(worktreePath: string, branchName: string, error: Error): Promise<void> {
    logger.error({ branchName, worktreePath, error: error.message }, 'Worktree creation failed - improper structure detected');

    try {
        await fs.remove(worktreePath);
        logger.info({ worktreePath }, 'Removed improperly created worktree directory');
    } catch (cleanupError) {
        logger.error({ worktreePath, error: (cleanupError as Error).message }, 'Failed to clean up improper worktree directory');
    }

    throw error;
}

async function handleWorktreeCreationError(git: SimpleGit, branchName: string, error: Error): Promise<void> {
    logger.error({ branchName, error: error.message }, 'Failed to create worktree from remote branch');

    try {
        const remoteBranches = await git.branch(['-r']);
        const remoteBranchExists = remoteBranches.all.includes(`origin/${branchName}`);
        if (!remoteBranchExists) {
            throw new Error(`Cannot create worktree: branch '${branchName}' not found on remote`);
        } else {
            throw new Error(`Cannot create worktree: ${error.message}`);
        }
    } catch {
        throw new Error(`Cannot create worktree: ${error.message}`);
    }
}

async function createWorktreeFromRemote(git: SimpleGit, worktreePath: string, branchName: string, localRepoPath: string): Promise<void> {
    try {
        const worktreeMetadataDir = path.join(localRepoPath, '.git', 'worktrees');
        await fs.ensureDir(worktreeMetadataDir);

        const mainRepoGitPath = path.join(localRepoPath, '.git');
        if (!await fs.pathExists(mainRepoGitPath)) {
            throw new Error(`Main repository is invalid - no .git found at ${localRepoPath}`);
        }

        try {
            const existingWorktrees = await git.raw(['worktree', 'list', '--porcelain']);
            logger.debug({ localRepoPath, existingWorktrees: existingWorktrees.trim() }, 'Current worktrees before adding new one');
        } catch (listError) {
            logger.warn({ error: (listError as Error).message }, 'Failed to list existing worktrees');
        }

        const worktreeAddResult = await git.raw(['worktree', 'add', '-B', branchName, worktreePath, `origin/${branchName}`]);
        logger.info({ branchName, worktreePath, gitOutput: worktreeAddResult.trim() }, 'Git worktree add command completed');

    } catch (error) {
        if ((error as Error).message && (error as Error).message.includes('is already used by worktree')) {
            await handleWorktreeConflict(git, error as Error, worktreePath, branchName);
        } else if ((error as Error).message && (error as Error).message.includes('.git is a directory')) {
            await handleImproperWorktree(worktreePath, branchName, error as Error);
        } else {
            await handleWorktreeCreationError(git, branchName, error as Error);
        }
    }
}

interface RemoteRef {
    name: string;
    refs: {
        fetch?: string;
    };
}

async function verifyFinalWorktreeSetup(worktreeGit: SimpleGit, worktreePath: string, branchName: string): Promise<void> {
    try {
        const finalRemotes = await worktreeGit.getRemotes(true) as RemoteRef[];
        const hasOrigin = finalRemotes.some(r => r.name === 'origin');

        if (!hasOrigin) throw new Error('Worktree was created but origin remote is missing');

        logger.info({ worktreePath, branchName, remotes: finalRemotes.map(r => ({ name: r.name, url: r.refs.fetch })) }, 'Git worktree created successfully from existing branch with remotes configured');
    } catch (verifyError) {
        logger.error({ worktreePath, error: (verifyError as Error).message }, 'Final verification failed - worktree may not be properly configured');
        throw new Error(`Worktree setup incomplete: ${(verifyError as Error).message}`);
    }
}

interface CreateWorktreeFromExistingBranchOptions {
    worktreeDirName: string;
    owner: string;
    repoName: string;
}

interface WorktreeResult {
    worktreePath: string;
    branchName: string;
}

export async function createWorktreeFromExistingBranch(localRepoPath: string, branchName: string, options: CreateWorktreeFromExistingBranchOptions): Promise<WorktreeResult> {
    const { worktreeDirName, owner, repoName } = options;
    const worktreePath = getWorktreePath(owner, repoName, worktreeDirName);

    try {
        const git: SimpleGit = simpleGit(localRepoPath);

        if (await fs.pathExists(worktreePath)) {
            await handleExistingWorktreePath(worktreePath, localRepoPath, branchName);
        }

        await fs.ensureDir(path.dirname(worktreePath));

        logger.info({ localRepoPath, worktreePath, branchName }, 'Creating Git worktree from existing branch...');

        // Use explicit refspec to ensure remote tracking ref is updated
        // Simple `git fetch origin <branch>` may only update FETCH_HEAD without
        // updating refs/remotes/origin/<branch> in some git configurations
        await git.raw(['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`, '--prune']);
        logger.debug({ branchName }, 'Fetched latest changes for branch with explicit refspec');

        await createWorktreeFromRemote(git, worktreePath, branchName, localRepoPath);

        await verifyWorktreeCreation(worktreePath);
        await setupWorktreePermissions(worktreePath, branchName, null);
        await addToSafeDirectories(git, worktreePath, localRepoPath, { branchName, issueId: null });

        const worktreeGit: SimpleGit = simpleGit({ baseDir: worktreePath });
        await setupWorktreeRemote(worktreeGit, git, worktreePath);

        await verifyFinalWorktreeSetup(worktreeGit, worktreePath, branchName);

        return { worktreePath, branchName };

    } catch (error) {
        handleError(error, `Failed to create worktree from branch ${branchName}`);
        throw error;
    }
}
