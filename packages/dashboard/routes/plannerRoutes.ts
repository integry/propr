import { Request, Response } from 'express';
import { Knex } from 'knex';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import {
  AttachmentService,
  generatePlan,
  refinePlan,
  executeDraft,
  getGitHubInstallationToken,
  ensureRepoCloned,
  generateCorrelationId,
  generateContextPreview,
  BranchNotFoundError
} from '@gitfix/core';
import type { MulterFile, Plan, Granularity } from '@gitfix/core';
import {
  checkDbAndAuth,
  sendCheckError,
  verifyDraftOwnership,
  setupRepoContext
} from './plannerHelpers.js';

const uploadDir = path.join(process.cwd(), 'temp_uploads');
fs.ensureDirSync(uploadDir);

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 }
});

export const attachmentUpload = upload.single('file');

interface PlannerRoutesDeps {
  db: Knex | null;
  isDbEnabled: boolean;
}

export function createPlannerRoutes(deps: PlannerRoutesDeps) {
  const { db, isDbEnabled } = deps;

  async function listDrafts(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const limit = Math.min(Number(req.query.limit) || 10, 100);
      const drafts = await db!('task_drafts')
        .where({ user_id: req.user!.id })
        .select('draft_id', 'name', 'repository', 'status', 'updated_at', 'created_at')
        .orderBy('updated_at', 'desc')
        .limit(limit);
      res.json(drafts);
    } catch (error) {
      console.error('List drafts error:', error);
      res.status(500).json({ error: 'Failed to fetch drafts' });
    }
  }

  async function createDraft(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { repository, prompt } = req.body;
    if (!repository) { res.status(400).json({ error: 'Repository is required' }); return; }

    try {
      const name = prompt ? prompt.substring(0, 50) + (prompt.length > 50 ? '...' : '') : 'Untitled Plan';
      const [draft] = await db!('task_drafts')
        .insert({ user_id: req.user!.id, repository, initial_prompt: prompt, name })
        .returning('*');
      res.status(201).json(draft);
    } catch (error) {
      console.error('Create draft error:', error);
      res.status(500).json({ error: 'Failed to create draft' });
    }
  }

  async function getDraft(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const draft = await db!('task_drafts').where({ draft_id: req.params.id }).first();
      if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
      if (draft.user_id !== req.user!.id) { res.status(403).json({ error: 'Unauthorized access to draft' }); return; }
      res.json(draft);
    } catch (error) {
      console.error('Get draft error:', error);
      res.status(500).json({ error: 'Failed to fetch draft' });
    }
  }

  async function updateDraft(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const { plan_json, context_config, status, name, chat_history } = req.body;
      const updateData: Record<string, unknown> = { updated_at: db!.fn.now() };
      if (plan_json !== undefined) updateData.plan_json = JSON.stringify(plan_json);
      if (context_config !== undefined) updateData.context_config = JSON.stringify(context_config);
      if (status !== undefined) updateData.status = status;
      if (name !== undefined) updateData.name = name;
      if (chat_history !== undefined) updateData.chat_history = JSON.stringify(chat_history);

      const [updated] = await db!('task_drafts').where({ draft_id: req.params.id }).update(updateData).returning('*');
      res.json(updated);
    } catch (error) {
      console.error('Update draft error:', error);
      res.status(500).json({ error: 'Failed to update draft' });
    }
  }

  async function deleteDraft(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      await db!('task_drafts').where({ draft_id: req.params.id }).delete();
      res.status(204).send();
    } catch (error) {
      console.error('Delete draft error:', error);
      res.status(500).json({ error: 'Failed to delete draft' });
    }
  }

  async function uploadAttachment(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const attachment = await AttachmentService.processUpload(req.file as MulterFile, req.params.id);
      res.json(attachment);
    } catch (error) {
      console.error('Upload attachment error:', error);
      const message = error instanceof Error ? error.message : 'Processing failed';
      const status = message.includes('not supported') || message.includes('Unsupported') ? 400 : 500;
      res.status(status).json({ error: message });
    }
  }

  async function getContextStats(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId, level } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, draftId, req.user!.id);
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
  }

  const VALID_GRANULARITIES = ['single', 'balanced', 'granular'] as const;
  const BRANCH_NAME_REGEX = /^[a-zA-Z0-9._/-]+$/;

  function validatePreviewInput(body: Record<string, unknown>): { valid: boolean; error?: string } {
    const { draftId, prompt, baseBranch, granularity, files } = body;
    if (!draftId) return { valid: false, error: 'draftId is required' };
    if (!prompt || typeof prompt !== 'string') return { valid: false, error: 'prompt is required' };
    if (!baseBranch || typeof baseBranch !== 'string') return { valid: false, error: 'baseBranch is required' };
    if (!BRANCH_NAME_REGEX.test(baseBranch as string)) return { valid: false, error: 'Invalid branch name format' };
    if (granularity && !VALID_GRANULARITIES.includes(granularity as typeof VALID_GRANULARITIES[number])) return { valid: false, error: `granularity must be one of: ${VALID_GRANULARITIES.join(', ')}` };
    if (files && (!Array.isArray(files) || !files.every(f => typeof f === 'string'))) return { valid: false, error: 'files must be an array of strings' };
    return { valid: true };
  }

  async function getRepoAuthToken(accessToken: string): Promise<string> {
    try { return await getGitHubInstallationToken(); } catch { return accessToken; }
  }

  async function previewContext(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const validation = validatePreviewInput(req.body);
    if (!validation.valid) { res.status(400).json({ error: validation.error }); return; }

    const { draftId, prompt, baseBranch, granularity, files } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const ownership = await verifyDraftOwnership(db!, draftId, req.user!.id, ['user_id', 'repository']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const [owner, repoName] = (draft.repository as string).split('/');
      if (!owner || !repoName) { res.status(400).json({ error: 'Invalid repository format' }); return; }

      const accessToken = req.user?.accessToken;
      if (!accessToken) { res.status(401).json({ error: 'GitHub access token not available' }); return; }

      const authToken = await getRepoAuthToken(accessToken);
      const worktreePath = await ensureRepoCloned(`https://github.com/${owner}/${repoName}.git`, owner, repoName, authToken);

      const result = await generateContextPreview({ draftId, prompt, baseBranch, granularity: (granularity || 'balanced') as Granularity, files, worktreePath, correlationId });
      res.json(result);
    } catch (error) {
      console.error('Preview context error:', error);
      if (error instanceof BranchNotFoundError) { res.status(400).json({ error: error.message }); return; }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to preview context' });
    }
  }

  async function deleteAttachment(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      await AttachmentService.deleteAttachment(req.params.id, req.params.attachmentId);
      res.status(204).send();
    } catch (error) {
      console.error('Delete attachment error:', error);
      const message = error instanceof Error ? error.message : 'Failed to delete attachment';
      res.status(message.includes('not found') ? 404 : 500).json({ error: message });
    }
  }

  async function generate(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId, baseBranch, granularity } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    const correlationId = generateCorrelationId();

    try {
      const ownership = await verifyDraftOwnership(db!, draftId, req.user!.id, ['user_id', 'repository', 'context_config']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const [owner, repoName] = (draft.repository as string).split('/');
      if (!owner || !repoName) { res.status(400).json({ error: 'Invalid repository format' }); return; }

      const accessToken = req.user?.accessToken;
      if (!accessToken) { res.status(401).json({ error: 'GitHub access token not available' }); return; }

      let authToken: string;
      try { authToken = await getGitHubInstallationToken(); } catch { authToken = accessToken; }

      const repoUrl = `https://github.com/${owner}/${repoName}.git`;
      const worktreePath = await ensureRepoCloned(repoUrl, owner, repoName, authToken);

      if (baseBranch || granularity) {
        const existingConfig = (draft.context_config as Record<string, unknown>) || {};
        const updatedConfig = {
          ...existingConfig,
          ...(baseBranch && { baseBranch }),
          ...(granularity && VALID_GRANULARITIES.includes(granularity) && { granularity })
        };
        await db!('task_drafts').where({ draft_id: draftId }).update({
          context_config: JSON.stringify(updatedConfig),
          updated_at: db!.fn.now()
        });
      }

      // Set status to 'generating' and return immediately
      await db!('task_drafts').where({ draft_id: draftId }).update({
        status: 'generating',
        updated_at: db!.fn.now()
      });

      // Return 202 Accepted immediately - client should poll for status
      res.status(202).json({ success: true, status: 'generating', message: 'Plan generation started' });

      // Run generation in background (don't await)
      generatePlan({ draftId, worktreePath, githubToken: authToken, correlationId })
        .then(() => {
          console.log(`[generate] Plan generation completed for draft ${draftId}`);
        })
        .catch(async (error) => {
          console.error(`[generate] Plan generation failed for draft ${draftId}:`, error);
          // Update draft status to indicate failure
          try {
            await db!('task_drafts').where({ draft_id: draftId }).update({
              status: 'draft',
              generation_trace: JSON.stringify({
                steps: [],
                error: error instanceof Error ? error.message : 'Plan generation failed'
              }),
              updated_at: db!.fn.now()
            });
          } catch (dbError) {
            console.error(`[generate] Failed to update draft status after error:`, dbError);
          }
        });
    } catch (error) {
      console.error('Generate plan error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate plan' });
    }
  }

  async function refine(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId, plan: currentPlan, instruction } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }
    if (!currentPlan || !Array.isArray(currentPlan)) { res.status(400).json({ error: 'currentPlan array is required' }); return; }
    if (!instruction || typeof instruction !== 'string') { res.status(400).json({ error: 'instruction is required' }); return; }

    const correlationId = generateCorrelationId();

    try {
      // Verify ownership
      const ownership = await verifyDraftOwnership(db!, draftId, req.user!.id, ['user_id']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      // Set status to 'refining' and return immediately
      await db!('task_drafts').where({ draft_id: draftId }).update({
        status: 'refining',
        updated_at: db!.fn.now()
      });

      // Return 202 Accepted immediately - client should poll for status
      res.status(202).json({ success: true, status: 'refining', message: 'Plan refinement started' });

      // Run refinement in background
      (async () => {
        try {
          const repoContext = await getRefineRepoContext(draftId, req.user?.accessToken || '');
          const plan = await refinePlan({
            currentPlan: currentPlan as Plan,
            instruction,
            worktreePath: repoContext.worktreePath,
            repository: repoContext.repository,
            githubToken: repoContext.authToken,
            correlationId
          });

          await db!('task_drafts').where({ draft_id: draftId }).update({
            plan_json: JSON.stringify(plan),
            status: 'review',
            updated_at: db!.fn.now()
          });
          console.log(`[refine] Plan refinement completed for draft ${draftId}`);
        } catch (error) {
          console.error(`[refine] Plan refinement failed for draft ${draftId}:`, error);
          // Revert status to review on failure
          await db!('task_drafts').where({ draft_id: draftId }).update({
            status: 'review',
            updated_at: db!.fn.now()
          });
        }
      })();
    } catch (error) {
      console.error('Refine plan error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to refine plan' });
    }
  }

  async function getRefineRepoContext(draftId: string | undefined, fallbackToken: string) {
    if (!draftId || !isDbEnabled || !db) {
      return { worktreePath: process.cwd(), authToken: fallbackToken, repository: 'unknown/unknown' };
    }
    const draft = await db('task_drafts').where({ draft_id: draftId }).first();
    if (!draft) return { worktreePath: process.cwd(), authToken: fallbackToken, repository: 'unknown/unknown' };
    return setupRepoContext(draft, fallbackToken);
  }

  async function finalize(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    const correlationId = generateCorrelationId();

    try {
      const result = await executeDraft(draftId, req.user!.id, correlationId);
      if (result.alreadyExecuted) { res.json({ success: true, alreadyExecuted: true, issuesCreated: 0 }); return; }
      res.json({ success: true, results: result.results, issuesCreated: result.results?.length || 0 });
    } catch (error) {
      console.error('Finalize plan error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to execute plan' });
    }
  }

  async function getAttachmentContent(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id, ['user_id', 'attachments']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const attachments = (ownership.draft?.attachments || []) as { id: string; storedPath: string; mimeType: string; originalName: string }[];
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
  }

  async function getRepositoryInfo(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(isDbEnabled, db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id, ['user_id', 'repository']);
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
  }

  return {
    listDrafts,
    createDraft,
    getDraft,
    updateDraft,
    deleteDraft,
    uploadAttachment,
    deleteAttachment,
    getAttachmentContent,
    getRepositoryInfo,
    getContextStats,
    previewContext,
    generate,
    refine,
    finalize
  };
}
