import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { Redis } from 'ioredis';
import { checkDbAndAuth, sendCheckError } from './plannerHelpers/index.js';

export async function clearAbortSignal(draftId: string): Promise<void> {
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379', 10)
  });
  await redis.del(`planner:abort:${draftId}`);
  await redis.quit();
}

async function setAbortSignal(draftId: string): Promise<void> {
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379', 10)
  });
  await redis.setex(`planner:abort:${draftId}`, 300, '1');
  await redis.quit();
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

      await setAbortSignal(draftId);
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

      await setAbortSignal(draftId);
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
