import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { isDemoMode } from '../demoMode.js';
import {
  AgentRegistry,
  getIndexingQueue as loadIndexingQueue,
  loadAgents as loadAgentConfigs,
  loadSummarizationRuntimeState
} from '@propr/core';
import type { Agent, AgentConfig } from '@propr/core';
import path from 'node:path';
import os from 'node:os';

interface StatusRoutesDeps {
  redisClient: RedisClientType;
  agentRegistry?: StatusAgentRegistry;
  loadAgents?: () => Promise<AgentConfig[]>;
  getIndexingQueue?: () => Promise<IndexingStatusQueue>;
  agentStatusCacheTtlMs?: number;
  agentHealthTimeoutMs?: number;
  now?: () => number;
  loadSummarizationRuntimeState?: typeof loadSummarizationRuntimeState;
}

interface IndexingStatusQueue {
  getJobCounts(...statuses: Array<'active' | 'waiting' | 'delayed' | 'failed'>): Promise<Record<string, number>>;
}

type StatusAgentRegistry = Pick<AgentRegistry, 'ensureInitialized' | 'getAllAgents' | 'getAgentById' | 'getAgentByAlias'> & {
  createAgentFromConfig(config: AgentConfig): Agent;
};

type ServiceStatus = 'connected' | 'disconnected' | 'active' | 'queued' | 'idle' | 'failed' | 'unknown';

interface AgentStatus {
  id: string;
  type: AgentConfig['type'];
  alias: string;
  status: 'connected' | 'disconnected';
}

export function createStatusRoutes(deps: StatusRoutesDeps) {
  const {
    redisClient,
    agentRegistry = AgentRegistry.getInstance() as StatusAgentRegistry,
    loadAgents = loadAgentConfigs,
    getIndexingQueue = loadIndexingQueue,
    agentStatusCacheTtlMs = 5000,
    agentHealthTimeoutMs = 1500,
    now = Date.now,
    loadSummarizationRuntimeState: loadSummarizationRuntimeStateDep = loadSummarizationRuntimeState
  } = deps;
  let agentStatusCache: { expiresAt: number; statuses: AgentStatus[] } | undefined;

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
          warnings: [],
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
        warnings: [],
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

      const agents = await getCachedAgentStatuses();
      status.agents = agents;
      status.claudeAuth = agents.some(agent => agent.type === 'claude' && agent.status === 'connected')
        ? 'connected'
        : 'disconnected';
      status.indexing = await getIndexingStatus(getIndexingQueue);
      status.warnings = await getSystemWarnings(loadSummarizationRuntimeStateDep);

      res.json(status);
    } catch (error) {
      console.error('Error in /api/status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getStatus };

  async function getCachedAgentStatuses(): Promise<AgentStatus[]> {
    const currentTime = now();
    if (agentStatusCache && agentStatusCache.expiresAt > currentTime) {
      return agentStatusCache.statuses;
    }

    const statuses = await getAgentStatuses(loadAgents, agentRegistry, agentHealthTimeoutMs);
    agentStatusCache = {
      statuses,
      expiresAt: currentTime + agentStatusCacheTtlMs
    };
    return statuses;
  }
}

async function getSystemWarnings(loadRuntimeState: typeof loadSummarizationRuntimeState): Promise<Array<{ type: string; message: string }>> {
  try {
    const state = await loadRuntimeState();
    const warnings: Array<{ type: string; message: string }> = [];
    const maxCooldownWarnings = 5;
    if (state.warning && state.warning.mode !== 'cooldown') {
      warnings.push({ type: `summarization_${state.warning.mode}`, message: state.warning.message });
    }
    // Surface the soonest-expiring cooldowns first so operators see what will
    // resume next; the rest are summarized in the overflow warning below.
    const cooldowns = Object.values(state.cooldowns || {})
      .sort((left, right) => Date.parse(left.until) - Date.parse(right.until));
    for (const cooldown of cooldowns.slice(0, maxCooldownWarnings)) {
      warnings.push({
        type: 'summarization_cooldown',
        message: `${cooldown.repository} (${cooldown.branch}) summarization is paused until ${formatCooldownUntil(cooldown.until)}: ${cooldown.reason}`
      });
    }
    if (cooldowns.length > maxCooldownWarnings) {
      warnings.push({
        type: 'summarization_cooldown_summary',
        message: `${cooldowns.length - maxCooldownWarnings} additional repositories are in summarization cooldown.`
      });
    }
    return warnings;
  } catch (error) {
    console.error('Error loading summarization warnings:', error);
    return [];
  }
}

function formatCooldownUntil(until: string): string {
  const parsed = new Date(until);
  if (Number.isNaN(parsed.getTime())) return until;
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short'
  });
}

async function getAgentStatuses(
  loadAgents: () => Promise<AgentConfig[]>,
  registry: StatusAgentRegistry,
  healthTimeoutMs: number
): Promise<AgentStatus[]> {
  let configuredAgents: AgentConfig[];
  try {
    configuredAgents = await loadAgents();
  } catch (error) {
    console.error('Error loading agent status configuration:', error);
    return [];
  }

  try {
    await registry.ensureInitialized();
  } catch (error) {
    console.error('Error initializing agent registry for status:', error);
  }

  if (configuredAgents.length === 0) {
    const defaultAgent = registry.getAgentById('default-claude-agent') ?? registry.getAgentByAlias('default');
    if (defaultAgent?.config.type === 'claude') {
      return [await buildRegisteredAgentStatus(defaultAgent, healthTimeoutMs)];
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
        return buildConfiguredAgentStatus(config, registry, healthTimeoutMs);
      }
      return buildRegisteredAgentStatus(registeredAgent, healthTimeoutMs);
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
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001'
    ],
    defaultModel: process.env.CLAUDE_MODEL || undefined
  };
}

async function buildConfiguredAgentStatus(
  config: AgentConfig,
  registry: StatusAgentRegistry,
  healthTimeoutMs: number
): Promise<AgentStatus> {
  try {
    return await buildRegisteredAgentStatus(registry.createAgentFromConfig(config), healthTimeoutMs);
  } catch (error) {
    console.error('Error checking configured agent status:', error);
    return buildDisconnectedAgentStatus(config);
  }
}

async function buildRegisteredAgentStatus(agent: Agent, healthTimeoutMs: number): Promise<AgentStatus> {
  let healthy = false;
  try {
    healthy = await withTimeout(agent.healthCheck(), healthTimeoutMs, false);
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>(resolve => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildDisconnectedAgentStatus(config: AgentConfig): AgentStatus {
  return {
    id: config.id,
    type: config.type,
    alias: config.alias,
    status: 'disconnected'
  };
}

async function getIndexingStatus(getIndexingQueue: () => Promise<IndexingStatusQueue>): Promise<ServiceStatus> {
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
