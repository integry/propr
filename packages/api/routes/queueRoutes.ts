import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Queue } from 'bullmq';

interface QueueRoutesDeps {
  redisClient: RedisClientType;
  taskQueue: Queue;
}

export function createQueueRoutes(deps: QueueRoutesDeps) {
  const { redisClient, taskQueue } = deps;

  async function getQueueStats(_req: Request, res: Response): Promise<void> {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        taskQueue.getWaitingCount(),
        taskQueue.getActiveCount(),
        taskQueue.getCompletedCount(),
        taskQueue.getFailedCount(),
        taskQueue.getDelayedCount()
      ]);
      res.json({ waiting, active, completed, failed, delayed, total: waiting + active + completed + failed + delayed });
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
