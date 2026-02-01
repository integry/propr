/* eslint-disable max-lines */
import { Request, Response } from 'express';
import { Knex } from 'knex';
import {
  getGitHubInstallationToken,
  ensureRepoCloned,
  generateCorrelationId,
  generateContextPreview,
  generatePlan,
  BranchNotFoundError,
  AttachmentService,
  loadSettings
} from '@gitfix/core';
import { Knex as KnexType } from 'knex';
import type { Granularity, MulterFile } from '@gitfix/core';

// Re-export plan issue handlers from separate module
export {
  createGetIssuesHandler,
  createImplementIssueHandler,
  createUpdateIssueHandler,
  createImplementAllIssuesHandler
} from './planIssueHandlers.js';

export interface DbCheckResult {
  valid: false;
  error: string;
  status: number;
}

export interface DbCheckSuccess {
  valid: true;
}

export type DbCheck = DbCheckResult | DbCheckSuccess;

export function checkDbAndAuth(
  db: Knex,
  userId: string | undefined
): DbCheck {
  if (!userId) {
    return { valid: false, error: 'User not authenticated', status: 401 };
  }
  return { valid: true };
}

export type HandlerFunction = (req: Request, res: Response) => Promise<void>;

export function withAuthCheck(db: Knex, handler: HandlerFunction): HandlerFunction {
  return async (req: Request, res: Response): Promise<void> => {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    return handler(req, res);
  };
}

export function checkAuth(userId: string | undefined): DbCheck {
  if (!userId) {
    return { valid: false, error: 'User not authenticated', status: 401 };
  }
  return { valid: true };
}

export function sendCheckError(res: Response, check: DbCheckResult): void {
  res.status(check.status).json({ error: check.error });
}

export interface OwnershipResult {
  authorized: boolean;
  draft?: Record<string, unknown>;
  error?: string;
  status?: number;
}

export async function verifyDraftOwnership(
  db: Knex,
  draftId: string,
  userId: string,
  selectFields: string[] = ['user_id']
): Promise<OwnershipResult> {
  // Always include user_id for ownership verification
  const fieldsWithUserId = selectFields.includes('user_id') ? selectFields : ['user_id', ...selectFields];
  const existing = await db('task_drafts')
    .select(...fieldsWithUserId)
    .where({ draft_id: draftId })
    .first();

  if (!existing) {
    return { authorized: false, error: 'Draft not found', status: 404 };
  }

  if (existing.user_id !== userId) {
    return { authorized: false, error: 'Unauthorized', status: 403 };
  }

  return { authorized: true, draft: existing };
}

export interface RepoSetupResult {
  worktreePath: string;
  authToken: string;
  repository: string;
}

export async function setupRepoContext(
  draft: { repository: string },
  fallbackToken: string
): Promise<RepoSetupResult> {
  const [owner, repoName] = draft.repository.split('/');
  if (!owner || !repoName) {
    return { worktreePath: process.cwd(), authToken: fallbackToken, repository: 'unknown/unknown' };
  }

  let authToken: string;
  try {
    authToken = await getGitHubInstallationToken();
  } catch {
    authToken = fallbackToken;
  }

  const repoUrl = `https://github.com/${owner}/${repoName}.git`;
  const worktreePath = await ensureRepoCloned({ repoUrl, owner, repoName, authToken });

  return { worktreePath, authToken, repository: draft.repository };
}

export const VALID_GRANULARITIES = ['single', 'balanced', 'granular'] as const;
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9._/-]+$/;

export interface ContextRepositoryInput {
  repository: string;
  branch?: string;
  description?: string;
}

export function validateContextRepositories(
  repos: unknown
): { valid: boolean; error?: string; repositories?: ContextRepositoryInput[] } {
  if (!repos) {
    return { valid: true, repositories: [] };
  }

  if (!Array.isArray(repos)) {
    return { valid: false, error: 'contextRepositories must be an array' };
  }

  const validated: ContextRepositoryInput[] = [];

  for (const repo of repos) {
    if (!repo || typeof repo !== 'object') {
      return { valid: false, error: 'Each context repository must be an object' };
    }

    if (!repo.repository || typeof repo.repository !== 'string') {
      return { valid: false, error: 'Each context repository must have a repository field' };
    }

    // Validate repository format (owner/repo)
    if (!repo.repository.match(/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/)) {
      return { valid: false, error: `Invalid repository format: ${repo.repository}` };
    }

    validated.push({
      repository: repo.repository,
      branch: typeof repo.branch === 'string' ? repo.branch : undefined,
      description: typeof repo.description === 'string' ? repo.description : undefined
    });
  }

  return { valid: true, repositories: validated };
}

export interface GenerateRequestBody {
  draftId?: string;
  baseBranch?: string;
  granularity?: string;
  contextLevel?: number;
  compress?: boolean;
  contextRepositories?: ContextRepositoryInput[];
}

export function validatePreviewInput(body: Record<string, unknown>): { valid: boolean; error?: string } {
  const { draftId, prompt, baseBranch, granularity, files, contextRepositories } = body;
  if (!draftId) return { valid: false, error: 'draftId is required' };
  if (!prompt || typeof prompt !== 'string') return { valid: false, error: 'prompt is required' };
  if (!baseBranch || typeof baseBranch !== 'string') return { valid: false, error: 'baseBranch is required' };
  if (!BRANCH_NAME_REGEX.test(baseBranch as string)) return { valid: false, error: 'Invalid branch name format' };
  if (granularity && !VALID_GRANULARITIES.includes(granularity as typeof VALID_GRANULARITIES[number])) return { valid: false, error: `granularity must be one of: ${VALID_GRANULARITIES.join(', ')}` };
  if (files && (!Array.isArray(files) || !files.every(f => typeof f === 'string'))) return { valid: false, error: 'files must be an array of strings' };

  // Validate context repositories if provided
  if (contextRepositories !== undefined) {
    const repoValidation = validateContextRepositories(contextRepositories);
    if (!repoValidation.valid) {
      return { valid: false, error: repoValidation.error };
    }
  }

  return { valid: true };
}

export async function getRepoAuthToken(accessToken: string): Promise<string> {
  try { return await getGitHubInstallationToken(); } catch { return accessToken; }
}

interface DownloadContextDeps {
  verifyOwnership: (draftId: string, userId: string, fields: string[]) => Promise<OwnershipResult>;
}

interface PreviewContextDeps {
  verifyOwnership: (draftId: string, userId: string, fields: string[]) => Promise<OwnershipResult>;
  validateInput: (body: Record<string, unknown>) => { valid: boolean; error?: string };
  db?: KnexType;
}

export function createPreviewContextHandler(deps: PreviewContextDeps) {
  return async function previewContext(req: Request, res: Response): Promise<void> {
    const validation = deps.validateInput(req.body);
    if (!validation.valid) { res.status(400).json({ error: validation.error }); return; }

    const { draftId, prompt, baseBranch, granularity, contextLevel, compress, files, contextRepositories } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository', 'context_config']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const [owner, repoName] = (draft.repository as string).split('/');
      if (!owner || !repoName) { res.status(400).json({ error: 'Invalid repository format' }); return; }

      const accessToken = req.user?.accessToken;
      if (!accessToken) { res.status(401).json({ error: 'GitHub access token not available' }); return; }

      const authToken = await getRepoAuthToken(accessToken);
      const worktreePath = await ensureRepoCloned({ repoUrl: `https://github.com/${owner}/${repoName}.git`, owner, repoName, authToken });

      // Load settings to get the configured context model for semantic scoring and generation model for limits
      const settings = await loadSettings();
      const contextModel = settings.planner_context_model;
      const generationModel = settings.planner_generation_model;

      // Store context repositories in draft config if provided
      if (deps.db && contextRepositories && Array.isArray(contextRepositories) && contextRepositories.length > 0) {
        const existingConfig = (draft.context_config as Record<string, unknown>) || {};
        const updatedConfig = {
          ...existingConfig,
          baseBranch,
          granularity: granularity || 'balanced',
          contextLevel,
          compress,
          contextRepositories
        };
        await deps.db('task_drafts').where({ draft_id: draftId }).update({
          context_config: JSON.stringify(updatedConfig),
          updated_at: deps.db.fn.now()
        });
      }

      const result = await generateContextPreview({ draftId, prompt, baseBranch, granularity: (granularity || 'balanced') as Granularity, contextLevel, compress, files, worktreePath, correlationId, contextModel, generationModel });
      res.json(result);
    } catch (error) {
      console.error('Preview context error:', error);
      if (error instanceof BranchNotFoundError) { res.status(400).json({ error: error.message }); return; }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to preview context' });
    }
  };
}

interface AttachmentContentDeps {
  verifyOwnership: (draftId: string, userId: string, fields: string[]) => Promise<OwnershipResult>;
}

interface ContextStatsDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

export function createGetContextStatsHandler(deps: ContextStatsDeps) {
  return async function getContextStats(req: Request, res: Response): Promise<void> {
    const { draftId, level } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    try {
      const ownership = await deps.verifyOwnership(draftId, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const levelMultipliers: Record<string, number> = { low: 1, medium: 3, high: 10 };
      const multiplier = levelMultipliers[level] || levelMultipliers.medium;
      const baseTokens = 5000;
      const tokenCount = baseTokens * multiplier;
      const costEstimate = (tokenCount / 1_000_000) * 3;
      const smartFiles = level === 'low' ? 0 : level === 'medium' ? 15 : 50;

      res.json({ tokenCount, costEstimate, smartFiles });
    } catch (error) {
      console.error('Get context stats error:', error);
      res.status(500).json({ error: 'Failed to get context stats' });
    }
  };
}

interface UploadAttachmentDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

export function createUploadAttachmentHandler(deps: UploadAttachmentDeps) {
  return async function uploadAttachment(req: Request, res: Response): Promise<void> {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const attachment = await AttachmentService.processUpload(req.file as MulterFile, req.params.id);
      res.json(attachment);
    } catch (error) {
      console.error('Upload attachment error:', error);
      const message = error instanceof Error ? error.message : 'Processing failed';
      const status = message.includes('not supported') || message.includes('Unsupported') ? 400 : 500;
      res.status(status).json({ error: message });
    }
  };
}

interface DeleteAttachmentDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

export function createDeleteAttachmentHandler(deps: DeleteAttachmentDeps) {
  return async function deleteAttachment(req: Request, res: Response): Promise<void> {
    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      await AttachmentService.deleteAttachment(req.params.id, req.params.attachmentId);
      res.status(204).send();
    } catch (error) {
      console.error('Delete attachment error:', error);
      const message = error instanceof Error ? error.message : 'Failed to delete attachment';
      res.status(message.includes('not found') ? 404 : 500).json({ error: message });
    }
  };
}

export function createGetAttachmentContentHandler(deps: AttachmentContentDeps) {
  return async function getAttachmentContent(req: Request, res: Response): Promise<void> {
    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id, ['user_id', 'attachments']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      let attachments: { id: string; storedPath: string; mimeType: string; originalName: string }[] = [];
      const rawAttachments = ownership.draft?.attachments;
      if (typeof rawAttachments === 'string') {
        try { attachments = JSON.parse(rawAttachments); } catch { attachments = []; }
      } else if (Array.isArray(rawAttachments)) {
        attachments = rawAttachments;
      }
      const attachment = attachments.find(a => a.id === req.params.attachmentId);
      if (!attachment) { res.status(404).json({ error: 'Attachment not found' }); return; }

      const content = await AttachmentService.getAttachmentContent(attachment.storedPath);
      res.setHeader('Content-Type', attachment.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${attachment.originalName}"`);
      res.send(content);
    } catch (error) {
      console.error('Get attachment content error:', error);
      res.status(500).json({ error: 'Failed to get attachment content' });
    }
  };
}

interface RepositoryInfoDeps {
  verifyOwnership: (draftId: string, userId: string, fields: string[]) => Promise<OwnershipResult>;
}

export function createGetRepositoryInfoHandler(deps: RepositoryInfoDeps) {
  return async function getRepositoryInfo(req: Request, res: Response): Promise<void> {
    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id, ['user_id', 'repository']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const repository = ownership.draft?.repository as string;
      if (!repository) { res.status(400).json({ error: 'Repository not found in draft' }); return; }

      const [owner, repoName] = repository.split('/');
      if (!owner || !repoName) { res.status(400).json({ error: 'Invalid repository format' }); return; }

      const accessToken = req.user?.accessToken;
      if (!accessToken) { res.status(401).json({ error: 'GitHub access token not available' }); return; }

      const authToken = await getRepoAuthToken(accessToken);
      const { Octokit } = await import('@octokit/core');
      const octokit = new Octokit({ auth: authToken });

      const [repoInfo, branchesResponse] = await Promise.all([
        octokit.request('GET /repos/{owner}/{repo}', { owner, repo: repoName }),
        octokit.request('GET /repos/{owner}/{repo}/branches', { owner, repo: repoName, per_page: 100 })
      ]);

      res.json({
        defaultBranch: repoInfo.data.default_branch,
        branches: branchesResponse.data.map(b => b.name)
      });
    } catch (error) {
      console.error('Get repository info error:', error);
      res.status(500).json({ error: 'Failed to get repository info' });
    }
  };
}

export function createDownloadContextHandler(deps: DownloadContextDeps) {
  return async function downloadContext(req: Request, res: Response): Promise<void> {
    const { draftId } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    try {
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'generated_context']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const generatedContext = draft.generated_context as string | undefined;

      if (!generatedContext) {
        res.status(400).json({ error: 'No context has been generated yet. Please preview the context first.' });
        return;
      }

      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="context-${draftId}.xml"`);
      res.send(generatedContext);

    } catch (error) {
      console.error('Download context error:', error);
      res.status(500).json({ error: 'Failed to download context' });
    }
  };
}

export async function updateDraftContextConfig(
  db: KnexType,
  draftId: string,
  draft: Record<string, unknown>,
  body: GenerateRequestBody
): Promise<void> {
  const { baseBranch, granularity, contextLevel, compress, contextRepositories } = body;
  const hasUpdates = baseBranch || granularity || contextLevel !== undefined ||
                     compress !== undefined || contextRepositories !== undefined;
  if (!hasUpdates) return;

  const existingConfig = (draft.context_config as Record<string, unknown>) || {};
  const updatedConfig = {
    ...existingConfig,
    ...(baseBranch && { baseBranch }),
    ...(granularity && VALID_GRANULARITIES.includes(granularity as typeof VALID_GRANULARITIES[number]) && { granularity }),
    ...(contextLevel !== undefined && { contextLevel }),
    ...(compress !== undefined && { compress }),
    ...(contextRepositories !== undefined && { contextRepositories })
  };
  await db('task_drafts').where({ draft_id: draftId }).update({
    context_config: JSON.stringify(updatedConfig),
    updated_at: db.fn.now()
  });
}

export interface BackgroundGenerationOptions {
  db: KnexType;
  draftId: string;
  worktreePath: string;
  authToken: string;
  correlationId: string;
}

export function runBackgroundGeneration(options: BackgroundGenerationOptions): void {
  const { db, draftId, worktreePath, authToken, correlationId } = options;
  generatePlan({ draftId, worktreePath, githubToken: authToken, correlationId })
    .then(() => {
      console.log(`[generate] Plan generation completed for draft ${draftId}`);
    })
    .catch(async (error) => {
      console.error(`[generate] Plan generation failed for draft ${draftId}:`, error);
      try {
        // Get current trace to preserve any completed steps
        const draft = await db('task_drafts').where({ draft_id: draftId }).first();
        let existingTrace = { steps: [] as { name: string; status: string; completedAt?: string }[] };
        try {
          if (draft?.generation_trace) {
            existingTrace = JSON.parse(draft.generation_trace);
          }
        } catch { /* ignore parse errors */ }

        // Mark any pending steps as failed and add error info
        const updatedSteps = existingTrace.steps.map((step: { name: string; status: string; completedAt?: string }) =>
          step.status === 'pending' ? { ...step, status: 'failed' } : step
        );

        await db('task_drafts').where({ draft_id: draftId }).update({
          status: 'failed',
          generation_trace: JSON.stringify({
            steps: updatedSteps,
            error: error instanceof Error ? error.message : 'Plan generation failed',
            failedAt: new Date().toISOString()
          }),
          updated_at: db.fn.now()
        });
      } catch (dbError) {
        console.error(`[generate] Failed to update draft status after error:`, dbError);
      }
    });
}

export async function getRefineRepoContext(
  db: KnexType,
  draftId: string | undefined,
  fallbackToken: string
): Promise<RepoSetupResult> {
  if (!draftId) {
    return { worktreePath: process.cwd(), authToken: fallbackToken, repository: 'unknown/unknown' };
  }
  const draft = await db('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) return { worktreePath: process.cwd(), authToken: fallbackToken, repository: 'unknown/unknown' };
  return setupRepoContext(draft, fallbackToken);
}

/**
 * Validate context repository response structure
 */
export interface ValidateContextRepositoryResponse {
  valid: boolean;
  repository: string;
  defaultBranch?: string;
  description?: string;
  error?: string;
}

/**
 * Create handler for validating context repositories
 */
export function createValidateContextRepositoryHandler() {
  return async function validateContextRepository(req: Request, res: Response): Promise<void> {
    const { repository, branch } = req.body;

    if (!repository || typeof repository !== 'string') {
      res.status(400).json({ valid: false, error: 'Repository is required (format: owner/repo)' });
      return;
    }

    const [owner, repoName] = repository.split('/');
    if (!owner || !repoName) {
      res.status(400).json({ valid: false, error: 'Invalid repository format. Expected: owner/repo' });
      return;
    }

    const accessToken = req.user?.accessToken;
    if (!accessToken) {
      res.status(401).json({ valid: false, error: 'GitHub access token not available' });
      return;
    }

    try {
      const authToken = await getRepoAuthToken(accessToken);
      const { Octokit } = await import('@octokit/core');
      const octokit = new Octokit({ auth: authToken });

      // Check if the repository exists and is accessible
      const repoInfo = await octokit.request('GET /repos/{owner}/{repo}', {
        owner,
        repo: repoName
      });

      // Verify the branch exists if specified
      if (branch) {
        try {
          await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
            owner,
            repo: repoName,
            branch
          });
        } catch {
          res.status(400).json({
            valid: false,
            repository,
            error: `Branch '${branch}' not found in repository`
          });
          return;
        }
      }

      const response: ValidateContextRepositoryResponse = {
        valid: true,
        repository,
        defaultBranch: repoInfo.data.default_branch,
        description: repoInfo.data.description || undefined
      };

      res.json(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check for specific GitHub API errors
      if (errorMessage.includes('Not Found')) {
        res.status(404).json({
          valid: false,
          repository,
          error: 'Repository not found or not accessible'
        });
        return;
      }

      res.status(500).json({
        valid: false,
        repository,
        error: `Failed to validate repository: ${errorMessage}`
      });
    }
  };
}
