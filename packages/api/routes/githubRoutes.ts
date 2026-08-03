import { NextFunction, Request, Response } from 'express';
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
  getNotificationRepositoryEntitlementTtlMs,
  replaceNotificationRepositoryEntitlements
} from '@propr/core';

interface GitHubRoutesDeps {
  redisClient: RedisClientType;
  taskQueue: Queue;
  db: Knex;
}

const entitlementRefreshes = new Map<string, Promise<void>>();
const entitlementRefreshRetryAfter = new Map<string, number>();
const ENTITLEMENT_REFRESH_RETRY_DELAY_MS = 60_000;
const MAX_ENTITLEMENT_REFRESH_BACKOFFS = 1_000;

function recordEntitlementRefreshFailure(userId: string): void {
  if (!entitlementRefreshRetryAfter.has(userId)
      && entitlementRefreshRetryAfter.size >= MAX_ENTITLEMENT_REFRESH_BACKOFFS) {
    const oldestUserId = entitlementRefreshRetryAfter.keys().next().value as string | undefined;
    if (oldestUserId) entitlementRefreshRetryAfter.delete(oldestUserId);
  }
  entitlementRefreshRetryAfter.set(userId, Date.now() + ENTITLEMENT_REFRESH_RETRY_DELAY_MS);
}

async function listAccessibleRepositories(accessToken: string): Promise<string[]> {
  const PaginatedOctokit = Octokit.plugin(paginateRest);
  const octokit = new PaginatedOctokit({ auth: accessToken });
  const repositories: string[] = [];
  for await (const response of octokit.paginate.iterator('GET /user/repos', {
    per_page: 100,
    sort: 'full_name',
    direction: 'asc',
    affiliation: 'owner,collaborator,organization_member'
  })) {
    for (const repository of response.data) {
      if (repository.full_name) repositories.push(repository.full_name);
    }
  }
  return [...new Set(repositories)].sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase()));
}

async function notificationEntitlementsNeedRefresh(userId: string, database: Knex): Promise<boolean> {
  const latest = await database('notification_repository_entitlement_snapshots')
    .select('expires_at')
    .where({ user_id: userId })
    .first() as { expires_at?: string } | undefined;
  if (!latest?.expires_at) return true;
  const refreshBefore = Date.now() + Math.floor(getNotificationRepositoryEntitlementTtlMs() / 2);
  const expiresAt = Date.parse(latest.expires_at);
  return !Number.isFinite(expiresAt) || expiresAt <= refreshBefore;
}

export async function refreshNotificationRepositoryEntitlements(options: {
  userId: string;
  accessToken: string;
  database: Knex;
  force?: boolean;
  listRepositories?: (accessToken: string) => Promise<string[]>;
}): Promise<void> {
  const existing = entitlementRefreshes.get(options.userId);
  if (existing) return existing;
  const retryAfter = entitlementRefreshRetryAfter.get(options.userId) ?? 0;
  if (!options.force && retryAfter > Date.now()) return;
  if (retryAfter > 0) entitlementRefreshRetryAfter.delete(options.userId);
  const refresh = (async () => {
    if (!options.force && !await notificationEntitlementsNeedRefresh(options.userId, options.database)) return;
    const repositories = await (options.listRepositories ?? listAccessibleRepositories)(options.accessToken);
    await replaceNotificationRepositoryEntitlements({
      userId: options.userId,
      repositories,
      database: options.database
    });
  })();
  entitlementRefreshes.set(options.userId, refresh);
  try {
    await refresh;
    entitlementRefreshRetryAfter.delete(options.userId);
  } catch (error) {
    recordEntitlementRefreshFailure(options.userId);
    throw error;
  } finally {
    if (entitlementRefreshes.get(options.userId) === refresh) {
      entitlementRefreshes.delete(options.userId);
    }
  }
}

export async function persistNotificationRepositoryEntitlementsBestEffort(options: {
  userId: string;
  repositories: readonly string[];
  database: Knex;
}): Promise<boolean> {
  try {
    await replaceNotificationRepositoryEntitlements(options);
    return true;
  } catch (error) {
    // Repository browsing remains available. Notification delivery stays
    // fail-closed because no new authorization snapshot was committed.
    console.warn('Failed to persist repository notification access:',
      error instanceof Error ? error.message : String(error));
    return false;
  }
}

interface NotificationEntitlementRefreshMiddlewareOptions {
  refresh?: typeof refreshNotificationRepositoryEntitlements;
}

/** Schedules authorization refresh without adding GitHub latency to API traffic. */
export function createNotificationEntitlementRefreshMiddleware(
  database: Knex,
  options: NotificationEntitlementRefreshMiddlewareOptions = {}
) {
  const refresh = options.refresh ?? refreshNotificationRepositoryEntitlements;
  return (req: Request, _res: Response, next: NextFunction): void => {
    const userId = req.user?.id;
    const accessToken = req.user?.accessToken;
    // getRepos performs a forced refresh using the same GitHub response, avoiding
    // a duplicate paginated request on this route.
    if (!userId || !accessToken || req.path === '/github/repos') {
      next();
      return;
    }
    void refresh({ userId, accessToken, database }).catch((error) => {
      console.warn('Failed to refresh repository notification access:',
        error instanceof Error ? error.message : String(error));
    });
    next();
  };
}

async function clearNotificationRepositoryEntitlements(userId: string | undefined, database: Knex): Promise<void> {
  if (!userId) return;
  try {
    await database.transaction(async (transaction) => {
      await transaction('notification_repository_entitlements').where({ user_id: userId }).delete();
      await transaction('notification_repository_entitlement_snapshots').where({ user_id: userId }).delete();
    });
  } catch (error) {
    console.warn('Failed to clear cached repository notification access:',
      error instanceof Error ? error.message : String(error));
  }
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
  const { redisClient, taskQueue, db } = deps;

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
        await clearNotificationRepositoryEntitlements(userId, db);
        res.status(401).json({ error: 'No GitHub access token available', code: 'NO_TOKEN' });
        return;
      }

      const repos = await listAccessibleRepositories(accessToken);
      await persistNotificationRepositoryEntitlementsBestEffort({
        userId,
        repositories: repos,
        database: db
      });

      res.json({ repos });
    } catch (error) {
      // Check if this is a token expiration/revocation error
      if (isAuthError(error)) {
        await clearNotificationRepositoryEntitlements(req.user?.id, db);
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
        await clearNotificationRepositoryEntitlements(req.user?.id, db);
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
          await clearNotificationRepositoryEntitlements(req.user?.id, db);
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
        await clearNotificationRepositoryEntitlements(req.user?.id, db);
        await handleAuthError(req, res);
        return;
      }
      console.error('Error in /api/github/repos/:owner/:repo/branches:', error);
      res.status(500).json({ error: 'Failed to fetch branches from GitHub' });
    }
  }

  return { importTasks, getRepos, getBranches };
}
