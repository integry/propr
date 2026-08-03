/**
 * Action handlers for planner routes (generate, refine, finalize, abort)
 */
import { Request, Response } from 'express';
import { Knex } from 'knex';
import {
  executeDraft,
  generateCorrelationId,
  estimateLlmDuration,
  loadSettings,
  estimateTokens,
  REFINER_SYSTEM_PROMPT,
  getEventPublisher, type Plan
} from '@propr/core';
import {
  checkDbAndAuth,
  sendCheckError,
  verifyDraftOwnership,
  validateContextRepositories,
  updateDraftContextConfig,
  runBackgroundGeneration,
  runBackgroundRefinement,
  claimDraftPreparation,
  claimDraftOperation,
  hasRunningPlannerContainer,
  isDraftOperationActive,
  recoverStaleRefinement,
  releaseDraftPreparation,
  setupRepoContext,
  validateRefineInput,
  GenerateRequestBody
} from './plannerHelpers/index.js';
import { clearAbortSignal } from './plannerAbortHandlers.js';

function validateGenerateRequest(body: GenerateRequestBody): string | undefined {
  const { draftId, contextRepositories, excludedFiles } = body;
  if (!draftId) return 'draftId is required';

  const repoValidation = validateContextRepositories(contextRepositories);
  if (!repoValidation.valid) return repoValidation.error;
  if (excludedFiles && (!Array.isArray(excludedFiles) || !excludedFiles.every(file => typeof file === 'string'))) {
    return 'excludedFiles must be an array of strings';
  }
  return undefined;
}

/**
 * Extract the model a plan was generated with from a draft's context_config
 * (stored as JSON text in SQLite or an object elsewhere). Returns undefined when
 * absent/unparseable so callers fall back to the planner generation setting.
 */
function parseDraftGenerationModel(contextConfig: unknown): string | undefined {
  if (!contextConfig) return undefined;
  try {
    const config = typeof contextConfig === 'string' ? JSON.parse(contextConfig) : contextConfig;
    const model = (config as { generationModel?: unknown })?.generationModel;
    return typeof model === 'string' && model.trim() ? model : undefined;
  } catch {
    return undefined;
  }
}

function selectRefinementModel(
  requestedModel: string | undefined, contextConfig: unknown, configuredModel: string | undefined
): string {
  return requestedModel || parseDraftGenerationModel(contextConfig) || configuredModel || 'opus';
}

export function createGenerateHandler(db: Knex) {
  return async function generate(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const body = req.body as GenerateRequestBody;
    const validationError = validateGenerateRequest(body);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    const { draftId = '', baseBranch, granularity, contextLevel, compress, contextRepositories, generationModel, excludedFiles } = body;

    const correlationId = generateCorrelationId();
    let generationClaimed = false;
    let preparationClaimed = false;

    try {
      const ownership = await verifyDraftOwnership(db, draftId, req.user!.id, ['user_id', 'repository', 'context_config', 'status']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      preparationClaimed = claimDraftPreparation(draftId, 'plan-generation');
      if (!preparationClaimed) {
        res.status(409).json({ error: 'Another planner operation is still preparing this draft' });
        return;
      }
      if (isDraftOperationActive(draft.status)) {
        res.status(409).json({ error: 'Another operation is already running for this draft' });
        return;
      }
      if (await hasRunningPlannerContainer(draftId, 'plan-generation')) {
        res.status(409).json({ error: 'Plan generation is already running for this draft' });
        return;
      }

      const [owner, repoName] = (draft.repository as string).split('/');
      if (!owner || !repoName) { res.status(400).json({ error: 'Invalid repository format' }); return; }

      const accessToken = req.user!.accessToken;
      if (!accessToken) { res.status(401).json({ error: 'GitHub access token not available' }); return; }

      const { worktreePath, authToken } = await setupRepoContext({ repository: draft.repository as string }, accessToken);

      await updateDraftContextConfig(db, draftId, draft, { baseBranch, granularity, contextLevel, compress, contextRepositories, generationModel, excludedFiles });

      generationClaimed = await claimDraftOperation(db, draftId, 'generating', {
        generation_trace: JSON.stringify({ steps: [], startedAt: new Date().toISOString() })
      });
      if (!generationClaimed) {
        res.status(409).json({ error: 'Another operation is already running for this draft' });
        return;
      }

      // Only the request that won the database claim may clear an old abort
      // signal. A concurrent loser must not erase an abort for the active run.
      await clearAbortSignal(draftId);

      res.status(202).json({ success: true, status: 'generating', message: 'Plan generation started' });

      runBackgroundGeneration({ db, draftId, worktreePath, authToken, correlationId });
    } catch (error) {
      console.error('Generate plan error:', error);
      if (generationClaimed && !res.headersSent) {
        try {
          await db('task_drafts').where({ draft_id: draftId, status: 'generating' }).update({
            status: 'failed',
            generation_trace: JSON.stringify({
              steps: [],
              error: error instanceof Error ? error.message : 'Failed to start plan generation',
              failedAt: new Date().toISOString()
            }),
            updated_at: db.fn.now()
          });
        } catch (updateError) {
          console.error('Failed to release generation claim:', updateError);
        }
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate plan' });
    } finally {
      if (preparationClaimed) releaseDraftPreparation(draftId, 'plan-generation');
    }
  };
}

export function createRefineHandler(db: Knex) {
  return async function refine(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId, plan: currentPlan, instruction, generationModel: requestedModel } = req.body;
    const inputCheck = validateRefineInput(req.body);
    if (!inputCheck.valid) { res.status(400).json({ error: inputCheck.error }); return; }

    const correlationId = generateCorrelationId();
    let refinementClaimed = false;
    let preparationClaimed = false;

    try {
      // Verify ownership
      const ownership = await verifyDraftOwnership(db, draftId, req.user!.id, ['user_id', 'status']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      preparationClaimed = claimDraftPreparation(draftId, 'plan-refinement');
      if (!preparationClaimed) {
        res.status(409).json({ error: 'Another planner operation is still preparing this draft' });
        return;
      }
      const draft = await recoverStaleRefinement(db, ownership.draft!);
      if (isDraftOperationActive(draft.status) || await hasRunningPlannerContainer(draftId, 'plan-refinement')) {
        res.status(409).json({ error: 'Another operation is already running for this draft' });
        return;
      }

      // Calculate estimation early so we can store it before the LLM call starts
      // Fetch original context to include in the token estimate (this is the bulk of the prompt)
      const draftForContext = await db('task_drafts').where({ draft_id: draftId }).select('generated_context', 'context_config').first();
      const originalContext = draftForContext?.generated_context as string | undefined;

      // Refine with the model the plan was generated with (stored on the draft),
      // overridable per-request from the UI model switcher. This keeps refinement
      // consistent with the original plan and respects that model's input limit.
      // Build a close approximation of the full prompt for token estimation
      // This matches the structure in taskPlanningService.refinePlan()
      const planJsonStr = JSON.stringify(currentPlan, null, 2);
      const contextSection = originalContext
        ? `\n\nOriginal Context (codebase details from initial plan generation):\n${originalContext}\n`
        : '';
      const roughPrompt = `${REFINER_SYSTEM_PROMPT}${contextSection}\n\nCurrent Plan:\n${planJsonStr}\n\nUser Request:\n"${instruction}"`;
      // Use tiktoken for accurate token count
      const estimatedInputTokens = estimateTokens(roughPrompt);

      const settings = await loadSettings();
      const generationModel = selectRefinementModel(
        requestedModel, draftForContext?.context_config, settings.planner_generation_model
      );

      const estimation = await estimateLlmDuration({
        executionType: 'plan-refinement',
        modelName: generationModel,
        inputTokenCount: estimatedInputTokens,
        correlationId
      });

      const startedAt = new Date().toISOString();

      // Set status to 'refining' with initial refinement_result containing estimation data
      // This allows the frontend to show progress immediately while also clearing any previous cancelled state
      const initialRefinementMeta = {
        status: 'in_progress',
        startedAt,
        model: generationModel,
        estimatedDuration: estimation.estimatedDurationMs,
        isHistoricalEstimate: estimation.isHistoricalEstimate,
        sampleCount: estimation.sampleCount
      };

      refinementClaimed = await claimDraftOperation(db, draftId, 'refining', {
        refinement_result: JSON.stringify(initialRefinementMeta),
      });
      if (!refinementClaimed) {
        res.status(409).json({ error: 'Another operation is already running for this draft' });
        return;
      }

      // Clear an abort from an earlier run only after this request has won the
      // claim, otherwise a duplicate request could cancel the active abort.
      await clearAbortSignal(draftId);

      // Return 202 Accepted immediately - client should poll for status
      res.status(202).json({ success: true, status: 'refining', message: 'Plan refinement started' });

      // Run refinement in background
      void runBackgroundRefinement({
        db,
        draftId,
        currentPlan: currentPlan as Plan,
        instruction,
        generationModel,
        correlationId,
        accessToken: req.user!.accessToken || ''
      });
    } catch (error) {
      console.error('Refine plan error:', error);
      if (refinementClaimed && !res.headersSent) {
        try {
          await db('task_drafts').where({ draft_id: draftId, status: 'refining' }).update({
            status: 'review',
            refinement_result: JSON.stringify({
              status: 'failed',
              error: error instanceof Error ? error.message : 'Failed to start plan refinement',
              timestamp: new Date().toISOString()
            }),
            updated_at: db.fn.now()
          });
        } catch (updateError) {
          console.error('Failed to release refinement claim:', updateError);
        }
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to refine plan' });
    } finally {
      if (preparationClaimed) releaseDraftPreparation(draftId, 'plan-refinement');
    }
  };
}

export function createFinalizeHandler(db: Knex) {
  return async function finalize(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    const correlationId = generateCorrelationId();
    const userId = req.user!.id;

    // Atomically update draft status to 'executing' only if it's in a valid state
    // This prevents race conditions from duplicate finalize requests
    const RE_FINALIZABLE_STATUSES = ['review', 'approved', 'executed', 'pr_created', 'merged', 'failed'];
    try {
      const updated = await db('task_drafts')
        .where({ draft_id: draftId, user_id: userId })
        .whereIn('status', RE_FINALIZABLE_STATUSES)
        .update({
          status: 'executing',
          updated_at: db.fn.now()
        });

      if (updated === 0) {
        // Check why - either draft doesn't exist, unauthorized, or already executing
        const draft = await db('task_drafts').where({ draft_id: draftId }).first();
        if (!draft) {
          res.status(404).json({ error: 'Draft not found' });
          return;
        }
        if (draft.user_id !== userId) {
          res.status(403).json({ error: 'Unauthorized' });
          return;
        }
        if (draft.status === 'executing') {
          res.status(409).json({ error: 'Draft is already being executed' });
          return;
        }
        res.status(400).json({ error: `Cannot execute draft with status: ${draft.status}` });
        return;
      }
    } catch (error) {
      console.error('Failed to update draft status:', error);
      res.status(500).json({ error: 'Failed to start execution' });
      return;
    }

    // Return 202 Accepted immediately - execution runs in background
    res.status(202).json({ success: true, status: 'executing', message: 'Plan execution started' });

    // Run execution in background
    (async () => {
      try {
        const result = await executeDraft(draftId, userId, correlationId);
        if (result.alreadyExecuted) {
          console.log(`[finalize] Draft ${draftId} was already executed`);
        } else {
          console.log(`[finalize] Draft ${draftId} execution completed, ${result.results?.length || 0} issues created`);
        }
      } catch (error) {
        console.error(`[finalize] Draft ${draftId} execution failed:`, error);
        // Emit failure event via WebSocket
        const eventPublisher = getEventPublisher();
        await eventPublisher.publishDraftUpdate({
          draftId,
          step: 'execution',
          status: 'failed',
          data: {
            error: error instanceof Error ? error.message : 'Execution failed'
          }
        });
        // Update status to failed on error
        try {
          await db('task_drafts').where({ draft_id: draftId }).update({
            status: 'failed',
            updated_at: db.fn.now()
          });
        } catch (updateError) {
          console.error(`[finalize] Failed to update draft status to failed:`, updateError);
        }
      }
    })();
  };
}

/**
 * Revise a draft plan - moves it from any active/completed status back to review,
 * detaching existing issues but preserving plan data and chat history.
 */
export function createReviseDraftHandler(db: Knex) {
  const ALLOWED_STATUSES = ['approved', 'executed', 'pr_created', 'merged', 'failed'];

  return async function reviseDraft(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const draftId = req.params.id;
    if (!draftId) { res.status(400).json({ error: 'Draft ID is required' }); return; }

    try {
      // Verify ownership and get current status
      const ownership = await verifyDraftOwnership(db, draftId, req.user!.id, ['user_id', 'status']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const currentStatus = ownership.draft!.status as string;

      // Validate that the draft is in an allowed status
      if (!ALLOWED_STATUSES.includes(currentStatus)) {
        res.status(400).json({
          error: `Cannot revise draft with status '${currentStatus}'. Allowed statuses: ${ALLOWED_STATUSES.join(', ')}`
        });
        return;
      }

      // Delete associated plan_issues (detach from GitHub issues)
      const deletedCount = await db('plan_issues').where({ draft_id: draftId }).delete();

      // Update draft status to 'review' while preserving plan_json and chat_history
      await db('task_drafts').where({ draft_id: draftId }).update({
        status: 'review',
        updated_at: db.fn.now()
      });

      console.log(`[revise] Draft ${draftId} revised from '${currentStatus}' to 'review', ${deletedCount} issues detached`);
      res.json({
        success: true,
        message: 'Plan revised successfully',
        previousStatus: currentStatus,
        issuesDetached: deletedCount
      });
    } catch (error) {
      console.error('Revise draft error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to revise draft' });
    }
  };
}
