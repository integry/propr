import { Request, Response } from 'express';
import { Knex } from 'knex';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
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
  withAuthCheck,
  createValidateContextRepositoryHandler
} from './plannerHelpers.js';
import {
  parseSearchWords,
  scoreDrafts,
  sortDraftsByScore,
  removeSearchScore
} from './plannerSearchHelpers.js';
import {
  buildIssueSummaryMap,
  parseDraftJsonFields,
  attachIssueSummaries
} from './plannerDraftHelpers.js';
import {
  createGenerateHandler,
  createRefineHandler,
  createFinalizeHandler,
  createAbortGenerationHandler,
  createAbortRefinementHandler,
  createReviseDraftHandler
} from './plannerActionHandlers.js';
import { linkTodosToDraft, pauseDraft, resumeDraft } from '@propr/core';

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
      const excludeStatuses = req.query.excludeStatuses as string | undefined;
      const validStatuses = ['draft', 'review', 'generating', 'refining', 'executed', 'approved', 'merged', 'pr_created'];
      // Build query with optional repository filter
      let query = db!('task_drafts').where({ user_id: req.user!.id });

      if (repository && repository !== 'all') {
        query = query.andWhere('repository', repository);
      }

      if (status && status !== 'all' && validStatuses.includes(status)) {
        query = query.andWhere('status', status);
      }

      // Exclude multiple statuses (comma-separated) - useful for header dropdown
      if (excludeStatuses) {
        const statusesToExclude = excludeStatuses.split(',').filter(s => validStatuses.includes(s.trim()));
        if (statusesToExclude.length > 0) {
          query = query.whereNotIn('status', statusesToExclude);
        }
      }

      // Apply search filter to name and initial_prompt with partial word matching
      const searchWords = parseSearchWords(search);
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
        .select('draft_id', 'name', 'repository', 'status', 'updated_at', 'created_at', 'initial_prompt', 'paused', 'paused_at')
        .orderBy('updated_at', 'desc');

      // Apply relevance scoring and sorting when searching
      if (searchWords.length > 0) {
        const exactPhrase = search!.trim().toLowerCase();
        const scoredDrafts = scoreDrafts(drafts, searchWords, exactPhrase);
        sortDraftsByScore(scoredDrafts);
        drafts = removeSearchScore(scoredDrafts);
      }

      // Apply pagination after scoring/sorting
      const paginatedDrafts = drafts.slice(offset, offset + limit);

      // Get issue summaries for paginated drafts only
      const draftIds = paginatedDrafts.map((d: { draft_id: string }) => d.draft_id);
      if (draftIds.length > 0) {
        const issues = await db!('plan_issues')
          .whereIn('draft_id', draftIds)
          .select('draft_id', 'status');
        const issueSummaries = buildIssueSummaryMap(issues);
        attachIssueSummaries(paginatedDrafts as Array<Record<string, unknown> & { draft_id: string }>, issueSummaries);
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

    const { repository, prompt, todoIds } = req.body;
    if (!repository) { res.status(400).json({ error: 'Repository is required' }); return; }

    try {
      const draftId = crypto.randomUUID();
      // Store full prompt as name - truncation should happen on frontend via CSS only
      const name = prompt || 'Untitled Plan';
      await db!('task_drafts')
        .insert({ draft_id: draftId, user_id: req.user!.id, repository, initial_prompt: prompt, name });

      // Link todos to the newly created draft if todoIds provided
      if (Array.isArray(todoIds) && todoIds.length > 0) {
        await linkTodosToDraft(todoIds, draftId, req.user!.id);
      }

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
      const parsedDraft = parseDraftJsonFields(draft) as Record<string, unknown> & { task_title?: string };
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

      const { plan_json, context_config, status, name, chat_history, initial_prompt } = req.body;
      const updateData: Record<string, unknown> = { updated_at: db!.fn.now() };
      if (plan_json !== undefined) updateData.plan_json = JSON.stringify(plan_json);
      if (context_config !== undefined) updateData.context_config = JSON.stringify(context_config);
      if (status !== undefined) updateData.status = status;
      if (name !== undefined) updateData.name = name;
      if (chat_history !== undefined) updateData.chat_history = JSON.stringify(chat_history);
      if (initial_prompt !== undefined) updateData.initial_prompt = initial_prompt;

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

  async function resetDraftToSetup(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id, ['user_id', 'status', 'context_config']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      if (ownership.draft!.status !== 'review') {
        res.status(400).json({ error: 'Can only reset drafts that are in review status' });
        return;
      }
      await db!('task_drafts').where({ draft_id: req.params.id }).update({
        status: 'draft', plan_json: null, chat_history: null, updated_at: db!.fn.now()
      });
      const updated = await db!('task_drafts').where({ draft_id: req.params.id }).first();

      // Parse JSON fields and add task_title
      const parsedDraft = parseDraftJsonFields(updated) as Record<string, unknown> & { task_title?: string };
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

  const generate = createGenerateHandler(db);
  const refine = createRefineHandler(db);
  const finalize = createFinalizeHandler(db);
  const abortGeneration = createAbortGenerationHandler(db);
  const abortRefinement = createAbortRefinementHandler(db);
  const reviseDraft = createReviseDraftHandler(db);

  async function pauseDraftExecution(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const result = await pauseDraft(req.params.id);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }

      res.json({ paused: result.paused, pausedAt: result.pausedAt });
    } catch (error) {
      console.error('Pause draft error:', error);
      res.status(500).json({ error: 'Failed to pause draft execution' });
    }
  }

  async function resumeDraftExecution(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const result = await resumeDraft(req.params.id);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }

      res.json({ paused: result.paused, pausedAt: result.pausedAt });
    } catch (error) {
      console.error('Resume draft error:', error);
      res.status(500).json({ error: 'Failed to resume draft execution' });
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
    abortGeneration,
    abortRefinement,
    reviseDraft,
    pauseDraftExecution,
    resumeDraftExecution
  };
}
