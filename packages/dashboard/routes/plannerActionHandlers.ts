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
  loadSettings
} from '@gitfix/core';
import type { Plan } from '@gitfix/core';
import {
  checkDbAndAuth,
  sendCheckError,
  verifyDraftOwnership,
  validateContextRepositories,
  updateDraftContextConfig,
  runBackgroundGeneration,
  getRefineRepoContext,
  GenerateRequestBody
} from './plannerHelpers.js';

export function createGenerateHandler(db: Knex) {
  return async function generate(req: Request, res: Response): Promise<void> {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }

    const { draftId, baseBranch, granularity, contextLevel, compress, contextRepositories, generationModel } = req.body as GenerateRequestBody;
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

      await updateDraftContextConfig(db, draftId, draft, { baseBranch, granularity, contextLevel, compress, contextRepositories, generationModel });

      await db('task_drafts').where({ draft_id: draftId }).update({
        status: 'generating',
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

    const { draftId, plan: currentPlan, instruction } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }
    if (!currentPlan || !Array.isArray(currentPlan)) { res.status(400).json({ error: 'currentPlan array is required' }); return; }
    if (!instruction || typeof instruction !== 'string') { res.status(400).json({ error: 'instruction is required' }); return; }

    const correlationId = generateCorrelationId();

    try {
      // Verify ownership
      const ownership = await verifyDraftOwnership(db, draftId, req.user!.id, ['user_id']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      // Calculate estimation early so we can store it before the LLM call starts
      // Estimate input token count based on current plan size and instruction
      const planJsonStr = JSON.stringify(currentPlan, null, 2);
      const estimatedInputTokens = Math.ceil((planJsonStr.length + instruction.length + 2000) / 4); // +2000 for system prompt

      const settings = await loadSettings();
      const generationModel = settings.planner_generation_model || 'opus';

      const estimation = await estimateLlmDuration({
        executionType: 'plan-refinement',
        modelName: generationModel,
        inputTokenCount: estimatedInputTokens,
        correlationId
      });

      const startedAt = new Date().toISOString();

      // Set status to 'refining' with initial refinement_result containing estimation data
      // This allows the frontend to show progress immediately
      const initialRefinementMeta = {
        status: 'in_progress',
        startedAt,
        estimatedDuration: estimation.estimatedDurationMs,
        isHistoricalEstimate: estimation.isHistoricalEstimate,
        sampleCount: estimation.sampleCount
      };

      await db('task_drafts').where({ draft_id: draftId }).update({
        status: 'refining',
        refinement_result: JSON.stringify(initialRefinementMeta),
        updated_at: db.fn.now()
      });

      // Return 202 Accepted immediately - client should poll for status
      res.status(202).json({ success: true, status: 'refining', message: 'Plan refinement started' });

      // Run refinement in background
      (async () => {
        try {
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
            draftId
          });

          // Store the refinement result including action, summary, and estimation data
          const refinementMeta = {
            status: 'completed',
            action: result.action,
            summary: result.summary,
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
          // Revert status to review on failure
          await db('task_drafts').where({ draft_id: draftId }).update({
            status: 'review',
            updated_at: db.fn.now()
          });
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

    try {
      const result = await executeDraft(draftId, req.user!.id, correlationId);
      if (result.alreadyExecuted) { res.json({ success: true, alreadyExecuted: true, issuesCreated: 0 }); return; }
      res.json({ success: true, results: result.results, issuesCreated: result.results?.length || 0 });
    } catch (error) {
      console.error('Finalize plan error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to execute plan' });
    }
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
