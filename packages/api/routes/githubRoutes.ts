import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Queue } from 'bullmq';
import { Knex } from 'knex';
import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { RequestError } from '@octokit/request-error';
import { refreshGitHubTokenWithResult } from '../authGithubTokens.js';
import { clearSessionCookie } from '../auth.js';
import { getSessionAuthGeneration } from '../authSessionGeneration.js';
import { isDemoMode } from '../demoMode.js';
import { loadDemoConfiguredRepoNames, loadDemoRepositoryMetadata } from './demoRepositoryMetadata.js';
import { logger, withNotificationDeadline } from '@propr/core';
import {
  invalidateNotificationRepositoryEntitlements,
  listAccessibleRepositories,
  refreshNotificationRepositoryEntitlements,
} from './notificationEntitlementRefresh.js';
export {
  createNotificationEntitlementRefreshMiddleware,
  persistNotificationRepositoryEntitlementsBestEffort,
  refreshNotificationRepositoryEntitlements,
} from './notificationEntitlementRefresh.js';

interface GitHubRoutesDeps {
  redisClient: RedisClientType;
  taskQueue: Queue;
  db: Knex;
  invalidateNotificationEntitlements?: (userId: string, authGeneration: string) => Promise<void>;
  refreshNotificationEntitlements?: typeof refreshNotificationRepositoryEntitlements;
  listNotificationRepositories?: typeof listAccessibleRepositories;
}

const AUTH_ENTITLEMENT_INVALIDATION_TIMEOUT_MS = 5_000;

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
export async function handleAuthError(
  req: Request,
  res: Response,
  invalidateEntitlements?: (userId: string, authGeneration: string) => Promise<void>
): Promise<void> {
  logger.warn('GitHub token expired or revoked; attempting token refresh');

  // Try to refresh the token before logging out
  const refreshResult = await refreshGitHubTokenWithResult(req, true);

  if (refreshResult.status === 'refreshed') {
    // Token was successfully refreshed, tell client to retry
    logger.info('GitHub token refresh succeeded; client should retry');
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
  logger.warn('GitHub token refresh failed; clearing session for re-authentication');
  const userId = req.user?.id;
  try {
    if (userId && invalidateEntitlements) {
      await withNotificationDeadline(
        invalidateEntitlements(userId, getSessionAuthGeneration(req)),
        AUTH_ENTITLEMENT_INVALIDATION_TIMEOUT_MS,
        'persisting notification entitlement invalidation after GitHub auth error'
      );
    }
  } catch (error) {
    logger.warn({ userId, error: error instanceof Error ? error.message : String(error) },
      'Could not persist repository notification access invalidation');
    res.status(503).json({
      error: 'Session cleanup unavailable',
      code: 'AUTH_CLEANUP_UNAVAILABLE',
      message: 'Authorization cleanup could not be persisted. Please retry.',
    });
    return;
  }

  await new Promise<void>((resolve) => {
    req.logout((err) => {
      if (err) logger.error({ error: err.message }, 'Passport logout failed after GitHub auth error');
      req.session.destroy((destroyErr) => {
        if (destroyErr) {
          logger.error({ error: destroyErr.message },
            'Session destruction failed after GitHub auth error');
        }
        resolve();
      });
    });
  });
  clearSessionCookie(res);

  res.status(401).json({
    error: 'GitHub authentication expired',
    code: 'TOKEN_EXPIRED',
    message: 'Your GitHub session has expired. Please log in again.'
  });
}

export function createGitHubRoutes(deps: GitHubRoutesDeps) {
  const { redisClient, taskQueue, db } = deps;
  const invalidateEntitlements = deps.invalidateNotificationEntitlements
    ?? (async (userId: string, authGeneration: string) => {
      await invalidateNotificationRepositoryEntitlements(db, userId, authGeneration);
    });
  const refreshNotificationEntitlements = deps.refreshNotificationEntitlements
    ?? refreshNotificationRepositoryEntitlements;
  const listNotificationRepositories = deps.listNotificationRepositories
    ?? listAccessibleRepositories;

  async function invalidateEntitlementsOrRespond(req: Request, res: Response): Promise<boolean> {
    const userId = req.user?.id;
    if (!userId) return true;
    try {
      await invalidateEntitlements(userId, getSessionAuthGeneration(req));
      return true;
    } catch (error) {
      logger.warn({ userId, error: error instanceof Error ? error.message : String(error) },
        'Could not persist repository notification access invalidation');
      res.status(503).json({
        error: 'Session cleanup unavailable',
        code: 'AUTH_CLEANUP_UNAVAILABLE',
        message: 'Authorization cleanup could not be persisted. Please retry.',
      });
      return false;
    }
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
      const jobId = `import-tasks-${repository.replace('/', '-')}-${Date.now()}`;
      const correlationId = `${jobId}-${Math.random().toString(36).substring(2, 9)}`;
      const newJob = await taskQueue.add('processTaskImport', { taskDescription, repository, correlationId, user: req.user?.username }, { jobId, removeOnComplete: { age: 24 * 3600, count: 100 }, removeOnFail: { age: 7 * 24 * 3600 } });
      await redisClient.lPush('system:activity:log', JSON.stringify({ id: `activity-${Date.now()}-${jobId}`, type: 'task_import', timestamp: new Date().toISOString(), user: req.user?.username, repository, description: `Task import job created for ${repository}`, status: 'pending' }));
      await redisClient.lTrim('system:activity:log', 0, 999);
      logger.info({ jobId, repository }, 'Created task import job');
      res.json({ jobId: newJob.id });
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) },
        'Task import route failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function getRepos(req: Request, res: Response): Promise<void> {
    try {
      if (isDemoMode()) {
        res.json({ repos: await loadDemoConfiguredRepoNames() });
        return;
      }

      // Get user's access token from session
      const accessToken = req.user?.accessToken;
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (!accessToken) {
        if (!await invalidateEntitlementsOrRespond(req, res)) return;
        res.status(401).json({ error: 'No GitHub access token available', code: 'NO_TOKEN' });
        return;
      }

      let repos: string[] = [];
      let repositoriesScanned = false;
      try {
        const refreshed = await refreshNotificationEntitlements({
          userId,
          accessToken,
          database: db,
          force: true,
          listRepositories: async (token, signal) => {
            repos = await listNotificationRepositories(token, signal);
            repositoriesScanned = true;
            return repos;
          },
        });
        if (!refreshed && !repositoriesScanned) {
          res.status(503).json({
            error: 'Repository entitlement refresh unavailable',
            code: 'ENTITLEMENT_REFRESH_UNAVAILABLE',
            message: 'Repository access could not be refreshed. Please retry shortly.'
          });
          return;
        }
        if (!refreshed) {
          logger.warn({ userId },
            'Repository scan completed after losing its entitlement persistence fence');
        }
      } catch (error) {
        // Keep repository browsing available when the GitHub scan succeeded but
        // durable entitlement bookkeeping failed. Delivery remains fail-closed.
        if (!repositoriesScanned) throw error;
        logger.warn({ error: error instanceof Error ? error.message : String(error) },
          'Failed to persist repository notification access');
      }

      res.json({ repos });
    } catch (error) {
      // Check if this is a token expiration/revocation error
      if (isAuthError(error)) {
        await handleAuthError(req, res, invalidateEntitlements);
        return;
      }
      logger.error({ error: error instanceof Error ? error.message : String(error) },
        'GitHub repositories route failed');
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

      if (isDemoMode()) {
        const metadata = await loadDemoRepositoryMetadata(`${owner}/${repo}`);
        if (!metadata) {
          res.status(404).json({ error: 'Repository is not configured in demo mode' });
          return;
        }
        res.json({ branches: metadata.branches, defaultBranch: metadata.defaultBranch });
        return;
      }

      // Get user's access token from session
      const accessToken = req.user?.accessToken;
      if (!accessToken) {
        if (req.user?.id
            && !await invalidateEntitlementsOrRespond(req, res)) return;
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
          await handleAuthError(req, res, invalidateEntitlements);
          return;
        }
        logger.warn({ owner, repo, error: error instanceof Error ? error.message : String(error) },
          'Could not load repository default branch');
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
        await handleAuthError(req, res, invalidateEntitlements);
        return;
      }
      logger.error({ error: error instanceof Error ? error.message : String(error) },
        'GitHub repository branches route failed');
      res.status(500).json({ error: 'Failed to fetch branches from GitHub' });
    }
  }

  return { importTasks, getRepos, getBranches };
}
