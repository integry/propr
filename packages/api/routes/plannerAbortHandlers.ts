import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { Redis } from 'ioredis';
import { checkDbAndAuth, sendCheckError } from './plannerHelpers/index.js';

export interface AbortRedisClient {
  del(key: string): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export type AbortRedisFactory = () => AbortRedisClient;

export interface PlannerAbortHandlerDependencies {
  clearAbortSignal: (draftId: string) => Promise<void>;
  setAbortSignal: (draftId: string) => Promise<void>;
}

function createAbortRedis(): AbortRedisClient {
  return new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379', 10)
  });
}

async function closeAbortRedis(redis: AbortRedisClient): Promise<void> {
  try {
    await redis.quit();
  } catch (error) {
    console.error('Failed to close planner abort Redis connection gracefully:', error);
    try { redis.disconnect(); } catch (disconnectError) {
      console.error('Failed to disconnect planner abort Redis connection:', disconnectError);
    }
  }
}

async function withAbortRedis(operation: (redis: AbortRedisClient) => Promise<unknown>, factory: AbortRedisFactory): Promise<void> {
  const redis = factory();
  try {
    await operation(redis);
  } finally {
    await closeAbortRedis(redis);
  }
}

export async function clearAbortSignal(draftId: string, factory: AbortRedisFactory = createAbortRedis): Promise<void> {
  await withAbortRedis(redis => redis.del(`planner:abort:${draftId}`), factory);
}

export async function setAbortSignal(draftId: string, factory: AbortRedisFactory = createAbortRedis): Promise<void> {
  await withAbortRedis(redis => redis.setex(`planner:abort:${draftId}`, 300, '1'), factory);
}

interface ConditionalAbortDraftOptions {
  db: Knex;
  draft: Record<string, unknown>;
  userId: string;
  activeStatus: 'generating' | 'refining';
  updates: Record<string, unknown>;
}

async function conditionallyAbortDraft({ db, draft, userId, activeStatus, updates }: ConditionalAbortDraftOptions): Promise<number> {
  let query = db('task_drafts').where({
    draft_id: draft.draft_id,
    user_id: userId,
    status: activeStatus,
  });
  query = draft.updated_at == null
    ? query.whereNull('updated_at')
    : query.where('updated_at', draft.updated_at);
  return Number(await query.update(updates));
}

async function clearAbortSignalBestEffort(
  signals: PlannerAbortHandlerDependencies,
  draftId: string,
): Promise<void> {
  try {
    await signals.clearAbortSignal(draftId);
  } catch (error) {
    console.error(`Failed to reconcile planner abort signal for draft ${draftId}:`, error);
  }
}

async function transitionDraftOrReconcileSignal(
  options: ConditionalAbortDraftOptions,
  signals: PlannerAbortHandlerDependencies,
): Promise<number> {
  try {
    const updatedRows = await conditionallyAbortDraft(options);
    if (updatedRows !== 1) await clearAbortSignalBestEffort(signals, String(options.draft.draft_id));
    return updatedRows;
  } catch (error) {
    await clearAbortSignalBestEffort(signals, String(options.draft.draft_id));
    throw error;
  }
}

export function createAbortGenerationHandler(db: Knex, dependencies: Partial<PlannerAbortHandlerDependencies> = {}) {
  const signals = { clearAbortSignal, setAbortSignal, ...dependencies };
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

      await signals.setAbortSignal(draftId);
      const updatedRows = await transitionDraftOrReconcileSignal({
        db,
        draft,
        userId: req.user!.id,
        activeStatus: 'generating',
        updates: {
          status: 'draft',
          generation_trace: JSON.stringify({
            steps: [],
            error: 'Generation aborted by user',
            abortedAt: new Date().toISOString()
          }),
          updated_at: db.fn.now()
        }
      }, signals);
      if (updatedRows !== 1) {
        res.status(409).json({ error: 'Draft state changed before generation could be aborted. Current state was preserved.' });
        return;
      }

      console.log(`[abort] Plan generation aborted for draft ${draftId}`);
      res.json({ success: true, message: 'Generation aborted' });
    } catch (error) {
      console.error('Abort generation error:', error);
      res.status(500).json({ error: 'Failed to abort generation' });
    }
  };
}

export function createAbortRefinementHandler(db: Knex, dependencies: Partial<PlannerAbortHandlerDependencies> = {}) {
  const signals = { clearAbortSignal, setAbortSignal, ...dependencies };
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

      await signals.setAbortSignal(draftId);
      const updatedRows = await transitionDraftOrReconcileSignal({
        db,
        draft,
        userId: req.user!.id,
        activeStatus: 'refining',
        updates: {
          status: 'review',
          refinement_result: JSON.stringify({
            action: 'cancelled',
            summary: 'Refinement cancelled by user',
            timestamp: new Date().toISOString()
          }),
          updated_at: db.fn.now()
        }
      }, signals);
      if (updatedRows !== 1) {
        res.status(409).json({ error: 'Draft state changed before refinement could be aborted. Current state was preserved.' });
        return;
      }

      console.log(`[abort] Plan refinement aborted for draft ${draftId}`);
      res.json({ success: true, message: 'Refinement aborted' });
    } catch (error) {
      console.error('Abort refinement error:', error);
      res.status(500).json({ error: 'Failed to abort refinement' });
    }
  };
}
