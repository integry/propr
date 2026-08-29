import type { Request, Response } from 'express';
import {
  getRepositoriesIndexingStatus,
  loadAgents,
  loadSyntheticAgents,
  loadMonitoredReposRaw,
  loadSettings,
  type AgentConfig,
  type RepoToMonitor,
  type RepositoryIndexingStatus,
} from '@propr/core';
import type {
  InstanceCatalogAgent,
  InstanceCatalogRepository,
  InstanceCatalogResponse,
  SyntheticAgentConfig,
} from '@propr/shared';

interface InstanceCatalogServices {
  loadAgents: () => Promise<AgentConfig[]>;
  loadSyntheticAgents: () => Promise<SyntheticAgentConfig[]>;
  loadIndexingStatuses: () => Promise<RepositoryIndexingStatus[]>;
  loadRepositories: () => Promise<RepoToMonitor[]>;
  loadSettings: () => Promise<Record<string, unknown>>;
}

interface InstanceCatalogRoutesDeps {
  services?: Partial<InstanceCatalogServices>;
}

function catalogAgent(agent: AgentConfig): InstanceCatalogAgent {
  return {
    id: agent.id,
    kind: 'direct',
    alias: agent.alias,
    enabled: true,
    supportedModels: [...agent.supportedModels],
    ...(agent.defaultModel ? { defaultModel: agent.defaultModel } : {}),
  };
}

export function catalogSyntheticAgents(
  syntheticAgents: SyntheticAgentConfig[],
  directAgents: AgentConfig[],
): InstanceCatalogAgent[] {
  const directByAlias = new Map(directAgents.map(agent => [agent.alias, agent]));

  return syntheticAgents.flatMap(syntheticAgent => {
    if (!syntheticAgent.enabled) return [];
    const supportedModels = syntheticAgent.models.flatMap(model => {
      if (!model.enabled) return [];
      const usable = model.members.some(member => {
        const direct = directByAlias.get(member.directAgentAlias);
        return member.enabled
          && direct?.enabled === true
          && direct.supportedModels.includes(member.model);
      });
      return usable ? [model.id] : [];
    });
    if (supportedModels.length === 0) return [];

    return [{
      id: syntheticAgent.id,
      kind: 'synthetic' as const,
      alias: syntheticAgent.alias,
      enabled: true,
      supportedModels,
      ...(supportedModels.includes(syntheticAgent.defaultModel)
        ? { defaultModel: syntheticAgent.defaultModel }
        : {}),
    }];
  });
}

function catalogRepository(repository: RepoToMonitor): InstanceCatalogRepository {
  return {
    name: repository.name,
    enabled: true,
    ...(repository.alias ? { alias: repository.alias } : {}),
    ...(repository.baseBranch ? { baseBranch: repository.baseBranch } : {}),
  };
}

function repositoryKey(name: string, branch?: string): string {
  return `${name}\0${branch?.trim() || 'HEAD'}`;
}

function catalogIndexingStatus(status: RepositoryIndexingStatus): RepositoryIndexingStatus {
  return {
    full_name: status.full_name,
    branch: status.branch,
    indexing_status: status.indexing_status,
    last_indexed_at: status.last_indexed_at,
    last_indexed_hash: status.last_indexed_hash,
    last_indexed_commit_message: status.last_indexed_commit_message,
    icon_path: status.icon_path,
    ...(status.progress ? {
      progress: {
        totalFiles: status.progress.totalFiles,
        processedFiles: status.progress.processedFiles,
        percentComplete: status.progress.percentComplete,
        inputTokens: status.progress.inputTokens,
        outputTokens: status.progress.outputTokens,
        phase: status.progress.phase,
        totalDirectories: status.progress.totalDirectories,
        processedDirectories: status.progress.processedDirectories,
      },
    } : {}),
  };
}

export function createInstanceCatalogRoutes({ services: overrides }: InstanceCatalogRoutesDeps = {}) {
  const services: InstanceCatalogServices = {
    loadAgents,
    loadSyntheticAgents,
    loadIndexingStatuses: getRepositoriesIndexingStatus,
    loadRepositories: loadMonitoredReposRaw,
    loadSettings,
    ...overrides,
  };

  async function getCatalog(_req: Request, res: Response): Promise<void> {
    try {
      const [agents, syntheticAgents, repositories, settings] = await Promise.all([
        services.loadAgents(),
        services.loadSyntheticAgents(),
        services.loadRepositories(),
        services.loadSettings(),
      ]);
      const catalogAgents = [
        ...agents.filter(agent => agent.enabled).map(catalogAgent),
        ...catalogSyntheticAgents(syntheticAgents, agents),
      ];
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

  async function getRepositoryIndexingStatus(_req: Request, res: Response): Promise<void> {
    try {
      const [repositories, statuses] = await Promise.all([
        services.loadRepositories(),
        services.loadIndexingStatuses(),
      ]);
      const enabledRepositoryKeys = new Set(
        repositories
          .filter(repository => repository.enabled)
          .map(repository => repositoryKey(repository.name, repository.baseBranch))
      );
      res.json({
        repositories: statuses
          .filter(status => enabledRepositoryKeys.has(repositoryKey(status.full_name, status.branch)))
          .map(catalogIndexingStatus),
      });
    } catch (error) {
      console.error('Failed to load repository indexing status:', error);
      res.status(500).json({ error: 'Failed to load repository indexing status' });
    }
  }

  return { getCatalog, getRepositoryIndexingStatus };
}
