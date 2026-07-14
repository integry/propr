/**
 * Background execution of plan refinement, kicked off after the refine
 * endpoint has returned 202.
 */

import { Knex } from 'knex';
import { Redis } from 'ioredis';
import { refinePlan } from '@propr/core';
import type { Plan } from '@propr/core';
import { getRefineRepoContext } from './repoSetup.js';

export interface BackgroundRefinementOptions {
  db: Knex;
  draftId: string;
  currentPlan: Plan;
  instruction: string;
  generationModel: string;
  correlationId: string;
  accessToken: string;
}

/**
 * Persists the refined plan, or a failure record the UI can surface, unless
 * the user aborted the refinement in the meantime.
 */
export async function runBackgroundRefinement(options: BackgroundRefinementOptions): Promise<void> {
  const { db, draftId, currentPlan, instruction, generationModel, correlationId, accessToken } = options;

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

    const repoContext = await getRefineRepoContext(db, draftId, accessToken);

    // Fetch original generated context from the draft for richer refinement
    const draft = await db('task_drafts').where({ draft_id: draftId }).select('generated_context').first();
    const originalContext = draft?.generated_context as string | undefined;

    const result = await refinePlan({
      currentPlan,
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
}
