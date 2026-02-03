import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import {
  getStoredFileChanges,
  getWorktreeChanges,
  storeFileChanges,
  getCommitChanges,
  ensureRepoCloned,
  getGitHubInstallationToken,
  isValidCommitHash,
  FileChangesData
} from '@gitfix/core';

interface FileChangesRoutesDeps {
  redisClient: RedisClientType;
  db: Knex;
}

export function createFileChangesRoutes(deps: FileChangesRoutesDeps) {
  const { redisClient, db } = deps;

  async function getFileChanges(req: Request, res: Response): Promise<void> {
    try {
      const { taskId: jobId } = req.params;
      const taskId = normalizeTaskId(jobId);

      console.log(`[file-changes] jobId: ${jobId}, taskId: ${taskId}`);

      // First try to get from Redis cache
      let fileChangesData = await getStoredFileChanges(taskId);

      if (fileChangesData) {
        console.log(`[file-changes] Found ${fileChangesData.files.length} files in cache for taskId: ${taskId}`);
        res.json(fileChangesData);
        return;
      }

      // If not in cache, try to get from active worktree
      const worktreePath = await findActiveWorktreePath(redisClient, db, taskId);

      if (worktreePath) {
        console.log(`[file-changes] Found active worktree at: ${worktreePath}`);
        const changes = await getWorktreeChanges(worktreePath);
        await storeFileChanges(taskId, changes);

        fileChangesData = {
          files: changes,
          lastUpdated: new Date().toISOString(),
          taskId
        };

        console.log(`[file-changes] Retrieved ${changes.length} file changes from worktree`);
        res.json(fileChangesData);
        return;
      }

      // Try to get historic changes from stored commit hash
      const commitChanges = await getHistoricCommitChanges(db, taskId);
      if (commitChanges) {
        console.log(`[file-changes] Retrieved ${commitChanges.files.length} file changes from commit hash`);
        res.json(commitChanges);
        return;
      }

      // No data found - return empty response
      console.log(`[file-changes] No file changes found for taskId: ${taskId}`);
      res.json({
        files: [],
        lastUpdated: new Date().toISOString(),
        taskId
      } as FileChangesData);
    } catch (error) {
      console.error(`Error in /api/task/:taskId/file-changes:`, error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getFileChanges };
}

function normalizeTaskId(jobId: string): string {
  // Handle job reference format: issue-owner-repo-number-timestamp
  if (jobId.startsWith('issue-')) {
    const parts = jobId.replace(/^issue-/, '').split('-');
    parts.pop(); // Remove timestamp
    return parts.join('-');
  }
  return jobId;
}

async function findActiveWorktreePath(
  redisClient: RedisClientType,
  db: Knex,
  taskId: string
): Promise<string | null> {
  try {
    // Try to get worktree path from Redis state
    const stateKey = `worker:state:${taskId}`;
    const stateData = await redisClient.get(stateKey);

    if (stateData) {
      const state = JSON.parse(stateData) as {
        history: Array<{
          state: string;
          metadata?: { worktreePath?: string }
        }>
      };

      // Find the processing entry with worktreePath
      for (const entry of state.history) {
        if (entry.metadata?.worktreePath) {
          return entry.metadata.worktreePath;
        }
      }
    }

    // Try to get from database llm_executions
    const llmExecution = await db('llm_executions')
      .where({ task_id: taskId })
      .orderBy('start_time', 'desc')
      .first();

    if (llmExecution?.worktree_path) {
      return llmExecution.worktree_path as string;
    }

    // As a fallback, try to construct the path from task ID components
    // taskId format: owner-repo-number-agent-model
    const parts = taskId.split('-');
    if (parts.length >= 3) {
      const owner = parts[0];
      const repo = parts[1];
      const number = parts[2];

      // Standard worktree path pattern
      const possiblePaths = [
        `/home/node/workspace/repos/${owner}/${repo}/worktrees/issue-${number}`,
        `/home/node/repos/${owner}/${repo}/worktrees/issue-${number}`
      ];

      // Check if any path exists
      const fs = await import('fs-extra');
      for (const path of possiblePaths) {
        if (await fs.pathExists(path)) {
          return path;
        }
      }
    }

    return null;
  } catch (error) {
    console.error('[file-changes] Error finding worktree path:', error);
    return null;
  }
}

/**
 * Get file changes from a stored commit hash for completed tasks.
 * This enables viewing historic changes even after the worktree is deleted.
 */
async function getHistoricCommitChanges(
  db: Knex,
  taskId: string
): Promise<FileChangesData | null> {
  try {
    // Look up the task to get the commit hash and repository
    const task = await db('tasks')
      .where({ task_id: taskId })
      .select('commit_hash', 'repository')
      .first();

    if (!task?.commit_hash || !task?.repository) {
      console.log(`[file-changes] No commit hash found for taskId: ${taskId}`);
      return null;
    }

    const { commit_hash: commitHash, repository } = task;
    console.log(`[file-changes] Found commit hash ${commitHash} for taskId: ${taskId}`);

    // Validate commit hash format before using
    if (!isValidCommitHash(commitHash)) {
      console.error(`[file-changes] Invalid commit hash format: ${commitHash}`);
      return null;
    }

    // Parse repository format: "owner/repo"
    const [owner, repoName] = repository.split('/');
    if (!owner || !repoName) {
      console.error(`[file-changes] Invalid repository format: ${repository}`);
      return null;
    }

    // Get authenticated token to clone/access the repo
    let repoPath: string;
    try {
      const token = await getGitHubInstallationToken();
      const repoUrl = `https://github.com/${owner}/${repoName}.git`;

      // Ensure the repo is cloned/accessible
      repoPath = await ensureRepoCloned({
        repoUrl,
        owner,
        repoName,
        authToken: token
      });
    } catch (authError) {
      console.error(`[file-changes] Failed to authenticate or clone repo: ${(authError as Error).message}`);
      return null;
    }

    // Get changes from the commit
    const changes = await getCommitChanges(repoPath, commitHash);

    // Cache the result in Redis for future requests
    await storeFileChanges(taskId, changes);

    return {
      files: changes,
      lastUpdated: new Date().toISOString(),
      taskId
    };
  } catch (error) {
    console.error('[file-changes] Error getting historic commit changes:', error);
    return null;
  }
}
