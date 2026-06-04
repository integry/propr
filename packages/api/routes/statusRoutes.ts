import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { isDemoMode } from '../demoMode.js';
import { AgentRegistry, ClaudeAgent, CodexAgent, GeminiAgent, VibeAgent, getIndexingQueue, loadAgents } from '@propr/core';
import type { Agent, AgentConfig } from '@propr/core';

interface StatusRoutesDeps {
  redisClient: RedisClientType;
}

type ServiceStatus = 'connected' | 'disconnected' | 'active' | 'queued' | 'idle' | 'failed' | 'unknown';

interface AgentStatus {
  id: string;
  type: AgentConfig['type'];
  alias: string;
  status: 'connected' | 'disconnected';
}

export function createStatusRoutes(deps: StatusRoutesDeps) {
  const { redisClient } = deps;

  async function getStatus(req: Request, res: Response): Promise<void> {
    try {
      // In demo mode, return all-green status
      if (isDemoMode()) {
        res.json({
          api: 'healthy',
          redis: 'connected',
          daemon: 'running',
          worker: 'running',
          workerCount: 3,
          githubAuth: 'connected',
          claudeAuth: 'connected',
          indexing: 'idle',
          agents: [{
            id: 'default-claude-agent',
            type: 'claude',
            alias: 'default',
            status: 'connected'
          }],
          timestamp: new Date().toISOString()
        });
        return;
      }

      const status: Record<string, unknown> = {
        api: 'healthy',
        redis: 'unknown',
        daemon: 'unknown',
        worker: 'unknown',
        githubAuth: 'unknown',
        claudeAuth: 'unknown',
        indexing: 'unknown',
        agents: [],
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

        const agents = await getAgentStatuses();
        status.agents = agents;
        status.claudeAuth = agents.some(agent => agent.type === 'claude' && agent.status === 'connected')
          ? 'connected'
          : await checkClaudeStatus(redisClient);
        status.indexing = await getIndexingStatus();
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

async function getAgentStatuses(): Promise<AgentStatus[]> {
  const registry = AgentRegistry.getInstance();
  await registry.ensureInitialized();

  const configuredAgents = await loadAgents();
  if (configuredAgents.length === 0) {
    return Promise.all(registry.getAllAgents().map(agent => buildRegisteredAgentStatus(agent)));
  }

  const registeredById = new Map(registry.getAllAgents().map(agent => [agent.config.id, agent]));
  const registeredByAlias = new Map(registry.getAllAgents().map(agent => [agent.config.alias, agent]));

  return Promise.all(configuredAgents
    .filter(agent => agent.enabled)
    .map(async (config) => {
      const registeredAgent = registeredById.get(config.id) ?? registeredByAlias.get(config.alias);
      if (!registeredAgent) {
        return buildRegisteredAgentStatus(createStatusAgent(config));
      }
      return buildRegisteredAgentStatus(registeredAgent);
    }));
}

function createStatusAgent(config: AgentConfig): Agent {
  switch (config.type) {
    case 'claude':
      return new ClaudeAgent(config);
    case 'codex':
      return new CodexAgent(config);
    case 'gemini':
      return new GeminiAgent(config);
    case 'vibe':
      return new VibeAgent(config);
    default:
      throw new Error(`Unknown agent type: ${config.type}`);
  }
}

async function buildRegisteredAgentStatus(agent: Agent): Promise<AgentStatus> {
  let healthy = false;
  try {
    healthy = await agent.healthCheck();
  } catch {
    healthy = false;
  }
  return {
    id: agent.config.id,
    type: agent.config.type,
    alias: agent.config.alias,
    status: healthy ? 'connected' : 'disconnected'
  };
}

async function getIndexingStatus(): Promise<ServiceStatus> {
  try {
    const indexingQueue = await getIndexingQueue();
    const counts = await indexingQueue.getJobCounts('active', 'waiting', 'delayed', 'failed');
    if ((counts.active ?? 0) > 0) return 'active';
    if ((counts.waiting ?? 0) > 0 || (counts.delayed ?? 0) > 0) return 'queued';
    if ((counts.failed ?? 0) > 0) return 'failed';
    return 'idle';
  } catch {
    return 'disconnected';
  }
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
