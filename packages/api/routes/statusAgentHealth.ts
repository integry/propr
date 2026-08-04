import path from 'node:path';
import os from 'node:os';
import { AGENT_DEFAULTS } from '@propr/shared';
import {
  logger,
  type Agent,
  type AgentConfig,
  type AgentRegistry,
  type AgentRegistryOperationalStatus,
} from '@propr/core';

export type StatusAgentRegistry =
  Pick<AgentRegistry, 'ensureInitialized' | 'getAllAgents'> & {
    createAgentFromConfig(config: AgentConfig): Agent;
    getOperationalStatus?: () => AgentRegistryOperationalStatus;
  };

export interface AgentStatus {
  id: string;
  type: AgentConfig['type'];
  alias: string;
  status: 'connected' | 'disconnected';
}

export async function getAgentStatuses(
  loadAgents: () => Promise<AgentConfig[]>,
  registry: StatusAgentRegistry,
  healthTimeoutMs: number
): Promise<AgentStatus[]> {
  let configuredAgents: AgentConfig[] | undefined;
  try {
    configuredAgents = await loadAgents();
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) },
      'Error loading agent status configuration');
  }

  let registeredAgents: Agent[] = [];
  let registryAvailable = false;
  try {
    await registry.ensureInitialized();
    // Capture one internally consistent registry view. Some implementations can
    // still throw from reads while initialization/runtime health is degraded.
    registeredAgents = registry.getAllAgents();
    registryAvailable = true;
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) },
      'Error reading agent registry for status');
  }

  if (configuredAgents === undefined) {
    return registryAvailable
      ? Promise.all(registeredAgents
        .filter(agent => agent.config.enabled)
        .map(agent => buildRegisteredAgentStatus(agent, healthTimeoutMs)))
      : [];
  }

  if (!registryAvailable) {
    return configuredAgents.length === 0
      ? [buildDisconnectedAgentStatus(getDefaultClaudeConfig())]
      : configuredAgents.filter(agent => agent.enabled).map(buildDisconnectedAgentStatus);
  }

  if (configuredAgents.length === 0) {
    const defaultAgent = registeredAgents.find(agent =>
      agent.config.id === 'default-claude-agent' || agent.config.alias === 'default');
    if (defaultAgent?.config.type === 'claude') {
      return [await buildRegisteredAgentStatus(defaultAgent, healthTimeoutMs)];
    }
    return [buildDisconnectedAgentStatus(getDefaultClaudeConfig())];
  }

  const registeredById = new Map(registeredAgents.map(agent => [agent.config.id, agent]));
  const registeredByAlias = new Map(
    registeredAgents.map(agent => [agent.config.alias, agent])
  );
  return Promise.all(configuredAgents.filter(agent => agent.enabled).map(async (config) => {
    const registeredAgent = registeredById.get(config.id) ?? registeredByAlias.get(config.alias);
    return registeredAgent
      ? buildRegisteredAgentStatus(registeredAgent, healthTimeoutMs)
      : buildConfiguredAgentStatus(config, registry, healthTimeoutMs);
  }));
}

function getDefaultClaudeConfig(): AgentConfig {
  return {
    id: 'default-claude-agent',
    type: 'claude',
    alias: 'default',
    enabled: true,
    dockerImage: process.env.AGENT_DOCKER_IMAGE || 'propr/agent:latest',
    configPath: process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude'),
    supportedModels: [...AGENT_DEFAULTS.claude.defaultModels],
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
    logger.error({
      agentId: config.id,
      error: error instanceof Error ? error.message : String(error)
    }, 'Error checking configured agent status');
    return buildDisconnectedAgentStatus(config);
  }
}

async function buildRegisteredAgentStatus(
  agent: Agent,
  healthTimeoutMs: number
): Promise<AgentStatus> {
  const healthy = await withTimeout(agent.healthCheck(), healthTimeoutMs, false);
  return {
    id: agent.config.id,
    type: agent.config.type,
    alias: agent.config.alias,
    status: healthy ? 'connected' : 'disconnected'
  };
}

async function withTimeout<T, F>(promise: Promise<T>, timeoutMs: number, fallback: F): Promise<T | F> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<F>(resolve => { timeout = setTimeout(() => resolve(fallback), timeoutMs); })
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
