import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Queue } from 'bullmq';
import { Knex } from 'knex';
import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { RequestError } from '@octokit/request-error';
import { refreshGitHubTokenIfNeeded } from '../auth';

interface GitHubRoutesDeps {
  redisClient: RedisClientType;
  taskQueue: Queue;
  db: Knex;
}

/**
 * Check if an error is a GitHub authentication error (401)
 */
function isAuthError(error: unknown): boolean {
  if (error instanceof RequestError && error.status === 401) {
    return true;
  }
  // Also check for error objects with status property
  if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
    return true;
  }
  return false;
}

/**
 * Handle GitHub authentication errors by attempting token refresh before clearing session
 */
async function handleAuthError(req: Request, res: Response): Promise<void> {
  console.warn('GitHub token expired or revoked, attempting token refresh');

  // Try to refresh the token before logging out
  const refreshed = await refreshGitHubTokenIfNeeded(req, true);

  if (refreshed) {
    // Token was successfully refreshed, tell client to retry
    console.log('Token refresh successful, client should retry');
    res.status(401).json({
      error: 'Token refreshed',
      code: 'TOKEN_REFRESHED',
      message: 'Your GitHub token has been refreshed. Please retry your request.'
    });
    return;
  }

  // Token refresh failed, clear the session to force re-login
  console.warn('Token refresh failed, clearing session for re-authentication');

  await new Promise<void>((resolve) => {
    req.logout((err) => {
      if (err) console.error('Error during logout:', err);
      req.session.destroy((destroyErr) => {
        if (destroyErr) console.error('Error destroying session:', destroyErr);
        resolve();
      });
    });
  });

  res.status(401).json({
    error: 'GitHub authentication expired',
    code: 'TOKEN_EXPIRED',
    message: 'Your GitHub session has expired. Please log in again.'
  });
}

export function createGitHubRoutes(deps: GitHubRoutesDeps) {
  const { redisClient, taskQueue } = deps;

  async function importTasks(req: Request, res: Response): Promise<void> {
    try {
      const { taskDescription, repository } = req.body;
      if (!taskDescription || !repository) {
        res.status(400).json({ error: 'Both taskDescription and repository are required' });
        return;
      }
      if (!/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_]+$/.test(repository)) {
        res.status(400).json({ error: 'Invalid repository format. Expected: owner/name' });
        return;
      }
      const jobId = `import-tasks-${repository.replace('/', '-')}-${Date.now()}`;
      const correlationId = `${jobId}-${Math.random().toString(36).substring(2, 9)}`;
      const newJob = await taskQueue.add('processTaskImport', { taskDescription, repository, correlationId, user: req.user?.username }, { jobId, removeOnComplete: { age: 24 * 3600, count: 100 }, removeOnFail: { age: 7 * 24 * 3600 } });
      await redisClient.lPush('system:activity:log', JSON.stringify({ id: `activity-${Date.now()}-${jobId}`, type: 'task_import', timestamp: new Date().toISOString(), user: req.user?.username, repository, description: `Task import job created for ${repository}`, status: 'pending' }));
      await redisClient.lTrim('system:activity:log', 0, 999);
      console.log(`Created task import job ${jobId} for repository ${repository}`);
      res.json({ jobId: newJob.id });
    } catch (error) {
      console.error('Error in /api/import-tasks:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function getRepos(req: Request, res: Response): Promise<void> {
    try {
      // Get user's access token from session
      const accessToken = req.user?.accessToken;
      if (!accessToken) {
        res.status(401).json({ error: 'No GitHub access token available', code: 'NO_TOKEN' });
        return;
      }

      // Create Octokit instance with user's token and pagination support
      const PaginatedOctokit = Octokit.plugin(paginateRest);
      const octokit = new PaginatedOctokit({ auth: accessToken });

      // Fetch all repositories the user has access to with pagination
      const repos: string[] = [];

      // Use paginate.iterator to fetch all pages of repos
      for await (const response of octokit.paginate.iterator('GET /user/repos', {
        per_page: 100,
        sort: 'full_name',
        direction: 'asc',
        affiliation: 'owner,collaborator,organization_member'
      })) {
        for (const repo of response.data) {
          if (repo.full_name) {
            repos.push(repo.full_name);
          }
        }
      }

      // Sort alphabetically
      repos.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      res.json({ repos });
    } catch (error) {
      // Check if this is a token expiration/revocation error
      if (isAuthError(error)) {
        await handleAuthError(req, res);
        return;
      }
      console.error('Error in /api/github/repos:', error);
      res.status(500).json({ error: 'Failed to fetch repositories from GitHub' });
    }
  }

  async function getBranches(req: Request, res: Response): Promise<void> {
    try {
      const { owner, repo } = req.params;

      if (!owner || !repo) {
        res.status(400).json({ error: 'Owner and repo are required' });
        return;
      }

      // Get user's access token from session
      const accessToken = req.user?.accessToken;
      if (!accessToken) {
        res.status(401).json({ error: 'No GitHub access token available', code: 'NO_TOKEN' });
        return;
      }

      // Create Octokit instance with user's token and pagination support
      const PaginatedOctokit = Octokit.plugin(paginateRest);
      const octokit = new PaginatedOctokit({ auth: accessToken });

      // Fetch branches with pagination
      const branches: string[] = [];
      let defaultBranch = 'main';

      // First get the repository info to find the default branch
      try {
        const repoInfo = await octokit.request('GET /repos/{owner}/{repo}', {
          owner,
          repo
        });
        defaultBranch = repoInfo.data.default_branch;
      } catch (error) {
        // Check for auth error on repo info request
        if (isAuthError(error)) {
          await handleAuthError(req, res);
          return;
        }
        console.error('Error fetching repo info for default branch:', error);
        // Continue without default branch info
      }

      // Fetch all branches using pagination
      for await (const response of octokit.paginate.iterator('GET /repos/{owner}/{repo}/branches', {
        owner,
        repo,
        per_page: 100
      })) {
        for (const branch of response.data) {
          if (branch.name) {
            branches.push(branch.name);
          }
        }
      }

      // Sort alphabetically but put default branch first
      branches.sort((a, b) => {
        if (a === defaultBranch) return -1;
        if (b === defaultBranch) return 1;
        return a.toLowerCase().localeCompare(b.toLowerCase());
      });

      res.json({ branches, defaultBranch });
    } catch (error) {
      // Check if this is a token expiration/revocation error
      if (isAuthError(error)) {
        await handleAuthError(req, res);
        return;
      }
      console.error('Error in /api/github/repos/:owner/:repo/branches:', error);
      res.status(500).json({ error: 'Failed to fetch branches from GitHub' });
    }
  }

  return { importTasks, getRepos, getBranches };
}
