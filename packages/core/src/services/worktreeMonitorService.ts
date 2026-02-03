import { Redis } from 'ioredis';
import { simpleGit, SimpleGit } from 'simple-git';
import logger from '../utils/logger.js';

/**
 * Validate that a string is a valid git commit hash (SHA-1 or SHA-256)
 * @param hash - The hash to validate
 * @returns true if valid, false otherwise
 */
export function isValidCommitHash(hash: string): boolean {
    // SHA-1 hashes are 40 hex characters, SHA-256 are 64
    // Also accept short hashes (minimum 7 characters)
    return /^[0-9a-f]{7,64}$/i.test(hash);
}

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
async function getGitStatusOutput(git: SimpleGit): Promise<string> {
    try {
        const status = await git.status();
        // Build porcelain-like output for status determination
        const lines: string[] = [];
        for (const file of status.modified) lines.push(` M ${file}`);
        for (const file of status.created) lines.push(`A  ${file}`);
        for (const file of status.deleted) lines.push(` D ${file}`);
        for (const file of status.renamed) lines.push(`R  ${file.from} -> ${file.to}`);
        for (const file of status.not_added) lines.push(`?? ${file}`);
        return lines.join('\n');
    } catch {
        return '';
    }
}

/**
 * Get git diff stat output for uncommitted or committed changes
 */
async function getGitDiffStatOutput(git: SimpleGit, hasUncommittedChanges: boolean): Promise<string> {
    if (hasUncommittedChanges) {
        try {
            return (await git.diff(['--stat', 'HEAD'])).trim();
        } catch {
            try {
                return (await git.diff(['--stat', '--cached'])).trim();
            } catch {
                return '';
            }
        }
    }

    // No uncommitted changes, check against tracking branch
    try {
        let trackingBranch: string;
        try {
            trackingBranch = (await git.revparse(['--abbrev-ref', '@{upstream}'])).trim();
        } catch {
            trackingBranch = 'HEAD~1';
        }

        return (await git.diff(['--stat', `${trackingBranch}...HEAD`])).trim();
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
async function getFileDiff(git: SimpleGit, filePath: string, status: FileChange['status']): Promise<string> {
    try {
        let diff = (await git.diff(['HEAD', '--', filePath])).trim();

        if (!diff) {
            diff = (await git.diff(['--cached', '--', filePath])).trim();
        }

        if (!diff && status === 'added') {
            try {
                const content = (await git.show([`:${filePath}`])).trim();
                if (content) {
                    diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${content.split('\n').length} @@\n` +
                        content.split('\n').map(l => `+${l}`).join('\n');
                }
            } catch {
                // File not in index, try reading from working directory
                const fs = await import('fs-extra');
                const baseDir = (await git.revparse(['--show-toplevel'])).trim();
                const fullPath = `${baseDir}/${filePath}`;
                if (await fs.pathExists(fullPath)) {
                    const content = (await fs.readFile(fullPath, 'utf-8')).trim();
                    if (content) {
                        diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${content.split('\n').length} @@\n` +
                            content.split('\n').map(l => `+${l}`).join('\n');
                    }
                }
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
async function parseStatLine(line: string, statusOutput: string, git: SimpleGit): Promise<FileChange | null> {
    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+|Bin)/);
    if (!match) {
        logger.debug({ line }, 'Failed to parse stat line: regex did not match');
        return null;
    }

    const filePath = match[1].trim();
    if (filePath.includes('file') && filePath.includes('changed')) return null;

    const status = determineFileStatus(statusOutput, filePath);
    const diff = await getFileDiff(git, filePath, status);
    const { linesAdded, linesRemoved } = countDiffLines(diff);

    return { path: filePath, linesAdded, linesRemoved, diff, status };
}

/**
 * Get the current file changes from a git worktree
 * Uses git diff --stat and git diff to get change information
 */
export async function getWorktreeChanges(worktreePath: string): Promise<FileChange[]> {
    try {
        const git: SimpleGit = simpleGit({ baseDir: worktreePath });
        const statusOutput = await getGitStatusOutput(git);
        const statOutput = await getGitDiffStatOutput(git, !!statusOutput);

        if (!statOutput) return [];

        const statLines = statOutput.split('\n').filter(line => line.includes('|'));
        const files: FileChange[] = [];

        for (const line of statLines) {
            const fileChange = await parseStatLine(line, statusOutput, git);
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
 * Get full diff output for a specific commit using simple-git
 * Returns both the stat summary and the full diff content in one call
 */
async function getCommitFullDiff(git: SimpleGit, commitHash: string): Promise<string> {
    try {
        // Use git show with --format="" to skip commit message, -p for patch
        return (await git.show(['--format=', '-p', '--stat', commitHash])).trim();
    } catch (error) {
        logger.debug({ commitHash, error: (error as Error).message }, 'Failed to get commit diff');
        return '';
    }
}

/**
 * Parse the full commit diff output into individual file changes
 * This is more efficient as it processes all files from a single git call
 */
function parseCommitDiffOutput(fullDiff: string): FileChange[] {
    const files: FileChange[] = [];

    // Split by diff headers to get individual file diffs
    const diffSections = fullDiff.split(/(?=^diff --git)/m);

    for (const section of diffSections) {
        if (!section.startsWith('diff --git')) continue;

        // Extract file path from diff header
        // Format: "diff --git a/path/to/file b/path/to/file"
        const headerMatch = section.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
        if (!headerMatch) {
            logger.debug({ section: section.substring(0, 100) }, 'Failed to parse diff header');
            continue;
        }

        const filePath = headerMatch[2]; // Use the "b" path (destination)

        // Determine status from the diff content
        let status: FileChange['status'] = 'modified';
        if (section.includes('new file mode')) {
            status = 'added';
        } else if (section.includes('deleted file mode')) {
            status = 'deleted';
        } else if (section.includes('rename from') || section.includes('rename to')) {
            status = 'renamed';
        }

        const { linesAdded, linesRemoved } = countDiffLines(section);

        files.push({
            path: filePath,
            linesAdded,
            linesRemoved,
            diff: section,
            status
        });
    }

    return files;
}

/**
 * Get file changes from a specific commit hash
 * This is used for viewing historic changes after the worktree has been deleted
 */
export async function getCommitChanges(repoPath: string, commitHash: string): Promise<FileChange[]> {
    try {
        // Validate commit hash to prevent injection
        if (!isValidCommitHash(commitHash)) {
            logger.error({ commitHash }, 'Invalid commit hash format');
            return [];
        }

        const git: SimpleGit = simpleGit({ baseDir: repoPath });

        // Get full diff in one call (optimized - no per-file git processes)
        const fullDiff = await getCommitFullDiff(git, commitHash);

        if (!fullDiff) return [];

        // Parse the diff output to extract individual file changes
        const files = parseCommitDiffOutput(fullDiff);

        return files;
    } catch (error) {
        logger.error({ repoPath, commitHash, error: (error as Error).message }, 'Error getting commit changes');
        return [];
    }
}
