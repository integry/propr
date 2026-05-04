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

      const previousAgents = await configManager.loadAgents();
      const settings = await configManager.loadSettings();
      const currentDefault = ((settings as Record<string, unknown>).default_agent_alias as string | undefined) ?? undefined;
      const enabledAgents = processedAgents.filter((a: { enabled: boolean }) => a.enabled);

      let newDefault = currentDefault;
      if (enabledAgents.length === 0) {
        newDefault = undefined;
      } else if (!currentDefault || !enabledAgents.some((a: { alias: string }) => a.alias === currentDefault)) {
        newDefault = enabledAgents[0].alias;
      }

      try {
        await configManager.saveAgents(processedAgents);
        if (newDefault !== currentDefault) {
          await configManager.saveSettings({ default_agent_alias: newDefault } as Record<string, unknown>);
        }
      } catch (syncError) {
        try {
          await configManager.saveAgents(previousAgents);
        } catch (rollbackError) {
          console.error('Failed to roll back agents configuration after sync error:', rollbackError);
        }
        console.error('Failed to sync default agent alias after agents update:', syncError);
        throw syncError;
      }

      try {
        await AgentRegistry.getInstance().refresh();
      } catch (refreshError) {
        try {
          await configManager.saveAgents(previousAgents);
          if (newDefault !== currentDefault) {
            await configManager.saveSettings({ default_agent_alias: currentDefault } as Record<string, unknown>);
          }
          await AgentRegistry.getInstance().refresh();
        } catch (rollbackError) {
          console.error('Failed to roll back agent configuration after registry refresh failure:', rollbackError);
        }
        console.error('Failed to refresh agent registry after agents update:', refreshError);
        return { status: 500, body: { error: 'Failed to apply agent configuration to the live registry' } };
      }

      await publishConfigUpdate('agents_update');
      if (newDefault !== currentDefault) {
        await publishConfigUpdate('settings_update');
      }
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
