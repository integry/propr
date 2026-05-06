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

interface PlanIssueDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

interface ImplementationSettings {
  useEpic: boolean;
  autoMerge: boolean;
}

interface ResolvedUltrafixSettings {
  runUltrafix: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
}

interface UpdateIssueRequestBody {
  agent_alias?: string;
  model_name?: string;
  status?: PlanIssueStatus;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: number | null;
  ultrafix_max_cycles?: number | null;
}

const ULTRAFIX_GOAL_MIN = 1;
const ULTRAFIX_GOAL_MAX = 10;
const ULTRAFIX_MAX_CYCLES_MIN = 1;

function parseContextConfig(draft: Record<string, unknown>): Record<string, unknown> | null {
  if (!draft.context_config) return null;
  if (typeof draft.context_config !== 'string') {
    return draft.context_config as Record<string, unknown>;
  }
  try {
    return JSON.parse(draft.context_config) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sanitizeUltrafixGoal(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= ULTRAFIX_GOAL_MIN && (value as number) <= ULTRAFIX_GOAL_MAX
    ? value as number
    : null;
}

function sanitizeUltrafixMaxCycles(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= ULTRAFIX_MAX_CYCLES_MIN
    ? value as number
    : null;
}

function validateUltrafixValue(
  value: unknown,
  fieldName: string,
  options: { minimum: number; maximum?: number }
): string | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) return `${fieldName} must be an integer`;
  if ((value as number) < options.minimum) return `${fieldName} must be at least ${options.minimum}`;
  if (options.maximum !== undefined && (value as number) > options.maximum) {
    return `${fieldName} must be at most ${options.maximum}`;
  }
  return null;
}

function resolveImplementationSettings(
  reqBody: { useEpic?: boolean; autoMerge?: boolean },
  contextConfig: Record<string, unknown> | null
): ImplementationSettings {
  return {
    useEpic: reqBody.useEpic ?? contextConfig?.useEpic ?? false,
    autoMerge: reqBody.autoMerge ?? contextConfig?.autoMerge ?? false
  } as ImplementationSettings;
}

function resolveIssueUltrafixSettings(
  planIssue: {
    run_ultrafix?: boolean | number | null;
    ultrafix_goal?: number | null;
    ultrafix_max_cycles?: number | null;
  },
  contextConfig: Record<string, unknown> | null
): ResolvedUltrafixSettings {
  const issueRunUltrafix = planIssue.run_ultrafix === true || planIssue.run_ultrafix === 1
    ? true
    : planIssue.run_ultrafix === false || planIssue.run_ultrafix === 0
      ? false
      : null;
  const runUltrafix = issueRunUltrafix ?? (contextConfig?.runUltrafix === true);
  const ultrafixGoal = runUltrafix
    ? (sanitizeUltrafixGoal(planIssue.ultrafix_goal) ?? sanitizeUltrafixGoal(contextConfig?.ultrafixGoal))
    : null;
  const ultrafixMaxCycles = runUltrafix
    ? (sanitizeUltrafixMaxCycles(planIssue.ultrafix_max_cycles) ?? sanitizeUltrafixMaxCycles(contextConfig?.ultrafixMaxCycles))
    : null;

  return {
    runUltrafix,
    ultrafixGoal,
    ultrafixMaxCycles
  };
}

function buildIssueForImplementation<T extends {
  issue_number: number;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: number | null;
  ultrafix_max_cycles?: number | null;
}>(planIssue: T, ultrafixSettings: ResolvedUltrafixSettings): T {
  return {
    ...planIssue,
    run_ultrafix: ultrafixSettings.runUltrafix,
    ultrafix_goal: ultrafixSettings.ultrafixGoal,
    ultrafix_max_cycles: ultrafixSettings.ultrafixMaxCycles
  };
}

async function resolveAndPersistIssueUltrafixSettings<T extends {
  issue_number: number;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: number | null;
  ultrafix_max_cycles?: number | null;
}>(draftId: string, planIssue: T, contextConfig: Record<string, unknown> | null): Promise<T> {
  const ultrafixSettings = resolveIssueUltrafixSettings(planIssue, contextConfig);
  const issueForImplementation = buildIssueForImplementation(planIssue, ultrafixSettings);
  const persistedIssue = await updatePlanIssue(draftId, planIssue.issue_number, {
    run_ultrafix: issueForImplementation.run_ultrafix === true,
    ultrafix_goal: issueForImplementation.ultrafix_goal,
    ultrafix_max_cycles: issueForImplementation.ultrafix_max_cycles
  });

  return (persistedIssue as T | null) ?? issueForImplementation;
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
  modelName: string;
}): Promise<void> {
  const [owner, repo] = params.repository.split('/');
  if (!owner || !repo) return;

  const [oldLabel, newLabel, octokit] = await Promise.all([
    getLlmLabel(params.currentModelName),
    getLlmLabel(params.modelName),
    getAuthenticatedOctokit()
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

function normalizeRunUltrafix(value: boolean | number | null | undefined): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return undefined;
}

function validateRunUltrafixValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value === true || value === false || value === 1 || value === 0) return null;
  return 'run_ultrafix must be a boolean, 1, 0, or null';
}

function buildIssueUpdate(body: UpdateIssueRequestBody) {
  return {
    agent_alias: body.agent_alias !== undefined ? body.agent_alias : undefined,
    model_name: body.model_name !== undefined ? body.model_name : undefined,
    status: body.status !== undefined ? body.status : undefined,
    run_ultrafix: normalizeRunUltrafix(body.run_ultrafix),
    ultrafix_goal: body.ultrafix_goal !== undefined ? sanitizeUltrafixGoal(body.ultrafix_goal) : undefined,
    ultrafix_max_cycles: body.ultrafix_max_cycles !== undefined ? sanitizeUltrafixMaxCycles(body.ultrafix_max_cycles) : undefined
  };
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

      const contextConfig = parseContextConfig(draft as Record<string, unknown>);

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

      const contextConfig = parseContextConfig(draft as Record<string, unknown>);

      const { agent_alias, model_name } = req.body;
      const { useEpic, autoMerge } = resolveImplementationSettings(req.body, contextConfig);

      if (agent_alias !== undefined || model_name !== undefined) {
        await batchUpdatePlanIssueConfig({
            draftId,
            agentAlias: agent_alias,
            modelName: model_name,
        });
      }

      const issues = await getPlanIssuesByDraft(draftId);
      const pendingIssues = issues.filter(issue => issue.status === PlanIssueStatus.PENDING);

      if (pendingIssues.length === 0) {
        res.json({ success: true, message: 'No pending issues to implement', implemented: 0 });
        return;
      }

      const resolvedPendingIssues = await Promise.all(
        pendingIssues.map((issue) => resolveAndPersistIssueUltrafixSettings(draftId, issue, contextConfig))
      );

      const processingLabels = await loadPrimaryProcessingLabels();
      const implementLabel = processingLabels[0] || 'AI';
      const octokit = await getAuthenticatedOctokit();
      const correlationId = `implement-all-${draftId}`;
      const labelLogger = logger.withCorrelation(correlationId);

      // Get existing epic label or create new one
      const epicLabelName = await resolveEpicLabel(useEpic, {
        draftId, owner, repo, draft: draft as Record<string, unknown>,
        firstIssueNumber: resolvedPendingIssues[0].issue_number,
        contextConfig, correlationId, labelLogger
      });

      const { results, queuedCount } = await processBatchIssues({
        octokit, owner, repo, draftId, pendingIssues: resolvedPendingIssues, implementLabel, epicLabelName, autoMerge: autoMerge as boolean
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
      console.error('Implement all issues error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to implement issues' });
    }
  };
}
