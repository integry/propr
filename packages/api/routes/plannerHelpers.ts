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
} from '@propr/core';
import { Knex as KnexType } from 'knex';
import type { Granularity, MulterFile } from '@propr/core';

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
  /** Model to use for plan generation (e.g., 'opus', 'claude:claude-opus-4-5-20251101') */
  generationModel?: string;
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

    const { draftId, prompt, baseBranch, granularity, contextLevel, compress, files, contextRepositories, generationModel: requestGenerationModel } = req.body;
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
      // Use request's generationModel if provided, otherwise use global setting
      const generationModel = requestGenerationModel || settings.planner_generation_model;

      // Store context repositories and generationModel in draft config if provided
      const hasConfigUpdates = contextRepositories || requestGenerationModel;
      if (deps.db && hasConfigUpdates) {
        const existingConfig = (draft.context_config as Record<string, unknown>) || {};
        const updatedConfig = {
          ...existingConfig,
          baseBranch,
          granularity: granularity || 'balanced',
          contextLevel,
          compress,
          ...(contextRepositories && { contextRepositories }),
          ...(requestGenerationModel && { generationModel: requestGenerationModel })
        };
        await deps.db('task_drafts').where({ draft_id: draftId }).update({
          context_config: JSON.stringify(updatedConfig),
          updated_at: deps.db.fn.now()
        });
      }

      const result = await generateContextPreview({ draftId, prompt, baseBranch, granularity: (granularity || 'balanced') as Granularity, contextLevel, compress, files, worktreePath, correlationId, contextModel, generationModel, contextRepositories, githubToken: authToken });
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
      const { paginateRest } = await import('@octokit/plugin-paginate-rest');
      const PaginatedOctokit = Octokit.plugin(paginateRest);
      const octokit = new PaginatedOctokit({ auth: authToken });

      // Get repository info for default branch
      const repoInfo = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo: repoName });
      const defaultBranch = repoInfo.data.default_branch;

      // Fetch all branches using pagination
      const branches: string[] = [];
      for await (const response of octokit.paginate.iterator('GET /repos/{owner}/{repo}/branches', {
        owner,
        repo: repoName,
        per_page: 100
      })) {
        for (const branch of response.data) {
          if (branch.name) {
            branches.push(branch.name);
          }
        }
      }

      // Sort alphabetically but put default branch first
      branches.sort((a, b) => {
        if (a === defaultBranch) return -1;
        if (b === defaultBranch) return 1;
        return a.toLowerCase().localeCompare(b.toLowerCase());
      });

      res.json({
        defaultBranch,
        branches
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
  const { baseBranch, granularity, contextLevel, compress, contextRepositories, generationModel } = body;
  const hasUpdates = baseBranch || granularity || contextLevel !== undefined ||
                     compress !== undefined || contextRepositories !== undefined || generationModel !== undefined;
  if (!hasUpdates) return;

  // Parse context_config if it's a JSON string (stored as text in SQLite)
  let existingConfig: Record<string, unknown> = {};
  if (draft.context_config) {
    try {
      existingConfig = typeof draft.context_config === 'string'
        ? JSON.parse(draft.context_config)
        : (draft.context_config as Record<string, unknown>);
    } catch {
      existingConfig = {};
    }
  }
  const updatedConfig = {
    ...existingConfig,
    ...(baseBranch && { baseBranch }),
    ...(granularity && VALID_GRANULARITIES.includes(granularity as typeof VALID_GRANULARITIES[number]) && { granularity }),
    ...(contextLevel !== undefined && { contextLevel }),
    ...(compress !== undefined && { compress }),
    ...(contextRepositories !== undefined && { contextRepositories }),
    ...(generationModel !== undefined && { generationModel })
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

/**
 * Score and sort drafts based on search relevance
 */
export function scoreDraftsBySearch<T extends { name?: string; initial_prompt?: string; updated_at?: string }>(
  drafts: T[],
  searchWords: string[],
  exactPhrase: string
): Omit<T, '_searchScore'>[] {
  const scoredDrafts = drafts.map((draft) => {
    const nameLC = (draft.name || '').toLowerCase(), promptLC = (draft.initial_prompt || '').toLowerCase();
    let score = 0;
    if (nameLC.includes(exactPhrase)) score += 100;
    if (promptLC.includes(exactPhrase)) score += 80;
    const allWordsMatchName = searchWords.every(w => nameLC.includes(w.toLowerCase()));
    const allWordsMatchPrompt = searchWords.every(w => promptLC.includes(w.toLowerCase()));
    if (allWordsMatchName && !nameLC.includes(exactPhrase)) score += 50;
    if (allWordsMatchPrompt && !promptLC.includes(exactPhrase)) score += 40;
    const wordsMatchingName = searchWords.filter(w => nameLC.includes(w.toLowerCase())).length;
    const wordsMatchingPrompt = searchWords.filter(w => promptLC.includes(w.toLowerCase())).length;
    score += wordsMatchingName * 10;
    score += wordsMatchingPrompt * 5;
    return { ...draft, _searchScore: score };
  });

  scoredDrafts.sort((a, b) => {
    if (b._searchScore !== a._searchScore) return b._searchScore - a._searchScore;
    return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
  });

  return scoredDrafts.map((d) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _searchScore, ...rest } = d;
    return rest as Omit<T, '_searchScore'>;
  });
}

interface AbortGenerationDeps {
  db: KnexType;
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

/**
 * Create handler for aborting plan generation
 */
export function createAbortGenerationHandler(deps: AbortGenerationDeps) {
  return async function abortGeneration(req: Request, res: Response): Promise<void> {
    const { draftId } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    try {
      const draft = await deps.db('task_drafts').where({ draft_id: draftId, user_id: req.user!.id }).first();
      if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
      if (draft.status !== 'generating') {
        res.status(400).json({ error: 'Can only abort drafts that are currently generating' });
        return;
      }

      // Set abort signal in Redis
      const { Redis } = await import('ioredis');
      const redis = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
      });
      await redis.setex(`planner:abort:${draftId}`, 300, '1');
      await redis.quit();

      await deps.db('task_drafts').where({ draft_id: draftId }).update({
        status: 'draft',
        generation_trace: JSON.stringify({
          steps: [],
          error: 'Generation aborted by user',
          abortedAt: new Date().toISOString()
        }),
        updated_at: deps.db.fn.now()
      });

      console.log(`[abort] Plan generation aborted for draft ${draftId}`);
      res.json({ success: true, message: 'Generation aborted' });
    } catch (error) {
      console.error('Abort generation error:', error);
      res.status(500).json({ error: 'Failed to abort generation' });
    }
  };
}

/**
 * Build issue summaries from plan issues
 */
export async function buildIssueSummaries(
  db: KnexType,
  draftIds: string[]
): Promise<Record<string, { total: number; pending: number; processing: number; merged: number; closed: number }>> {
  const issues = await db('plan_issues')
    .whereIn('draft_id', draftIds)
    .select('draft_id', 'status');

  const summaryMap: Record<string, { total: number; pending: number; processing: number; merged: number; closed: number }> = {};
  for (const issue of issues as Array<{ draft_id: string; status: string }>) {
    if (!summaryMap[issue.draft_id]) {
      summaryMap[issue.draft_id] = { total: 0, pending: 0, processing: 0, merged: 0, closed: 0 };
    }
    summaryMap[issue.draft_id].total++;
    if (issue.status === 'pending') summaryMap[issue.draft_id].pending++;
    else if (issue.status === 'processing' || issue.status === 'under_review' || issue.status === 'in_refinement' || issue.status === 'refinement_processing') summaryMap[issue.draft_id].processing++;
    else if (issue.status === 'merged') summaryMap[issue.draft_id].merged++;
    else if (issue.status === 'closed') summaryMap[issue.draft_id].closed++;
  }
  return summaryMap;
}

/**
 * Parse JSON fields in a draft object
 */
export function parseDraftJsonFields(draft: Record<string, unknown>): Record<string, unknown> & { task_title?: string } {
  const parsedDraft: Record<string, unknown> & { task_title?: string } = { ...draft };
  if (typeof parsedDraft.plan_json === 'string') {
    try { parsedDraft.plan_json = JSON.parse(parsedDraft.plan_json); } catch { parsedDraft.plan_json = []; }
  }
  if (typeof parsedDraft.chat_history === 'string') {
    try { parsedDraft.chat_history = JSON.parse(parsedDraft.chat_history); } catch { parsedDraft.chat_history = []; }
  }
  if (typeof parsedDraft.context_config === 'string') {
    try { parsedDraft.context_config = JSON.parse(parsedDraft.context_config); } catch { parsedDraft.context_config = {}; }
  }
  if (typeof parsedDraft.attachments === 'string') {
    try { parsedDraft.attachments = JSON.parse(parsedDraft.attachments); } catch { parsedDraft.attachments = []; }
  }
  if (typeof parsedDraft.generation_trace === 'string') {
    try { parsedDraft.generation_trace = JSON.parse(parsedDraft.generation_trace); } catch { parsedDraft.generation_trace = null; }
  }
  if (typeof parsedDraft.refinement_result === 'string') {
    try { parsedDraft.refinement_result = JSON.parse(parsedDraft.refinement_result); } catch { parsedDraft.refinement_result = null; }
  }
  parsedDraft.task_title = draft.name as string | undefined;
  return parsedDraft;
}

interface RefineDeps {
  db: KnexType;
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  refinePlan: (opts: { currentPlan: any; instruction: string; worktreePath: string; repository: string; githubToken: string; correlationId: string; originalContext?: string; draftId?: string }) => Promise<any>;
  generateCorrelationId: () => string;
}

export function createRefineHandler(deps: RefineDeps) {
  return async function refine(req: Request, res: Response): Promise<void> {
    const { draftId, plan: currentPlan, instruction } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }
    if (!currentPlan || !Array.isArray(currentPlan)) { res.status(400).json({ error: 'currentPlan array is required' }); return; }
    if (!instruction || typeof instruction !== 'string') { res.status(400).json({ error: 'instruction is required' }); return; }

    const correlationId = deps.generateCorrelationId();
    try {
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      // Clear any previous refinement_result (e.g., from cancelled operations) to avoid false positives when polling
      await deps.db('task_drafts').where({ draft_id: draftId }).update({
        status: 'refining', refinement_result: null, updated_at: deps.db.fn.now()
      });
      res.status(202).json({ success: true, status: 'refining', message: 'Plan refinement started' });

      (async () => {
        try {
          const repoContext = await getRefineRepoContext(deps.db, draftId, req.user?.accessToken || '');

          // Fetch original generated context from the draft for richer refinement
          const draft = await deps.db('task_drafts').where({ draft_id: draftId }).select('generated_context').first();
          const originalContext = draft?.generated_context as string | undefined;

          const result = await deps.refinePlan({
            currentPlan, instruction, worktreePath: repoContext.worktreePath,
            repository: repoContext.repository, githubToken: repoContext.authToken, correlationId,
            originalContext: originalContext || undefined, draftId
          });

          // Store the refinement result including action and summary
          const refinementMeta = {
            action: result.action,
            summary: result.summary,
            timestamp: new Date().toISOString()
          };

          await deps.db('task_drafts').where({ draft_id: draftId }).update({
            plan_json: JSON.stringify(result.plan),
            refinement_result: JSON.stringify(refinementMeta),
            status: 'review',
            updated_at: deps.db.fn.now()
          });
          console.log(`[refine] Plan refinement completed for draft ${draftId} (action: ${result.action})`);
        } catch (error) {
          console.error(`[refine] Plan refinement failed for draft ${draftId}:`, error);
          await deps.db('task_drafts').where({ draft_id: draftId }).update({
            status: 'review', updated_at: deps.db.fn.now()
          });
        }
      })();
    } catch (error) {
      console.error('Refine plan error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to refine plan' });
    }
  };
}
