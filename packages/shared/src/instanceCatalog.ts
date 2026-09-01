export interface InstanceCatalogAgent {
  alias: string;
  /** Always true: the operational catalog omits disabled entries. */
  enabled: boolean;
  supportedModels: string[];
  /** Goal creation requires this explicit agent opt-in. */
  goalCapable: boolean;
  /** Supported models explicitly opted into goal execution. */
  goalCapableModels: string[];
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
