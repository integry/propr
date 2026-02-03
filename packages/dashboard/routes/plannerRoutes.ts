import { Request, Response } from 'express';
import { Knex } from 'knex';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import { Redis } from 'ioredis';
import {
  refinePlan,
  executeDraft,
  getGitHubInstallationToken,
  ensureRepoCloned,
  generateCorrelationId
} from '@gitfix/core';
import type { Plan } from '@gitfix/core';
import {
  checkDbAndAuth,
  sendCheckError,
  verifyDraftOwnership,
  createDownloadContextHandler,
  createGetRepositoryInfoHandler,
  createGetAttachmentContentHandler,
  createPreviewContextHandler,
  createDeleteAttachmentHandler,
  createUploadAttachmentHandler,
  createGetContextStatsHandler,
  createGetIssuesHandler,
  createImplementIssueHandler,
  createUpdateIssueHandler,
  createImplementAllIssuesHandler,
  validatePreviewInput,
  validateContextRepositories,
  withAuthCheck,
  updateDraftContextConfig,
  runBackgroundGeneration,
  getRefineRepoContext,
  createValidateContextRepositoryHandler,
  GenerateRequestBody
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
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(Math.max(1, Number(req.query.limit) || 10), 100);
      const offset = (page - 1) * limit;
      const repository = req.query.repository as string | undefined;
      const search = req.query.search as string | undefined;
      const status = req.query.status as string | undefined;
      const validStatuses = ['draft', 'review', 'generating', 'refining', 'executed', 'approved', 'merged'];
      // Build query with optional repository filter
      let query = db!('task_drafts').where({ user_id: req.user!.id });

      if (repository && repository !== 'all') {
        query = query.andWhere('repository', repository);
      }

      if (status && status !== 'all' && validStatuses.includes(status)) {
        query = query.andWhere('status', status);
      }

      // Apply search filter to name and initial_prompt with partial word matching
      const searchWords = search?.trim().split(/\s+/).filter(w => w.length > 0) || [];
      if (searchWords.length > 0) {
        // Match any word (partial matching) - results where ANY word matches
        query = query.andWhere(function() {
          for (const word of searchWords) {
            const wordPattern = `%${word}%`;
            this.orWhere('name', 'like', wordPattern)
              .orWhere('initial_prompt', 'like', wordPattern);
          }
        });
      }

      let drafts = await query
        .select('draft_id', 'name', 'repository', 'status', 'updated_at', 'created_at', 'initial_prompt')
        .orderBy('updated_at', 'desc');

      // Apply relevance scoring and sorting when searching
      if (searchWords.length > 0) {
        const exactPhrase = search!.trim().toLowerCase();

        // Score each draft based on search relevance
        const scoredDrafts = drafts.map((draft: { name?: string; initial_prompt?: string }) => {
          const nameLC = (draft.name || '').toLowerCase(), promptLC = (draft.initial_prompt || '').toLowerCase();
          let score = 0;

          // Highest score: exact phrase match in name
          if (nameLC.includes(exactPhrase)) score += 100;
          // High score: exact phrase match in prompt
          if (promptLC.includes(exactPhrase)) score += 80;

          // Medium score: all words match (but not as exact phrase)
          const allWordsMatchName = searchWords.every(w => nameLC.includes(w.toLowerCase()));
          const allWordsMatchPrompt = searchWords.every(w => promptLC.includes(w.toLowerCase()));
          if (allWordsMatchName && !nameLC.includes(exactPhrase)) score += 50;
          if (allWordsMatchPrompt && !promptLC.includes(exactPhrase)) score += 40;

          // Lower score: partial word matches (some words match)
          const wordsMatchingName = searchWords.filter(w => nameLC.includes(w.toLowerCase())).length;
          const wordsMatchingPrompt = searchWords.filter(w => promptLC.includes(w.toLowerCase())).length;
          score += wordsMatchingName * 10;
          score += wordsMatchingPrompt * 5;

          return { ...draft, _searchScore: score };
        });

        // Sort by score (descending), then by updated_at (descending)
        scoredDrafts.sort((a, b) => {
          if (b._searchScore !== a._searchScore) return b._searchScore - a._searchScore;
          const aDate = (a as { updated_at?: string }).updated_at;
          const bDate = (b as { updated_at?: string }).updated_at;
          return new Date(bDate || 0).getTime() - new Date(aDate || 0).getTime();
        });

        // Remove the score property before returning
        drafts = scoredDrafts.map((d: { _searchScore?: number; [key: string]: unknown }) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { _searchScore, ...rest } = d;
          return rest;
        });
      }

      // Apply pagination after scoring/sorting
      const paginatedDrafts = drafts.slice(offset, offset + limit);

      // Get issue summaries for paginated drafts only
      const draftIds = paginatedDrafts.map((d: { draft_id: string }) => d.draft_id);
      if (draftIds.length > 0) {
        const issueSummaries = await db!('plan_issues')
          .whereIn('draft_id', draftIds)
          .select('draft_id', 'status')
          .then((issues: Array<{ draft_id: string; status: string }>) => {
            const summaryMap: Record<string, { total: number; pending: number; processing: number; merged: number; closed: number }> = {};
            for (const issue of issues) {
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
          });

        // Attach issue summaries to paginated drafts
        for (const draft of paginatedDrafts) {
          const typedDraft = draft as { draft_id: string; issue_summary?: { total: number; pending: number; processing: number; merged: number; closed: number } };
          typedDraft.issue_summary = issueSummaries[typedDraft.draft_id] || null;
        }
      }

      res.json({
        drafts: paginatedDrafts,
        total: drafts.length,
        page,
        limit,
        hasMore: offset + paginatedDrafts.length < drafts.length
      });
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

  const ownershipVerifier = (draftId: string, userId: string, fields?: string[]) => verifyDraftOwnership(db!, draftId, userId, fields);

  const uploadAttachment = withAuthCheck(db, createUploadAttachmentHandler({ verifyOwnership: ownershipVerifier }));
  const getContextStats = withAuthCheck(db, createGetContextStatsHandler({ verifyOwnership: ownershipVerifier }));
  const previewContext = withAuthCheck(db, createPreviewContextHandler({ verifyOwnership: ownershipVerifier, validateInput: validatePreviewInput, db }));
  const deleteAttachment = withAuthCheck(db, createDeleteAttachmentHandler({ verifyOwnership: ownershipVerifier }));

  async function generate(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId, baseBranch, granularity, contextLevel, compress, contextRepositories } = req.body as GenerateRequestBody;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    // Validate context repositories if provided
    if (contextRepositories) {
      const repoValidation = validateContextRepositories(contextRepositories);
      if (!repoValidation.valid) {
        res.status(400).json({ error: repoValidation.error });
        return;
      }
    }

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

      await updateDraftContextConfig(db, draftId, draft, { baseBranch, granularity, contextLevel, compress, contextRepositories });

      await db!('task_drafts').where({ draft_id: draftId }).update({
        status: 'generating',
        updated_at: db!.fn.now()
      });

      res.status(202).json({ success: true, status: 'generating', message: 'Plan generation started' });

      runBackgroundGeneration({ db, draftId, worktreePath, authToken, correlationId });
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
          const repoContext = await getRefineRepoContext(db, draftId, req.user?.accessToken || '');
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

  async function resetDraftToSetup(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id, ['user_id', 'status', 'context_config']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      if (draft.status !== 'review') {
        res.status(400).json({ error: 'Can only reset drafts that are in review status' });
        return;
      }

      // Reset status to 'draft' and clear plan_json, but preserve context_config
      await db!('task_drafts').where({ draft_id: req.params.id }).update({
        status: 'draft',
        plan_json: null,
        chat_history: null,
        updated_at: db!.fn.now()
      });

      // Fetch the updated draft
      const updated = await db!('task_drafts').where({ draft_id: req.params.id }).first();

      // Parse JSON fields and add task_title
      const parsedDraft: Record<string, unknown> & { task_title?: string } = { ...updated };
      if (typeof parsedDraft.context_config === 'string') {
        try { parsedDraft.context_config = JSON.parse(parsedDraft.context_config); } catch { parsedDraft.context_config = {}; }
      }
      if (typeof parsedDraft.attachments === 'string') {
        try { parsedDraft.attachments = JSON.parse(parsedDraft.attachments); } catch { parsedDraft.attachments = []; }
      }
      parsedDraft.task_title = updated.name;

      res.json(parsedDraft);
    } catch (error) {
      console.error('Reset draft to setup error:', error);
      res.status(500).json({ error: 'Failed to reset draft' });
    }
  }

  const getAttachmentContent = withAuthCheck(db, createGetAttachmentContentHandler({ verifyOwnership: ownershipVerifier }));
  const getRepositoryInfo = withAuthCheck(db, createGetRepositoryInfoHandler({ verifyOwnership: ownershipVerifier }));
  const downloadContext = withAuthCheck(db, createDownloadContextHandler({ verifyOwnership: ownershipVerifier }));
  const getIssues = withAuthCheck(db, createGetIssuesHandler({ verifyOwnership: ownershipVerifier }));
  const implementIssue = withAuthCheck(db, createImplementIssueHandler({ verifyOwnership: ownershipVerifier }));
  const updateIssue = withAuthCheck(db, createUpdateIssueHandler({ verifyOwnership: ownershipVerifier }));
  const implementAllIssues = withAuthCheck(db, createImplementAllIssuesHandler({ verifyOwnership: ownershipVerifier }));
  const validateContextRepository = withAuthCheck(db, createValidateContextRepositoryHandler());

  async function abortGeneration(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    try {
      const draft = await db!('task_drafts').where({ draft_id: draftId, user_id: req.user!.id }).first();
      if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
      if (draft.status !== 'generating') {
        res.status(400).json({ error: 'Can only abort drafts that are currently generating' });
        return;
      }

      // Set abort signal in Redis
      const redis = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
      });
      await redis.setex(`planner:abort:${draftId}`, 300, '1'); // Expires in 5 minutes
      await redis.quit();

      // Update draft status back to draft (ready for review/edit)
      await db!('task_drafts').where({ draft_id: draftId }).update({
        status: 'draft',
        generation_trace: JSON.stringify({
          steps: [],
          error: 'Generation aborted by user',
          abortedAt: new Date().toISOString()
        }),
        updated_at: db!.fn.now()
      });

      console.log(`[abort] Plan generation aborted for draft ${draftId}`);
      res.json({ success: true, message: 'Generation aborted' });
    } catch (error) {
      console.error('Abort generation error:', error);
      res.status(500).json({ error: 'Failed to abort generation' });
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
    resetDraftToSetup,
    getIssues,
    implementIssue,
    updateIssue,
    implementAllIssues,
    validateContextRepository,
    abortGeneration
  };
}
