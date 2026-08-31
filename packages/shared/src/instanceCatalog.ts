export interface InstanceCatalogAgent {
  alias: string;
  /** Always true: the operational catalog omits disabled entries. */
  enabled: boolean;
  /**
   * Explicit opt-in for long-running goal execution. Optional so older catalog
   * producers and consumers remain wire-compatible; goal UIs must require
   * `true` instead of treating every enabled coding agent as goal-capable.
   */
  goalCapable?: boolean;
  /**
   * Optional model-level goal allowlist. When omitted, every supported model
   * on an explicitly goal-capable agent is eligible.
   */
  goalCapableModels?: string[];
  supportedModels: string[];
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
  if (!agent.goalCapableModels) return agent.supportedModels;
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
