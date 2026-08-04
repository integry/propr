/**
 * Background execution of plan refinement, kicked off after the refine
 * endpoint has returned 202.
 */

import { Knex } from 'knex';
import { Redis } from 'ioredis';
import { buildPlannerAbortSignalKey, refinePlan, runWithPlannerAbortContext } from '@propr/core';
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
  runId: string;
}

export interface BackgroundRefinementDependencies {
  checkAborted?: () => Promise<boolean>;
  getRepoContext?: typeof getRefineRepoContext;
  refine?: typeof refinePlan;
}

async function closeAbortRedis(redis: Redis): Promise<void> {
  try {
    await redis.quit();
  } catch (closeError) {
    console.error('[refine] Failed to close abort-check Redis connection gracefully:', closeError);
    try {
      redis.disconnect();
    } catch (disconnectError) {
      console.error('[refine] Failed to disconnect abort-check Redis connection:', disconnectError);
    }
  }
}

function createRefinementAbortChecker(
  draftId: string,
  runId: string,
  override?: () => Promise<boolean>,
): { check: () => Promise<boolean>; close: () => Promise<void> } {
  if (override) return { check: override, close: async () => undefined };
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  });
  return {
    check: async () => !!(await redis.get(buildPlannerAbortSignalKey(draftId, runId))),
    close: () => closeAbortRedis(redis),
  };
}

function parseRefinementRunId(raw: unknown): string | undefined {
  try {
    const metadata = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const runId = (metadata as { runId?: unknown } | null)?.runId;
    return typeof runId === 'string' && runId.length > 0 ? runId : undefined;
  } catch {
    return undefined;
  }
}

async function persistActiveRefinement(
  db: Knex,
  draftId: string,
  runId: string,
  updates: Record<string, unknown>,
): Promise<boolean> {
  const draft = await db('task_drafts')
    .where({ draft_id: draftId })
    .select('status', 'refinement_result')
    .first();
  if (draft?.status !== 'refining' || parseRefinementRunId(draft.refinement_result) !== runId) return false;

  let query = db('task_drafts').where({ draft_id: draftId, status: 'refining' });
  query = draft.refinement_result == null
    ? query.whereNull('refinement_result')
    : query.where('refinement_result', draft.refinement_result);
  return Number(await query.update({ ...updates, updated_at: db.fn.now() })) === 1;
}

/**
 * Persists the refined plan, or a failure record the UI can surface, unless
 * the user aborted the refinement in the meantime.
 */
export async function runBackgroundRefinement(
  options: BackgroundRefinementOptions,
  dependencies: BackgroundRefinementDependencies = {},
): Promise<void> {
  const { db, draftId, currentPlan, instruction, generationModel, correlationId, accessToken, runId } = options;

  // Reuse one connection for all checks in this refinement instead of opening a
  // new Redis connection before and after every LLM execution.
  const abortChecker = createRefinementAbortChecker(draftId, runId, dependencies.checkAborted);
  const checkAborted = abortChecker.check;
  const loadRepoContext = dependencies.getRepoContext ?? getRefineRepoContext;
  const executeRefinement = dependencies.refine ?? refinePlan;

  try {
    // Check if already aborted before starting
    if (await checkAborted()) {
      console.log(`[refine] Refinement aborted before starting for draft ${draftId}`);
      return;
    }

    const repoContext = await loadRepoContext(db, draftId, accessToken);

    // Fetch original generated context from the draft for richer refinement
    const draft = await db('task_drafts').where({ draft_id: draftId }).select('generated_context').first();
    const originalContext = draft?.generated_context as string | undefined;

    const result = await runWithPlannerAbortContext(draftId, runId, () => executeRefinement({
      currentPlan,
      instruction,
      worktreePath: repoContext.worktreePath,
      repository: repoContext.repository,
      githubToken: repoContext.authToken,
      correlationId,
      originalContext: originalContext || undefined,
      draftId,
      generationModel
    }));

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

    const persisted = await persistActiveRefinement(db, draftId, runId, {
      plan_json: JSON.stringify(result.plan),
      refinement_result: JSON.stringify(refinementMeta),
      status: 'review',
    });
    if (!persisted) {
      console.log(`[refine] Refinement run ${runId} is no longer active for draft ${draftId}, not saving result`);
      return;
    }
    console.log(`[refine] Plan refinement completed for draft ${draftId} (action: ${result.action})`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error(`[refine] Plan refinement failed for draft ${draftId}:`, errorMessage);
    if (errorStack) console.error(`[refine] Stack trace:`, errorStack);
    // Only revert status to review on failure if not aborted. Persist the
    // error into refinement_result so the UI can surface it to the user
    // instead of silently returning to review with no explanation.
    let aborted = false;
    try {
      aborted = await checkAborted();
    } catch (abortCheckError) {
      console.error(`[refine] Failed to check abort state while recovering draft ${draftId}:`, abortCheckError);
    }
    if (aborted) return;

    const failureMeta = {
      status: 'failed',
      error: errorMessage,
      model: generationModel,
      timestamp: new Date().toISOString()
    };
    const persisted = await persistActiveRefinement(db, draftId, runId, {
      status: 'review',
      refinement_result: JSON.stringify(failureMeta),
    });
    if (!persisted) {
      console.log(`[refine] Refinement run ${runId} is no longer active for draft ${draftId}, not saving failure`);
    }
  } finally {
    await abortChecker.close();
  }
}
