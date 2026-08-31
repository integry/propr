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

export type GoalCapableCatalogAgent = InstanceCatalogAgent & { goalCapable: true };

export function isGoalCapableCatalogAgent(
  agent: InstanceCatalogAgent
): agent is GoalCapableCatalogAgent {
  return agent.enabled && agent.goalCapable === true;
}

export function getGoalCapableModels(agent: InstanceCatalogAgent): string[] {
  if (!isGoalCapableCatalogAgent(agent)) return [];
  // Fail closed for stale/malformed catalog producers even though the V1 type
  // makes the allowlist required.
  if (!Array.isArray(agent.goalCapableModels)) return [];
  const allowed = new Set(agent.goalCapableModels);
  return agent.supportedModels.filter(model => allowed.has(model));
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
