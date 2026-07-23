import { AGENT_TYPES, toProprOpenCodeModelId, validateAgentType, type AgentConfig, type CliVersionType } from '@propr/core';
import { isReasoningLevel } from '@propr/shared';

const ALIAS_REGEX = /^[a-z0-9-]+$/;
const VALID_CLI_VERSION_TYPES: CliVersionType[] = ['default', 'tag', 'specific', 'custom'];

export function normalizeAgentAlias(alias: string): string {
  return alias.trim();
}

function normalizeSupportedModel(agentType: AgentConfig['type'], model: string): string {
  const trimmed = model.trim();
  if (trimmed === 'default') return trimmed;
  return agentType === 'opencode' ? toProprOpenCodeModelId(trimmed) : trimmed;
}

function isAgentRecord(agent: unknown): agent is Record<string, unknown> {
  return typeof agent === 'object' && agent !== null;
}

export function normalizeAgentsConfig(agents: AgentConfig[]): AgentConfig[] {
  return agents.map(agent => {
    if (!isAgentRecord(agent)) {
      return agent;
    }
    const cliVersionType = typeof agent.cliVersionType === 'string' ? agent.cliVersionType : undefined;
    const modelReasoningLevels = isAgentRecord(agent.modelReasoningLevels) && !Array.isArray(agent.modelReasoningLevels)
      ? Object.fromEntries(Object.entries(agent.modelReasoningLevels).map(([model, level]) => [
          normalizeSupportedModel(agent.type, model),
          typeof level === 'string' ? level.trim().toLowerCase() : level
        ])) as AgentConfig['modelReasoningLevels']
      : agent.modelReasoningLevels;
    return {
      ...agent,
      alias: typeof agent.alias === 'string' ? normalizeAgentAlias(agent.alias) : agent.alias,
      cliVersion: cliVersionType === 'default' ? undefined : (typeof agent.cliVersion === 'string' ? agent.cliVersion.trim() : agent.cliVersion),
      defaultModel: typeof agent.defaultModel === 'string' ? normalizeSupportedModel(agent.type, agent.defaultModel) : agent.defaultModel,
      modelReasoningLevels,
      supportedModels: Array.isArray(agent.supportedModels)
        ? agent.supportedModels.map(model => typeof model === 'string' ? normalizeSupportedModel(agent.type, model) : model)
        : agent.supportedModels
    };
  });
}

export function validateAgentsConfig(agents: AgentConfig[]): string | null {
  if (!Array.isArray(agents)) return 'agents must be an array';
  const seenAliases = new Set<string>();
  for (const agent of agents) {
    const error = validateSingleAgent(agent, seenAliases);
    if (error) return error;
    seenAliases.add(normalizeAgentAlias(agent.alias));
  }
  return null;
}

function validateAgentBaseFields(agent: AgentConfig, normalizedAlias: string): string | null {
  if (!agent.id || typeof agent.id !== 'string') return `Agent missing required 'id' field`;
  const typeValidation = validateAgentType(agent.type);
  if (!typeValidation.ok) return `Agent '${agent.id}' has invalid type. Must be one of: ${AGENT_TYPES.join(', ')}`;
  if (!agent.alias || typeof agent.alias !== 'string') return `Agent '${agent.id}' missing required 'alias' field`;
  if (!normalizedAlias) return `Agent '${agent.id}' missing required 'alias' field`;
  if (!ALIAS_REGEX.test(normalizedAlias)) return `Agent '${agent.id}' has invalid alias '${agent.alias}'. Must match pattern ^[a-z0-9-]+$`;
  if (typeof agent.enabled !== 'boolean') return `Agent '${agent.id}' missing required 'enabled' field`;
  if (agent.dockerImage !== undefined && typeof agent.dockerImage !== 'string') return `Agent '${agent.id}' has invalid 'dockerImage'. Must be a string`;
  if (!agent.configPath || typeof agent.configPath !== 'string') return `Agent '${agent.id}' missing required 'configPath' field`;
  if (!Array.isArray(agent.supportedModels)) return `Agent '${agent.id}' missing required 'supportedModels' field`;
  if (!agent.supportedModels.every(model => typeof model === 'string' && model.trim().length > 0)) {
    return `Agent '${agent.id}' has invalid 'supportedModels'. Each supported model must be a non-empty string`;
  }
  return null;
}

function validateAgentCliVersion(agent: AgentConfig): string | null {
  if (agent.cliVersionType !== undefined && !VALID_CLI_VERSION_TYPES.includes(agent.cliVersionType)) {
    return `Agent '${agent.id}' has invalid cliVersionType '${String(agent.cliVersionType)}'. Must be one of: ${VALID_CLI_VERSION_TYPES.join(', ')}`;
  }
  if (agent.cliVersion !== undefined && typeof agent.cliVersion !== 'string') {
    return `Agent '${agent.id}' has invalid cliVersion. Must be a string`;
  }
  if (agent.cliVersionType === undefined && agent.cliVersion) {
    return `Agent '${agent.id}' cannot set cliVersion without cliVersionType`;
  }
  if (agent.cliVersionType === 'default' && agent.cliVersion) {
    return `Agent '${agent.id}' must not set cliVersion when cliVersionType is 'default'`;
  }
  if (agent.cliVersionType && agent.cliVersionType !== 'default' && !agent.cliVersion) {
    return `Agent '${agent.id}' missing required cliVersion for cliVersionType '${agent.cliVersionType}'`;
  }
  return null;
}

function validateAgentModelReasoningLevels(agent: AgentConfig): string | null {
  if (agent.modelReasoningLevels === undefined) return null;
  if (!isAgentRecord(agent.modelReasoningLevels) || Array.isArray(agent.modelReasoningLevels)) {
    return `Agent '${agent.id}' has invalid modelReasoningLevels. Must be an object`;
  }
  for (const [model, level] of Object.entries(agent.modelReasoningLevels)) {
    if (!model.trim() || !isReasoningLevel(String(level))) {
      return `Agent '${agent.id}' has invalid reasoning level '${String(level)}' for model '${model}'`;
    }
  }
  return null;
}

function validateSingleAgent(agent: AgentConfig, seenAliases: Set<string>): string | null {
  if (!isAgentRecord(agent)) {
    return 'Each agent must be an object';
  }
  if (typeof agent.alias !== 'string') {
    const id = typeof agent.id === 'string' && agent.id ? agent.id : 'unknown';
    return `Agent '${id}' missing required 'alias' field`;
  }
  const normalizedAlias = normalizeAgentAlias(agent.alias);
  const baseFieldError = validateAgentBaseFields(agent, normalizedAlias);
  if (baseFieldError) return baseFieldError;
  const cliVersionError = validateAgentCliVersion(agent);
  if (cliVersionError) return cliVersionError;
  const reasoningLevelError = validateAgentModelReasoningLevels(agent);
  if (reasoningLevelError) return reasoningLevelError;
  if (seenAliases.has(normalizedAlias)) return `Duplicate agent alias '${normalizedAlias}' found`;
  return null;
}
