import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { isDemoMode } from '../demoMode.js';
import { AgentRegistry, ClaudeAgent, CodexAgent, GeminiAgent, VibeAgent, getIndexingQueue, loadAgents } from '@propr/core';
import type { Agent, AgentConfig } from '@propr/core';
import path from 'node:path';
import os from 'node:os';

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
      } catch {
        status.redis = 'disconnected';
      }

      const githubAppConfigured = process.env.GH_APP_ID &&
                                 process.env.GH_PRIVATE_KEY_PATH &&
                                 process.env.GH_INSTALLATION_ID;
      status.githubAuth = githubAppConfigured ? 'connected' : 'disconnected';

      const agents = await getAgentStatuses();
      status.agents = agents;
      status.claudeAuth = agents.some(agent => agent.type === 'claude' && agent.status === 'connected')
        ? 'connected'
        : 'disconnected';
      status.indexing = await getIndexingStatus();

      res.json(status);
    } catch (error) {
      console.error('Error in /api/status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getStatus };
}

async function getAgentStatuses(): Promise<AgentStatus[]> {
  let configuredAgents: AgentConfig[];
  try {
    configuredAgents = await loadAgents();
  } catch (error) {
    console.error('Error loading agent status configuration:', error);
    return [];
  }

  const registry = AgentRegistry.getInstance();
  try {
    await registry.ensureInitialized();
  } catch (error) {
    console.error('Error initializing agent registry for status:', error);
  }

  if (configuredAgents.length === 0) {
    const defaultAgent = registry.getAgentById('default-claude-agent') ?? registry.getAgentByAlias('default');
    if (defaultAgent?.config.type === 'claude') {
      return [await buildRegisteredAgentStatus(defaultAgent)];
    }
    return [buildDisconnectedAgentStatus(getDefaultClaudeConfig())];
  }

  const registeredById = new Map(registry.getAllAgents().map(agent => [agent.config.id, agent]));
  const registeredByAlias = new Map(registry.getAllAgents().map(agent => [agent.config.alias, agent]));

  return Promise.all(configuredAgents
    .filter(agent => agent.enabled)
    .map(async (config) => {
      const registeredAgent = registeredById.get(config.id) ?? registeredByAlias.get(config.alias);
      if (!registeredAgent) {
        return buildConfiguredAgentStatus(config);
      }
      return buildRegisteredAgentStatus(registeredAgent);
    }));
}

function getDefaultClaudeConfig(): AgentConfig {
  return {
    id: 'default-claude-agent',
    type: 'claude',
    alias: 'default',
    enabled: true,
    dockerImage: process.env.CLAUDE_DOCKER_IMAGE || 'propr/agent-claude:latest',
    configPath: process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude'),
    supportedModels: [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001'
    ],
    defaultModel: process.env.CLAUDE_MODEL || undefined
  };
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

async function buildConfiguredAgentStatus(config: AgentConfig): Promise<AgentStatus> {
  try {
    return await buildRegisteredAgentStatus(createStatusAgent(config));
  } catch (error) {
    console.error('Error checking configured agent status:', error);
    return buildDisconnectedAgentStatus(config);
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

function buildDisconnectedAgentStatus(config: AgentConfig): AgentStatus {
  return {
    id: config.id,
    type: config.type,
    alias: config.alias,
    status: 'disconnected'
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
