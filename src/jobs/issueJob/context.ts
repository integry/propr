/**
 * Job context initialization for GitHub issue processing.
 */

import { Job } from 'bullmq';
import {
  logger, generateCorrelationId, getStateManager, loadSettings, resolveLlmLabel, AgentRegistry, NoDefaultModelConfiguredError
} from '@propr/core';
import type { IssueJobData, Agent } from '@propr/core';
import type { JobContext } from './types.js';
import { DEFAULT_MODEL_NAME, getPrimaryProcessingLabels, getPrLabel } from './config.js';

export async function initializeJobContext(job: Job<IssueJobData>): Promise<JobContext> {
  const { id: jobId, name: jobName, data: issueRef } = job;
  const correlationId = issueRef.correlationId || generateCorrelationId();
  const correlatedLogger = logger.withCorrelation(correlationId);
  const stateManager = getStateManager();

  const primaryProcessingLabels = await getPrimaryProcessingLabels();
  const triggeringLabel = issueRef.triggeringLabel || primaryProcessingLabels[0] || 'AI';

  // Get agent alias from job data, or resolve from model name, or use default
  const registry = AgentRegistry.getInstance();
  await registry.ensureInitialized();

  let agentAlias = issueRef.agentAlias;
  let modelName = issueRef.modelName;

  // If agentAlias is missing but we have a modelName, try to resolve the agent from the model
  if (!agentAlias && modelName) {
    const resolution = await resolveLlmLabel(modelName);
    agentAlias = resolution.agentAlias;
    // Keep original modelName if it was specific, otherwise use resolved one
    correlatedLogger.debug({ originalModel: modelName, resolvedAgent: agentAlias }, 'Resolved agent from model name');
  }

  // Fallback to default agent if still missing
  if (!agentAlias) {
    // First, try to use the configured default agent from settings
    try {
      const settings = await loadSettings();
      if (settings.default_agent_alias) {
        const configuredAgent = registry.getAgentByAlias(settings.default_agent_alias as string);
        if (configuredAgent && configuredAgent.config.enabled) {
          agentAlias = settings.default_agent_alias as string;
          correlatedLogger.debug({ configuredDefaultAgent: agentAlias }, 'Using default agent from settings');
        }
      }
    } catch (settingsError) {
      correlatedLogger.debug({ error: (settingsError as Error).message }, 'Failed to load default agent from settings, using first available agent');
    }

    // If still no agent, fall back to the first valid enabled agent
    if (!agentAlias) {
      const allAgents = registry.getAllAgents();
      const firstValidAgent = allAgents.find((agent: Agent) => agent.config.enabled);
      if (firstValidAgent) {
        agentAlias = firstValidAgent.config.alias;
        correlatedLogger.debug({ firstValidAgent: agentAlias }, 'Using first valid enabled agent');
      } else {
        // Last resort: try the default agent from registry
        const defaultAgent = registry.getDefaultAgent();
        agentAlias = defaultAgent?.config.alias || 'claude';
        correlatedLogger.debug({ fallbackAgent: agentAlias }, 'No enabled agents found, using fallback');
      }
    }
  }

  // Get model if still missing (use agent's default model)
  const agent = registry.getAgentByAlias(agentAlias);
  modelName = modelName || agent?.config.defaultModel || DEFAULT_MODEL_NAME || undefined;
  if (!modelName) {
    throw new NoDefaultModelConfiguredError();
  }

  const taskId = `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}-${agentAlias}-${modelName}-${correlationId}`;

  return {
    jobId, jobName, issueRef, correlationId, correlatedLogger, stateManager, agentAlias, modelName, taskId,
    AI_PROCESSING_TAG: `${triggeringLabel}-processing`,
    AI_DONE_TAG: `${triggeringLabel}-done`,
    AI_WAITING_TAG: `${triggeringLabel}-waiting`,
    AI_PRIMARY_TAG: triggeringLabel,
    PR_LABEL: await getPrLabel()
  };
}
