import { agentCliVersionWarnings, describeAgentCliVersionStates, findReasoningLevelCliVersionWarnings, logger, type AgentCliVersionState, type AgentConfig } from '@propr/core';
import { redactAgentConfigsSecrets } from '@propr/shared';
import type { AgentConfigStore, AgentRegistrySync, ApplyAgentsUpdateResult } from './configRoutesAgentsTypes.js';

// A settings read must not wait on the worker's image build.
const AGENT_IMAGE_INSPECTION_WAIT_MS = 2000;

async function settleWithin(promise: Promise<unknown> | undefined, timeoutMs: number): Promise<void> {
  if (!promise) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise.catch(() => undefined), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Configured vs in-effect CLI version per enabled agent; empty when the registry cannot say. */
export async function loadAgentCliVersionStates(
  registry: AgentRegistrySync,
  agents: AgentConfig[],
  inspect = false,
): Promise<AgentCliVersionState[]> {
  if (!registry.getAgentByAlias || !registry.getOperationalStatus) return [];
  try {
    if (inspect) {
      // Pick up an image the worker finished preparing since the last check,
      // without letting a read wait on the worker's build.
      const check = registry.isInitialized && !registry.isInitialized()
        ? registry.refresh()
        : registry.inspectAgentImageAvailability?.();
      await settleWithin(check, AGENT_IMAGE_INSPECTION_WAIT_MS);
    }
    return describeAgentCliVersionStates(agents, {
      getAgentByAlias: registry.getAgentByAlias.bind(registry),
      getOperationalStatus: registry.getOperationalStatus.bind(registry),
    });
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Could not determine agent CLI versions in effect');
    return [];
  }
}

async function loadReasoningLevelWarnings(
  configStore: AgentConfigStore,
  agents: AgentConfig[],
): Promise<string[]> {
  if (!configStore.loadModelReasoningLevel) return [];
  try {
    return findReasoningLevelCliVersionWarnings(
      agents,
      await configStore.loadModelReasoningLevel(),
    );
  } catch (warningError) {
    console.warn('Could not evaluate reasoning-level CLI compatibility after agents save:', warningError);
    return [];
  }
}

/** The saved agents plus whether each changed CLI version is in effect yet. */
export async function buildAgentsUpdateSuccessBody(
  configStore: AgentConfigStore,
  registry: AgentRegistrySync,
  processedAgents: AgentConfig[],
): Promise<ApplyAgentsUpdateResult['body']> {
  const cliVersionStates = await loadAgentCliVersionStates(registry, processedAgents);
  const warnings = [
    ...agentCliVersionWarnings(cliVersionStates),
    ...await loadReasoningLevelWarnings(configStore, processedAgents),
  ];
  return {
    success: true,
    agents: redactAgentConfigsSecrets(processedAgents),
    ...(cliVersionStates.length > 0 ? { cliVersionStates } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
