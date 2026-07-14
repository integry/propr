/**
 * Action handlers for planner routes (generate, refine, finalize, abort)
 */
import { Request, Response } from 'express';
import { Knex } from 'knex';
import { Redis } from 'ioredis';
import {
  refinePlan,
  executeDraft,
  getGitHubInstallationToken,
  ensureRepoCloned,
  generateCorrelationId,
  estimateLlmDuration,
  loadSettings,
  estimateTokens,
  REFINER_SYSTEM_PROMPT,
  getEventPublisher
} from '@propr/core';
import type { Plan } from '@propr/core';
import {
  checkDbAndAuth,
  sendCheckError,
  verifyDraftOwnership,
  validateContextRepositories,
  updateDraftContextConfig,
  runBackgroundGeneration,
  getRefineRepoContext,
  GenerateRequestBody
} from './plannerHelpers/index.js';

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

export function createGenerateHandler(db: Knex) {
  return async function generate(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId, baseBranch, granularity, contextLevel, compress, contextRepositories, generationModel, excludedFiles } = req.body as GenerateRequestBody;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    // Validate context repositories if provided
    if (contextRepositories) {
      const repoValidation = validateContextRepositories(contextRepositories);
      if (!repoValidation.valid) {
        res.status(400).json({ error: repoValidation.error });
        return;
      }
    }

    // Validate excludedFiles if provided
    if (excludedFiles && (!Array.isArray(excludedFiles) || !excludedFiles.every(f => typeof f === 'string'))) {
      res.status(400).json({ error: 'excludedFiles must be an array of strings' });
      return;
    }

    const correlationId = generateCorrelationId();

    try {
      const ownership = await verifyDraftOwnership(db, draftId, req.user!.id, ['user_id', 'repository', 'context_config']);
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

      await updateDraftContextConfig(db, draftId, draft, { baseBranch, granularity, contextLevel, compress, contextRepositories, generationModel, excludedFiles });

      // Clear any previous abort signal to allow immediate retry after abort
      const redis = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
      });
      await redis.del(`planner:abort:${draftId}`);
      await redis.quit();

      await db('task_drafts').where({ draft_id: draftId }).update({
        status: 'generating',
        generation_trace: JSON.stringify({ steps: [], startedAt: new Date().toISOString() }),
        updated_at: db.fn.now()
      });

      res.status(202).json({ success: true, status: 'generating', message: 'Plan generation started' });

      runBackgroundGeneration({ db, draftId, worktreePath, authToken, correlationId });
    } catch (error) {
      console.error('Generate plan error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate plan' });
    }
  };
}

export function createRefineHandler(db: Knex) {
  return async function refine(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId, plan: currentPlan, instruction, generationModel: requestedModel } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }
    if (!currentPlan || !Array.isArray(currentPlan)) { res.status(400).json({ error: 'currentPlan array is required' }); return; }
    if (!instruction || typeof instruction !== 'string') { res.status(400).json({ error: 'instruction is required' }); return; }
    if (requestedModel !== undefined && typeof requestedModel !== 'string') { res.status(400).json({ error: 'generationModel must be a string' }); return; }

    const correlationId = generateCorrelationId();

    try {
      // Verify ownership
      const ownership = await verifyDraftOwnership(db, draftId, req.user!.id, ['user_id']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      // Calculate estimation early so we can store it before the LLM call starts
      // Fetch original context to include in the token estimate (this is the bulk of the prompt)
      const draftForContext = await db('task_drafts').where({ draft_id: draftId }).select('generated_context', 'context_config').first();
      const originalContext = draftForContext?.generated_context as string | undefined;

      // Refine with the model the plan was generated with (stored on the draft),
      // overridable per-request from the UI model switcher. This keeps refinement
      // consistent with the original plan and respects that model's input limit.
      const draftGenerationModel = parseDraftGenerationModel(draftForContext?.context_config);

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
      const generationModel = requestedModel || draftGenerationModel || settings.planner_generation_model || 'opus';

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

      // Clear any previous abort signal to allow immediate retry after abort
      const redisForClear = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
      });
      await redisForClear.del(`planner:abort:${draftId}`);
      await redisForClear.quit();

      await db('task_drafts').where({ draft_id: draftId }).update({
        status: 'refining',
        refinement_result: JSON.stringify(initialRefinementMeta),
        updated_at: db.fn.now()
      });

      // Return 202 Accepted immediately - client should poll for status
      res.status(202).json({ success: true, status: 'refining', message: 'Plan refinement started' });

      // Run refinement in background
      (async () => {
        // Helper to check if refinement was aborted
        const checkAborted = async (): Promise<boolean> => {
          const redis = new Redis({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10)
          });
          const aborted = await redis.get(`planner:abort:${draftId}`);
          await redis.quit();
          return !!aborted;
        };

        try {
          // Check if already aborted before starting
          if (await checkAborted()) {
            console.log(`[refine] Refinement aborted before starting for draft ${draftId}`);
            return;
          }

          const repoContext = await getRefineRepoContext(db, draftId, req.user?.accessToken || '');

          // Fetch original generated context from the draft for richer refinement
          const draft = await db('task_drafts').where({ draft_id: draftId }).select('generated_context').first();
          const originalContext = draft?.generated_context as string | undefined;

          const result = await refinePlan({
            currentPlan: currentPlan as Plan,
            instruction,
            worktreePath: repoContext.worktreePath,
            repository: repoContext.repository,
            githubToken: repoContext.authToken,
            correlationId,
            originalContext: originalContext || undefined,
            draftId,
            generationModel
          });

          // Check if aborted before saving result (race condition protection)
          if (await checkAborted()) {
            console.log(`[refine] Refinement aborted after completion for draft ${draftId}, not saving result`);
            return;
          }

          // Store the refinement result including action, summary, and estimation data
          const refinementMeta = {
            status: 'completed',
            action: result.action,
            summary: result.summary,
            model: result.model,
            timestamp: new Date().toISOString(),
            // Include estimation data from the LLM call
            estimatedDuration: result.estimation?.estimatedDurationMs,
            startedAt: result.estimation?.startedAt,
            isHistoricalEstimate: result.estimation?.isHistoricalEstimate,
            sampleCount: result.estimation?.sampleCount
          };

          console.log(`[refine] Storing refinement result for draft ${draftId}:`, JSON.stringify(refinementMeta));

          await db('task_drafts').where({ draft_id: draftId }).update({
            plan_json: JSON.stringify(result.plan),
            refinement_result: JSON.stringify(refinementMeta),
            status: 'review',
            updated_at: db.fn.now()
          });
          console.log(`[refine] Plan refinement completed for draft ${draftId} (action: ${result.action})`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : undefined;
          console.error(`[refine] Plan refinement failed for draft ${draftId}:`, errorMessage);
          if (errorStack) console.error(`[refine] Stack trace:`, errorStack);
          // Only revert status to review on failure if not aborted. Persist the
          // error into refinement_result so the UI can surface it to the user
          // instead of silently returning to review with no explanation.
          if (!(await checkAborted())) {
            const failureMeta = {
              status: 'failed',
              error: errorMessage,
              model: generationModel,
              timestamp: new Date().toISOString()
            };
            await db('task_drafts').where({ draft_id: draftId }).update({
              status: 'review',
              refinement_result: JSON.stringify(failureMeta),
              updated_at: db.fn.now()
            });
          }
        }
      })();
    } catch (error) {
      console.error('Refine plan error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to refine plan' });
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

export function createAbortGenerationHandler(db: Knex) {
  return async function abortGeneration(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    try {
      const draft = await db('task_drafts').where({ draft_id: draftId, user_id: req.user!.id }).first();
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
      await db('task_drafts').where({ draft_id: draftId }).update({
        status: 'draft',
        generation_trace: JSON.stringify({
          steps: [],
          error: 'Generation aborted by user',
          abortedAt: new Date().toISOString()
        }),
        updated_at: db.fn.now()
      });

      console.log(`[abort] Plan generation aborted for draft ${draftId}`);
      res.json({ success: true, message: 'Generation aborted' });
    } catch (error) {
      console.error('Abort generation error:', error);
      res.status(500).json({ error: 'Failed to abort generation' });
    }
  };
}

export function createAbortRefinementHandler(db: Knex) {
  return async function abortRefinement(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    try {
      const draft = await db('task_drafts').where({ draft_id: draftId, user_id: req.user!.id }).first();
      if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
      if (draft.status !== 'refining') {
        res.status(400).json({ error: 'Can only abort drafts that are currently refining' });
        return;
      }

      // Set abort signal in Redis
      const redis = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
      });
      await redis.setex(`planner:abort:${draftId}`, 300, '1'); // Expires in 5 minutes
      await redis.quit();

      // Update draft status back to review (ready for refinement again)
      await db('task_drafts').where({ draft_id: draftId }).update({
        status: 'review',
        refinement_result: JSON.stringify({
          action: 'cancelled',
          summary: 'Refinement cancelled by user',
          timestamp: new Date().toISOString()
        }),
        updated_at: db.fn.now()
      });

      console.log(`[abort] Plan refinement aborted for draft ${draftId}`);
      res.json({ success: true, message: 'Refinement aborted' });
    } catch (error) {
      console.error('Abort refinement error:', error);
      res.status(500).json({ error: 'Failed to abort refinement' });
    }
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
