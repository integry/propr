import { Request, Response } from 'express';
import {
  getPlanIssuesByDraft,
  getPlanIssuesByDraftPaginated,
  getPlanIssue,
  updatePlanIssue,
  batchUpdatePlanIssueConfig,
  loadPrimaryProcessingLabels,
  getAuthenticatedOctokit,
  MODEL_INFO_MAP,
  getDefaultModel,
  safeUpdateLabels,
  logger,
  ensureEpicPR
} from '@gitfix/core';
import type { PlanIssueStatus } from '@gitfix/core';
import type { OwnershipResult } from './plannerHelpers.js';

interface PlanIssueDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

interface ImplementIssueContext {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repo: string;
  issueNumber: number;
  implementLabel: string;
  epicLabelName: string | null;
  autoMerge: boolean;
  labelLogger: ReturnType<typeof logger.withCorrelation>;
}

interface MultiAgentParams extends ImplementIssueContext {
  draftId: string;
  planIssue: { model_name: string | null };
  models: Array<{ agent_alias: string; model_name: string }>;
}

async function handleMultiAgentImplementation(params: MultiAgentParams): Promise<{
  success: boolean;
  message: string;
  autoMergeEnabled: boolean;
  epicLabel: string | null;
}> {
  const { octokit, owner, repo, issueNumber, implementLabel, epicLabelName, autoMerge, labelLogger, draftId, planIssue, models } = params;

  const oldLlmLabel = getLlmLabel(planIssue.model_name);
  const newLlmLabels = new Set<string>();
  for (const m of models) {
    const label = getLlmLabel(m.model_name);
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
    status: 'processing',
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

interface SingleAgentParams extends ImplementIssueContext {
  draftId: string;
  planIssue: { model_name: string | null };
}

async function handleSingleAgentImplementation(params: SingleAgentParams): Promise<{
  success: boolean;
  message: string;
  autoMergeEnabled: boolean;
  epicLabel: string | null;
}> {
  const { octokit, owner, repo, issueNumber, implementLabel, epicLabelName, autoMerge, draftId, planIssue } = params;

  const llmLabel = getLlmLabel(planIssue.model_name);
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

  await updatePlanIssue(draftId, issueNumber, { status: 'processing' });

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

interface EpicPRParams {
  owner: string;
  repo: string;
  planName: string;
  issueNumber: number;
  correlationId: string;
  labelLogger: ReturnType<typeof logger.withCorrelation>;
}

async function handleEpicPRCreation(params: EpicPRParams): Promise<string | null> {
  const { owner, repo, planName, issueNumber, correlationId, labelLogger } = params;

  labelLogger.info({ owner, repo, planName, issueNumber }, 'Creating Epic PR for single issue implementation');
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

/**
 * Gets the LLM GitHub label for a given model name.
 * Falls back to the default model's label if model_name is null.
 */
function getLlmLabel(modelName: string | null): string | null {
  const effectiveModel = modelName || getDefaultModel();
  const modelInfo = MODEL_INFO_MAP[effectiveModel];
  return modelInfo?.githubLabel || null;
}

export function createGetIssuesHandler(deps: PlanIssueDeps) {
  return async function getIssues(req: Request, res: Response): Promise<void> {
    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      // Check for pagination query params
      const { page, limit, status } = req.query;
      const hasPagination = page !== undefined || limit !== undefined;

      if (hasPagination) {
        // Return paginated response
        const pageNum = page ? parseInt(page as string, 10) : 0;
        const limitNum = limit ? parseInt(limit as string, 10) : 50;

        const options: { page?: number; limit?: number; status?: PlanIssueStatus } = {
          page: isNaN(pageNum) ? 0 : pageNum,
          limit: isNaN(limitNum) ? 50 : Math.min(limitNum, 100)
        };

        if (status) {
          const validStatuses: PlanIssueStatus[] = ['pending', 'processing', 'under_review', 'in_refinement', 'refinement_processing', 'merged', 'closed'];
          if (validStatuses.includes(status as PlanIssueStatus)) {
            options.status = status as PlanIssueStatus;
          }
        }

        const result = await getPlanIssuesByDraftPaginated(req.params.id, options);
        res.json(result);
      } else {
        // Return all issues for backward compatibility
        const issues = await getPlanIssuesByDraft(req.params.id);
        res.json(issues);
      }
    } catch (error) {
      console.error('Get issues error:', error);
      res.status(500).json({ error: 'Failed to fetch issues' });
    }
  };
}

export function createImplementIssueHandler(deps: PlanIssueDeps) {
  return async function implementIssue(req: Request, res: Response): Promise<void> {
    const draftId = req.params.id;
    const issueNumber = parseInt(req.params.issueNumber, 10);

    if (isNaN(issueNumber)) { res.status(400).json({ error: 'Invalid issue number' }); return; }

    try {
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository', 'name']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const repository = draft.repository as string;
      const [owner, repo] = repository.split('/');

      if (!owner || !repo) { res.status(400).json({ error: 'Invalid repository format' }); return; }

      const planIssue = await getPlanIssue(draftId, issueNumber);
      if (!planIssue) { res.status(404).json({ error: 'Issue not found in this plan' }); return; }

      const processingLabels = await loadPrimaryProcessingLabels();
      const implementLabel = processingLabels[0] || 'AI';
      const octokit = await getAuthenticatedOctokit();

      const { models, autoMerge, useEpic } = req.body as {
        models?: Array<{ agent_alias: string; model_name: string }>;
        autoMerge?: boolean;
        useEpic?: boolean;
      };

      const correlationId = `implement-${draftId}-${issueNumber}`;
      const labelLogger = logger.withCorrelation(correlationId);

      const epicLabelName = useEpic
        ? await handleEpicPRCreation({
            owner,
            repo,
            planName: (draft.name as string) || 'Unnamed Plan',
            issueNumber,
            correlationId,
            labelLogger
          })
        : null;

      const context: ImplementIssueContext = {
        octokit, owner, repo, issueNumber, implementLabel, epicLabelName, autoMerge: autoMerge || false, labelLogger
      };

      const result = (models && Array.isArray(models) && models.length > 0)
        ? await handleMultiAgentImplementation({ ...context, draftId, planIssue, models })
        : await handleSingleAgentImplementation({ ...context, draftId, planIssue });

      res.json(result);
    } catch (error) {
      console.error('Implement issue error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to implement issue' });
    }
  };
}

export function createUpdateIssueHandler(deps: PlanIssueDeps) {
  return async function updateIssueHandler(req: Request, res: Response): Promise<void> {
    const draftId = req.params.id;
    const issueNumber = parseInt(req.params.issueNumber, 10);

    if (isNaN(issueNumber)) { res.status(400).json({ error: 'Invalid issue number' }); return; }

    try {
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const { agent_alias, model_name, status } = req.body;

      const validStatuses: PlanIssueStatus[] = ['pending', 'processing', 'under_review', 'in_refinement', 'refinement_processing', 'merged', 'closed'];
      if (status && !validStatuses.includes(status)) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        return;
      }

      // Get current plan issue to compare model changes
      const currentIssue = await getPlanIssue(draftId, issueNumber);
      if (!currentIssue) { res.status(404).json({ error: 'Issue not found in this plan' }); return; }

      // Update GitHub labels when model_name is provided
      // Always ensure the correct label is set, even if model_name hasn't changed (sync behavior)
      if (model_name !== undefined) {
        const draft = ownership.draft!;
        const repository = draft.repository as string;
        const [owner, repo] = repository.split('/');

        if (owner && repo) {
          const oldLabel = getLlmLabel(currentIssue.model_name);
          const newLabel = getLlmLabel(model_name);
          const octokit = await getAuthenticatedOctokit();
          const labelLogger = logger.withCorrelation(`update-issue-${draftId}-${issueNumber}`);

          // Only remove old label if it's different from new label
          const labelsToRemove = (oldLabel && oldLabel !== newLabel) ? [oldLabel] : [];
          const labelsToAdd = newLabel ? [newLabel] : [];

          if (labelsToRemove.length > 0 || labelsToAdd.length > 0) {
            await safeUpdateLabels(
              { octokit, owner, repo, issueNumber, logger: labelLogger },
              labelsToRemove,
              labelsToAdd
            );
          }
        }
      }

      const updated = await updatePlanIssue(draftId, issueNumber, {
        agent_alias: agent_alias !== undefined ? agent_alias : undefined,
        model_name: model_name !== undefined ? model_name : undefined,
        status: status !== undefined ? status : undefined
      });

      if (!updated) { res.status(404).json({ error: 'Issue not found in this plan' }); return; }
      res.json(updated);
    } catch (error) {
      console.error('Update issue error:', error);
      res.status(500).json({ error: 'Failed to update issue' });
    }
  };
}

interface ProcessIssueParams {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repo: string;
  draftId: string;
  issue: { issue_number: number; model_name: string | null };
  implementLabel: string;
  epicLabelName: string | null;
  autoMerge: boolean;
}

async function processIssueForImplementation(params: ProcessIssueParams): Promise<{ issueNumber: number; success: boolean; error?: string }> {
  const { octokit, owner, repo, draftId, issue, implementLabel, epicLabelName, autoMerge } = params;

  try {
    const llmLabel = getLlmLabel(issue.model_name);
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
    await updatePlanIssue(draftId, issue.issue_number, { status: 'processing' });
    return { issueNumber: issue.issue_number, success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    return { issueNumber: issue.issue_number, success: false, error: errMsg };
  }
}

interface BatchEpicParams {
  owner: string;
  repo: string;
  planName: string;
  firstIssueId: number;
  correlationId: string;
  labelLogger: ReturnType<typeof logger.withCorrelation>;
}

async function handleBatchEpicPRCreation(params: BatchEpicParams): Promise<string | null> {
  const { owner, repo, planName, firstIssueId, correlationId, labelLogger } = params;

  labelLogger.info({ owner, repo, planName, firstIssueId }, 'Creating Epic PR for batch implementation');
  const epicResult = await ensureEpicPR({
    owner,
    repoName: repo,
    firstIssueId,
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

interface BatchProcessParams {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repo: string;
  draftId: string;
  pendingIssues: Array<{ issue_number: number; model_name: string | null }>;
  implementLabel: string;
  epicLabelName: string | null;
  autoMerge: boolean;
}

async function processBatchIssues(params: BatchProcessParams): Promise<{
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

export function createImplementAllIssuesHandler(deps: PlanIssueDeps) {
  return async function implementAllIssues(req: Request, res: Response): Promise<void> {
    const draftId = req.params.id;

    try {
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository', 'name']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const repository = draft.repository as string;
      const [owner, repo] = repository.split('/');

      if (!owner || !repo) { res.status(400).json({ error: 'Invalid repository format' }); return; }

      const { agent_alias, model_name, useEpic, autoMerge } = req.body;

      if (agent_alias !== undefined || model_name !== undefined) {
        await batchUpdatePlanIssueConfig(draftId, agent_alias, model_name);
      }

      const issues = await getPlanIssuesByDraft(draftId);
      const pendingIssues = issues.filter(issue => issue.status === 'pending');

      if (pendingIssues.length === 0) {
        res.json({ success: true, message: 'No pending issues to implement', implemented: 0 });
        return;
      }

      const processingLabels = await loadPrimaryProcessingLabels();
      const implementLabel = processingLabels[0] || 'AI';
      const octokit = await getAuthenticatedOctokit();
      const correlationId = `implement-all-${draftId}`;
      const labelLogger = logger.withCorrelation(correlationId);

      const epicLabelName = useEpic
        ? await handleBatchEpicPRCreation({
            owner,
            repo,
            planName: (draft.name as string) || 'Unnamed Plan',
            firstIssueId: pendingIssues[0].issue_number,
            correlationId,
            labelLogger
          })
        : null;

      const { results, queuedCount } = await processBatchIssues({
        octokit, owner, repo, draftId, pendingIssues, implementLabel, epicLabelName, autoMerge: autoMerge || false
      });

      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;
      const queuedMessage = queuedCount > 0 ? ` (${queuedCount} more queued for sequential processing)` : '';

      res.json({
        success: failedCount === 0,
        message: `Implemented ${successCount} issues${failedCount > 0 ? `, ${failedCount} failed` : ''}${queuedMessage}`,
        implemented: successCount,
        failed: failedCount,
        queued: queuedCount,
        results,
        epicLabel: epicLabelName,
        autoMergeEnabled: autoMerge || false
      });
    } catch (error) {
      console.error('Implement all issues error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to implement issues' });
    }
  };
}
