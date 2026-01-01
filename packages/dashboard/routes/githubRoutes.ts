import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Queue } from 'bullmq';
import { Knex } from 'knex';

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

  async function getRepos(_req: Request, res: Response): Promise<void> {
    try {
      const distinctRepos = await db('tasks').distinct('repository').whereNotNull('repository').orderBy('repository', 'asc');
      // Filter out invalid repository names: null, empty, 'Unknown', and malformed names like 'undefined/undefined'
      const isValidRepoName = (r: string): boolean => {
        if (!r || r === 'Unknown') return false;
        // Must match owner/repo format with valid characters
        const parts = r.split('/');
        if (parts.length !== 2) return false;
        const [owner, name] = parts;
        // Both owner and name must be non-empty and not 'undefined'
        if (!owner || !name || owner === 'undefined' || name === 'undefined') return false;
        return true;
      };
      const repos = distinctRepos.map((row: { repository: string }) => row.repository).filter(isValidRepoName);
      res.json({ repos });
    } catch (error) {
      console.error('Error in /api/github/repos:', error);
      res.status(500).json({ error: 'Failed to fetch repositories with tasks' });
    }
  }

  return { importTasks, getRepos };
}
