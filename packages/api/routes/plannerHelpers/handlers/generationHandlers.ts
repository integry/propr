/**
 * Generation-related HTTP handlers (abort, refine).
 */

import { Request, Response } from 'express';
import { Knex } from 'knex';
import { generateCorrelationId } from '@propr/core';
import type { OwnershipResult } from '../types.js';
import { getRefineRepoContext } from '../repoSetup.js';

interface AbortGenerationDeps {
  db: Knex;
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

interface RefineDeps {
  db: Knex;
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  refinePlan: (opts: { currentPlan: any; instruction: string; worktreePath: string; repository: string; githubToken: string; correlationId: string; originalContext?: string; draftId?: string }) => Promise<any>;
}

export function createRefineHandler(deps: RefineDeps) {
  return async function refine(req: Request, res: Response): Promise<void> {
    const { draftId, plan: currentPlan, instruction } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }
    if (!currentPlan || !Array.isArray(currentPlan)) { res.status(400).json({ error: 'currentPlan array is required' }); return; }
    if (!instruction || typeof instruction !== 'string') { res.status(400).json({ error: 'instruction is required' }); return; }

    const correlationId = generateCorrelationId();
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
