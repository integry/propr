import { simpleGit, SimpleGit } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';

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

interface RetentionInfo {
    timestamp: string;
    issueProcessed: boolean;
    success: boolean;
    retentionHours: number;
    scheduledCleanup: string;
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

    if (!success && retentionStrategy === 'keep_on_failure') {
        logger.info({ worktreePath, branchName, retentionStrategy }, 'Keeping worktree due to failure and retention strategy');
        await createRetentionMarker(worktreePath, retentionHours);
        return;
    }

    if (!success && retentionStrategy === 'keep_for_hours') {
        logger.info({ worktreePath, retentionHours }, `Scheduling worktree cleanup in ${retentionHours} hours`);
        await createRetentionMarker(worktreePath, retentionHours);
    }

    const git: SimpleGit = simpleGit(localRepoPath);

    try {
        await git.raw(['worktree', 'remove', worktreePath, '--force']);
        logger.info({ worktreePath }, 'Worktree removed successfully');
    } catch (error) {
        if ((error as Error).message && (error as Error).message.includes('.git\' is not a .git file')) {
            logger.info({ worktreePath }, 'Directory is not a valid worktree, will remove directly');
        } else {
            logger.warn({ worktreePath, error: (error as Error).message }, 'Failed to remove worktree with git command');
        }

        try {
            await fs.remove(worktreePath);
            logger.info({ worktreePath }, 'Worktree directory removed directly');
        } catch (fsError) {
            logger.error({ worktreePath, error: (fsError as Error).message }, 'Failed to remove worktree directory');
        }
    }

    if (deleteBranch && branchName) {
        try {
            await git.deleteLocalBranch(branchName, true);
            logger.info({ branchName }, 'Local branch deleted');
        } catch (branchError) {
            logger.warn({ branchName, error: (branchError as Error).message }, 'Failed to delete local branch');
        }
    }

    // NOTE: Removed `git worktree prune` here - it was causing race conditions by
    // deleting worktree metadata for other running tasks. Stale worktree references
    // will be cleaned up by the periodic cleanupExpiredWorktrees job instead.
}

async function createRetentionMarker(worktreePath: string, retentionHours: number): Promise<void> {
    try {
        const retentionInfo: RetentionInfo = {
            timestamp: new Date().toISOString(),
            issueProcessed: true,
            success: false,
            retentionHours,
            scheduledCleanup: new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString()
        };
        await fs.writeJson(path.join(worktreePath, '.retention-info.json'), retentionInfo);
        logger.info({ worktreePath }, 'Created retention marker file');
    } catch (markerError) {
        logger.warn({ worktreePath, error: (markerError as Error).message }, 'Failed to create retention marker file');
    }
}

export async function cleanupExpiredWorktrees(worktreesBasePath: string = WORKTREES_BASE_PATH): Promise<CleanupResult> {
    logger.info({ worktreesBasePath }, 'Starting cleanup of expired worktrees...');

    let cleaned = 0;
    let retained = 0;

    try {
        if (!await fs.pathExists(worktreesBasePath)) {
            logger.info({ worktreesBasePath }, 'Worktrees base path does not exist, nothing to clean');
            return { cleaned, retained };
        }

        const result = await processWorktreeDirectory(worktreesBasePath);
        cleaned = result.cleaned;
        retained = result.retained;

        logger.info({ worktreesBasePath, cleaned, retained }, 'Expired worktrees cleanup completed');

    } catch (error) {
        handleError(error, 'Failed to cleanup expired worktrees');
        throw error;
    }

    return { cleaned, retained };
}

async function processWorktreeDirectory(dirPath: string): Promise<CleanupResult> {
    let cleaned = 0;
    let retained = 0;

    const items = await fs.readdir(dirPath);

    for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stats = await fs.stat(itemPath);

        if (stats.isDirectory()) {
            const result = await processWorktreeItem(itemPath, stats);
            cleaned += result.cleaned;
            retained += result.retained;
        }
    }

    return { cleaned, retained };
}

async function processWorktreeItem(itemPath: string, stats: fs.Stats): Promise<CleanupResult> {
    let cleaned = 0;
    let retained = 0;

    const retentionFile = path.join(itemPath, '.retention-info.json');

    if (await fs.pathExists(retentionFile)) {
        try {
            const retentionInfo = await fs.readJson(retentionFile) as RetentionInfo;
            const scheduledCleanup = new Date(retentionInfo.scheduledCleanup);
            const now = new Date();

            if (now >= scheduledCleanup) {
                logger.info({ worktreePath: itemPath, scheduledCleanup: retentionInfo.scheduledCleanup }, 'Cleaning up expired worktree');
                await fs.remove(itemPath);
                cleaned++;
            } else {
                logger.debug({ worktreePath: itemPath, scheduledCleanup: retentionInfo.scheduledCleanup }, 'Retaining worktree until scheduled cleanup time');
                retained++;
            }
        } catch (retentionError) {
            logger.warn({ worktreePath: itemPath, error: (retentionError as Error).message }, 'Failed to read retention info, skipping cleanup');
            retained++;
        }
    } else {
        const ageHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
        const maxAgeHours = parseInt(process.env.WORKTREE_MAX_AGE_HOURS || '72', 10);

        if (ageHours > maxAgeHours) {
            logger.info({ worktreePath: itemPath, ageHours: Math.round(ageHours), maxAgeHours }, 'Cleaning up old worktree (fallback cleanup)');
            await fs.remove(itemPath);
            cleaned++;
        } else {
            const subResult = await processWorktreeDirectory(itemPath);
            cleaned += subResult.cleaned;
            retained += subResult.retained;
        }
    }

    return { cleaned, retained };
}

/**
 * Safely prunes stale worktree references, but only for entries older than the specified threshold.
 * This prevents accidentally removing metadata for currently running tasks.
 *
 * @param localRepoPath - Path to the main repository
 * @param minAgeHours - Minimum age in hours before a stale entry can be pruned (default: 1 hour)
 */
export async function safePruneWorktrees(localRepoPath: string, minAgeHours: number = 1): Promise<{ pruned: number; skipped: number }> {
    let pruned = 0;
    let skipped = 0;

    try {
        const git = simpleGit(localRepoPath);
        // Get worktree list for logging purposes
        await git.raw(['worktree', 'list', '--porcelain']);

        const worktreesDir = path.join(localRepoPath, '.git', 'worktrees');
        if (!await fs.pathExists(worktreesDir)) {
            return { pruned: 0, skipped: 0 };
        }

        const entries = await fs.readdir(worktreesDir);
        const now = Date.now();
        const minAgeMs = minAgeHours * 60 * 60 * 1000;

        for (const entry of entries) {
            const entryPath = path.join(worktreesDir, entry);
            const gitdirFile = path.join(entryPath, 'gitdir');

            if (!await fs.pathExists(gitdirFile)) {
                // Entry doesn't have gitdir file, check age before removing
                const stats = await fs.stat(entryPath);
                const ageMs = now - stats.mtimeMs;

                if (ageMs > minAgeMs) {
                    logger.info({ entry, ageHours: Math.round(ageMs / (60 * 60 * 1000)) }, 'Removing stale worktree entry (no gitdir file)');
                    await fs.remove(entryPath);
                    pruned++;
                } else {
                    logger.debug({ entry, ageHours: Math.round(ageMs / (60 * 60 * 1000)), minAgeHours }, 'Skipping recent worktree entry');
                    skipped++;
                }
                continue;
            }

            // Check if the worktree directory still exists
            const gitdirContent = await fs.readFile(gitdirFile, 'utf8');
            const worktreePath = gitdirContent.trim();

            if (!await fs.pathExists(worktreePath)) {
                // Worktree directory doesn't exist, check age before removing metadata
                const stats = await fs.stat(entryPath);
                const ageMs = now - stats.mtimeMs;

                if (ageMs > minAgeMs) {
                    logger.info({ entry, worktreePath, ageHours: Math.round(ageMs / (60 * 60 * 1000)) }, 'Removing stale worktree metadata (worktree directory missing)');
                    await fs.remove(entryPath);
                    pruned++;
                } else {
                    logger.debug({ entry, ageHours: Math.round(ageMs / (60 * 60 * 1000)), minAgeHours }, 'Skipping recent stale worktree entry');
                    skipped++;
                }
            }
        }

        logger.info({ localRepoPath, pruned, skipped, minAgeHours }, 'Safe worktree prune completed');
    } catch (error) {
        logger.warn({ localRepoPath, error: (error as Error).message }, 'Failed to safely prune worktrees');
    }

    return { pruned, skipped };
}

export async function setupWorktreePermissions(worktreePath: string, branchName: string, issueId: number | string | null): Promise<void> {
    try {
        const { execSync } = await import('child_process');
        execSync(`sudo chown -R 1000:1000 "${worktreePath}"`, {
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
                logger.info({ worktreePath, remoteUrl: originRemote.refs.fetch }, 'Successfully added origin remote to worktree');
            } else {
                logger.error({ worktreePath, parentRemotes }, 'Could not find origin remote in parent repository');
            }
        } else {
            logger.debug({ worktreePath }, 'Origin remote already exists in worktree');
        }
    } catch (remoteError) {
        logger.error({ worktreePath, error: (remoteError as Error).message, stack: (remoteError as Error).stack }, 'Failed to set up remote in worktree - push operations WILL fail');
    }
}

export function getWorktreePath(owner: string, repoName: string, worktreeDirName: string): string {
    return path.join(WORKTREES_BASE_PATH, owner, repoName, worktreeDirName);
}
