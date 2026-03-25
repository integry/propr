import { Request, Response } from 'express';
import {
  getPlanIssuesByDraft,
  getPlanIssuesByDraftPaginated,
  getPlanIssue,
  updatePlanIssue,
  batchUpdatePlanIssueConfig,
  loadPrimaryProcessingLabels,
  getAuthenticatedOctokit,
  safeUpdateLabels,
  logger
} from '@propr/core';
import { PlanIssueStatus } from '@propr/core';
import type { OwnershipResult } from './plannerHelpers.js';
import {
  getLlmLabel,
  handleMultiAgentImplementation,
  handleSingleAgentImplementation,
  handleEpicPRCreation,
  processBatchIssues,
  type ImplementIssueContext
} from './planIssueHelpers.js';

interface PlanIssueDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
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
          const validStatuses: PlanIssueStatus[] = Object.values(PlanIssueStatus);
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

      const validStatuses: PlanIssueStatus[] = Object.values(PlanIssueStatus);
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
      const pendingIssues = issues.filter(issue => issue.status === PlanIssueStatus.PENDING);

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
        ? await handleEpicPRCreation({
            owner,
            repo,
            planName: (draft.name as string) || 'Unnamed Plan',
            issueNumber: pendingIssues[0].issue_number,
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
