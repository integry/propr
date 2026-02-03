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
 * Get git status output (porcelain format)
 */
function getGitStatusOutput(worktreePath: string): string {
    try {
        return execSync('git status --porcelain', {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout: 10000
        }).trim();
    } catch {
        return '';
    }
}

/**
 * Get git diff stat output for uncommitted or committed changes
 */
function getGitDiffStatOutput(worktreePath: string, hasUncommittedChanges: boolean): string {
    if (hasUncommittedChanges) {
        try {
            return execSync('git diff --stat HEAD', {
                cwd: worktreePath,
                encoding: 'utf-8',
                timeout: 30000
            }).trim();
        } catch {
            try {
                return execSync('git diff --stat --cached', {
                    cwd: worktreePath,
                    encoding: 'utf-8',
                    timeout: 30000
                }).trim();
            } catch {
                return '';
            }
        }
    }

    // No uncommitted changes, check against tracking branch
    try {
        const trackingBranch = execSync('git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "HEAD~1"', {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout: 5000
        }).trim() || 'HEAD~1';

        return execSync(`git diff --stat ${trackingBranch}...HEAD`, {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout: 30000
        }).trim();
    } catch {
        return '';
    }
}

/**
 * Determine file status from porcelain output
 */
function determineFileStatus(statusOutput: string, filePath: string): FileChange['status'] {
    const statusLine = statusOutput.split('\n').find(l => l.includes(filePath));
    if (!statusLine) return 'modified';

    const statusCode = statusLine.substring(0, 2);
    if (statusCode.includes('A') || statusCode === '??') return 'added';
    if (statusCode.includes('D')) return 'deleted';
    if (statusCode.includes('R')) return 'renamed';
    return 'modified';
}

/**
 * Get diff content for a file
 */
function getFileDiff(worktreePath: string, filePath: string, status: FileChange['status']): string {
    try {
        let diff = execSync(`git diff HEAD -- "${filePath}"`, {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout: 10000,
            maxBuffer: 1024 * 1024 * 5
        }).trim();

        if (!diff) {
            diff = execSync(`git diff --cached -- "${filePath}"`, {
                cwd: worktreePath,
                encoding: 'utf-8',
                timeout: 10000,
                maxBuffer: 1024 * 1024 * 5
            }).trim();
        }

        if (!diff && status === 'added') {
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
        return diff;
    } catch (error) {
        logger.debug({ filePath, error: (error as Error).message }, 'Failed to get diff for file');
        return '';
    }
}

/**
 * Count added and removed lines from diff output
 */
function countDiffLines(diff: string): { linesAdded: number; linesRemoved: number } {
    let linesAdded = 0;
    let linesRemoved = 0;

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

    return { linesAdded, linesRemoved };
}

/**
 * Parse a single stat line and create a FileChange object
 */
function parseStatLine(line: string, statusOutput: string, worktreePath: string): FileChange | null {
    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+|Bin)/);
    if (!match) return null;

    const filePath = match[1].trim();
    if (filePath.includes('file') && filePath.includes('changed')) return null;

    const status = determineFileStatus(statusOutput, filePath);
    const diff = getFileDiff(worktreePath, filePath, status);
    const { linesAdded, linesRemoved } = countDiffLines(diff);

    return { path: filePath, linesAdded, linesRemoved, diff, status };
}

/**
 * Get the current file changes from a git worktree
 * Uses git diff --stat and git diff to get change information
 */
export async function getWorktreeChanges(worktreePath: string): Promise<FileChange[]> {
    try {
        const statusOutput = getGitStatusOutput(worktreePath);
        const statOutput = getGitDiffStatOutput(worktreePath, !!statusOutput);

        if (!statOutput) return [];

        const statLines = statOutput.split('\n').filter(line => line.includes('|'));
        const files: FileChange[] = [];

        for (const line of statLines) {
            const fileChange = parseStatLine(line, statusOutput, worktreePath);
            if (fileChange) {
                files.push(fileChange);
            }
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

/**
 * Get diff stat output for a specific commit using git show
 */
function getCommitDiffStatOutput(repoPath: string, commitHash: string): string {
    try {
        return execSync(`git show --stat --format="" ${commitHash}`, {
            cwd: repoPath,
            encoding: 'utf-8',
            timeout: 30000
        }).trim();
    } catch {
        return '';
    }
}

/**
 * Get the diff content for a specific file in a commit
 */
function getCommitFileDiff(repoPath: string, commitHash: string, filePath: string): string {
    try {
        return execSync(`git show ${commitHash} -- "${filePath}"`, {
            cwd: repoPath,
            encoding: 'utf-8',
            timeout: 10000,
            maxBuffer: 1024 * 1024 * 5
        }).trim();
    } catch (error) {
        logger.debug({ filePath, commitHash, error: (error as Error).message }, 'Failed to get commit diff for file');
        return '';
    }
}

/**
 * Parse commit stat line and create a FileChange object
 */
function parseCommitStatLine(line: string, repoPath: string, commitHash: string): FileChange | null {
    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+|Bin)/);
    if (!match) return null;

    const filePath = match[1].trim();
    if (filePath.includes('file') && filePath.includes('changed')) return null;

    // Determine status from the diff
    const diff = getCommitFileDiff(repoPath, commitHash, filePath);
    let status: FileChange['status'] = 'modified';

    // Check for new file or deleted file indicators in the diff
    if (diff.includes('new file mode')) {
        status = 'added';
    } else if (diff.includes('deleted file mode')) {
        status = 'deleted';
    } else if (diff.includes('rename from') || diff.includes('rename to')) {
        status = 'renamed';
    }

    const { linesAdded, linesRemoved } = countDiffLines(diff);

    return { path: filePath, linesAdded, linesRemoved, diff, status };
}

/**
 * Get file changes from a specific commit hash
 * This is used for viewing historic changes after the worktree has been deleted
 */
export async function getCommitChanges(repoPath: string, commitHash: string): Promise<FileChange[]> {
    try {
        const statOutput = getCommitDiffStatOutput(repoPath, commitHash);

        if (!statOutput) return [];

        const statLines = statOutput.split('\n').filter(line => line.includes('|'));
        const files: FileChange[] = [];

        for (const line of statLines) {
            const fileChange = parseCommitStatLine(line, repoPath, commitHash);
            if (fileChange) {
                files.push(fileChange);
            }
        }

        return files;
    } catch (error) {
        logger.error({ repoPath, commitHash, error: (error as Error).message }, 'Error getting commit changes');
        return [];
    }
}
