import type { AgentType } from './modelDefinitions.js';

export interface InstanceCatalogAgent {
  /** Stable configuration identity. Omitted by older servers. */
  id?: string;
  /** Omitted by older servers; consumers should treat omission as direct. */
  kind?: 'direct' | 'synthetic';
  alias: string;
  /** Agent runtime of a direct agent (e.g. `claude`). Omitted for synthetic agents and by older servers. */
  type?: AgentType;
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
  /** Repository-wide notification filter. Omitted by older servers; treat omission as enabled. */
  notificationsEnabled?: boolean;
}

export interface InstanceCatalogResponse {
  agents: InstanceCatalogAgent[];
  repositories: InstanceCatalogRepository[];
  defaultAgentAlias?: string;
}
