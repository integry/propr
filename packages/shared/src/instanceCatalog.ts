export interface InstanceCatalogAgent {
  alias: string;
  /** Always true: the operational catalog omits disabled entries. */
  enabled: boolean;
  supportedModels: string[];
  defaultModel?: string;
}

export interface InstanceCatalogRepository {
  name: string;
  /** Always true: the operational catalog omits disabled entries. */
  enabled: boolean;
  alias?: string;
  baseBranch?: string;
}

export interface InstanceCatalogResponse {
  agents: InstanceCatalogAgent[];
  repositories: InstanceCatalogRepository[];
  defaultAgentAlias?: string;
}
