import { Request, Response } from 'express';
import {
  getPlanIssuesByDraft,
  getPlanIssuesByDraftPaginated,
  getPlanIssue,
  updatePlanIssue,
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
  validateIssueUltrafixPayload,
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
  return status !== undefined && !validStatuses.includes(status)
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

async function updateIssueConfigWithRollback(params: {
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
}): Promise<void> {
  const nextIssue = await updatePlanIssue(params.draftId, params.issueNumber, params.updates);
  if (!nextIssue) {
    throw new Error('Issue not found in this plan');
  }

  if (params.updates.model_name === undefined) {
    return;
  }

  try {
    await syncModelLabels({
      draftId: params.draftId,
      issueNumber: params.issueNumber,
      repository: params.repository,
      currentModelName: params.currentIssue.model_name ?? null,
      modelName: params.updates.model_name
    });
  } catch (error) {
    try {
      await updatePlanIssue(params.draftId, params.issueNumber, {
        agent_alias: params.currentIssue.agent_alias ?? null,
        model_name: params.currentIssue.model_name ?? null
      });
    } catch (rollbackError) {
      logger.error(
        {
          draftId: params.draftId,
          issueNumber: params.issueNumber,
          error: (rollbackError as Error).message
        },
        'Failed to roll back plan issue config after GitHub label sync failure'
      );
    }
    throw error;
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
      const ultrafixPayloadError = validateIssueUltrafixPayload(body);
      if (ultrafixPayloadError) { res.status(400).json({ error: ultrafixPayloadError }); return; }

      const currentIssue = await getPlanIssue(draftId, issueNumber);
      if (!currentIssue) { res.status(404).json({ error: 'Issue not found in this plan' }); return; }
      const issueUpdates = buildIssueUpdate(body);
      const configUpdates: { agent_alias?: string | null; model_name?: string | null } = {};
      if (issueUpdates.agent_alias !== undefined) configUpdates.agent_alias = issueUpdates.agent_alias;
      if (issueUpdates.model_name !== undefined) configUpdates.model_name = issueUpdates.model_name;

      if (configUpdates.agent_alias !== undefined || configUpdates.model_name !== undefined) {
        await updateIssueConfigWithRollback({
          draftId,
          issueNumber,
          repository: ownership.draft!.repository as string,
          currentIssue,
          updates: configUpdates
        });
      }

      const nonConfigUpdates = {
        status: issueUpdates.status,
        run_ultrafix: issueUpdates.run_ultrafix,
        ultrafix_goal: issueUpdates.ultrafix_goal,
        ultrafix_max_cycles: issueUpdates.ultrafix_max_cycles
      };
      const hasNonConfigUpdates = Object.values(nonConfigUpdates).some((value) => value !== undefined);
      const updated = hasNonConfigUpdates
        ? await updatePlanIssue(draftId, issueNumber, nonConfigUpdates)
        : await getPlanIssue(draftId, issueNumber);

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
        for (const issue of pendingIssues) {
          await updateIssueConfigWithRollback({
            draftId,
            issueNumber: issue.issue_number,
            repository,
            currentIssue: issue,
            updates: {
              agent_alias,
              model_name
            }
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
