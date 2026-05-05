interface AgentConfig {
  id: string;
  type: string;
  alias: string;
  enabled: boolean;
  dockerImage: string;
  configPath: string;
  supportedModels: string[];
}

const ALIAS_REGEX = /^[a-z0-9-]+$/;
const VALID_AGENT_TYPES = ['claude', 'codex', 'gemini'];

export function validateAgentsConfig(agents: AgentConfig[]): string | null {
  if (!Array.isArray(agents)) return 'agents must be an array';
  const seenAliases = new Set<string>();
  for (const agent of agents) {
    const error = validateSingleAgent(agent, seenAliases);
    if (error) return error;
    seenAliases.add(agent.alias);
  }
  return null;
}

function validateSingleAgent(agent: AgentConfig, seenAliases: Set<string>): string | null {
  if (!agent.id || typeof agent.id !== 'string') return `Agent missing required 'id' field`;
  if (!agent.type || !VALID_AGENT_TYPES.includes(agent.type)) return `Agent '${agent.id}' has invalid type. Must be one of: ${VALID_AGENT_TYPES.join(', ')}`;
  if (!agent.alias || typeof agent.alias !== 'string') return `Agent '${agent.id}' missing required 'alias' field`;
  if (!ALIAS_REGEX.test(agent.alias)) return `Agent '${agent.id}' has invalid alias '${agent.alias}'. Must match pattern ^[a-z0-9-]+$`;
  if (typeof agent.enabled !== 'boolean') return `Agent '${agent.id}' missing required 'enabled' field`;
  if (!agent.dockerImage || typeof agent.dockerImage !== 'string') return `Agent '${agent.id}' missing required 'dockerImage' field`;
  if (!agent.configPath || typeof agent.configPath !== 'string') return `Agent '${agent.id}' missing required 'configPath' field`;
  if (!Array.isArray(agent.supportedModels)) return `Agent '${agent.id}' missing required 'supportedModels' field`;
  if (!agent.supportedModels.every(model => typeof model === 'string' && model.trim().length > 0)) {
    return `Agent '${agent.id}' has invalid 'supportedModels'. Each supported model must be a non-empty string`;
  }
  if (seenAliases.has(agent.alias)) return `Duplicate agent alias '${agent.alias}' found`;
  return null;
}
