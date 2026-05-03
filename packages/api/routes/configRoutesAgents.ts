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
import { withConfigLock, validateAgentsConfig } from './configHelpers.js';

interface AgentsRoutesDeps {
  redisClient: RedisClientType;
  publishConfigUpdate: (subtype: string) => Promise<void>;
  logActivityHelper: (description: string, idSuffix: string, type: string, username?: string) => Promise<void>;
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
    const result = await withConfigLock(redisClient, 'config:agents:lock', async () => {
      const { agents } = req.body;

      const validationError = validateAgentsConfig(agents);
      if (validationError) {
        return { status: 400, body: { error: validationError } };
      }

      // Resolve CLI versions for each agent
      const processedAgents: AgentConfig[] = [];
      for (const agent of agents) {
        const processedAgent = { ...agent };

        // If agent has version configuration, resolve it
        if (agent.cliVersionType) {
          try {
            const agentType = agent.type as AgentType;
            const versionType = agent.cliVersionType as CliVersionType;

            // Resolve version to actual semver
            const resolvedVersion = await resolveVersion(agentType, versionType, agent.cliVersion);
            processedAgent.cliVersionResolved = resolvedVersion;
            processedAgent.dockerImage = generateImageTag(agentType, resolvedVersion, computeContentHash(agentType));

          } catch (versionError) {
            console.warn(`Failed to resolve version for agent ${agent.alias}:`, versionError);
            // Keep existing values if resolution fails
          }
        } else {
          // Default: use default version if no type specified
          const agentType = agent.type as AgentType;
          processedAgent.cliVersionType = 'default';
          processedAgent.cliVersionResolved = AGENT_DEFAULT_VERSIONS[agentType];
        }

        processedAgents.push(processedAgent);
      }

      await configManager.saveAgents(processedAgents);

      // Refresh the AgentRegistry to apply changes immediately
      try {
        await AgentRegistry.getInstance().refresh();
      } catch (refreshError) {
        console.error('Warning: Failed to refresh agent registry:', refreshError);
      }

      // Sync default_agent_alias: ensure it points to a valid enabled agent
      // Note: this read-check-write is not atomic; concurrent requests could produce
      // inconsistent state, but this is acceptable for a settings endpoint that is
      // rarely called concurrently.
      try {
        const settings = await configManager.loadSettings();
        const currentDefault = (settings as Record<string, unknown>).default_agent_alias as string | undefined;
        const enabledAgents = processedAgents.filter((a: { enabled: boolean }) => a.enabled);

        let newDefault = currentDefault;
        if (enabledAgents.length === 0) {
          // No enabled agents - clear default
          newDefault = undefined;
        } else if (!currentDefault || !enabledAgents.some((a: { alias: string }) => a.alias === currentDefault)) {
          // Current default is missing or points to a removed/disabled agent - set to first enabled
          newDefault = enabledAgents[0].alias;
        }

        if (newDefault !== currentDefault) {
          await configManager.saveSettings({ default_agent_alias: newDefault } as Record<string, unknown>);
          // Update the registry's cached alias
          const registry = AgentRegistry.getInstance();
          registry.setDefaultAgentAlias(newDefault || null);
        }
      } catch (syncError) {
        // Log at error level — configuration corruption should not be silently swallowed
        console.error('Failed to sync default agent alias after agents update:', syncError);
        throw syncError;
      }

      await publishConfigUpdate('agents_update');
      await logActivityHelper(`Updated agents configuration (${processedAgents.length} agents)`, 'agents-update', 'agents_updated', req.user?.username);

      return { status: 200, body: { success: true, agents: processedAgents } };
    });

    res.status(result.status).json(result.body);
  }

  return {
    getAgents,
    postAgents
  };
}
