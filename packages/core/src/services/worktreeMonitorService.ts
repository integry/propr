import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { Redis } from 'ioredis';

/**
 * Represents a single file change in the worktree
 */
export interface FileChange {
  /** Relative path from worktree root */
  path: string;
  /** Number of lines added */
  linesAdded: number;
  /** Number of lines removed */
  linesRemoved: number;
  /** Unified diff content for this file */
  diff: string;
  /** File status: 'modified', 'added', 'deleted', 'renamed' */
  status: 'modified' | 'added' | 'deleted' | 'renamed';
}

/**
 * File changes data stored in Redis
 */
export interface FileChangesData {
  /** Array of file changes */
  files: FileChange[];
  /** Timestamp of when this data was last updated */
  lastUpdated: string;
  /** Total lines added across all files */
  totalLinesAdded: number;
  /** Total lines removed across all files */
  totalLinesRemoved: number;
  /** Whether the task is still active */
  isActive: boolean;
  /** The worktree path this data was collected from */
  worktreePath?: string;
}

const REDIS_KEY_PREFIX = 'file-changes:';
const REDIS_EXPIRY_SECONDS = 3600; // 1 hour - keep data available after task completes

/**
 * Gets the current file changes from a git worktree
 * @param worktreePath Path to the git worktree
 * @returns FileChangesData with all file changes
 */
export async function getWorktreeChanges(worktreePath: string): Promise<Omit<FileChangesData, 'isActive'>> {
  const files: FileChange[] = [];
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;

  try {
    // Check if the path exists and is a git repository
    const gitPath = path.join(worktreePath, '.git');
    const gitExists = await fs.pathExists(gitPath);

    if (!gitExists) {
      console.log(`[worktree-monitor] Not a git repository: ${worktreePath}`);
      return {
        files: [],
        lastUpdated: new Date().toISOString(),
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        worktreePath
      };
    }

    // Get the base to compare against
    // For worktrees, we want to compare against the branch point (merge-base with origin/main)
    let baseBranch = 'origin/main';
    try {
      // Try to find merge-base with origin/main
      const mergeBase = execSync('git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo ""', {
        cwd: worktreePath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      if (mergeBase) {
        baseBranch = mergeBase;
      }
    } catch {
      // Fall back to origin/main or origin/master
      try {
        execSync('git rev-parse --verify origin/main', { cwd: worktreePath, stdio: ['pipe', 'pipe', 'pipe'] });
        baseBranch = 'origin/main';
      } catch {
        try {
          execSync('git rev-parse --verify origin/master', { cwd: worktreePath, stdio: ['pipe', 'pipe', 'pipe'] });
          baseBranch = 'origin/master';
        } catch {
          // If we can't find a remote branch, try HEAD~1 or just use HEAD for unstaged changes
          baseBranch = 'HEAD~1';
        }
      }
    }

    // Get list of changed files with stats using git diff --numstat
    let diffStatOutput = '';
    try {
      // First try diff against base branch
      diffStatOutput = execSync(`git diff --numstat ${baseBranch} HEAD 2>/dev/null || echo ""`, {
        cwd: worktreePath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      }).trim();

      // If no diff against base, check for uncommitted changes
      if (!diffStatOutput) {
        diffStatOutput = execSync('git diff --numstat HEAD 2>/dev/null || echo ""', {
          cwd: worktreePath,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024
        }).trim();
      }

      // Also check for staged changes
      if (!diffStatOutput) {
        diffStatOutput = execSync('git diff --numstat --cached 2>/dev/null || echo ""', {
          cwd: worktreePath,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024
        }).trim();
      }
    } catch (error) {
      console.log('[worktree-monitor] Error running git diff --numstat:', error);
      return {
        files: [],
        lastUpdated: new Date().toISOString(),
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        worktreePath
      };
    }

    if (!diffStatOutput) {
      return {
        files: [],
        lastUpdated: new Date().toISOString(),
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        worktreePath
      };
    }

    // Parse the numstat output (format: added\tremoved\tfilepath)
    const lines = diffStatOutput.split('\n').filter(line => line.trim());

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
        const removed = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
        const filePath = parts.slice(2).join('\t'); // Handle paths with tabs

        totalLinesAdded += added;
        totalLinesRemoved += removed;

        // Get unified diff for this specific file
        let diff = '';
        try {
          diff = execSync(`git diff ${baseBranch} HEAD -- "${filePath}" 2>/dev/null || git diff HEAD -- "${filePath}" 2>/dev/null || echo ""`, {
            cwd: worktreePath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 5 * 1024 * 1024 // 5MB buffer per file
          }).trim();
        } catch {
          // Unable to get diff for this file - might be binary or too large
        }

        // Determine file status using git diff --name-status
        let status: FileChange['status'] = 'modified';
        try {
          const statusOutput = execSync(`git diff --name-status ${baseBranch} HEAD -- "${filePath}" 2>/dev/null || echo "M"`, {
            cwd: worktreePath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();

          if (statusOutput.startsWith('A')) status = 'added';
          else if (statusOutput.startsWith('D')) status = 'deleted';
          else if (statusOutput.startsWith('R')) status = 'renamed';
        } catch {
          // Default to modified
        }

        files.push({
          path: filePath,
          linesAdded: added,
          linesRemoved: removed,
          diff,
          status
        });
      }
    }

    return {
      files,
      lastUpdated: new Date().toISOString(),
      totalLinesAdded,
      totalLinesRemoved,
      worktreePath
    };
  } catch (error) {
    console.error('[worktree-monitor] Error getting worktree changes:', error);
    return {
      files: [],
      lastUpdated: new Date().toISOString(),
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      worktreePath
    };
  }
}

/**
 * Stores file changes data in Redis
 * @param redisClient Redis client instance
 * @param taskId Task ID to store changes for
 * @param changes File changes data
 */
export async function storeFileChanges(
  redisClient: Redis,
  taskId: string,
  changes: FileChangesData
): Promise<void> {
  try {
    const key = `${REDIS_KEY_PREFIX}${taskId}`;
    await redisClient.setex(key, REDIS_EXPIRY_SECONDS, JSON.stringify(changes));
  } catch (error) {
    console.error('[worktree-monitor] Error storing file changes in Redis:', error);
  }
}

/**
 * Retrieves stored file changes from Redis
 * @param redisClient Redis client instance
 * @param taskId Task ID to retrieve changes for
 * @returns FileChangesData or null if not found
 */
export async function getStoredFileChanges(
  redisClient: Redis,
  taskId: string
): Promise<FileChangesData | null> {
  try {
    const key = `${REDIS_KEY_PREFIX}${taskId}`;
    const data = await redisClient.get(key);
    if (data) {
      return JSON.parse(data) as FileChangesData;
    }
  } catch (error) {
    console.error('[worktree-monitor] Error retrieving file changes from Redis:', error);
  }
  return null;
}

/**
 * Clears stored file changes from Redis
 * @param redisClient Redis client instance
 * @param taskId Task ID to clear changes for
 */
export async function clearFileChanges(
  redisClient: Redis,
  taskId: string
): Promise<void> {
  try {
    const key = `${REDIS_KEY_PREFIX}${taskId}`;
    await redisClient.del(key);
  } catch (error) {
    console.error('[worktree-monitor] Error clearing file changes from Redis:', error);
  }
}

/**
 * Updates file changes for a task by fetching from the worktree
 * @param redisClient Redis client instance
 * @param taskId Task ID to update changes for
 * @param worktreePath Path to the git worktree
 * @param isActive Whether the task is still actively running
 */
export async function updateFileChanges(
  redisClient: Redis,
  taskId: string,
  worktreePath: string,
  isActive: boolean
): Promise<FileChangesData> {
  const changes = await getWorktreeChanges(worktreePath);
  const data: FileChangesData = {
    ...changes,
    isActive
  };
  await storeFileChanges(redisClient, taskId, data);
  return data;
}
