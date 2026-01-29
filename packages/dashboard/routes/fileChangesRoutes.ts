import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs-extra';

interface FileChangesRoutesDeps {
  redisClient: RedisClientType;
  db: Knex;
}

interface FileChange {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
}

interface FileChangesData {
  files: FileChange[];
  lastUpdated: string;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  isActive: boolean;
}

const REDIS_KEY_PREFIX = 'file-changes:';

export function createFileChangesRoutes(deps: FileChangesRoutesDeps) {
  const { redisClient, db } = deps;

  /**
   * Get file changes for a task
   * First tries Redis cache, then falls back to git commands if worktree exists
   */
  async function getFileChanges(req: Request, res: Response): Promise<void> {
    try {
      const { taskId } = req.params;

      console.log(`[file-changes] Getting file changes for task: ${taskId}`);

      // Try to get from Redis cache first
      const cachedData = await getFromRedis(taskId);
      if (cachedData) {
        console.log(`[file-changes] Returning cached data for task: ${taskId}`);
        res.json(cachedData);
        return;
      }

      // Try to get worktree path from task state
      const worktreePath = await findWorktreePath(taskId);

      if (!worktreePath) {
        console.log(`[file-changes] No worktree found for task: ${taskId}`);
        res.json({
          files: [],
          lastUpdated: new Date().toISOString(),
          totalLinesAdded: 0,
          totalLinesRemoved: 0,
          isActive: false
        });
        return;
      }

      // Get file changes from git
      const fileChanges = await getGitFileChanges(worktreePath);

      // Check if task is still active
      const isActive = await isTaskActive(taskId);

      const response: FileChangesData = {
        ...fileChanges,
        isActive
      };

      // Store in Redis for caching (short TTL since data changes frequently)
      await storeInRedis(taskId, response);

      res.json(response);
    } catch (error) {
      console.error(`[file-changes] Error getting file changes:`, error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function getFromRedis(taskId: string): Promise<FileChangesData | null> {
    try {
      const key = `${REDIS_KEY_PREFIX}${taskId}`;
      const data = await redisClient.get(key);
      if (data) {
        return JSON.parse(data) as FileChangesData;
      }
    } catch (error) {
      console.error('[file-changes] Error reading from Redis:', error);
    }
    return null;
  }

  async function storeInRedis(taskId: string, data: FileChangesData): Promise<void> {
    try {
      const key = `${REDIS_KEY_PREFIX}${taskId}`;
      await redisClient.setEx(key, 30, JSON.stringify(data)); // 30 second cache for active polling
    } catch (error) {
      console.error('[file-changes] Error storing in Redis:', error);
    }
  }

  async function findWorktreePath(taskId: string): Promise<string | null> {
    try {
      // First try to get from Redis worker state
      const stateKey = `worker:state:${taskId}`;
      const stateData = await redisClient.get(stateKey);

      if (stateData) {
        const state = JSON.parse(stateData) as {
          history: Array<{
            state: string;
            metadata?: { worktreePath?: string; historyMetadata?: { worktreePath?: string } }
          }>
        };

        // Look for worktree path in history (check both metadata and historyMetadata)
        for (const entry of state.history) {
          const worktreePath = entry.metadata?.worktreePath || entry.metadata?.historyMetadata?.worktreePath;
          if (worktreePath && await fs.pathExists(worktreePath)) {
            return worktreePath;
          }
        }
      }

      // Try to find worktree from SQLite
      const llmExecution = await db('llm_executions')
        .where({ task_id: taskId })
        .orderBy('start_time', 'desc')
        .first();

      if (llmExecution?.worktree_path) {
        const worktreePath = llmExecution.worktree_path as string;
        if (await fs.pathExists(worktreePath)) {
          return worktreePath;
        }
      }

      // Try to find worktree from task metadata
      const taskRecord = await db('tasks')
        .where({ task_id: taskId })
        .first();

      if (taskRecord?.metadata) {
        try {
          const metadata = typeof taskRecord.metadata === 'string'
            ? JSON.parse(taskRecord.metadata)
            : taskRecord.metadata;

          if (metadata.worktreePath && await fs.pathExists(metadata.worktreePath)) {
            return metadata.worktreePath;
          }
        } catch {
          // Ignore parse errors
        }
      }

      return null;
    } catch (error) {
      console.error('[file-changes] Error finding worktree path:', error);
      return null;
    }
  }

  async function isTaskActive(taskId: string): Promise<boolean> {
    try {
      const stateKey = `worker:state:${taskId}`;
      const stateData = await redisClient.get(stateKey);

      if (stateData) {
        const state = JSON.parse(stateData) as {
          history: Array<{ state: string }>
        };

        if (state.history.length > 0) {
          const lastState = state.history[state.history.length - 1].state;
          return ['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(lastState.toUpperCase());
        }
      }

      return false;
    } catch (error) {
      console.error('[file-changes] Error checking task state:', error);
      return false;
    }
  }

  return { getFileChanges };
}

function createEmptyFileChangesResult(): Omit<FileChangesData, 'isActive'> {
  return {
    files: [],
    lastUpdated: new Date().toISOString(),
    totalLinesAdded: 0,
    totalLinesRemoved: 0
  };
}

function resolveGitBaseBranch(worktreePath: string): string {
  // For worktrees, we compare against the branch point
  try {
    const result = execSync('git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo ""', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (result) return result;
  } catch {
    // Continue to fallbacks
  }

  // Fall back to main/master
  try {
    execSync('git rev-parse --verify origin/main', { cwd: worktreePath, stdio: ['pipe', 'pipe', 'pipe'] });
    return 'origin/main';
  } catch {
    // Continue
  }

  try {
    execSync('git rev-parse --verify origin/master', { cwd: worktreePath, stdio: ['pipe', 'pipe', 'pipe'] });
    return 'origin/master';
  } catch {
    return 'HEAD~1';
  }
}

function getGitDiffStatOutput(worktreePath: string, baseBranch: string): string {
  let output = execSync(`git diff --numstat ${baseBranch} HEAD 2>/dev/null || git diff --numstat HEAD 2>/dev/null || echo ""`, {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024
  }).trim();

  if (output) return output;

  // Check for staged/unstaged changes
  try {
    output = execSync('git diff --numstat HEAD 2>/dev/null', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024
    }).trim();
  } catch {
    // No changes
  }

  return output;
}

function getGitFileStatus(worktreePath: string, baseBranch: string, filePath: string): FileChange['status'] {
  try {
    const statusOutput = execSync(`git diff --name-status ${baseBranch} HEAD -- "${filePath}" 2>/dev/null || echo "M"`, {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (statusOutput.startsWith('A')) return 'added';
    if (statusOutput.startsWith('D')) return 'deleted';
    if (statusOutput.startsWith('R')) return 'renamed';
  } catch {
    // Default to modified
  }
  return 'modified';
}

function getGitFileDiff(worktreePath: string, baseBranch: string, filePath: string): string {
  try {
    return execSync(`git diff ${baseBranch} HEAD -- "${filePath}" 2>/dev/null || git diff HEAD -- "${filePath}" 2>/dev/null || echo ""`, {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 5 * 1024 * 1024
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Get file changes from git worktree using git diff commands
 */
async function getGitFileChanges(worktreePath: string): Promise<Omit<FileChangesData, 'isActive'>> {
  try {
    if (!await fs.pathExists(path.join(worktreePath, '.git'))) {
      console.log(`[file-changes] Not a git repository: ${worktreePath}`);
      return createEmptyFileChangesResult();
    }

    const baseBranch = resolveGitBaseBranch(worktreePath);

    let diffStatOutput: string;
    try {
      diffStatOutput = getGitDiffStatOutput(worktreePath, baseBranch);
    } catch (error) {
      console.log('[file-changes] Error running git diff --numstat:', error);
      return createEmptyFileChangesResult();
    }

    if (!diffStatOutput) {
      return createEmptyFileChangesResult();
    }

    const files: FileChange[] = [];
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;

    const lines = diffStatOutput.split('\n').filter(line => line.trim());

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
      const removed = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
      const filePath = parts.slice(2).join('\t');

      totalLinesAdded += added;
      totalLinesRemoved += removed;

      files.push({
        path: filePath,
        linesAdded: added,
        linesRemoved: removed,
        diff: getGitFileDiff(worktreePath, baseBranch, filePath),
        status: getGitFileStatus(worktreePath, baseBranch, filePath)
      });
    }

    return {
      files,
      lastUpdated: new Date().toISOString(),
      totalLinesAdded,
      totalLinesRemoved
    };
  } catch (error) {
    console.error('[file-changes] Error getting git file changes:', error);
    return createEmptyFileChangesResult();
  }
}
