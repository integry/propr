import { generatedPayloadStorage } from '../storage/generatedPayloads.js';
import { SimpleGit } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { resolveRepositoryWorktreePath } from './repositoryPaths.js';
import { redactAuthenticatedGitUrl } from './repoBranching.js';
import { isSalvageRetainedWorktree } from './pushSalvage.js';
import { detachRetainedWorktree, mountUsesWorktree, removeWorktreeIfDisposable, worktreeRemovalDisabled } from './worktreeReclaim.js';
import { runningContainerMountSources } from './worktreeMounts.js';

const WORKTREES_BASE_PATH = process.env.GIT_WORKTREES_BASE_PATH || "/tmp/git-processor/worktrees";

interface CleanupOptions {
    deleteBranch?: boolean;
    success?: boolean;
    retentionStrategy?: string;
    retentionHours?: number;
}

interface CleanupResult {
    cleaned: number;
    retained: number;
}

export async function cleanupWorktree(localRepoPath: string, worktreePath: string, branchName: string, options: CleanupOptions = {}): Promise<void> {
    const {
        deleteBranch = false,
        success = true,
        retentionStrategy = process.env.WORKTREE_RETENTION_STRATEGY || 'always_delete',
        retentionHours = parseInt(process.env.WORKTREE_RETENTION_HOURS || '24', 10)
    } = options;

    logger.info({
        worktreePath,
        branchName,
        deleteBranch,
        success,
        retentionStrategy,
        retentionHours
    }, 'Cleaning up Git worktree...');

    // Producer records are outside customer checkouts. Failed/salvage runs remain protected.
    await generatedPayloadStorage().complete(worktreePath, success && !await isSalvageRetainedWorktree(worktreePath)).catch(error => {
        logger.warn({ worktreePath, error: (error as Error).message }, 'Generated payload completion unavailable; retaining payloads');
    });

    // The push salvage ladder kept this worktree because it holds the only copy of
    // commits a rejected push could not deliver; it overrides the retention strategy.
    // Only the worker's record outside the checkout counts, never a repository file.
    if (await isSalvageRetainedWorktree(worktreePath)) {
        logger.warn({ worktreePath, branchName }, 'Keeping worktree retained by push salvage');
        return;
    }

    if (!success && (retentionStrategy === 'keep_on_failure' || retentionStrategy === 'keep_for_hours')) {
        logger.info({ worktreePath, branchName, retentionStrategy }, 'Keeping worktree due to failure and retention strategy');
        // Preserve staged/untracked work while freeing the PR branch for a retry.
        // Never force this checkout: if detaching fails, keep the only copy anyway.
        try {
            await detachRetainedWorktree(worktreePath);
        } catch (error) {
            logger.warn({ worktreePath, error: (error as Error).message }, 'Failed to detach retained worktree');
        }
        return;
    }

    // A finished worktree whose work is all stored in Git (clean status, HEAD
    // contained in a branch, remote ref or tag) is removed: each one carries its
    // own node_modules and build output, and keeping them all fills the disk.
    // Anything else is kept. Branches are never deleted here.
    if (!worktreeRemovalDisabled(retentionStrategy)) {
        try {
            const outcome = await removeWorktreeIfDisposable(worktreePath, undefined, async () => {
                try {
                    if ((await runningContainerMountSources()).some(mount => mountUsesWorktree(mount, worktreePath))) return false;
                    // Read after Docker's awaited boundary, on both sides of detach.
                    const { db } = await import('../db/connection.js');
                    return !await db('pr_followup_handoffs').whereNot('status', 'released')
                        .where('worktree_path', worktreePath).first('worktree_path');
                } catch (error) {
                    logger.warn({ worktreePath, error: (error as Error).message }, 'Worktree liveness authority unavailable; keeping worktree');
                    return false;
                }
            });
            if (outcome.removed) {
                logger.info({ worktreePath, branchName }, 'Removed finished worktree; its work is stored in Git');
                return;
            }
            const uncertain = ['remove_failed', 'unknown_git_state', 'not_a_worktree'].includes(outcome.reason);
            logger[uncertain ? 'warn' : 'info']({ worktreePath, branchName, reason: outcome.reason },
                uncertain ? 'Worktree cleanup needs inspection; checkout or Git state is unavailable' : 'Keeping worktree due to retention or Git safety checks');
        } catch (error) {
            logger.warn({ worktreePath, error: (error as Error).message }, 'Worktree removal claim failed; retaining checkout and releasing branch');
        }
    }

    try {
        // Release the branch for a subsequent task without discarding the retained checkout.
        await detachRetainedWorktree(worktreePath);
    } catch {
        // Unknown Git state remains intact, including its branch registration.
    }
}

/**
 * @deprecated Use sweepIdleWorktrees with durable-reference and container liveness
 * providers (the daemon's sweepWorktrees supplies these). This compatibility
 * export performs no removal: age alone cannot establish disposability.
 */
export async function cleanupExpiredWorktrees(worktreesBasePath: string = WORKTREES_BASE_PATH): Promise<CleanupResult> {
    const exists = await fs.pathExists(worktreesBasePath);
    return { cleaned: 0, retained: exists ? 1 : 0 };
}

/** Missing directories may still have unique detached commits in their administrative refs. */
export async function safePruneWorktrees(localRepoPath: string, _minAgeHours: number = 1): Promise<{ pruned: number; skipped: number }> {
    // Retain caller compatibility; age cannot authorize pruning protected worktrees.
    void _minAgeHours;
    const exists = await fs.pathExists(path.join(localRepoPath, '.git', 'worktrees'));
    return { pruned: 0, skipped: exists ? 1 : 0 };
}

export async function setupWorktreePermissions(worktreePath: string, branchName: string, issueId: number | string | null): Promise<void> {
    try {
        const { execFileSync } = await import('child_process');
        execFileSync('sudo', ['chown', '-R', '1000:1000', '--', worktreePath], {
            stdio: 'inherit',
            timeout: 10000
        });
        logger.debug({ worktreePath, branchName, issueId }, 'Set worktree ownership to UID 1000 for container compatibility');
    } catch (chownError) {
        logger.warn({ worktreePath, branchName, issueId, error: (chownError as Error).message }, 'Failed to set worktree ownership - container may have permission issues');
    }
}

interface SafeDirectoryOptions {
    branchName?: string;
    issueId?: number | string | null;
}

export async function addToSafeDirectories(git: SimpleGit, worktreePath: string, localRepoPath: string, options: SafeDirectoryOptions = {}): Promise<void> {
    const { branchName, issueId } = options;
    try {
        await git.raw(['config', '--global', '--add', 'safe.directory', worktreePath]);
        await git.raw(['config', '--global', '--add', 'safe.directory', localRepoPath]);
        logger.debug({ worktreePath, localRepoPath, branchName, issueId }, 'Added worktree and main repo to Git safe directories');
    } catch (safeConfigError) {
        logger.warn({ worktreePath, branchName, issueId, error: (safeConfigError as Error).message }, 'Failed to add directories to Git safe directories');
    }
}

/**
 * Trusts every clone and worktree ProPR manages, once per process start.
 * Worktrees are chowned for the agent containers, so Git in the worker sees
 * them as owned by another user. The per-path entries added on creation live
 * in the container's global config and vanish on restart, which made recovery
 * of an older worktree fail with "dubious ownership". `<base>/*` (Git 2.46+)
 * trusts only paths under ProPR's own folders, at any depth: per-repository
 * worktree roots (`<base>/<owner>/<repo>/...`) always resolve under the
 * configured base, so they are covered too.
 */
export async function trustManagedGitDirectories(git: SimpleGit): Promise<void> {
    const clonesBase = process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones';
    const wanted = [`${path.resolve(WORKTREES_BASE_PATH)}/*`, `${path.resolve(clonesBase)}/*`];
    try {
        const version = (await git.raw(['--version'])).trim();
        const parsed = /git version (\d+)\.(\d+)/.exec(version);
        if (!parsed || Number(parsed[1]) < 2 || (Number(parsed[1]) === 2 && Number(parsed[2]) < 46)) {
            logger.warn({ version }, 'Managed safe.directory wildcards require Git 2.46 or newer; upgrade Git to trust existing worktrees after restart (per-path creation entries still apply)');
        }
        const existing = new Set((await git.raw(['config', '--global', '--get-all', 'safe.directory']).catch(() => '')).split('\n').map(line => line.trim()));
        for (const entry of wanted) {
            if (!existing.has(entry)) await git.raw(['config', '--global', '--add', 'safe.directory', entry]);
        }
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Could not trust ProPR clone and worktree folders; Git may reject worktrees after a restart');
    }
}

export async function verifyWorktreeCreation(worktreePath: string): Promise<void> {
    const gitFilePath = path.join(worktreePath, '.git');
    if (await fs.pathExists(gitFilePath)) {
        const stats = await fs.stat(gitFilePath);
        if (stats.isDirectory()) {
            logger.error({ worktreePath, gitFilePath, isDirectory: true }, 'Git created a regular repository instead of a worktree');
            throw new Error('Worktree creation failed - .git is a directory instead of a file');
        } else {
            const gitFileContent = await fs.readFile(gitFilePath, 'utf8');
            logger.debug({ worktreePath, gitFileContent: gitFileContent.trim() }, 'Worktree .git file content');

            const match = gitFileContent.match(/gitdir:\s*(.+)/);
            if (match) {
                const gitdirPath = match[1].trim();
                if (!await fs.pathExists(gitdirPath)) {
                    logger.error({ worktreePath, gitdirPath, gitFileContent: gitFileContent.trim() }, 'Worktree .git file points to non-existent directory');
                    throw new Error(`Worktree creation failed - gitdir path does not exist: ${gitdirPath}`);
                }
            }
        }
    } else {
        throw new Error('Worktree creation failed - no .git file found');
    }
}

interface RemoteRef {
    name: string;
    refs: {
        fetch?: string;
    };
}

export async function setupWorktreeRemote(worktreeGit: SimpleGit, parentGit: SimpleGit, worktreePath: string): Promise<void> {
    try {
        const remotes = await worktreeGit.getRemotes();
        logger.debug({ worktreePath, existingRemotes: remotes.map(r => r.name) }, 'Checking existing remotes in worktree');

        if (!remotes.find(r => r.name === 'origin')) {
            logger.info({ worktreePath }, 'No origin remote found in worktree, adding it');

            const parentRemotes = await parentGit.getRemotes(true) as RemoteRef[];
            const originRemote = parentRemotes.find(r => r.name === 'origin');

            if (originRemote && originRemote.refs.fetch) {
                await worktreeGit.addRemote('origin', originRemote.refs.fetch);
                logger.info({ worktreePath, remoteName: originRemote.name }, 'Successfully added origin remote to worktree');
            } else {
                logger.error({ worktreePath, remoteNames: parentRemotes.map(remote => remote.name) }, 'Could not find origin remote in parent repository');
            }
        } else {
            logger.debug({ worktreePath }, 'Origin remote already exists in worktree');
        }
    } catch (remoteError) {
        const error = remoteError as Error;
        logger.error({
            worktreePath,
            error: redactAuthenticatedGitUrl(error.message),
            stack: error.stack ? redactAuthenticatedGitUrl(error.stack) : undefined
        }, 'Failed to set up remote in worktree - push operations WILL fail');
    }
}

export function getWorktreePath(owner: string, repoName: string, worktreeDirName: string): string {
    return resolveRepositoryWorktreePath(WORKTREES_BASE_PATH, owner, repoName, worktreeDirName);
}
