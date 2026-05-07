import { Request, Response } from 'express';
import { Knex } from 'knex';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import { validatePagination, validateRepository, validateRepositoryFilter, validateEnum, validateUUID, ALLOWED_EXTENSIONS } from './validation.js';
import { checkDbAndAuth, sendCheckError, verifyDraftOwnership, createDownloadContextHandler, createGetRepositoryInfoHandler, createGetAttachmentContentHandler, createPreviewContextHandler, createDeleteAttachmentHandler, createUploadAttachmentHandler, createGetContextStatsHandler, createGetIssuesHandler, createImplementIssueHandler, createUpdateIssueHandler, createImplementAllIssuesHandler, validatePreviewInput, withAuthCheck, createValidateContextRepositoryHandler } from './plannerHelpers.js';
import { parseSearchWords, scoreDrafts, sortDraftsByScore, removeSearchScore } from './plannerSearchHelpers.js';
import { buildIssueSummaryMap, parseDraftJsonFields, attachIssueSummaries } from './plannerDraftHelpers.js';
import { createGenerateHandler, createRefineHandler, createFinalizeHandler, createAbortGenerationHandler, createAbortRefinementHandler, createReviseDraftHandler } from './plannerActionHandlers.js';
import {
  buildNormalizedUltrafixUpdate,
  ULTRAFIX_GOAL_MAX,
  ULTRAFIX_GOAL_MIN,
  ULTRAFIX_MAX_CYCLES_MIN,
  validateRunUltrafixValue,
  validateUltrafixPayload,
  validateUltrafixValue
} from './planIssueRouteUtils.js';
import { linkTodosToDraft, pauseDraft, resumeDraft, parseExistingContextConfig, type TaskDraftConfig } from '@propr/core';

const uploadDir = path.join(process.cwd(), 'temp_uploads');
fs.ensureDirSync(uploadDir);

const ALLOWED_MIME_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.includes('..') || file.originalname.includes('/') || file.originalname.includes('\\'))
      return cb(new Error('Invalid filename'));
    if (file.originalname.length > 255)
      return cb(new Error('Filename is too long (max 255 characters)'));
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext && !ALLOWED_EXTENSIONS.includes(ext as typeof ALLOWED_EXTENSIONS[number]))
      return cb(new Error(`File type not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`));
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype))
      return cb(new Error(`MIME type not allowed. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`));
    cb(null, true);
  },
});

export const attachmentUpload = upload.single('file');

interface PlannerRoutesDeps { db: Knex; }

class ExecutionSettingsValidationError extends Error {}
class ExecutionSettingsContextConfigError extends Error {}

type DraftExecutionConfig = Partial<TaskDraftConfig> & {
  useEpic?: boolean;
  autoMerge?: boolean;
  runUltrafix?: boolean;
  ultrafixGoal?: number | null;
  ultrafixMaxCycles?: number | null;
};

export function buildUpdatedExecutionConfig(
  existingConfig: DraftExecutionConfig,
  body: Record<string, unknown>,
): DraftExecutionConfig {
  function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new ExecutionSettingsValidationError(`${fieldName} must be a boolean`);
    return value;
  }

  const useEpic = parseOptionalBoolean(body.useEpic, 'useEpic');
  const autoMerge = parseOptionalBoolean(body.autoMerge, 'autoMerge');
  const runUltrafixError = validateRunUltrafixValue(body.runUltrafix, 'runUltrafix', { allowNull: false });
  if (runUltrafixError) throw new ExecutionSettingsValidationError(runUltrafixError);
  const ultrafixGoalError = validateUltrafixValue(body.ultrafixGoal, 'ultrafixGoal', {
    minimum: ULTRAFIX_GOAL_MIN,
    maximum: ULTRAFIX_GOAL_MAX
  });
  if (ultrafixGoalError) throw new ExecutionSettingsValidationError(ultrafixGoalError);
  const ultrafixMaxCyclesError = validateUltrafixValue(body.ultrafixMaxCycles, 'ultrafixMaxCycles', {
    minimum: ULTRAFIX_MAX_CYCLES_MIN
  });
  if (ultrafixMaxCyclesError) throw new ExecutionSettingsValidationError(ultrafixMaxCyclesError);
  const ultrafixPayloadError = validateUltrafixPayload({
    runUltrafix: body.runUltrafix as boolean | number | null | undefined,
    ultrafixGoal: body.ultrafixGoal as number | null | undefined,
    ultrafixMaxCycles: body.ultrafixMaxCycles as number | null | undefined,
    fieldNames: {
      run: 'runUltrafix',
      goal: 'ultrafixGoal',
      maxCycles: 'ultrafixMaxCycles'
    }
  });
  if (ultrafixPayloadError) throw new ExecutionSettingsValidationError(ultrafixPayloadError);

  const hasUltrafixGoal = Object.prototype.hasOwnProperty.call(body, 'ultrafixGoal');
  const hasUltrafixMaxCycles = Object.prototype.hasOwnProperty.call(body, 'ultrafixMaxCycles');
  const normalizedUltrafixUpdate = buildNormalizedUltrafixUpdate({
    runUltrafix: body.runUltrafix as boolean | number | null | undefined,
    ultrafixGoal: body.ultrafixGoal as number | null | undefined,
    ultrafixMaxCycles: body.ultrafixMaxCycles as number | null | undefined,
    hasUltrafixGoal,
    hasUltrafixMaxCycles,
    existingRunUltrafix: existingConfig.runUltrafix ?? null
  });

  return {
    ...existingConfig,
    useEpic: useEpic ?? existingConfig.useEpic,
    autoMerge: autoMerge ?? existingConfig.autoMerge,
    runUltrafix: normalizedUltrafixUpdate.runUltrafix ?? undefined,
    ultrafixGoal: normalizedUltrafixUpdate.ultrafixGoal !== undefined
      ? normalizedUltrafixUpdate.ultrafixGoal
      : existingConfig.ultrafixGoal,
    ultrafixMaxCycles: normalizedUltrafixUpdate.ultrafixMaxCycles !== undefined
      ? normalizedUltrafixUpdate.ultrafixMaxCycles
      : existingConfig.ultrafixMaxCycles,
  };
}

export function createPlannerRoutes(deps: PlannerRoutesDeps) {
  const { db } = deps;
  const ownershipVerifier = (draftId: string, userId: string, fields?: string[]) => verifyDraftOwnership(db!, draftId, userId, fields);
  const parseExistingExecutionConfig = (contextConfig: unknown): DraftExecutionConfig => {
    const parsedConfig = parseExistingContextConfig(contextConfig as TaskDraftConfig | string | null | undefined);
    if (parsedConfig) return parsedConfig as DraftExecutionConfig;
    if (contextConfig) {
      try {
        JSON.parse(contextConfig as string);
      } catch (error) {
        throw new ExecutionSettingsContextConfigError(`Failed to parse existing execution settings: ${(error as Error).message}`);
      }
    }
    return {};
  };
  const sendExecutionSettingsResponse = (res: Response, updatedConfig: DraftExecutionConfig): void => { res.json({ success: true, useEpic: updatedConfig.useEpic ?? false, autoMerge: updatedConfig.autoMerge ?? false, runUltrafix: updatedConfig.runUltrafix ?? false, ultrafixGoal: updatedConfig.ultrafixGoal ?? null, ultrafixMaxCycles: updatedConfig.ultrafixMaxCycles ?? null }); };

  async function listRepositories(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    try {
      const results = await db!('task_drafts').select('repository').count('* as count')
        .where({ user_id: req.user!.id }).groupBy('repository').orderBy('repository') as { repository: string; count: number | string }[];
      const repositories = results.map((row) => ({
        repo: row.repository, count: typeof row.count === 'string' ? parseInt(row.count, 10) : row.count
      }));
      res.json({ repositories, total: repositories.reduce((sum: number, r: { count: number }) => sum + r.count, 0) });
    } catch (error) {
      console.error('List repositories error:', error);
      res.status(500).json({ error: 'Failed to fetch repositories' });
    }
  }

  async function listDrafts(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    try {
      const paginationResult = validatePagination(req.query.page, req.query.limit, { maxLimit: 100, defaultLimit: 10 });
      if (!paginationResult.valid) { res.status(400).json({ error: paginationResult.error }); return; }
      const { page, limit, offset } = paginationResult.params!;

      const repoValidation = validateRepositoryFilter(req.query.repository);
      if (!repoValidation.valid) { res.status(400).json({ error: repoValidation.error }); return; }

      const validStatuses = ['draft', 'review', 'generating', 'refining', 'executed', 'approved', 'merged', 'pr_created'] as const;
      const statusValidation = validateEnum(req.query.status, ['all', ...validStatuses], 'Status');
      if (!statusValidation.valid) { res.status(400).json({ error: statusValidation.error }); return; }

      const repository = req.query.repository as string | undefined;
      const search = req.query.search as string | undefined;
      const status = req.query.status as string | undefined;
      const excludeStatuses = req.query.excludeStatuses as string | undefined;
      let query = db!('task_drafts').where({ user_id: req.user!.id });

      if (repository && repository !== 'all') query = query.andWhere('repository', repository);
      if (status && status !== 'all' && (validStatuses as readonly string[]).includes(status)) query = query.andWhere('status', status);

      if (excludeStatuses) {
        const statusesToExclude = excludeStatuses.split(',').filter(s => (validStatuses as readonly string[]).includes(s.trim()));
        if (statusesToExclude.length > 0) query = query.whereNotIn('status', statusesToExclude);
      }

      const searchWords = parseSearchWords(search);
      if (searchWords.length > 0) {
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

      if (searchWords.length > 0) { const exactPhrase = search!.trim().toLowerCase(); const scoredDrafts = scoreDrafts(drafts, searchWords, exactPhrase); sortDraftsByScore(scoredDrafts); drafts = removeSearchScore(scoredDrafts); }

      const paginatedDrafts = drafts.slice(offset, offset + limit);
      const draftIds = paginatedDrafts.map((d: { draft_id: string }) => d.draft_id);
      if (draftIds.length > 0) {
        const issues = await db!('plan_issues').whereIn('draft_id', draftIds).select('draft_id', 'status');
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

    const repoValidation = validateRepository(repository);
    if (!repoValidation.valid) { res.status(400).json({ error: repoValidation.error }); return; }
    if (prompt !== undefined && typeof prompt !== 'string') { res.status(400).json({ error: 'Prompt must be a string' }); return; }
    if (todoIds !== undefined && (!Array.isArray(todoIds) || !todoIds.every(id => typeof id === 'string'))) {
      res.status(400).json({ error: 'todoIds must be an array of strings' }); return;
    }

    try {
      const draftId = crypto.randomUUID();
      const name = prompt || 'Untitled Plan';
      await db!('task_drafts')
        .insert({ draft_id: draftId, user_id: req.user!.id, repository, initial_prompt: prompt, name });

      if (Array.isArray(todoIds) && todoIds.length > 0) await linkTodosToDraft(todoIds, draftId, req.user!.id);

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

    const idValidation = validateUUID(req.params.id, 'Draft ID');
    if (!idValidation.valid) { res.status(400).json({ error: idValidation.error }); return; }

    try {
      const draft = await db!('task_drafts').where({ draft_id: req.params.id }).first();
      if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
      if (draft.user_id !== req.user!.id) { res.status(403).json({ error: 'Unauthorized access to draft' }); return; }

      const parsedDraft = parseDraftJsonFields(draft) as Record<string, unknown> & { task_title?: string };
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

    const idValidation = validateUUID(req.params.id, 'Draft ID');
    if (!idValidation.valid) { res.status(400).json({ error: idValidation.error }); return; }

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
      const updated = await db!('task_drafts').where({ draft_id: req.params.id }).first();
      if (updated) { const responseData: Record<string, unknown> & { task_title?: string } = { ...updated }; responseData.task_title = updated.name; res.json(responseData); } else { res.json(updated); }
    } catch (error) {
      console.error('Update draft error:', error);
      res.status(500).json({ error: 'Failed to update draft' });
    }
  }

  async function deleteDraft(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    const idValidation = validateUUID(req.params.id, 'Draft ID');
    if (!idValidation.valid) { res.status(400).json({ error: idValidation.error }); return; }
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

  const uploadAttachment = withAuthCheck(db, createUploadAttachmentHandler({ verifyOwnership: ownershipVerifier }));
  const getContextStats = withAuthCheck(db, createGetContextStatsHandler({ verifyOwnership: ownershipVerifier }));
  const previewContext = withAuthCheck(db, createPreviewContextHandler({ verifyOwnership: ownershipVerifier, validateInput: validatePreviewInput, db }));
  const deleteAttachment = withAuthCheck(db, createDeleteAttachmentHandler({ verifyOwnership: ownershipVerifier }));

  async function resetDraftToSetup(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    const idValidation = validateUUID(req.params.id, 'Draft ID');
    if (!idValidation.valid) { res.status(400).json({ error: idValidation.error }); return; }
    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id, ['user_id', 'status', 'context_config']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      if (ownership.draft!.status !== 'review') { res.status(400).json({ error: 'Can only reset drafts that are in review status' }); return; }
      await db!('task_drafts').where({ draft_id: req.params.id }).update({ status: 'draft', plan_json: null, chat_history: null, updated_at: db!.fn.now() });
      const updated = await db!('task_drafts').where({ draft_id: req.params.id }).first();
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

  async function draftPauseAction(req: Request, res: Response, action: 'pause' | 'resume'): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      const result = action === 'pause' ? await pauseDraft(req.params.id) : await resumeDraft(req.params.id);
      if (!result.success) { res.status(400).json({ error: result.error }); return; }
      res.json({ paused: result.paused, pausedAt: result.pausedAt });
    } catch (error) {
      console.error(`${action} draft error:`, error);
      res.status(500).json({ error: `Failed to ${action} draft execution` });
    }
  }
  const pauseDraftExecution = (req: Request, res: Response) => draftPauseAction(req, res, 'pause');
  const resumeDraftExecution = (req: Request, res: Response) => draftPauseAction(req, res, 'resume');

  async function updateExecutionSettings(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    const idValidation = validateUUID(req.params.id, 'Draft ID');
    if (!idValidation.valid) { res.status(400).json({ error: idValidation.error }); return; }

    try {
      const ownership = await verifyDraftOwnership(db!, req.params.id, req.user!.id, ['user_id', 'context_config']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      const existingConfig = parseExistingExecutionConfig(ownership.draft!.context_config);
      const updatedConfig = buildUpdatedExecutionConfig(existingConfig, req.body as Record<string, unknown>);

      await db!('task_drafts').where({ draft_id: req.params.id }).update({ context_config: JSON.stringify(updatedConfig), updated_at: db!.fn.now() });
      sendExecutionSettingsResponse(res, updatedConfig);
    } catch (error) {
      if (error instanceof ExecutionSettingsValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof ExecutionSettingsContextConfigError) {
        res.status(409).json({ error: error.message });
        return;
      }
      console.error('Update execution settings error:', error);
      res.status(500).json({ error: 'Failed to update execution settings' });
    }
  }

  return {
    listRepositories, listDrafts, createDraft, getDraft, updateDraft, deleteDraft,
    uploadAttachment, deleteAttachment, getAttachmentContent, getRepositoryInfo,
    getContextStats, previewContext, downloadContext, generate, refine, finalize,
    resetDraftToSetup, getIssues, implementIssue, updateIssue, implementAllIssues,
    validateContextRepository, abortGeneration, abortRefinement, reviseDraft,
    pauseDraftExecution, resumeDraftExecution, updateExecutionSettings,
  };
}
