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
  logger,
  db
} from '@propr/core';
import { PlanIssueStatus } from '@propr/core';
import type { OwnershipResult } from './plannerHelpers.js';
import {
  getLlmLabel,
  handleMultiAgentImplementation,
  handleSingleAgentImplementation,
  processBatchIssues,
  type ImplementIssueContext,
  getOrCreateEpicLabel
} from './planIssueHelpers.js';
import {
  buildIssueUpdate,
  ContextConfigParseError,
  parseContextConfig,
  resolveAndPersistIssueUltrafixSettings,
  resolveImplementationSettings,
  ULTRAFIX_GOAL_MAX,
  ULTRAFIX_GOAL_MIN,
  ULTRAFIX_MAX_CYCLES_MIN,
  type UpdateIssueRequestBody,
  validateRunUltrafixValue,
  validateUltrafixValue
} from './planIssueRouteUtils.js';

interface PlanIssueDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

async function resolveEpicLabel(
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

function validateIssueStatus(status: PlanIssueStatus | undefined): string | null {
  const validStatuses: PlanIssueStatus[] = Object.values(PlanIssueStatus);
  return status && !validStatuses.includes(status)
    ? `Invalid status. Must be one of: ${validStatuses.join(', ')}`
    : null;
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

async function syncModelLabelsForIssues(params: {
  draftId: string;
  repository: string;
  issues: Array<{ issue_number: number; model_name?: string | null }>;
  modelName: string | null;
}): Promise<void> {
  const octokit = await getAuthenticatedOctokit();
  const maxConcurrentUpdates = 5;

  for (let index = 0; index < params.issues.length; index += maxConcurrentUpdates) {
    const batch = params.issues.slice(index, index + maxConcurrentUpdates);
    await Promise.all(
      batch.map((issue) =>
        syncModelLabels({
          draftId: params.draftId,
          issueNumber: issue.issue_number,
          repository: params.repository,
          currentModelName: issue.model_name ?? null,
          modelName: params.modelName,
          octokit
        })
      )
    );
  }
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
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository', 'name', 'context_config']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const repository = draft.repository as string;
      const [owner, repo] = repository.split('/');

      if (!owner || !repo) { res.status(400).json({ error: 'Invalid repository format' }); return; }

      const contextConfig = parseContextConfig(draft.context_config);

      const planIssue = await getPlanIssue(draftId, issueNumber);
      if (!planIssue) { res.status(404).json({ error: 'Issue not found in this plan' }); return; }
      const issueForImplementation = await resolveAndPersistIssueUltrafixSettings(draftId, planIssue, contextConfig);

      const processingLabels = await loadPrimaryProcessingLabels();
      const implementLabel = processingLabels[0] || 'AI';
      const octokit = await getAuthenticatedOctokit();

      const { models } = req.body as { models?: Array<{ agent_alias: string; model_name: string }> };
      const { useEpic, autoMerge } = resolveImplementationSettings(req.body, contextConfig);

      const correlationId = `implement-${draftId}-${issueNumber}`;
      const labelLogger = logger.withCorrelation(correlationId);

      // Get existing epic label or create new one (using first pending issue number for consistency)
      const allIssues = await getPlanIssuesByDraft(draftId);
      const pendingIssues = allIssues.filter(i => i.status === PlanIssueStatus.PENDING);
      const firstIssueNumber = pendingIssues.length > 0 ? pendingIssues[0].issue_number : issueNumber;

      const epicLabelName = await resolveEpicLabel(useEpic, {
        draftId, owner, repo, draft: draft as Record<string, unknown>,
        firstIssueNumber, contextConfig, correlationId, labelLogger
      });

      const context: ImplementIssueContext = {
        octokit, owner, repo, issueNumber, implementLabel, epicLabelName, autoMerge: autoMerge as boolean, labelLogger
      };

      const result = (models && Array.isArray(models) && models.length > 0)
        ? await handleMultiAgentImplementation({ ...context, draftId, planIssue: issueForImplementation, models })
        : await handleSingleAgentImplementation({ ...context, draftId, planIssue: issueForImplementation });

      res.json(result);
    } catch (error) {
      if (error instanceof ContextConfigParseError) {
        res.status(409).json({ error: error.message });
        return;
      }
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

      const body = req.body as UpdateIssueRequestBody;
      const statusError = validateIssueStatus(body.status);
      if (statusError) { res.status(400).json({ error: statusError }); return; }
      const runUltrafixError = validateRunUltrafixValue(body.run_ultrafix);
      if (runUltrafixError) { res.status(400).json({ error: runUltrafixError }); return; }
      const ultrafixGoalError = validateUltrafixValue(body.ultrafix_goal, 'ultrafix_goal', { minimum: ULTRAFIX_GOAL_MIN, maximum: ULTRAFIX_GOAL_MAX });
      if (ultrafixGoalError) { res.status(400).json({ error: ultrafixGoalError }); return; }
      const ultrafixMaxCyclesError = validateUltrafixValue(body.ultrafix_max_cycles, 'ultrafix_max_cycles', { minimum: ULTRAFIX_MAX_CYCLES_MIN });
      if (ultrafixMaxCyclesError) { res.status(400).json({ error: ultrafixMaxCyclesError }); return; }

      const currentIssue = await getPlanIssue(draftId, issueNumber);
      if (!currentIssue) { res.status(404).json({ error: 'Issue not found in this plan' }); return; }

      if (body.model_name !== undefined) {
        await syncModelLabels({
          draftId,
          issueNumber,
          repository: ownership.draft!.repository as string,
          currentModelName: currentIssue.model_name ?? null,
          modelName: body.model_name
        });
      }

      const updated = await updatePlanIssue(draftId, issueNumber, buildIssueUpdate(body));

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
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository', 'name', 'context_config']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const repository = draft.repository as string;
      const [owner, repo] = repository.split('/');

      if (!owner || !repo) { res.status(400).json({ error: 'Invalid repository format' }); return; }

      const contextConfig = parseContextConfig(draft.context_config);

      const { agent_alias, model_name } = req.body;
      const { useEpic, autoMerge } = resolveImplementationSettings(req.body, contextConfig);
      const existingIssues = await getPlanIssuesByDraft(draftId);
      const pendingIssues = existingIssues.filter(issue => issue.status === PlanIssueStatus.PENDING);

      if (agent_alias !== undefined || model_name !== undefined) {
        await batchUpdatePlanIssueConfig({
          draftId,
          agentAlias: agent_alias,
          modelName: model_name,
        });

        if (model_name !== undefined) {
          await syncModelLabelsForIssues({
            draftId,
            repository,
            issues: pendingIssues,
            modelName: model_name
          });
        }
      }

      const issues = agent_alias !== undefined || model_name !== undefined
        ? await getPlanIssuesByDraft(draftId)
        : existingIssues;
      const pendingIssuesForImplementation = issues.filter(issue => issue.status === PlanIssueStatus.PENDING);

      if (pendingIssuesForImplementation.length === 0) {
        res.json({ success: true, message: 'No pending issues to implement', implemented: 0 });
        return;
      }

      const processingLabels = await loadPrimaryProcessingLabels();
      const implementLabel = processingLabels[0] || 'AI';
      const octokit = await getAuthenticatedOctokit();
      const correlationId = `implement-all-${draftId}`;
      const labelLogger = logger.withCorrelation(correlationId);

      // Get existing epic label or create new one
      const epicLabelName = await resolveEpicLabel(useEpic, {
        draftId, owner, repo, draft: draft as Record<string, unknown>,
        firstIssueNumber: pendingIssuesForImplementation[0].issue_number,
        contextConfig, correlationId, labelLogger
      });

      const resolvedIssuesForImplementation = await Promise.all(
        pendingIssuesForImplementation.map((issue) => resolveAndPersistIssueUltrafixSettings(draftId, issue, contextConfig))
      );

      const { results, queuedCount } = await processBatchIssues({
        octokit,
        owner,
        repo,
        draftId,
        pendingIssues: resolvedIssuesForImplementation,
        implementLabel,
        epicLabelName,
        autoMerge: autoMerge as boolean
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
        autoMergeEnabled: autoMerge as boolean
      });
    } catch (error) {
      if (error instanceof ContextConfigParseError) {
        res.status(409).json({ error: error.message });
        return;
      }
      console.error('Implement all issues error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to implement issues' });
    }
  };
}
