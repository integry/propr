import { repositoryStorageLifecycle } from '../storage/lifecycle.js';
import { SimpleGit } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import {
    setupWorktreePermissions,
    addToSafeDirectories,
    verifyWorktreeCreation,
    setupWorktreeRemote,
    getWorktreePath
} from './worktreeOperations.js';
import { createHooklessGit } from './hooklessGit.js';
import { assertRepositoryClonePath } from './repositoryPaths.js';
import { configureGitRemoteAuthentication, redactAuthenticatedGitUrl } from './repoBranching.js';
import { isRescueRef } from './rescueRefs.js';

const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones';

/**
 * Inspect ref output rather than promise resolution: simple-git can resolve a
 * nonzero exit without stderr (including show-ref in an empty repository).
 * Listing heads gives us exact names and reports corrupt refs as Git errors.
 * Let those errors propagate rather than treating an unreadable repo as empty.
 */
async function localBranchExists(git: SimpleGit, branchName: string): Promise<boolean> {
    const ref = `refs/heads/${branchName}`;
    const refs = await git.raw(['show-ref', '--heads']);
    return refs.split('\n').some(line => line.split(' ')[1] === ref);
}

/**
 * Create a worktree branch without recording an upstream in the shared clone
 * config. Parallel issue jobs use the same clone, so implicit tracking writes
 * from `git worktree add` can race on `.git/config.lock` even though their
 * branches and worktree directories are distinct.
 */
export async function addWorktreeWithoutTracking(
    git: SimpleGit,
    worktreePath: string,
    branchName: string,
    options: {
        startPoint: string;
        resetBranch?: boolean;
    },
): Promise<string> {
    const { startPoint, resetBranch = false } = options;
    if (resetBranch) {
        const exists = await localBranchExists(git, branchName);
        if (exists) return git.raw(['worktree', 'add', worktreePath, branchName]);
    }
    return git.raw([
        'worktree',
        'add',
        '--no-track',
        '-b',
        branchName,
        worktreePath,
        startPoint,
    ]);
}

export async function cleanupExistingBranch(git: SimpleGit, branchName: string): Promise<void> {
    const exists = await localBranchExists(git, branchName);
    if (exists) throw new Error('Existing branch retained; use a new task branch');
}

async function handleExistingWorktreePath(): Promise<void> {
    throw new Error('Existing worktree retained; use a new worktree path');
}

/** Missing checkouts remain protected until their administrative history is proven recoverable. */
export async function removeStaleWorktreeRegistration(_git: SimpleGit, _worktreePath: string): Promise<boolean> {
    // Keep the legacy call signature without using it to prune protected state.
    void _git;
    void _worktreePath;
    // A missing checkout does not prove the administrative HEAD recoverable.
    return false;
}

async function handleWorktreeConflict(): Promise<void> {
    throw new Error('Existing worktree retained; branch is in use');
}

async function handleImproperWorktree(_worktreePath: string, _branchName: string, error: Error): Promise<void> {
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

        const worktreeAddResult = await addWorktreeWithoutTracking(
            git,
            worktreePath,
            branchName,
            { startPoint: `origin/${branchName}`, resetBranch: true },
        );
        logger.info({ branchName, worktreePath, gitOutput: worktreeAddResult.trim() }, 'Git worktree add command completed');

    } catch (error) {
        if ((error as Error).message && (error as Error).message.includes('is already used by worktree')) {
            await handleWorktreeConflict();
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

        logger.info({ worktreePath, branchName, remoteNames: finalRemotes.map(remote => remote.name) }, 'Git worktree created successfully from existing branch with remotes configured');
    } catch (verifyError) {
        const safeMessage = redactAuthenticatedGitUrl((verifyError as Error).message);
        logger.error({ worktreePath, error: safeMessage }, 'Final verification failed - worktree may not be properly configured');
        throw new Error(`Worktree setup incomplete: ${safeMessage}`);
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
    return repositoryStorageLifecycle.use(() => createWorktreeFromExistingBranchInternal(localRepoPath, branchName, options));
}

async function createWorktreeFromExistingBranchInternal(localRepoPath: string, branchName: string, options: CreateWorktreeFromExistingBranchOptions): Promise<WorktreeResult> {
    const { worktreeDirName, owner, repoName } = options;
    // Rescue refs preserve rejected pushes; they are never a branch a task works on.
    if (isRescueRef(branchName)) throw new Error(`Refusing to use push salvage rescue ref ${branchName} as a task branch`);
    assertRepositoryClonePath(localRepoPath, CLONES_BASE_PATH, owner, repoName);
    const worktreePath = getWorktreePath(owner, repoName, worktreeDirName);

    try {
        const git: SimpleGit = createHooklessGit(localRepoPath);

        if (await fs.pathExists(worktreePath)) {
            await handleExistingWorktreePath();
        }

        await fs.ensureDir(path.dirname(worktreePath));

        logger.info({ localRepoPath, worktreePath, branchName }, 'Creating Git worktree from existing branch...');

        // Use explicit refspec to ensure remote tracking ref is updated
        // Simple `git fetch origin <branch>` may only update FETCH_HEAD without
        // updating refs/remotes/origin/<branch> in some git configurations
        await configureGitRemoteAuthentication(git);
        await git.raw(['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`, '--prune']);
        logger.debug({ branchName }, 'Fetched latest changes for branch with explicit refspec');

        await createWorktreeFromRemote(git, worktreePath, branchName, localRepoPath);

        await verifyWorktreeCreation(worktreePath);
        await setupWorktreePermissions(worktreePath, branchName, null);
        await addToSafeDirectories(git, worktreePath, localRepoPath, { branchName, issueId: null });

        const worktreeGit: SimpleGit = createHooklessGit(worktreePath);
        await setupWorktreeRemote(worktreeGit, git, worktreePath);

        await verifyFinalWorktreeSetup(worktreeGit, worktreePath, branchName);

        return { worktreePath, branchName };

    } catch (error) {
        handleError(error, `Failed to create worktree from branch ${branchName}`);
        throw error;
    }
}
