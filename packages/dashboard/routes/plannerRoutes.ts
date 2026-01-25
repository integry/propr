import { Request, Response } from 'express';
import { Knex } from 'knex';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import {
  generatePlan,
  refinePlan,
  executeDraft,
  getGitHubInstallationToken,
  getAuthenticatedOctokit,
  ensureRepoCloned,
  generateCorrelationId,
  getPlanIssuesByDraft,
  getPlanIssue,
  updatePlanIssue,
  batchUpdatePlanIssueConfig,
  loadPrimaryProcessingLabels
} from '@gitfix/core';
import type { Plan, PlanIssue, PlanIssueStatus } from '@gitfix/core';
import {
  checkDbAndAuth,
  sendCheckError,
  verifyDraftOwnership,
  setupRepoContext,
  createDownloadContextHandler,
  createGetRepositoryInfoHandler,
  createGetAttachmentContentHandler,
  createPreviewContextHandler,
  createDeleteAttachmentHandler,
  createUploadAttachmentHandler,
  createGetContextStatsHandler,
  validatePreviewInput,
  VALID_GRANULARITIES
} from './plannerHelpers.js';

const uploadDir = path.join(process.cwd(), 'temp_uploads');
fs.ensureDirSync(uploadDir);

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 }
});

export const attachmentUpload = upload.single('file');

interface PlannerRoutesDeps {
  db: Knex;
}

export function createPlannerRoutes(deps: PlannerRoutesDeps) {
  const { db } = deps;

  async function listDrafts(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
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
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { repository, prompt } = req.body;
    if (!repository) { res.status(400).json({ error: 'Repository is required' }); return; }

    try {
      const draftId = crypto.randomUUID();
      const name = prompt ? prompt.substring(0, 50) + (prompt.length > 50 ? '...' : '') : 'Untitled Plan';
      await db!('task_drafts')
        .insert({ draft_id: draftId, user_id: req.user!.id, repository, initial_prompt: prompt, name });

      // Fetch the created draft (SQLite doesn't support returning() properly)
      const draft = await db!('task_drafts').where({ draft_id: draftId }).first();
      res.status(201).json(draft);
    } catch (error) {
      console.error('Create draft error:', error);
      res.status(500).json({ error: 'Failed to create draft' });
    }
  }

  async function getDraft(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const draft = await db!('task_drafts').where({ draft_id: req.params.id }).first();
      if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
      if (draft.user_id !== req.user!.id) { res.status(403).json({ error: 'Unauthorized access to draft' }); return; }

      // Parse JSON string fields before returning
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
      // Map name to task_title as expected by frontend
      parsedDraft.task_title = draft.name;

      res.json(parsedDraft);
    } catch (error) {
      console.error('Get draft error:', error);
      res.status(500).json({ error: 'Failed to fetch draft' });
    }
  }

  async function updateDraft(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
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

      await db!('task_drafts').where({ draft_id: req.params.id }).update(updateData);
      // Fetch the updated draft (SQLite doesn't support returning() properly)
      const updated = await db!('task_drafts').where({ draft_id: req.params.id }).first();
      // Map name to task_title as expected by frontend
      if (updated) {
        const responseData: Record<string, unknown> & { task_title?: string } = { ...updated };
        responseData.task_title = updated.name;
        res.json(responseData);
      } else {
        res.json(updated);
      }
    } catch (error) {
      console.error('Update draft error:', error);
      res.status(500).json({ error: 'Failed to update draft' });
    }
  }

  async function deleteDraft(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
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

  const uploadAttachmentHandler = createUploadAttachmentHandler({
    verifyOwnership: (draftId, userId, fields) => verifyDraftOwnership(db!, draftId, userId, fields)
  });

  async function uploadAttachment(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    return uploadAttachmentHandler(req, res);
  }

  const getContextStatsHandler = createGetContextStatsHandler({
    verifyOwnership: (draftId, userId, fields) => verifyDraftOwnership(db!, draftId, userId, fields)
  });

  async function getContextStats(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    return getContextStatsHandler(req, res);
  }

  const previewContextHandler = createPreviewContextHandler({
    verifyOwnership: (draftId, userId, fields) => verifyDraftOwnership(db!, draftId, userId, fields),
    validateInput: validatePreviewInput
  });

  async function previewContext(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    return previewContextHandler(req, res);
  }

  const deleteAttachmentHandler = createDeleteAttachmentHandler({
    verifyOwnership: (draftId, userId, fields) => verifyDraftOwnership(db!, draftId, userId, fields)
  });

  async function deleteAttachment(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    return deleteAttachmentHandler(req, res);
  }

  interface GenerateRequestBody {
    draftId?: string;
    baseBranch?: string;
    granularity?: string;
    contextLevel?: number;
    compress?: boolean;
  }

  async function updateDraftContextConfig(
    draftId: string,
    draft: Record<string, unknown>,
    body: GenerateRequestBody
  ): Promise<void> {
    const { baseBranch, granularity, contextLevel, compress } = body;
    const hasUpdates = baseBranch || granularity || contextLevel !== undefined || compress !== undefined;
    if (!hasUpdates) return;

    const existingConfig = (draft.context_config as Record<string, unknown>) || {};
    const updatedConfig = {
      ...existingConfig,
      ...(baseBranch && { baseBranch }),
      ...(granularity && VALID_GRANULARITIES.includes(granularity as typeof VALID_GRANULARITIES[number]) && { granularity }),
      ...(contextLevel !== undefined && { contextLevel }),
      ...(compress !== undefined && { compress })
    };
    await db!('task_drafts').where({ draft_id: draftId }).update({
      context_config: JSON.stringify(updatedConfig),
      updated_at: db!.fn.now()
    });
  }

  function runBackgroundGeneration(
    draftId: string,
    worktreePath: string,
    authToken: string,
    correlationId: string
  ): void {
    generatePlan({ draftId, worktreePath, githubToken: authToken, correlationId })
      .then(() => {
        console.log(`[generate] Plan generation completed for draft ${draftId}`);
      })
      .catch(async (error) => {
        console.error(`[generate] Plan generation failed for draft ${draftId}:`, error);
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
  }

  async function generate(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId, baseBranch, granularity, contextLevel, compress } = req.body as GenerateRequestBody;
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
      const worktreePath = await ensureRepoCloned({ repoUrl, owner, repoName, authToken });

      await updateDraftContextConfig(draftId, draft, { baseBranch, granularity, contextLevel, compress });

      await db!('task_drafts').where({ draft_id: draftId }).update({
        status: 'generating',
        updated_at: db!.fn.now()
      });

      res.status(202).json({ success: true, status: 'generating', message: 'Plan generation started' });

      runBackgroundGeneration(draftId, worktreePath, authToken, correlationId);
    } catch (error) {
      console.error('Generate plan error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate plan' });
    }
  }

  async function refine(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
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
    if (!draftId) {
      return { worktreePath: process.cwd(), authToken: fallbackToken, repository: 'unknown/unknown' };
    }
    const draft = await db('task_drafts').where({ draft_id: draftId }).first();
    if (!draft) return { worktreePath: process.cwd(), authToken: fallbackToken, repository: 'unknown/unknown' };
    return setupRepoContext(draft, fallbackToken);
  }

  async function finalize(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
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

  const getAttachmentContentHandler = createGetAttachmentContentHandler({
    verifyOwnership: (draftId, userId, fields) => verifyDraftOwnership(db!, draftId, userId, fields)
  });

  async function getAttachmentContent(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    return getAttachmentContentHandler(req, res);
  }

  const getRepositoryInfoHandler = createGetRepositoryInfoHandler({
    verifyOwnership: (draftId, userId, fields) => verifyDraftOwnership(db!, draftId, userId, fields)
  });

  async function getRepositoryInfo(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    return getRepositoryInfoHandler(req, res);
  }

  const downloadContextHandler = createDownloadContextHandler({
    verifyOwnership: (draftId, userId, fields) => verifyDraftOwnership(db!, draftId, userId, fields)
  });

  async function downloadContext(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    return downloadContextHandler(req, res);
  }

  // --- Plan Issue Management Endpoints ---

  /**
   * GET /api/planner/drafts/:id/issues
   * Get all issues created from a plan with their status.
   */
  async function getIssues(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const issues = await getPlanIssuesByDraft(req.params.id);
      res.json(issues);
    } catch (error) {
      console.error('Get issues error:', error);
      res.status(500).json({ error: 'Failed to fetch issues' });
    }
  }

  /**
   * POST /api/planner/drafts/:id/issues/:issueNumber/implement
   * Add implementation label to trigger AI processing for a specific issue.
   */
  async function implementIssue(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const draftId = req.params.id;
    const issueNumber = parseInt(req.params.issueNumber, 10);

    if (isNaN(issueNumber)) {
      res.status(400).json({ error: 'Invalid issue number' });
      return;
    }

    try {
      const ownership = await verifyDraftOwnership(db!, draftId, req.user!.id, ['user_id', 'repository']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const repository = draft.repository as string;
      const [owner, repo] = repository.split('/');

      if (!owner || !repo) {
        res.status(400).json({ error: 'Invalid repository format' });
        return;
      }

      // Get the plan issue to verify it exists
      const planIssue = await getPlanIssue(draftId, issueNumber);
      if (!planIssue) {
        res.status(404).json({ error: 'Issue not found in this plan' });
        return;
      }

      // Get the implementation label(s) from config
      const processingLabels = await loadPrimaryProcessingLabels();
      const implementLabel = processingLabels[0] || 'AI';

      // Add label to the GitHub issue
      const octokit = await getAuthenticatedOctokit();
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner,
        repo,
        issue_number: issueNumber,
        labels: [implementLabel]
      });

      // Update the plan issue status to processing
      await updatePlanIssue(draftId, issueNumber, { status: 'processing' });

      res.json({ success: true, message: `Added '${implementLabel}' label to issue #${issueNumber}` });
    } catch (error) {
      console.error('Implement issue error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to implement issue' });
    }
  }

  /**
   * PATCH /api/planner/drafts/:id/issues/:issueNumber
   * Update agent/model selection for a specific issue.
   */
  async function updateIssue(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const draftId = req.params.id;
    const issueNumber = parseInt(req.params.issueNumber, 10);

    if (isNaN(issueNumber)) {
      res.status(400).json({ error: 'Invalid issue number' });
      return;
    }

    try {
      const ownership = await verifyDraftOwnership(db!, draftId, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const { agent_alias, model_name, status } = req.body;

      // Validate status if provided
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

      if (!updated) {
        res.status(404).json({ error: 'Issue not found in this plan' });
        return;
      }

      res.json(updated);
    } catch (error) {
      console.error('Update issue error:', error);
      res.status(500).json({ error: 'Failed to update issue' });
    }
  }

  /**
   * POST /api/planner/drafts/:id/implement-all
   * Batch add implementation labels with optional agent/model override.
   */
  async function implementAllIssues(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const draftId = req.params.id;

    try {
      const ownership = await verifyDraftOwnership(db!, draftId, req.user!.id, ['user_id', 'repository']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const repository = draft.repository as string;
      const [owner, repo] = repository.split('/');

      if (!owner || !repo) {
        res.status(400).json({ error: 'Invalid repository format' });
        return;
      }

      const { agent_alias, model_name } = req.body;

      // Update all issues with the provided agent/model config if specified
      if (agent_alias !== undefined || model_name !== undefined) {
        await batchUpdatePlanIssueConfig(draftId, agent_alias, model_name);
      }

      // Get all pending issues for this draft
      const issues = await getPlanIssuesByDraft(draftId);
      const pendingIssues = issues.filter(issue => issue.status === 'pending');

      if (pendingIssues.length === 0) {
        res.json({ success: true, message: 'No pending issues to implement', implemented: 0 });
        return;
      }

      // Get the implementation label(s) from config
      const processingLabels = await loadPrimaryProcessingLabels();
      const implementLabel = processingLabels[0] || 'AI';

      const octokit = await getAuthenticatedOctokit();
      const results: { issueNumber: number; success: boolean; error?: string }[] = [];

      // Add label to each pending issue
      for (const issue of pendingIssues) {
        try {
          await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: issue.issue_number,
            labels: [implementLabel]
          });

          // Update the plan issue status to processing
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
    downloadContext,
    generate,
    refine,
    finalize,
    // Plan issue management endpoints
    getIssues,
    implementIssue,
    updateIssue,
    implementAllIssues
  };
}
