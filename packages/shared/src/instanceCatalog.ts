export interface InstanceCatalogAgent {
  alias: string;
  enabled: boolean;
  supportedModels: string[];
  defaultModel?: string;
}

export interface InstanceCatalogRepository {
  name: string;
  enabled: boolean;
  alias?: string;
  baseBranch?: string;
}

export interface InstanceCatalogResponse {
  agents: InstanceCatalogAgent[];
  repositories: InstanceCatalogRepository[];
  defaultAgentAlias?: string;
}
