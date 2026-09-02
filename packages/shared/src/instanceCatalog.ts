import type { AgentType } from './modelDefinitions.js';
import type { GoalProviderCapabilities } from './goals.js';

export interface GoalCatalogModel {
  id: string;
  displayName: string;
  goalCapable: boolean;
}

export interface InstanceCatalogAgent {
  alias: string;
  type?: AgentType;
  /** Always true: the operational catalog omits disabled entries. */
  enabled: boolean;
  supportedModels: string[];
  /** Goal creation requires this explicit agent opt-in. */
  goalCapable: boolean;
  /** Supported models explicitly opted into goal execution. */
  goalCapableModels: string[];
  goalModelCatalog?: GoalCatalogModel[];
  goalCapabilities?: GoalProviderCapabilities;
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
  const catalog = getGoalModelCatalog(agent);
  if (catalog.length > 0) return catalog.filter(model => model.goalCapable && allowed.has(model.id)).map(model => model.id);
  return agent.supportedModels.filter(model => allowed.has(model));
}

export function getGoalModelCatalog(agent: InstanceCatalogAgent): GoalCatalogModel[] {
  if (!isGoalCapableCatalogAgent(agent) || !Array.isArray(agent.goalModelCatalog)) return [];
  const supported = new Set(agent.supportedModels);
  return agent.goalModelCatalog.filter(model => supported.has(model.id));
}

const capability = (application: 'immediate' | 'next_turn' | 'safe_boundary') => ({
  supported: true as const,
  application,
});

export function goalCapabilitiesForAgentType(type: AgentType): GoalProviderCapabilities | null {
  if (type === 'claude') return {
    nativeGoal: true,
    pause: capability('safe_boundary'), resume: capability('immediate'),
    steer: capability('next_turn'), modelChange: capability('safe_boundary'),
  };
  if (type === 'codex') return {
    nativeGoal: true,
    pause: capability('safe_boundary'), resume: capability('immediate'),
    steer: capability('next_turn'), modelChange: capability('next_turn'),
  };
  if (type === 'antigravity') return {
    nativeGoal: true,
    pause: capability('safe_boundary'), resume: capability('immediate'),
    steer: capability('next_turn'), modelChange: capability('safe_boundary'),
  };
  return null;
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
