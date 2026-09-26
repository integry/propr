import type { Request, Response } from 'express';
import type { FlatRequest } from '../requestTypes.js';
import { RedisClientType } from 'redis';
import { Queue } from 'bullmq';
import { Knex } from 'knex';
import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { RequestError } from '@octokit/request-error';
import { refreshGitHubTokenWithResult } from '../authGithubTokens.js';
import { isDemoMode } from '../demoMode.js';
import { loadDemoConfiguredRepoNames, loadDemoRepositoryMetadata } from './demoRepositoryMetadata.js';
import {
  GitHubMetadataAuthorizationError,
  refreshRejectedGitHubMetadataToken,
  resolveGitHubMetadataToken,
  sendGitHubMetadataAuthorizationError,
} from '../githubMetadataAuth.js';

const PaginatedOctokit = Octokit.plugin(paginateRest);
type MetadataOctokit = InstanceType<typeof PaginatedOctokit>;

interface GitHubRoutesDeps {
  redisClient: RedisClientType;
  taskQueue: Queue;
  db: Knex;
  resolveMetadataToken?: typeof resolveGitHubMetadataToken;
  createMetadataOctokit?: (accessToken: string) => MetadataOctokit;
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
export async function handleAuthError(req: Request, res: Response): Promise<void> {
  console.warn('GitHub token expired or revoked, attempting token refresh');

  // Try to refresh the token before logging out
  const refreshResult = await refreshGitHubTokenWithResult(req, true);

  if (refreshResult.status === 'refreshed') {
    // Token was successfully refreshed, tell client to retry
    console.log('Token refresh successful, client should retry');
    res.status(401).json({
      error: 'Token refreshed',
      code: 'TOKEN_REFRESHED',
      message: 'Your GitHub token has been refreshed. Please retry your request.'
    });
    return;
  }

  if (refreshResult.status === 'temporarily-unavailable') {
    res.status(503).json({
      error: 'GitHub token refresh unavailable',
      code: 'GITHUB_TOKEN_REFRESH_UNAVAILABLE',
      message: 'GitHub authentication could not be refreshed right now. Please retry shortly.'
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
  const resolveMetadataToken = deps.resolveMetadataToken ?? resolveGitHubMetadataToken;
  const createMetadataOctokit = deps.createMetadataOctokit
    ?? ((accessToken: string) => new PaginatedOctokit({ auth: accessToken }));

  async function handleMetadataError(req: Request, res: Response, error: unknown): Promise<void> {
    if (error instanceof GitHubMetadataAuthorizationError) {
      sendGitHubMetadataAuthorizationError(error, res);
      return;
    }
    if (isAuthError(error)) {
      if (req.authenticationMethod === 'instance_token') await refreshRejectedGitHubMetadataToken(req, res);
      else await handleAuthError(req, res);
      return;
    }
    const status = (error as { status?: number })?.status;
    if (status === 403 || status === 404) {
      res.status(404).json({
        error: 'Repository not found or not accessible with your GitHub authorization',
        code: 'REPOSITORY_NOT_ACCESSIBLE',
      });
      return;
    }
    throw error;
  }

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
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unable to determine requesting user ID' });
        return;
      }
      const jobId = `import-tasks-${repository.replace('/', '-')}-${Date.now()}`;
      const correlationId = `${jobId}-${Math.random().toString(36).substring(2, 9)}`;
      const newJob = await taskQueue.add('processTaskImport', { taskDescription, repository, correlationId, userId, user: req.user?.username }, { jobId, removeOnComplete: { age: 24 * 3600, count: 100 }, removeOnFail: { age: 7 * 24 * 3600 } });
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
      if (isDemoMode()) {
        res.json({ repos: await loadDemoConfiguredRepoNames() });
        return;
      }

      const accessToken = await resolveMetadataToken(req);
      const octokit = createMetadataOctokit(accessToken);

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
      if (error instanceof GitHubMetadataAuthorizationError || isAuthError(error)) {
        await handleMetadataError(req, res, error);
        return;
      }
      console.error('Error in /api/github/repos:', error);
      res.status(500).json({ error: 'Failed to fetch repositories from GitHub' });
    }
  }

  async function getBranches(req: FlatRequest, res: Response): Promise<void> {
    try {
      const { owner, repo } = req.params;

      if (!owner || !repo) {
        res.status(400).json({ error: 'Owner and repo are required' });
        return;
      }

      if (isDemoMode()) {
        const metadata = await loadDemoRepositoryMetadata(`${owner}/${repo}`);
        if (!metadata) {
          res.status(404).json({ error: 'Repository is not configured in demo mode' });
          return;
        }
        res.json({ branches: metadata.branches, defaultBranch: metadata.defaultBranch });
        return;
      }

      const accessToken = await resolveMetadataToken(req);
      const octokit = createMetadataOctokit(accessToken);

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
        // Authentication failures need request-auth-specific handling in the
        // outer boundary (desktop grants must never clear a browser session).
        const status = (error as { status?: number })?.status;
        if (isAuthError(error) || status === 403 || status === 404) throw error;
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
      if (error instanceof GitHubMetadataAuthorizationError || isAuthError(error)
        || (error as { status?: number })?.status === 403 || (error as { status?: number })?.status === 404) {
        await handleMetadataError(req, res, error);
        return;
      }
      console.error('Error in /api/github/repos/:owner/:repo/branches:', error);
      res.status(500).json({ error: 'Failed to fetch branches from GitHub' });
    }
  }

  return { importTasks, getRepos, getBranches };
}
