import { Request, Response } from 'express';
import { RedisClientType } from 'redis';

interface StatusRoutesDeps {
  redisClient: RedisClientType;
}

export function createStatusRoutes(deps: StatusRoutesDeps) {
  const { redisClient } = deps;

  async function getStatus(req: Request, res: Response): Promise<void> {
    try {
      const status: Record<string, unknown> = {
        api: 'healthy',
        redis: 'unknown',
        daemon: 'unknown',
        worker: 'unknown',
        githubAuth: 'unknown',
        claudeAuth: 'unknown',
        timestamp: new Date().toISOString()
      };
      
      try {
        await redisClient.ping();
        status.redis = 'connected';
        
        const daemonHeartbeat = await redisClient.get('system:status:daemon');
        status.daemon = (daemonHeartbeat && Date.now() - parseInt(daemonHeartbeat) < 120000) ? 'running' : 'stopped';
        
        const activeWorkers = await redisClient.sCard('system:status:workers');
        status.worker = activeWorkers > 0 ? 'running' : 'stopped';
        status.workerCount = activeWorkers;
        
        const githubAppConfigured = process.env.GH_APP_ID && 
                                   process.env.GH_PRIVATE_KEY_PATH && 
                                   process.env.GH_INSTALLATION_ID;
        status.githubAuth = githubAppConfigured ? 'connected' : 'disconnected';
        
        status.claudeAuth = await checkClaudeStatus(redisClient);
      } catch {
        status.redis = 'disconnected';
      }
      
      res.json(status);
    } catch (error) {
      console.error('Error in /api/status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getStatus };
}

async function checkClaudeStatus(redisClient: RedisClientType): Promise<string> {
  try {
    const recentActivity = await redisClient.lRange('system:activity:log', 0, 20);
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    for (const activityStr of recentActivity) {
      try {
        const activity = JSON.parse(activityStr) as { type?: string; status?: string; id?: string; timestamp?: string };
        const isClaudeActivity = activity.type === 'issue_processed' && 
            activity.status === 'success' &&
            activity.id && activity.id.includes('claude-');
        const isRecent = new Date(activity.timestamp || '').getTime() > oneHourAgo;
        if (isClaudeActivity && isRecent) {
          return 'connected';
        }
      } catch {
        continue;
      }
    }
  } catch (err) {
    console.error('Error checking Claude status:', err);
  }
  return 'disconnected';
}
