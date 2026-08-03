import {
  AGENT_DEFAULT_VERSIONS,
  computeContentHash,
  findAgentCliVersionConflicts,
  generateAgentBundleImageTag,
  getAgentCliVersionMatrix,
  resolveVersion,
} from '@propr/core';
import type { AgentConfig, AgentType, CliVersionType } from '@propr/core';
import { normalizeAgentsConfig, validateAgentsConfig } from './configHelpers.js';
import type { AgentPreparationDeps } from './configRoutesAgentsTypes.js';

export const AGENT_VERSION_LOOKUP_UNAVAILABLE_CODE = 'AGENT_VERSION_LOOKUP_UNAVAILABLE';

export const DEFAULT_PREPARATION_DEPS: AgentPreparationDeps = {
  resolveVersion,
  computeContentHash,
  generateAgentBundleImageTag,
};

export function resolveDefaultAgentAlias(
  processedAgents: AgentConfig[],
  currentDefault: string | undefined,
): string | undefined {
  const enabledAgents = processedAgents.filter(agent => agent.enabled);
  if (enabledAgents.length === 0) return undefined;
  if (!currentDefault || !enabledAgents.some(agent => agent.alias === currentDefault)) {
    return enabledAgents[0].alias;
  }
  return currentDefault;
}

function requiresExplicitVersionSpec(versionType: CliVersionType): boolean {
  return versionType === 'tag' || versionType === 'specific' || versionType === 'custom';
}

function hasVersionSpec(versionSpec: string | undefined): boolean {
  return typeof versionSpec === 'string' && versionSpec.trim().length > 0;
}

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENETDOWN',
  'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
]);

function hasTransientNetworkCode(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && TRANSIENT_NETWORK_ERROR_CODES.has(candidate.code)) return true;
    current = candidate.cause;
  }
  return false;
}

function classifyVersionResolutionError(error: unknown): { code?: string; publicMessage: string; status: number } {
  const message = error instanceof Error ? error.message : 'Unknown version resolution error';
  if (hasTransientNetworkCode(error)
      || /\b(?:fetch failed|network (?:error|failure|timeout)|request timed out|EAI_AGAIN|ECONN(?:ABORTED|REFUSED|RESET)|ENET(?:DOWN|UNREACH)|ENOTFOUND|ETIMEDOUT)\b/i.test(message)) {
    return {
      code: AGENT_VERSION_LOOKUP_UNAVAILABLE_CODE,
      publicMessage: 'Agent version lookup is temporarily unavailable',
      status: 502,
    };
  }
  if (message.startsWith('NPM registry returned ')
      || message.startsWith('PyPI request failed ')
      || message.startsWith('PyPI request timed out ')) {
    return {
      code: AGENT_VERSION_LOOKUP_UNAVAILABLE_CODE,
      publicMessage: 'Agent version lookup is temporarily unavailable',
      status: 502,
    };
  }
  if (message.startsWith('Version spec required')
      || message.startsWith('Unknown tag ')
      || message.includes('not found for package')) {
    return { publicMessage: message, status: 400 };
  }
  return { publicMessage: 'Agent version resolution failed', status: 500 };
}

export async function prepareAgentsUpdate(
  agents: unknown,
  preparationDeps: AgentPreparationDeps = DEFAULT_PREPARATION_DEPS,
): Promise<{ code?: string; error?: string; processedAgents?: AgentConfig[]; status?: number }> {
  if (!Array.isArray(agents)) {
    return { error: 'agents must be an array', status: 400 };
  }
  const normalizedAgents = normalizeAgentsConfig(agents);
  const validationError = validateAgentsConfig(normalizedAgents);
  if (validationError) {
    return { error: validationError, status: 400 };
  }

  const processedAgents: AgentConfig[] = [];
  for (const agent of normalizedAgents) {
    const processedAgent = { ...agent };
    if (agent.cliVersionType) {
      const versionType = agent.cliVersionType as CliVersionType;
      if (requiresExplicitVersionSpec(versionType) && !hasVersionSpec(agent.cliVersion)) {
        return {
          error: `Failed to resolve version for agent '${agent.alias}': version spec is required for ${versionType} version type`,
          status: 400,
        };
      }
      try {
        const agentType = agent.type as AgentType;
        processedAgent.cliVersionResolved = await preparationDeps.resolveVersion(
          agentType,
          versionType,
          agent.cliVersion,
        );
      } catch (versionError) {
        console.error(`Failed to resolve version for agent '${agent.alias}':`, versionError);
        const { code, publicMessage, status } = classifyVersionResolutionError(versionError);
        return {
          ...(code ? { code } : {}),
          error: `Failed to resolve version for agent '${agent.alias}': ${publicMessage}`,
          status,
        };
      }
    } else {
      const agentType = agent.type as AgentType;
      processedAgent.cliVersionType = 'default';
      processedAgent.cliVersionResolved = AGENT_DEFAULT_VERSIONS[agentType];
    }
    processedAgents.push(processedAgent);
  }

  const versionConflicts = findAgentCliVersionConflicts(processedAgents);
  if (versionConflicts.length > 0) {
    const details = versionConflicts
      .map(conflict => `${conflict.agentType} (${conflict.aliases.join(', ')}: ${conflict.versions.join(' vs ')})`)
      .join('; ');
    return {
      error: `Conflicting CLI versions for the unified agent image: ${details}. Enabled agents of the same type must use the same CLI version.`,
      status: 400,
    };
  }

  try {
    const bundleImage = preparationDeps.generateAgentBundleImageTag(
      getAgentCliVersionMatrix(processedAgents),
      preparationDeps.computeContentHash(),
    );
    for (const agent of processedAgents) agent.dockerImage = bundleImage;
  } catch (error) {
    console.error('Failed to derive managed agent image:', error);
    return {
      error: 'Failed to derive managed agent image',
      status: 500,
    };
  }

  return { processedAgents };
}

export async function loadProcessedAgents(
  agents: AgentConfig[],
  providedProcessedAgents?: AgentConfig[],
  preparationDeps: AgentPreparationDeps = DEFAULT_PREPARATION_DEPS,
): Promise<{ code?: string; error?: string; processedAgents?: AgentConfig[]; status?: number }> {
  if (providedProcessedAgents) return { processedAgents: providedProcessedAgents };
  const prepared = await prepareAgentsUpdate(agents, preparationDeps);
  if (prepared.error || !prepared.processedAgents) {
    return prepared.error
      ? prepared
      : { status: 500, error: 'Failed to prepare agent configuration update' };
  }
  return { processedAgents: prepared.processedAgents };
}
