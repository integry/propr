import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import * as configManager from '@propr/core';
import {
    AgentRegistry,
    resolveVersion,
    computeContentHash,
    generateImageTag,
    AGENT_DEFAULT_VERSIONS
} from '@propr/core';
import type { CliVersionType, AgentType, AgentConfig } from '@propr/core';
import { withConfigLock, validateAgentsConfig, SETTINGS_CONFIG_LOCK_KEY, type ConfigLockContext } from './configHelpers.js';

interface AgentsRoutesDeps {
  redisClient: RedisClientType;
  publishConfigUpdate: (subtype: string) => Promise<void>;
  logActivityHelper: (description: string, idSuffix: string, type: string, username?: string) => Promise<void>;
}

interface AgentConfigStore {
  loadAgents: typeof configManager.loadAgents;
  loadSettings: typeof configManager.loadSettings;
  saveAgents: typeof configManager.saveAgents;
  saveSettings: typeof configManager.saveSettings;
}

interface AgentRegistrySync {
  refresh: () => Promise<void>;
  setDefaultAgentAlias: (alias: string | null) => void;
}

interface ApplyAgentsUpdateParams {
  agents: AgentConfig[];
  username?: string;
  publishConfigUpdate: AgentsRoutesDeps['publishConfigUpdate'];
  logActivityHelper: AgentsRoutesDeps['logActivityHelper'];
  configStore?: AgentConfigStore;
  registry?: AgentRegistrySync;
  lock?: ConfigLockContext;
}

interface RollbackAgentConfigStateParams {
  configStore: AgentConfigStore;
  registry: AgentRegistrySync;
  previousAgents: AgentConfig[];
  currentDefault: string | undefined;
  defaultChanged: boolean;
}

async function rollbackAgentConfigState({
  configStore,
  registry,
  previousAgents,
  currentDefault,
  defaultChanged
}: RollbackAgentConfigStateParams): Promise<boolean> {
  try {
    await configStore.saveAgents(previousAgents);
    if (defaultChanged) {
      await configStore.saveSettings({ default_agent_alias: currentDefault } as Record<string, unknown>);
    }
    await registry.refresh();
    registry.setDefaultAgentAlias(currentDefault ?? null);
    return true;
  } catch (rollbackError) {
    console.error('Failed to roll back agent configuration after agents update failure:', rollbackError);
    return false;
  }
}

export async function applyAgentsUpdate({
  agents,
  username,
  publishConfigUpdate,
  logActivityHelper,
  configStore = configManager,
  registry = AgentRegistry.getInstance(),
  lock
}: ApplyAgentsUpdateParams): Promise<{ status: number; body: Record<string, unknown> }> {
  const validationError = validateAgentsConfig(agents);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }

  const processedAgents: AgentConfig[] = [];
  for (const agent of agents) {
    const processedAgent = { ...agent };

    if (agent.cliVersionType) {
      try {
        const agentType = agent.type as AgentType;
        const versionType = agent.cliVersionType as CliVersionType;
        const resolvedVersion = await resolveVersion(agentType, versionType, agent.cliVersion);
        processedAgent.cliVersionResolved = resolvedVersion;
        processedAgent.dockerImage = generateImageTag(agentType, resolvedVersion, computeContentHash(agentType));
      } catch (versionError) {
        console.warn(`Failed to resolve version for agent ${agent.alias}:`, versionError);
      }
    } else {
      const agentType = agent.type as AgentType;
      processedAgent.cliVersionType = 'default';
      processedAgent.cliVersionResolved = AGENT_DEFAULT_VERSIONS[agentType];
    }

    processedAgents.push(processedAgent);
  }

  const previousAgents = await configStore.loadAgents();
  const settings = await configStore.loadSettings();
  const currentDefault = ((settings as Record<string, unknown>).default_agent_alias as string | undefined) ?? undefined;
  const enabledAgents = processedAgents.filter((a: { enabled: boolean }) => a.enabled);

  let newDefault = currentDefault;
  if (enabledAgents.length === 0) {
    newDefault = undefined;
  } else if (!currentDefault || !enabledAgents.some((a: { alias: string }) => a.alias === currentDefault)) {
    newDefault = enabledAgents[0].alias;
  }

  try {
    await lock?.assertLockHeld();
    await configStore.saveAgents(processedAgents);
    if (newDefault !== currentDefault) {
      await lock?.assertLockHeld();
      await configStore.saveSettings({ default_agent_alias: newDefault } as Record<string, unknown>);
    }
  } catch (syncError) {
    await rollbackAgentConfigState({
      configStore,
      registry,
      previousAgents,
      currentDefault,
      defaultChanged: newDefault !== currentDefault
    });
    console.error('Failed to sync default agent alias after agents update:', syncError);
    throw syncError;
  }

  try {
    await registry.refresh();
    registry.setDefaultAgentAlias(newDefault ?? null);
  } catch (refreshError) {
    const rollbackSucceeded = await rollbackAgentConfigState({
      configStore,
      registry,
      previousAgents,
      currentDefault,
      defaultChanged: newDefault !== currentDefault
    });
    console.error('Failed to refresh agent registry after agents update:', refreshError);
    if (!rollbackSucceeded) {
      return {
        status: 500,
        body: {
          error: 'Failed to apply agent configuration to the live registry, and automatic rollback did not complete. Persisted config may be out of sync with the live registry.',
          out_of_sync: true
        }
      };
    }
    return { status: 500, body: { error: 'Failed to apply agent configuration to the live registry' } };
  }

  await publishConfigUpdate('agents_update');
  if (newDefault !== currentDefault) {
    await publishConfigUpdate('settings_update');
  }
  try {
    await logActivityHelper(`Updated agents configuration (${processedAgents.length} agents)`, 'agents-update', 'agents_updated', username);
  } catch (error) {
    console.error('Failed to log agents configuration update activity:', error);
  }

  return { status: 200, body: { success: true, agents: processedAgents } };
}

export function createAgentsRoutes(deps: AgentsRoutesDeps) {
  const { redisClient, publishConfigUpdate, logActivityHelper } = deps;

  async function getAgents(_req: Request, res: Response): Promise<void> {
    try {
      res.json({ agents: await configManager.loadAgents() });
    } catch (error) {
      console.error('Error in /api/config/agents GET:', error);
      res.status(500).json({ error: 'Failed to load agents configuration' });
    }
  }

  async function postAgents(req: Request, res: Response): Promise<void> {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }
    const validationError = validateAgentsConfig(req.body.agents);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const result = await withConfigLock(redisClient, SETTINGS_CONFIG_LOCK_KEY, async lock => {
      return applyAgentsUpdate({
        agents: req.body.agents,
        username: req.user?.username,
        publishConfigUpdate,
        logActivityHelper,
        lock
      });
    });

    res.status(result.status).json(result.body);
  }

  return {
    getAgents,
    postAgents
  };
}
