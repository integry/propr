import { Request, Response } from 'express';
import {
  getPlanIssuesByDraft,
  getPlanIssuesByDraftPaginated,
  getPlanIssue,
  updatePlanIssue,
  loadPrimaryProcessingLabels,
  getAuthenticatedOctokit,
  logger,
  type PlanIssue
} from '@propr/core';
import { PlanIssueStatus } from '@propr/core';
import {
  handleMultiAgentImplementation,
  handleSingleAgentImplementation,
  type ImplementIssueContext
} from './planIssueHelpers.js';
import {
  buildIssueConfigRollbackUpdates,
  IssueConfigSyncReconciliationError,
  persistEffectiveUltrafixSettings,
  resolveEpicLabel,
  updateIssueConfigWithRollback
} from './planIssueConfigSync.js';
import {
  buildIssueUpdate,
  ContextConfigParseError,
  parseContextConfig,
  parseImplementationSettingsOverrides,
  resolveIssueForResponse,
  resolveImplementationSettings,
  type UpdateIssueRequestBody,
  validateUpdateIssueRequest
} from './planIssueRouteUtils.js';
import type { OwnershipResult } from './plannerHelpers/index.js';
export interface PlanIssueDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}
class IssueConfigRollbackError extends Error {
  constructor(readonly details: Record<string, unknown>) {
    super('Failed to update issue and failed to roll back synchronized config changes');
    this.name = 'IssueConfigRollbackError';
  }
}
class BadImplementationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadImplementationRequestError';
  }
}
function buildConfigUpdatesFromIssueUpdate(issueUpdates: ReturnType<typeof buildIssueUpdate>): { agent_alias?: string | null; model_name?: string | null } {
  const configUpdates: { agent_alias?: string | null; model_name?: string | null } = {};
  if (issueUpdates.agent_alias !== undefined) configUpdates.agent_alias = issueUpdates.agent_alias;
  if (issueUpdates.model_name !== undefined) configUpdates.model_name = issueUpdates.model_name;
  return configUpdates;
}
function hasConfigUpdates(configUpdates: { agent_alias?: string | null; model_name?: string | null }): boolean {
  return configUpdates.agent_alias !== undefined || configUpdates.model_name !== undefined;
}
function buildUpdatedConfigState(
  currentIssue: Pick<PlanIssue, 'agent_alias' | 'model_name'>,
  configUpdates: { agent_alias?: string | null; model_name?: string | null }
): { agent_alias: string | null; model_name: string | null } {
  return {
    agent_alias: configUpdates.agent_alias !== undefined ? configUpdates.agent_alias ?? null : currentIssue.agent_alias ?? null,
    model_name: configUpdates.model_name !== undefined ? configUpdates.model_name ?? null : currentIssue.model_name ?? null
  };
}

async function rollbackIssueConfigUpdate(params: {
  draftId: string;
  issueNumber: number;
  repository: string;
  currentIssue: Pick<PlanIssue, 'agent_alias' | 'model_name'>;
  configUpdates: { agent_alias?: string | null; model_name?: string | null };
  logMessage: string;
  originalError: unknown;
}): Promise<void> {
  if (!hasConfigUpdates(params.configUpdates)) return;
  try {
    await updateIssueConfigWithRollback({
      draftId: params.draftId,
      issueNumber: params.issueNumber,
      repository: params.repository,
      currentIssue: buildUpdatedConfigState(params.currentIssue, params.configUpdates),
      updates: buildIssueConfigRollbackUpdates(params.currentIssue, params.configUpdates)
    });
  } catch (rollbackError) {
    if (rollbackError instanceof IssueConfigSyncReconciliationError) {
      throw rollbackError;
    }
    logger.error(
      {
        draftId: params.draftId,
        issueNumber: params.issueNumber,
        error: (rollbackError as Error).message,
        originalError: params.originalError instanceof Error ? params.originalError.message : String(params.originalError)
      },
      params.logMessage
    );
    throw new IssueConfigRollbackError({
      draftId: params.draftId,
      issueNumber: params.issueNumber,
      repository: params.repository,
      originalError: params.originalError instanceof Error ? params.originalError.message : String(params.originalError),
      rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
    });
  }
}
async function persistNonConfigIssueUpdates(params: {
  draftId: string;
  issueNumber: number;
  issueUpdates: ReturnType<typeof buildIssueUpdate>;
}): Promise<PlanIssue | null> {
  const nonConfigUpdates = {
    status: params.issueUpdates.status,
    run_ultrafix: params.issueUpdates.run_ultrafix,
    ultrafix_goal: params.issueUpdates.ultrafix_goal,
    ultrafix_max_cycles: params.issueUpdates.ultrafix_max_cycles
  };
  const hasNonConfigUpdates = Object.values(nonConfigUpdates).some((value) => value !== undefined);
  return hasNonConfigUpdates
    ? updatePlanIssue(params.draftId, params.issueNumber, nonConfigUpdates)
    : getPlanIssue(params.draftId, params.issueNumber);
}
function sendIssueConfigSyncReconciliationError(res: Response, error: IssueConfigSyncReconciliationError): void {
  res.status(409).json({
    error: error.message,
    code: 'ISSUE_CONFIG_SYNC_RECONCILIATION_REQUIRED',
    details: error.details
  });
}
type ImplementationModel = { agent_alias: string; model_name: string };
interface ImplementIssueBody {
  repository?: unknown;
  useEpic?: unknown;
  autoMerge?: unknown;
  models?: ImplementationModel[];
  agent_alias?: string;
  model_name?: string;
}
function parseRepositoryParts(repository: string): { owner: string; repo: string } | null {
  const parts = repository.trim().split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  const isValidSegment = (segment: string): boolean => (
    segment !== '.' &&
    segment !== '..' &&
    /^[A-Za-z0-9_.-]+$/.test(segment)
  );
  return isValidSegment(owner) && isValidSegment(repo) ? { owner, repo } : null;
}
function validateRequestedRepository(requestedRepository: unknown, repository: string): string | null {
  if (requestedRepository === undefined) return null;
  if (typeof requestedRepository !== 'string') {
    return 'repository must be an owner/repo string';
  }
  const requestedParts = parseRepositoryParts(requestedRepository);
  if (!requestedParts) {
    return 'repository must be an owner/repo string';
  }
  const trimmedRepository = `${requestedParts.owner}/${requestedParts.repo}`;
  return trimmedRepository === repository ? null : `Issue belongs to ${repository}, not ${trimmedRepository}`;
}
function buildEffectivePlanIssue(issue: PlanIssue, body: ImplementIssueBody): PlanIssue {
  if (!body.agent_alias && !body.model_name) return issue;
  return {
    ...issue,
    agent_alias: body.agent_alias ?? issue.agent_alias,
    model_name: body.model_name ?? issue.model_name
  };
}
async function runIssueImplementation(params: ImplementIssueContext & {
  draftId: string;
  planIssue: PlanIssue;
  models?: ImplementationModel[];
}): Promise<unknown> {
  const { models } = params;
  if (models && Array.isArray(models) && models.length > 0) {
    return handleMultiAgentImplementation({ ...params, models });
  }
  return handleSingleAgentImplementation(params);
}

async function loadImplementationTarget(params: {
  deps: PlanIssueDeps;
  req: Request;
  res: Response;
  draftId: string;
  issueNumber: number;
}): Promise<{
  owner: string;
  repo: string;
  draft: Record<string, unknown>;
  contextConfig: ReturnType<typeof parseContextConfig>;
  implementationSettings: ReturnType<typeof parseImplementationSettingsOverrides>['settings'];
  body: ImplementIssueBody;
  planIssue: PlanIssue;
} | null> {
  const { deps, req, res, draftId, issueNumber } = params;
  const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository', 'name', 'context_config']);
  if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return null; }
  const draft = ownership.draft!;
  const repository = draft.repository as string;
  const repositoryParts = parseRepositoryParts(repository);
  if (!repositoryParts) { res.status(400).json({ error: 'Invalid repository format' }); return null; }
  const body = req.body as ImplementIssueBody;
  const repositorySlug = `${repositoryParts.owner}/${repositoryParts.repo}`;
  const requestedRepositoryError = validateRequestedRepository(body.repository, repositorySlug);
  if (requestedRepositoryError) { res.status(400).json({ error: requestedRepositoryError }); return null; }
  const contextConfig = parseContextConfig(draft.context_config);
  const { settings: implementationSettings, error: implementationSettingsError } = parseImplementationSettingsOverrides(body);
  if (implementationSettingsError) throw new BadImplementationRequestError(implementationSettingsError);
  const planIssue = await getPlanIssue(draftId, issueNumber);
  if (!planIssue) { res.status(404).json({ error: 'Issue not found in this plan' }); return null; }
  return {
    owner: repositoryParts.owner,
    repo: repositoryParts.repo,
    draft: draft as Record<string, unknown>,
    contextConfig,
    implementationSettings,
    body,
    planIssue
  };
}

async function implementLoadedIssue(params: {
  draftId: string;
  issueNumber: number;
  owner: string;
  repo: string;
  draft: Record<string, unknown>;
  contextConfig: ReturnType<typeof parseContextConfig>;
  implementationSettings: ReturnType<typeof parseImplementationSettingsOverrides>['settings'];
  body: ImplementIssueBody;
  planIssue: PlanIssue;
}): Promise<unknown> {
  const { draftId, issueNumber, owner, repo, draft, contextConfig, implementationSettings, body, planIssue } = params;
  const [issueForImplementation] = await persistEffectiveUltrafixSettings({ draftId, issues: [planIssue], contextConfig });
  const processingLabels = await loadPrimaryProcessingLabels();
  const implementLabel = processingLabels[0] || 'AI';
  const octokit = await getAuthenticatedOctokit();
  const { useEpic, autoMerge } = resolveImplementationSettings(implementationSettings, contextConfig);
  const correlationId = `implement-${draftId}-${issueNumber}`;
  const labelLogger = logger.withCorrelation(correlationId);
  const firstPendingIssue = await getPlanIssuesByDraftPaginated(draftId, { status: PlanIssueStatus.PENDING, page: 0, limit: 1 });
  const firstIssueNumber = firstPendingIssue.issues[0]?.issue_number ?? issueNumber;
  const epicLabelName = await resolveEpicLabel(useEpic, { draftId, owner, repo, draft, firstIssueNumber, contextConfig, correlationId, labelLogger });
  const context: ImplementIssueContext = {
    octokit, owner, repo, issueNumber, implementLabel, epicLabelName, autoMerge: autoMerge as boolean, labelLogger
  };
  const effectivePlanIssue = buildEffectivePlanIssue(issueForImplementation, body);
  return runIssueImplementation({ ...context, draftId, planIssue: effectivePlanIssue, models: body.models });
}

export function createGetIssuesHandler(deps: PlanIssueDeps) {
  return async function getIssues(req: Request, res: Response): Promise<void> {
    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id, ['user_id']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      const { page, limit, status } = req.query;
      const hasPagination = page !== undefined || limit !== undefined;
      if (hasPagination) {
        const pageNum = page ? parseInt(page as string, 10) : 0;
        const limitNum = limit ? parseInt(limit as string, 10) : 50;
        const options: { page?: number; limit?: number; status?: PlanIssueStatus } = { page: isNaN(pageNum) ? 0 : pageNum, limit: isNaN(limitNum) ? 50 : Math.min(limitNum, 100) };
        if (status) {
          const validStatuses: PlanIssueStatus[] = Object.values(PlanIssueStatus);
          if (validStatuses.includes(status as PlanIssueStatus)) options.status = status as PlanIssueStatus;
        }
        const result = await getPlanIssuesByDraftPaginated(req.params.id, options);
        res.json({ ...result, issues: result.issues.map((issue) => resolveIssueForResponse(issue)) });
      } else {
        const issues = await getPlanIssuesByDraft(req.params.id);
        res.json(issues.map((issue) => resolveIssueForResponse(issue)));
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
      const target = await loadImplementationTarget({ deps, req, res, draftId, issueNumber });
      if (!target) return;
      const result = await implementLoadedIssue({ ...target, draftId, issueNumber });
      res.json(result);
    } catch (error) {
      if (error instanceof ContextConfigParseError) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof BadImplementationRequestError) {
        res.status(400).json({ error: error.message });
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
      const requestValidationError = validateUpdateIssueRequest(body);
      if (requestValidationError) { res.status(400).json({ error: requestValidationError }); return; }
      const currentIssue = await getPlanIssue(draftId, issueNumber);
      if (!currentIssue) { res.status(404).json({ error: 'Issue not found in this plan' }); return; }
      const issueUpdates = buildIssueUpdate(body);
      const repository = ownership.draft!.repository as string;
      const configUpdates = buildConfigUpdatesFromIssueUpdate(issueUpdates);
      const shouldUpdateConfig = hasConfigUpdates(configUpdates);
      if (shouldUpdateConfig) {
        await updateIssueConfigWithRollback({ draftId, issueNumber, repository, currentIssue, updates: configUpdates });
      }
      let updated: PlanIssue | null;
      try {
        updated = await persistNonConfigIssueUpdates({ draftId, issueNumber, issueUpdates });
      } catch (error) {
        await rollbackIssueConfigUpdate({ draftId, issueNumber, repository, currentIssue, configUpdates, logMessage: 'Failed to roll back plan issue config after non-config update failure', originalError: error });
        throw error;
      }
      if (!updated) {
        await rollbackIssueConfigUpdate({ draftId, issueNumber, repository, currentIssue, configUpdates, logMessage: 'Failed to roll back plan issue config after update returned no issue', originalError: 'Issue not found in this plan' });
        res.status(404).json({ error: 'Issue not found in this plan' });
        return;
      }
      res.json(resolveIssueForResponse(updated));
    } catch (error) {
      if (error instanceof IssueConfigSyncReconciliationError) {
        sendIssueConfigSyncReconciliationError(res, error);
        return;
      }
      if (error instanceof IssueConfigRollbackError) {
        res.status(500).json({ error: error.message, code: 'ISSUE_CONFIG_ROLLBACK_FAILED', details: error.details });
        return;
      }
      console.error('Update issue error:', error);
      res.status(500).json({ error: 'Failed to update issue' });
    }
  };
}
