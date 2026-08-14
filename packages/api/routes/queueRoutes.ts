import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Job, Queue } from 'bullmq';

interface LiveQueueJob {
  id: string;
  taskId: string;
  name: string;
  title: string;
  repository: string;
  createdAt: string;
}

interface QueueRoutesDeps {
  redisClient: RedisClientType;
  taskQueue: Queue;
}

export function createQueueRoutes(deps: QueueRoutesDeps) {
  const { redisClient, taskQueue } = deps;

  async function getQueueStats(_req: Request, res: Response): Promise<void> {
    try {
      // The header has always treated only active jobs as Running. Waiting and
      // delayed jobs remain separate queue statistics and are intentionally not
      // included in this presentation snapshot.
      const [waiting, activeJobs, completed, failed, delayed] = await Promise.all([
        taskQueue.getWaitingCount(),
        taskQueue.getJobs(['active']),
        taskQueue.getCompletedCount(),
        taskQueue.getFailedCount(),
        taskQueue.getDelayedCount()
      ]);
      const liveJobs = serializeLiveJobs(activeJobs);
      const active = liveJobs.length;
      res.json({
        waiting,
        active,
        activeJobs: liveJobs,
        completed,
        failed,
        delayed,
        total: waiting + active + completed + failed + delayed
      });
    } catch (error) {
      console.error('Error in /api/queue/stats:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function getActivity(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const activities = await redisClient.lRange('system:activity:log', offset, offset + limit - 1);
      const parsedActivities = activities.map((activity, index) => parseActivityLog(activity, index));
      res.json(parsedActivities);
    } catch (error) {
      console.error('Error in /api/activity:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function getMetrics(_req: Request, res: Response): Promise<void> {
    try {
      const jobsProcessed = parseInt(await redisClient.get('metrics:jobs:processed') || '0');
      const jobsFailed = parseInt(await redisClient.get('metrics:jobs:failed') || '0');
      const avgTime = parseFloat(await redisClient.get('metrics:jobs:avgTime') || '0');
      const totalJobs = jobsProcessed + jobsFailed;
      const successRate = totalJobs > 0 ? jobsProcessed / totalJobs : 1;
      const activeRepos = await redisClient.sMembers('active:repositories');
      const dailyStats = await getDailyStats(redisClient);

      res.json({
        totalIssuesProcessed: jobsProcessed,
        successRate,
        averageProcessingTime: avgTime,
        activeRepositories: activeRepos.length,
        dailyStats,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error in /api/metrics:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getQueueStats, getActivity, getMetrics };
}

function serializeLiveJobs(jobs: Job[]): LiveQueueJob[] {
  const seenIds = new Set<string>();
  const liveJobs: LiveQueueJob[] = [];

  for (const job of jobs) {
    const id = typeof job.id === 'string' ? job.id : undefined;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    const data = isRecord(job.data) ? job.data : {};
    const repository = getRepository(data);
    liveJobs.push({
      id,
      taskId: getNavigationTaskId(job.name, id, data),
      name: job.name,
      title: getJobTitle(job.name, data),
      repository,
      createdAt: new Date(job.timestamp).toISOString(),
    });
  }

  return liveJobs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function getRepository(data: Record<string, unknown>): string {
  const repository = nonEmptyString(data.repository);
  if (repository) return repository;
  const owner = nonEmptyString(data.repoOwner);
  const name = nonEmptyString(data.repoName);
  return owner && name ? `${owner}/${name}` : 'unknown/unknown';
}

function getNavigationTaskId(jobName: string, jobId: string, data: Record<string, unknown>): string {
  // Issue child jobs currently use a task-history ID derived from their queue
  // metadata. Reproduce that existing identity for navigation only; do not
  // persist or reconcile it with either queue or task history state.
  if (jobName !== 'processGitHubIssue' || data.isChildJob !== true) return jobId;
  const owner = nonEmptyString(data.repoOwner);
  const repo = nonEmptyString(data.repoName);
  const number = positiveNumber(data.number);
  const agent = nonEmptyString(data.agentAlias);
  const model = nonEmptyString(data.modelName);
  const correlationId = nonEmptyString(data.correlationId);
  return owner && repo && number && agent && model && correlationId
    ? `${owner}-${repo}-${number}-${agent}-${model}-${correlationId}`
    : jobId;
}

function getJobTitle(jobName: string, data: Record<string, unknown>): string {
  const explicitTitle = nonEmptyString(data.title);
  if (explicitTitle) return explicitTitle;

  const issuePayload = isRecord(data.issuePayload) ? data.issuePayload : undefined;
  const issueTitle = nonEmptyString(issuePayload?.title);
  if (issueTitle) return issueTitle;

  const pullRequestNumber = positiveNumber(data.pullRequestNumber);
  if (pullRequestNumber) {
    return jobName === 'processMergeConflict'
      ? `Resolve merge conflicts for PR #${pullRequestNumber}`
      : `Pull request #${pullRequestNumber}`;
  }

  const issueNumber = positiveNumber(data.number) ?? positiveNumber(data.issueNumber);
  if (issueNumber) return `Issue #${issueNumber}`;

  return nonEmptyString(data.taskDescription) || jobName;
}

function parseActivityLog(activity: string, index: number): Record<string, unknown> {
  try {
    const parsed = JSON.parse(activity) as Record<string, unknown>;
    return {
      id: parsed.id || `activity-${Date.now()}-${index}`,
      type: parsed.type || 'info',
      timestamp: parsed.timestamp || new Date().toISOString(),
      user: parsed.user,
      repository: parsed.repository,
      issueNumber: parsed.issueNumber,
      description: parsed.description || parsed.message || JSON.stringify(parsed),
      status: parsed.status || 'info'
    };
  } catch {
    return {
      id: `activity-${Date.now()}-${index}`,
      type: 'info',
      timestamp: new Date().toISOString(),
      description: activity.toString(),
      status: 'info'
    };
  }
}

async function getDailyStats(redisClient: RedisClientType): Promise<Array<Record<string, unknown>>> {
  const dailyStats = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateKey = date.toISOString().split('T')[0];
    const processed = parseInt(await redisClient.get(`metrics:daily:${dateKey}:processed`) || '0');
    const failed = parseInt(await redisClient.get(`metrics:daily:${dateKey}:failed`) || '0');
    dailyStats.push({ date: dateKey, processed, successful: processed - failed, failed });
  }
  return dailyStats;
}
