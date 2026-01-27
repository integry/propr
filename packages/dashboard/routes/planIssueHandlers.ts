import { Request, Response } from 'express';
import {
  getPlanIssuesByDraft,
  getPlanIssue,
  updatePlanIssue,
  batchUpdatePlanIssueConfig,
  loadPrimaryProcessingLabels,
  getAuthenticatedOctokit,
  MODEL_INFO_MAP,
  getDefaultModel
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

      const issues = await getPlanIssuesByDraft(req.params.id);
      res.json(issues);
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

      // Get LLM label based on the issue's model (or default model)
      const llmLabel = getLlmLabel(planIssue.model_name);
      const labelsToAdd = llmLabel ? [implementLabel, llmLabel] : [implementLabel];

      const octokit = await getAuthenticatedOctokit();
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner, repo, issue_number: issueNumber, labels: labelsToAdd
      });

      await updatePlanIssue(draftId, issueNumber, { status: 'processing' });
      const labelMessage = llmLabel
        ? `Added '${implementLabel}' and '${llmLabel}' labels to issue #${issueNumber}`
        : `Added '${implementLabel}' label to issue #${issueNumber}`;
      res.json({ success: true, message: labelMessage });
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
      const ownership = await deps.verifyOwnership(draftId, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const { agent_alias, model_name, status } = req.body;

      const validStatuses: PlanIssueStatus[] = ['pending', 'processing', 'under_review', 'in_refinement', 'refinement_processing', 'merged', 'closed'];
      if (status && !validStatuses.includes(status)) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        return;
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
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const repository = draft.repository as string;
      const [owner, repo] = repository.split('/');

      if (!owner || !repo) { res.status(400).json({ error: 'Invalid repository format' }); return; }

      const { agent_alias, model_name } = req.body;

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
      const results: { issueNumber: number; success: boolean; error?: string }[] = [];

      for (const issue of pendingIssues) {
        try {
          // Get LLM label based on the issue's model (or default model)
          const llmLabel = getLlmLabel(issue.model_name);
          const labelsToAdd = llmLabel ? [implementLabel, llmLabel] : [implementLabel];

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
        results
      });
    } catch (error) {
      console.error('Implement all issues error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to implement issues' });
    }
  };
}
