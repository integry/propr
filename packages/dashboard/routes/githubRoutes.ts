import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Queue } from 'bullmq';
import { Knex } from 'knex';
import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';

interface GitHubRoutesDeps {
  redisClient: RedisClientType;
  taskQueue: Queue;
  db: Knex;
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
      // Get user's access token from session
      const accessToken = req.user?.accessToken;
      if (!accessToken) {
        res.status(401).json({ error: 'No GitHub access token available' });
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
      console.error('Error in /api/github/repos:', error);
      res.status(500).json({ error: 'Failed to fetch repositories from GitHub' });
    }
  }

  return { importTasks, getRepos };
}
