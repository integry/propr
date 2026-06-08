import {
  getAuthenticatedOctokit,
  MODEL_INFO_MAP,
  safeUpdateLabels,
  logger,
  ensureEpicPR,
  updatePlanIssue,
  PlanIssueStatus,
  loadSettings,
  AgentRegistry
} from '@propr/core';

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

export interface ProcessIssueParams {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repo: string;
  draftId: string;
  issue: { issue_number: number; model_name: string | null };
  implementLabel: string;
  epicLabelName: string | null;
  autoMerge: boolean;
}

export interface BatchProcessParams {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repo: string;
  draftId: string;
  pendingIssues: Array<{ issue_number: number; model_name: string | null }>;
  implementLabel: string;
  epicLabelName: string | null;
  autoMerge: boolean;
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
  return modelInfo?.githubLabel || null;
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

  const labelsToRemove = (oldLlmLabel && !newLlmLabels.has(oldLlmLabel)) ? [oldLlmLabel] : [];
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

  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
    owner, repo, issue_number: issueNumber, labels: labelsToAdd
  });

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

export async function processIssueForImplementation(params: ProcessIssueParams): Promise<{ issueNumber: number; success: boolean; error?: string }> {
  const { octokit, owner, repo, draftId, issue, implementLabel, epicLabelName, autoMerge } = params;

  try {
    const llmLabel = await getLlmLabel(issue.model_name);
    const labelsToAdd = llmLabel ? [implementLabel, llmLabel] : [implementLabel];

    if (epicLabelName) {
      labelsToAdd.push(epicLabelName);
    }

    if (autoMerge) {
      labelsToAdd.push('auto-merge');
    }

    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
      owner, repo, issue_number: issue.issue_number, labels: labelsToAdd
    });
    await updatePlanIssue(draftId, issue.issue_number, { status: PlanIssueStatus.PROCESSING });
    return { issueNumber: issue.issue_number, success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    return { issueNumber: issue.issue_number, success: false, error: errMsg };
  }
}

export async function processBatchIssues(params: BatchProcessParams): Promise<{
  results: Array<{ issueNumber: number; success: boolean; error?: string }>;
  queuedCount: number;
}> {
  const { octokit, owner, repo, draftId, pendingIssues, implementLabel, epicLabelName, autoMerge } = params;
  const results: Array<{ issueNumber: number; success: boolean; error?: string }> = [];

  // When auto-merge is enabled with an epic, only trigger the first issue.
  // The rest will be triggered sequentially as each PR is merged.
  // This prevents merge conflicts from parallel processing.
  const issuesToProcess = (autoMerge && epicLabelName) ? [pendingIssues[0]] : pendingIssues;

  for (const issue of issuesToProcess) {
    const result = await processIssueForImplementation({
      octokit, owner, repo, draftId, issue, implementLabel, epicLabelName, autoMerge
    });
    results.push(result);
  }

  const queuedCount = (autoMerge && epicLabelName) ? pendingIssues.length - 1 : 0;
  return { results, queuedCount };
}
