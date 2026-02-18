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
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository']);
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

      // Check if multi-agent models array is provided
      const { models } = req.body as { models?: Array<{ agent_alias: string; model_name: string }> };

      if (models && Array.isArray(models) && models.length > 0) {
        // Multi-agent mode: apply labels for all selected agent:model combinations
        const labelLogger = logger.withCorrelation(`implement-multi-${draftId}-${issueNumber}`);

        // Collect all LLM labels from the old model (to remove) and new models (to add)
        const oldLlmLabel = getLlmLabel(planIssue.model_name);
        const newLlmLabels = new Set<string>();
        for (const m of models) {
          const label = getLlmLabel(m.model_name);
          if (label) newLlmLabels.add(label);
        }

        // Remove old label only if it's not in the new set
        const labelsToRemove = (oldLlmLabel && !newLlmLabels.has(oldLlmLabel)) ? [oldLlmLabel] : [];
        const labelsToAdd = [implementLabel, ...Array.from(newLlmLabels)];

        await safeUpdateLabels(
          { octokit, owner, repo, issueNumber, logger: labelLogger },
          labelsToRemove,
          labelsToAdd
        );

        // Update plan issue with the first model as primary
        const primaryModel = models[0];
        await updatePlanIssue(draftId, issueNumber, {
          status: 'processing',
          agent_alias: primaryModel.agent_alias,
          model_name: primaryModel.model_name
        });

        const labelList = Array.from(newLlmLabels).map(l => `'${l}'`).join(', ');
        res.json({
          success: true,
          message: `Added '${implementLabel}' and ${labelList} labels to issue #${issueNumber} (${models.length} agents assigned)`
        });
      } else {
        // Single-agent mode (original behavior)
        const llmLabel = getLlmLabel(planIssue.model_name);
        const labelsToAdd = llmLabel ? [implementLabel, llmLabel] : [implementLabel];

        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
          owner, repo, issue_number: issueNumber, labels: labelsToAdd
        });

        await updatePlanIssue(draftId, issueNumber, { status: 'processing' });
        const labelMessage = llmLabel
          ? `Added '${implementLabel}' and '${llmLabel}' labels to issue #${issueNumber}`
          : `Added '${implementLabel}' label to issue #${issueNumber}`;
        res.json({ success: true, message: labelMessage });
      }
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

      // Handle Epic PR creation if useEpic is true
      let epicLabelName: string | null = null;
      if (useEpic) {
        const planName = (draft.name as string) || 'Unnamed Plan';
        const firstIssueId = pendingIssues[0].issue_number;

        labelLogger.info({ owner, repo, planName, firstIssueId }, 'Creating Epic PR for batch implementation');
        const epicResult = await ensureEpicPR({
          owner,
          repoName: repo,
          firstIssueId,
          planName,
          correlationId
        });

        if (epicResult.success && epicResult.labelName) {
          epicLabelName = epicResult.labelName;
          labelLogger.info({ epicLabelName, prNumber: epicResult.prNumber }, 'Epic PR created successfully');
        } else {
          labelLogger.warn({ error: epicResult.error }, 'Failed to create Epic PR, continuing without epic labels');
        }
      }

      const results: { issueNumber: number; success: boolean; error?: string }[] = [];

      for (const issue of pendingIssues) {
        try {
          // Get LLM label based on the issue's model (or default model)
          const llmLabel = getLlmLabel(issue.model_name);
          const labelsToAdd = llmLabel ? [implementLabel, llmLabel] : [implementLabel];

          // Add epic base branch label if useEpic was successful
          if (epicLabelName) {
            labelsToAdd.push(epicLabelName);
          }

          // Add auto-merge label if autoMerge is true
          if (autoMerge) {
            labelsToAdd.push('auto-merge');
          }

          await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner, repo, issue_number: issue.issue_number, labels: labelsToAdd
          });
          await updatePlanIssue(draftId, issue.issue_number, { status: 'processing' });
          results.push({ issueNumber: issue.issue_number, success: true });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Unknown error';
          results.push({ issueNumber: issue.issue_number, success: false, error: errMsg });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;

      res.json({
        success: failedCount === 0,
        message: `Implemented ${successCount} issues${failedCount > 0 ? `, ${failedCount} failed` : ''}`,
        implemented: successCount,
        failed: failedCount,
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
