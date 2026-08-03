import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { Redis } from 'ioredis';
import { buildPlannerAbortSignalKey } from '@propr/core';
import { checkDbAndAuth, sendCheckError } from './plannerHelpers/index.js';

export interface AbortRedisClient {
  del(key: string): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export type AbortRedisFactory = () => AbortRedisClient;

export interface PlannerAbortHandlerDependencies {
  clearAbortSignal: (draftId: string, runId?: string) => Promise<void>;
  setAbortSignal: (draftId: string, runId?: string) => Promise<void>;
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

export async function clearAbortSignal(
  draftId: string,
  runIdOrFactory?: string | AbortRedisFactory,
  factory: AbortRedisFactory = createAbortRedis,
): Promise<void> {
  const runId = typeof runIdOrFactory === 'string' ? runIdOrFactory : undefined;
  const redisFactory = typeof runIdOrFactory === 'function' ? runIdOrFactory : factory;
  await withAbortRedis(redis => redis.del(buildPlannerAbortSignalKey(draftId, runId)), redisFactory);
}

export async function setAbortSignal(
  draftId: string,
  runIdOrFactory?: string | AbortRedisFactory,
  factory: AbortRedisFactory = createAbortRedis,
): Promise<void> {
  const runId = typeof runIdOrFactory === 'string' ? runIdOrFactory : undefined;
  const redisFactory = typeof runIdOrFactory === 'function' ? runIdOrFactory : factory;
  await withAbortRedis(redis => redis.setex(buildPlannerAbortSignalKey(draftId, runId), 300, '1'), redisFactory);
}

interface ConditionalAbortDraftOptions {
  db: Knex;
  draft: Record<string, unknown>;
  userId: string;
  activeStatus: 'generating' | 'refining';
  updates: Record<string, unknown>;
}

async function conditionallyAbortDraft({ db, draft, userId, activeStatus, updates }: ConditionalAbortDraftOptions): Promise<number> {
  const metadataColumn = activeStatus === 'generating' ? 'generation_trace' : 'refinement_result';
  let query = db('task_drafts').where({
    draft_id: draft.draft_id,
    user_id: userId,
    status: activeStatus,
  });
  query = draft[metadataColumn] == null
    ? query.whereNull(metadataColumn)
    : query.where(metadataColumn, draft[metadataColumn]);
  query = draft.updated_at == null
    ? query.whereNull('updated_at')
    : query.where('updated_at', draft.updated_at);
  return Number(await query.update(updates));
}

function parseActiveRunId(draft: Record<string, unknown>, activeStatus: 'generating' | 'refining'): string | undefined {
  const rawMetadata = activeStatus === 'generating' ? draft.generation_trace : draft.refinement_result;
  try {
    const metadata = typeof rawMetadata === 'string' ? JSON.parse(rawMetadata) : rawMetadata;
    const runId = (metadata as { runId?: unknown } | null)?.runId;
    return typeof runId === 'string' && runId.length > 0 ? runId : undefined;
  } catch {
    return undefined;
  }
}

async function transitionDraftOrReconcileSignal(
  options: ConditionalAbortDraftOptions,
  signals: PlannerAbortHandlerDependencies,
  runId: string | undefined,
): Promise<number> {
  try {
    const updatedRows = await conditionallyAbortDraft(options);
    // Versioned keys can safely expire after a lost database race: no newer run
    // observes them. Legacy draft-wide keys must be cleared synchronously and a
    // cleanup failure must reach the client instead of masquerading as a safe 409.
    if (updatedRows !== 1 && !runId) await signals.clearAbortSignal(String(options.draft.draft_id));
    return updatedRows;
  } catch (error) {
    if (!runId) await signals.clearAbortSignal(String(options.draft.draft_id));
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

      const runId = parseActiveRunId(draft, 'generating');
      await signals.setAbortSignal(draftId, runId);
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
      }, signals, runId);
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

      const runId = parseActiveRunId(draft, 'refining');
      await signals.setAbortSignal(draftId, runId);
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
      }, signals, runId);
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
