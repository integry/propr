export interface AgentModelMatrixEntry {
  alias: string;
  supportedModels: string[];
  defaultModel?: string;
}

export interface SelectedAgentModelPair {
  agent_alias: string;
  model_name: string;
}

export function parseModelPairLimit(raw: string | undefined, fallback = 8): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Select one model per agent first, then fill the remaining deterministic slots. */
export function selectAgentModelPairs(
  agents: AgentModelMatrixEntry[],
  maxPairs: number,
): SelectedAgentModelPair[] {
  const pairsByAgent = [...agents]
    .sort((left, right) => left.alias.localeCompare(right.alias))
    .map((agent) => {
      const models = [...new Set(agent.supportedModels)].sort();
      const representativeModel = agent.defaultModel && models.includes(agent.defaultModel)
        ? agent.defaultModel
        : models[0]!;
      return { alias: agent.alias, models, representativeModel };
    })
    .filter((agent) => agent.models.length > 0);
  const representatives = pairsByAgent.map((agent) => ({
    agent_alias: agent.alias,
    model_name: agent.representativeModel,
  }));
  const remaining = pairsByAgent.flatMap((agent) => agent.models
    .filter((model) => model !== agent.representativeModel)
    .map((model) => ({
      agent_alias: agent.alias,
      model_name: model,
    })));
  const ordered = [...representatives, ...remaining];
  return maxPairs === 0 ? ordered : ordered.slice(0, maxPairs);
}
