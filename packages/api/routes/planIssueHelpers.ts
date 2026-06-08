import {
  getAuthenticatedOctokit,
  MODEL_INFO_MAP,
  safeUpdateLabels,
  logger,
  ensureEpicPR,
  updatePlanIssue,
  PlanIssueStatus,
  loadSettings,
  AgentRegistry,
  toProprOpenCodeModelId,
  getIssueQueue,
  generateCorrelationId
} from '@propr/core';

const MAX_GITHUB_LABEL_LENGTH = 50;

export interface ImplementIssueContext {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repo: string;
  issueNumber: number;
  implementLabel: string;
  epicLabelName: string | null;
  autoMerge: boolean;
  labelLogger: ReturnType<typeof logger.withCorrelation>;
}

export interface MultiAgentParams extends ImplementIssueContext {
  draftId: string;
  planIssue: { agent_alias: string | null; model_name: string | null };
  models: Array<{ agent_alias: string; model_name: string }>;
}

export interface SingleAgentParams extends ImplementIssueContext {
  draftId: string;
  planIssue: { agent_alias: string | null; model_name: string | null };
}

export interface EpicPRParams {
  owner: string;
  repo: string;
  planName: string;
  issueNumber: number;
  correlationId: string;
  labelLogger: ReturnType<typeof logger.withCorrelation>;
}

async function enqueueIssueImplementationJob(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  triggeringLabel: string;
}): Promise<void> {
  const { owner, repo, issueNumber, triggeringLabel } = params;
  const queue = await getIssueQueue();
  const jobId = `issue-${owner}-${repo}-${issueNumber}`;
  await queue.add('processGitHubIssue', {
    repoOwner: owner,
    repoName: repo,
    number: issueNumber,
    triggeringLabel,
    correlationId: generateCorrelationId()
  }, {
    jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: true
  });
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildDynamicLlmLabel(agentAlias: string, labelModel: string): string {
  const canonicalLabel = `llm-${agentAlias}:${labelModel}`;
  if (canonicalLabel.length <= MAX_GITHUB_LABEL_LENGTH) return canonicalLabel;

  const hash = shortHash(labelModel);
  const maxAliasLength = Math.max(1, MAX_GITHUB_LABEL_LENGTH - `llm-:-x-${hash}`.length);
  const labelAlias = agentAlias
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, maxAliasLength)
    .replace(/[^a-zA-Z0-9]+$/, '') || 'agent';
  const prefixBudget = MAX_GITHUB_LABEL_LENGTH - `llm-${labelAlias}:-${hash}`.length;
  const modelPrefix = labelModel
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, Math.max(1, prefixBudget))
    .replace(/[^a-zA-Z0-9]+$/, '');
  return `llm-${labelAlias}:${modelPrefix || 'model'}-${hash}`;
}

/**
 * Gets the default model from the configured default agent.
 * Falls back to 'claude-sonnet-4-6' if no default agent is configured.
 */
async function getConfiguredDefaultModel(): Promise<string> {
  try {
    const settings = await loadSettings();
    const defaultAgentAlias = settings.default_agent_alias as string | undefined;

    if (defaultAgentAlias) {
      const registry = AgentRegistry.getInstance();
      await registry.ensureInitialized();
      const agent = registry.getAgentByAlias(defaultAgentAlias);

      if (agent?.config.defaultModel) {
        return agent.config.defaultModel;
      }
    }
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Failed to get configured default model, using fallback');
  }

  return 'claude-sonnet-4-6'; // Fallback
}

/**
 * Gets the LLM GitHub label for a given model name.
 * Falls back to the default agent's model if model_name is null.
 */
export async function getLlmLabel(modelName: string | null): Promise<string | null> {
  const effectiveModel = modelName || await getConfiguredDefaultModel();
  const modelInfo = MODEL_INFO_MAP[effectiveModel];
  if (modelInfo?.githubLabel) return modelInfo.githubLabel;

  try {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const agent = registry.getAllAgents().find(a =>
      a.config.supportedModels.some(model => {
        if (model.toLowerCase() === effectiveModel.toLowerCase()) return true;
        return a.config.type === 'opencode' && model.toLowerCase() === toProprOpenCodeModelId(effectiveModel).toLowerCase();
      })
    );
    const labelModel = agent?.config.type === 'opencode' ? toProprOpenCodeModelId(effectiveModel) : effectiveModel;
    return agent ? buildDynamicLlmLabel(agent.config.alias, labelModel) : null;
  } catch (err) {
    logger.warn({ modelName: effectiveModel, error: (err as Error).message }, 'Failed to resolve dynamic LLM label');
    return null;
  }
}

export async function handleMultiAgentImplementation(params: MultiAgentParams): Promise<{
  success: boolean;
  message: string;
  autoMergeEnabled: boolean;
  epicLabel: string | null;
}> {
  const { octokit, owner, repo, issueNumber, implementLabel, epicLabelName, autoMerge, labelLogger, draftId, planIssue, models } = params;

  const oldLlmLabel = await getLlmLabel(planIssue.model_name);
  const newLlmLabels = new Set<string>();
  for (const m of models) {
    const label = await getLlmLabel(m.model_name);
    if (label) newLlmLabels.add(label);
  }

  const labelsToRemove = [`${implementLabel}-processing`, `${implementLabel}-done`];
  if (oldLlmLabel && !newLlmLabels.has(oldLlmLabel)) labelsToRemove.push(oldLlmLabel);
  const labelsToAdd = [implementLabel, ...Array.from(newLlmLabels)];

  if (epicLabelName) {
    labelsToAdd.push(epicLabelName);
  }

  if (autoMerge) {
    labelsToAdd.push('auto-merge');
  }

  await safeUpdateLabels(
    { octokit, owner, repo, issueNumber, logger: labelLogger },
    labelsToRemove,
    labelsToAdd
  );

  await enqueueIssueImplementationJob({ owner, repo, issueNumber, triggeringLabel: implementLabel });

  const primaryModel = models[0];
  await updatePlanIssue(draftId, issueNumber, {
    status: PlanIssueStatus.PROCESSING,
    agent_alias: primaryModel.agent_alias,
    model_name: primaryModel.model_name
  });

  const labelList = Array.from(newLlmLabels).map(l => `'${l}'`).join(', ');
  const autoMergeNote = autoMerge ? ' with auto-merge enabled' : '';

  return {
    success: true,
    message: `Added '${implementLabel}' and ${labelList} labels to issue #${issueNumber} (${models.length} agents assigned)${autoMergeNote}`,
    autoMergeEnabled: autoMerge,
    epicLabel: epicLabelName
  };
}

export async function handleSingleAgentImplementation(params: SingleAgentParams): Promise<{
  success: boolean;
  message: string;
  autoMergeEnabled: boolean;
  epicLabel: string | null;
}> {
  const { octokit, owner, repo, issueNumber, implementLabel, epicLabelName, autoMerge, draftId, planIssue } = params;

  const llmLabel = await getLlmLabel(planIssue.model_name);
  const labelsToAdd = llmLabel ? [implementLabel, llmLabel] : [implementLabel];

  if (epicLabelName) {
    labelsToAdd.push(epicLabelName);
  }

  if (autoMerge) {
    labelsToAdd.push('auto-merge');
  }

  await safeUpdateLabels(
    { octokit, owner, repo, issueNumber, logger: logger.withCorrelation(`implement-single-${draftId}-${issueNumber}`) },
    [`${implementLabel}-processing`, `${implementLabel}-done`],
    labelsToAdd
  );

  await enqueueIssueImplementationJob({ owner, repo, issueNumber, triggeringLabel: implementLabel });

  // Update status and also persist agent_alias/model_name if provided
  const updateData: Record<string, unknown> = { status: PlanIssueStatus.PROCESSING };
  if (planIssue.agent_alias) updateData.agent_alias = planIssue.agent_alias;
  if (planIssue.model_name) updateData.model_name = planIssue.model_name;
  await updatePlanIssue(draftId, issueNumber, updateData);

  const autoMergeNote = autoMerge ? ' with auto-merge enabled' : '';
  const labelMessage = llmLabel
    ? `Added '${implementLabel}' and '${llmLabel}' labels to issue #${issueNumber}${autoMergeNote}`
    : `Added '${implementLabel}' label to issue #${issueNumber}${autoMergeNote}`;

  return {
    success: true,
    message: labelMessage,
    autoMergeEnabled: autoMerge,
    epicLabel: epicLabelName
  };
}

export async function handleEpicPRCreation(params: EpicPRParams): Promise<string | null> {
  const { owner, repo, planName, issueNumber, correlationId, labelLogger } = params;

  labelLogger.info({ owner, repo, planName, issueNumber }, 'Creating Epic PR for implementation');
  const epicResult = await ensureEpicPR({
    owner,
    repoName: repo,
    firstIssueId: issueNumber,
    planName,
    correlationId
  });

  if (epicResult.success && epicResult.labelName) {
    labelLogger.info({ epicLabelName: epicResult.labelName, prNumber: epicResult.prNumber }, 'Epic PR created successfully');
    return epicResult.labelName;
  }

  labelLogger.warn({ error: epicResult.error }, 'Failed to create Epic PR, continuing without epic labels');
  return null;
}

export interface GetOrCreateEpicLabelParams {
  draftId: string;
  owner: string;
  repo: string;
  planName: string;
  firstIssueNumber: number;
  contextConfig: Record<string, unknown> | null;
  correlationId: string;
  labelLogger: ReturnType<typeof logger.withCorrelation>;
  db: typeof import('@propr/core').db;
}

/**
 * Gets the existing epic label from context_config or creates a new one if needed.
 * Stores the epic label back to context_config for reuse by subsequent issues.
 */
export async function getOrCreateEpicLabel(params: GetOrCreateEpicLabelParams): Promise<string | null> {
  const { draftId, owner, repo, planName, firstIssueNumber, contextConfig, correlationId, labelLogger, db } = params;

  // Check if epic label already exists in context_config
  if (contextConfig?.epicLabel && typeof contextConfig.epicLabel === 'string') {
    labelLogger.info({ epicLabel: contextConfig.epicLabel }, 'Using existing epic label from draft');
    return contextConfig.epicLabel;
  }

  // Create new epic PR and label
  const epicLabelName = await handleEpicPRCreation({
    owner,
    repo,
    planName,
    issueNumber: firstIssueNumber,
    correlationId,
    labelLogger
  });

  // Store the epic label in context_config for reuse
  if (epicLabelName && db) {
    try {
      const updatedConfig = { ...contextConfig, epicLabel: epicLabelName };
      await db('task_drafts')
        .where({ draft_id: draftId })
        .update({
          context_config: JSON.stringify(updatedConfig),
          updated_at: db.fn.now()
        });
      labelLogger.info({ draftId, epicLabel: epicLabelName }, 'Stored epic label in draft context_config');
    } catch (err) {
      labelLogger.warn({ error: (err as Error).message }, 'Failed to store epic label in context_config');
    }
  }

  return epicLabelName;
}
