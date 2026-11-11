import type { Response } from 'express';
import type { FlatRequest } from '../requestTypes.js';
import { Knex } from 'knex';
import {
  getStoredFileChanges,
  storeFileChanges,
  getCommitChanges,
  ensureRepoCloned,
  getGitHubInstallationToken,
  isValidCommitHash,
  getCurrentFileOverlaps,
  FileChangesData
} from '@propr/core';
import type { TaskFileOverlap } from '@propr/core';
import type { RedisClientType } from 'redis';

interface FileChangesRoutesDeps {
  db: Knex;
  normalizeJobReferences?: boolean;
  /** Reads the task's current overlaps with other active tasks; none are reported without it. */
  redisClient?: RedisClientType;
}

/** File changes plus the other active tasks currently changing the same files. */
export type FileChangesResponse = FileChangesData & { overlaps: TaskFileOverlap[] };

export function createFileChangesRoutes(deps: FileChangesRoutesDeps) {
  const { db } = deps;

  async function currentOverlaps(taskId: string): Promise<TaskFileOverlap[]> {
    const client = deps.redisClient;
    if (!client) return [];
    return getCurrentFileOverlaps({
      get: key => client.get(key),
      zscore: (key, member) => client.zScore(key, member),
    }, taskId);
  }

  async function getFileChanges(req: FlatRequest, res: Response): Promise<void> {
    try {
      const { taskId: jobId } = req.params;
      const taskId = deps.normalizeJobReferences === false ? jobId : normalizeTaskId(jobId);

      console.log(`[file-changes] jobId: ${jobId}, taskId: ${taskId}`);

      // First try to get from Redis cache
      const fileChangesData = await getStoredFileChanges(taskId);

      if (fileChangesData) {
        console.log(`[file-changes] Found ${fileChangesData.files.length} files in cache for taskId: ${taskId}`);
        res.json({ ...fileChangesData, overlaps: await currentOverlaps(taskId) } satisfies FileChangesResponse);
        return;
      }

      // Get changes from the commit hash in the main repository
      // The commit is always pushed, so we can read directly from the repo clone
      const commitChanges = await getCommitChangesFromRepo(db, taskId);
      if (commitChanges) {
        console.log(`[file-changes] Retrieved ${commitChanges.files.length} file changes from commit hash`);
        res.json({ ...commitChanges, overlaps: await currentOverlaps(taskId) } satisfies FileChangesResponse);
        return;
      }

      // No data found - return empty response
      console.log(`[file-changes] No file changes found for taskId: ${taskId}`);
      res.json({
        files: [],
        lastUpdated: new Date().toISOString(),
        taskId,
        overlaps: await currentOverlaps(taskId),
      } satisfies FileChangesResponse);
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

/**
 * Get file changes from a stored commit hash by reading from the main repository clone.
 * Since commits are always pushed, we can read directly from the repo without needing worktrees.
 */
async function getCommitChangesFromRepo(
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
