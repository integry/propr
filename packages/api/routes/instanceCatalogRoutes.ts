import type { Request, Response } from 'express';
import {
  loadAgents,
  loadMonitoredReposRaw,
  loadSettings,
  type AgentConfig,
  type RepoToMonitor,
} from '@propr/core';
import type {
  InstanceCatalogAgent,
  InstanceCatalogRepository,
  InstanceCatalogResponse,
} from '@propr/shared';

interface InstanceCatalogServices {
  loadAgents: () => Promise<AgentConfig[]>;
  loadRepositories: () => Promise<RepoToMonitor[]>;
  loadSettings: () => Promise<Record<string, unknown>>;
}

interface InstanceCatalogRoutesDeps {
  services?: Partial<InstanceCatalogServices>;
}

function catalogAgent(agent: AgentConfig): InstanceCatalogAgent {
  return {
    alias: agent.alias,
    enabled: true,
    supportedModels: [...agent.supportedModels],
    ...(agent.defaultModel ? { defaultModel: agent.defaultModel } : {}),
  };
}

function catalogRepository(repository: RepoToMonitor): InstanceCatalogRepository {
  return {
    name: repository.name,
    enabled: true,
    ...(repository.alias ? { alias: repository.alias } : {}),
    ...(repository.baseBranch ? { baseBranch: repository.baseBranch } : {}),
  };
}

export function createInstanceCatalogRoutes({ services: overrides }: InstanceCatalogRoutesDeps = {}) {
  const services: InstanceCatalogServices = {
    loadAgents,
    loadRepositories: loadMonitoredReposRaw,
    loadSettings,
    ...overrides,
  };

  async function getCatalog(_req: Request, res: Response): Promise<void> {
    try {
      const [agents, repositories, settings] = await Promise.all([
        services.loadAgents(),
        services.loadRepositories(),
        services.loadSettings(),
      ]);
      const catalogAgents = agents.filter(agent => agent.enabled).map(catalogAgent);
      const defaultAgentAlias = typeof settings.default_agent_alias === 'string'
        ? settings.default_agent_alias.trim()
        : '';
      const response: InstanceCatalogResponse = {
        agents: catalogAgents,
        repositories: repositories.filter(repository => repository.enabled).map(catalogRepository),
        ...(defaultAgentAlias && catalogAgents.some(agent => agent.alias === defaultAgentAlias)
          ? { defaultAgentAlias }
          : {}),
      };
      res.json(response);
    } catch (error) {
      console.error('Failed to load the instance catalog:', error);
      res.status(500).json({ error: 'Failed to load the instance catalog' });
    }
  }

  return { getCatalog };
}
