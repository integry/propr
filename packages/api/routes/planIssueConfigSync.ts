import {
  db,
  getAuthenticatedOctokit,
  logger,
  safeUpdateLabels,
  updatePlanIssue
} from '@propr/core';
import type { OwnershipResult } from './plannerHelpers.js';
import { getLlmLabel, getOrCreateEpicLabel } from './planIssueHelpers.js';

export interface PlanIssueDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

const IMPLEMENT_ALL_CONFIG_SYNC_BATCH_SIZE = 5;

export async function resolveEpicLabel(
  useEpic: boolean,
  params: {
    draftId: string;
    owner: string;
    repo: string;
    draft: Record<string, unknown>;
    firstIssueNumber: number;
    contextConfig: Record<string, unknown> | null;
    correlationId: string;
    labelLogger: ReturnType<typeof logger.withCorrelation>;
  }
): Promise<string | null> {
  if (!useEpic) return null;
  return getOrCreateEpicLabel({
    draftId: params.draftId,
    owner: params.owner,
    repo: params.repo,
    planName: (params.draft.name as string) || 'Unnamed Plan',
    firstIssueNumber: params.firstIssueNumber,
    contextConfig: params.contextConfig,
    correlationId: params.correlationId,
    labelLogger: params.labelLogger,
    db
  });
}

async function syncModelLabels(params: {
  draftId: string;
  issueNumber: number;
  repository: string;
  currentModelName: string | null;
  modelName: string | null;
  octokit?: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
}): Promise<void> {
  const [owner, repo] = params.repository.split('/');
  if (!owner || !repo) return;

  const [oldLabel, newLabel, octokit] = await Promise.all([
    getLlmLabel(params.currentModelName),
    getLlmLabel(params.modelName),
    params.octokit ? Promise.resolve(params.octokit) : getAuthenticatedOctokit()
  ]);

  const labelsToRemove = oldLabel && oldLabel !== newLabel ? [oldLabel] : [];
  const labelsToAdd = newLabel ? [newLabel] : [];
  if (labelsToRemove.length === 0 && labelsToAdd.length === 0) return;

  await safeUpdateLabels(
    {
      octokit,
      owner,
      repo,
      issueNumber: params.issueNumber,
      logger: logger.withCorrelation(`update-issue-${params.draftId}-${params.issueNumber}`)
    },
    labelsToRemove,
    labelsToAdd
  );
}

export async function updateIssueConfigWithRollback(params: {
  draftId: string;
  issueNumber: number;
  repository: string;
  currentIssue: {
    agent_alias?: string | null;
    model_name?: string | null;
  };
  updates: {
    agent_alias?: string | null;
    model_name?: string | null;
  };
  octokit?: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
}): Promise<void> {
  const hasAgentAliasUpdate = params.updates.agent_alias !== undefined;
  const hasModelNameUpdate = params.updates.model_name !== undefined;
  const nextAgentAlias = hasAgentAliasUpdate ? params.updates.agent_alias ?? null : params.currentIssue.agent_alias ?? null;
  const nextModelName = hasModelNameUpdate ? params.updates.model_name ?? null : params.currentIssue.model_name ?? null;

  if (
    nextAgentAlias === (params.currentIssue.agent_alias ?? null)
    && nextModelName === (params.currentIssue.model_name ?? null)
  ) {
    return;
  }

  if (!hasModelNameUpdate) {
    const nextIssue = await updatePlanIssue(params.draftId, params.issueNumber, params.updates);
    if (!nextIssue) {
      throw new Error('Issue not found in this plan');
    }
    return;
  }

  const octokit = params.octokit ?? await getAuthenticatedOctokit();

  await syncModelLabels({
    draftId: params.draftId,
    issueNumber: params.issueNumber,
    repository: params.repository,
    currentModelName: params.currentIssue.model_name ?? null,
    modelName: nextModelName,
    octokit
  });

  try {
    const nextIssue = await updatePlanIssue(params.draftId, params.issueNumber, params.updates);
    if (!nextIssue) {
      throw new Error('Issue not found in this plan');
    }
  } catch (error) {
    try {
      await syncModelLabels({
        draftId: params.draftId,
        issueNumber: params.issueNumber,
        repository: params.repository,
        currentModelName: nextModelName,
        modelName: params.currentIssue.model_name ?? null,
        octokit
      });
    } catch (rollbackError) {
      logger.error(
        {
          draftId: params.draftId,
          issueNumber: params.issueNumber,
          error: (rollbackError as Error).message
        },
        'Failed to roll back GitHub labels after plan issue config update failure'
      );
    }
    throw error;
  }
}

export async function syncPendingIssueConfigs(params: {
  draftId: string;
  repository: string;
  pendingIssues: Array<{
    issue_number: number;
    agent_alias?: string | null;
    model_name?: string | null;
  }>;
  updates: {
    agent_alias?: string | null;
    model_name?: string | null;
  };
}): Promise<void> {
  if (params.pendingIssues.length === 0) return;

  const octokit = params.updates.model_name !== undefined
    ? await getAuthenticatedOctokit()
    : undefined;

  for (let index = 0; index < params.pendingIssues.length; index += IMPLEMENT_ALL_CONFIG_SYNC_BATCH_SIZE) {
    const issueBatch = params.pendingIssues.slice(index, index + IMPLEMENT_ALL_CONFIG_SYNC_BATCH_SIZE);
    await Promise.all(issueBatch.map((issue) => updateIssueConfigWithRollback({
      draftId: params.draftId,
      issueNumber: issue.issue_number,
      repository: params.repository,
      currentIssue: issue,
      updates: params.updates,
      octokit
    })));
  }
}
