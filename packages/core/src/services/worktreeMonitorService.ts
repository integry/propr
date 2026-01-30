import { Redis } from 'ioredis';
import { execSync } from 'child_process';
import logger from '../utils/logger.js';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const FILE_CHANGES_PREFIX = 'task:file-changes:';
const CACHE_TTL_SECONDS = 86400; // 24 hours - keep for completed tasks

interface RedisConnectionOptions {
    host: string;
    port: number;
    maxRetriesPerRequest: null;
    enableReadyCheck: boolean;
}

const connectionOptions: RedisConnectionOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
};

export interface FileChange {
    path: string;
    linesAdded: number;
    linesRemoved: number;
    diff: string;
    status: 'modified' | 'added' | 'deleted' | 'renamed';
}

export interface FileChangesData {
    files: FileChange[];
    lastUpdated: string;
    taskId: string;
}

/**
 * Get the current file changes from a git worktree
 * Uses git diff --stat and git diff to get change information
 */
export async function getWorktreeChanges(worktreePath: string): Promise<FileChange[]> {
    const files: FileChange[] = [];

    try {
        // Get list of changed files with stats (staged and unstaged)
        // First check for staged changes
        let statOutput = '';
        let statusOutput = '';

        try {
            // Get file status first to understand what's modified/added/deleted
            statusOutput = execSync('git status --porcelain', {
                cwd: worktreePath,
                encoding: 'utf-8',
                timeout: 10000
            }).trim();
        } catch {
            // No changes or git error
            return [];
        }

        if (!statusOutput) {
            // No uncommitted changes, check against the base branch
            try {
                // Get the tracking branch or default to HEAD~1
                const trackingBranch = execSync('git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "HEAD~1"', {
                    cwd: worktreePath,
                    encoding: 'utf-8',
                    timeout: 5000
                }).trim() || 'HEAD~1';

                statOutput = execSync(`git diff --stat ${trackingBranch}...HEAD`, {
                    cwd: worktreePath,
                    encoding: 'utf-8',
                    timeout: 30000
                }).trim();

                if (!statOutput) return [];

            } catch {
                return [];
            }
        } else {
            // There are uncommitted changes, get diff including staged
            try {
                statOutput = execSync('git diff --stat HEAD', {
                    cwd: worktreePath,
                    encoding: 'utf-8',
                    timeout: 30000
                }).trim();
            } catch {
                // Might fail if no commits yet, try without HEAD
                try {
                    statOutput = execSync('git diff --stat --cached', {
                        cwd: worktreePath,
                        encoding: 'utf-8',
                        timeout: 30000
                    }).trim();
                } catch {
                    return [];
                }
            }
        }

        if (!statOutput) return [];

        // Parse stat output to get file list
        // Example line: " src/file.ts | 10 ++++----"
        const statLines = statOutput.split('\n').filter(line => line.includes('|'));

        for (const line of statLines) {
            const match = line.match(/^\s*(.+?)\s*\|\s*(\d+|Bin)/);
            if (!match) continue;

            const filePath = match[1].trim();

            // Skip summary line
            if (filePath.includes('file') && filePath.includes('changed')) continue;

            // Determine file status from porcelain output
            let status: FileChange['status'] = 'modified';
            const statusLine = statusOutput.split('\n').find(l => l.includes(filePath));
            if (statusLine) {
                const statusCode = statusLine.substring(0, 2);
                if (statusCode.includes('A') || statusCode === '??') {
                    status = 'added';
                } else if (statusCode.includes('D')) {
                    status = 'deleted';
                } else if (statusCode.includes('R')) {
                    status = 'renamed';
                }
            }

            // Get detailed diff for this file
            let diff = '';
            let linesAdded = 0;
            let linesRemoved = 0;

            try {
                // Try to get diff against HEAD first
                diff = execSync(`git diff HEAD -- "${filePath}"`, {
                    cwd: worktreePath,
                    encoding: 'utf-8',
                    timeout: 10000,
                    maxBuffer: 1024 * 1024 * 5 // 5MB max
                }).trim();

                if (!diff) {
                    // Try staged diff
                    diff = execSync(`git diff --cached -- "${filePath}"`, {
                        cwd: worktreePath,
                        encoding: 'utf-8',
                        timeout: 10000,
                        maxBuffer: 1024 * 1024 * 5
                    }).trim();
                }

                if (!diff && status === 'added') {
                    // For new files, show the entire content as added
                    const content = execSync(`git show :${filePath} 2>/dev/null || cat "${filePath}"`, {
                        cwd: worktreePath,
                        encoding: 'utf-8',
                        timeout: 10000,
                        maxBuffer: 1024 * 1024 * 5
                    }).trim();

                    if (content) {
                        diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${content.split('\n').length} @@\n` +
                            content.split('\n').map(l => `+${l}`).join('\n');
                    }
                }
            } catch (error) {
                logger.debug({ filePath, error: (error as Error).message }, 'Failed to get diff for file');
            }

            // Count added and removed lines
            if (diff) {
                const diffLines = diff.split('\n');
                for (const diffLine of diffLines) {
                    if (diffLine.startsWith('+') && !diffLine.startsWith('+++')) {
                        linesAdded++;
                    } else if (diffLine.startsWith('-') && !diffLine.startsWith('---')) {
                        linesRemoved++;
                    }
                }
            }

            files.push({
                path: filePath,
                linesAdded,
                linesRemoved,
                diff,
                status
            });
        }

        return files;
    } catch (error) {
        logger.error({ worktreePath, error: (error as Error).message }, 'Error getting worktree changes');
        return [];
    }
}

/**
 * Store file changes in Redis for a task
 */
export async function storeFileChanges(taskId: string, changes: FileChange[]): Promise<void> {
    const redis = new Redis(connectionOptions);

    try {
        const data: FileChangesData = {
            files: changes,
            lastUpdated: new Date().toISOString(),
            taskId
        };

        const key = `${FILE_CHANGES_PREFIX}${taskId}`;
        await redis.setex(key, CACHE_TTL_SECONDS, JSON.stringify(data));
        logger.debug({ taskId, fileCount: changes.length }, 'Stored file changes in Redis');
    } catch (error) {
        logger.error({ taskId, error: (error as Error).message }, 'Error storing file changes');
    } finally {
        await redis.quit();
    }
}

/**
 * Retrieve stored file changes from Redis
 */
export async function getStoredFileChanges(taskId: string): Promise<FileChangesData | null> {
    const redis = new Redis(connectionOptions);

    try {
        const key = `${FILE_CHANGES_PREFIX}${taskId}`;
        const data = await redis.get(key);

        if (!data) {
            return null;
        }

        return JSON.parse(data) as FileChangesData;
    } catch (error) {
        logger.error({ taskId, error: (error as Error).message }, 'Error getting stored file changes');
        return null;
    } finally {
        await redis.quit();
    }
}

/**
 * Clear file changes from Redis (optional cleanup)
 */
export async function clearFileChanges(taskId: string): Promise<void> {
    const redis = new Redis(connectionOptions);

    try {
        const key = `${FILE_CHANGES_PREFIX}${taskId}`;
        await redis.del(key);
        logger.debug({ taskId }, 'Cleared file changes from Redis');
    } catch (error) {
        logger.error({ taskId, error: (error as Error).message }, 'Error clearing file changes');
    } finally {
        await redis.quit();
    }
}

/**
 * Update file changes by scanning the worktree and storing results
 * This is the main function to call during task execution
 */
export async function updateFileChangesFromWorktree(taskId: string, worktreePath: string): Promise<FileChange[]> {
    const changes = await getWorktreeChanges(worktreePath);
    await storeFileChanges(taskId, changes);
    return changes;
}
