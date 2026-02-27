import { Request, Response } from 'express';
import { Knex } from 'knex';
import {
  getStoredFileChanges,
  storeFileChanges,
  getCommitChanges,
  ensureRepoCloned,
  getGitHubInstallationToken,
  isValidCommitHash,
  FileChangesData
} from '@propr/core';

interface FileChangesRoutesDeps {
  db: Knex;
}

export function createFileChangesRoutes(deps: FileChangesRoutesDeps) {
  const { db } = deps;

  async function getFileChanges(req: Request, res: Response): Promise<void> {
    try {
      const { taskId: jobId } = req.params;
      const taskId = normalizeTaskId(jobId);

      console.log(`[file-changes] jobId: ${jobId}, taskId: ${taskId}`);

      // First try to get from Redis cache
      const fileChangesData = await getStoredFileChanges(taskId);

      if (fileChangesData) {
        console.log(`[file-changes] Found ${fileChangesData.files.length} files in cache for taskId: ${taskId}`);
        res.json(fileChangesData);
        return;
      }

      // Get changes from the commit hash in the main repository
      // The commit is always pushed, so we can read directly from the repo clone
      const commitChanges = await getCommitChangesFromRepo(db, taskId);
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
