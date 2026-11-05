import type { Request, Response } from 'express';
import { createUsageTipsStore, db, UsageTipDismissalConflict } from '@propr/core';
import { isUsageTipEventId, USAGE_TIPS_BY_ID } from '@propr/shared';

export function createUsageTipsRoutes(store = createUsageTipsStore(db)) {
  const user = (req: Request, res: Response) => {
    const id = req.user?.id;
    if (typeof id !== 'string' || !id.trim()) { res.status(401).json({ error: 'Authentication required' }); return null; }
    return id;
  };
  return {
    async get(req: Request, res: Response) {
      const id = user(req, res);
      if (!id) return;
      res.setHeader('Cache-Control', 'no-store');
      try { res.json(await store.get(id)); }
      catch { res.status(503).json({ error: 'Usage tips unavailable' }); }
    },
    async dismiss(req: Request, res: Response) {
      const id = user(req, res);
      if (!id) return;
      const { tipId, eventId } = req.body ?? {};
      if (typeof tipId !== 'string' || !USAGE_TIPS_BY_ID.has(tipId) || !isUsageTipEventId(eventId)) {
        res.status(400).json({ error: 'Valid tipId and UUID eventId required' }); return;
      }
      try { await store.dismiss(id, tipId, eventId); res.json({ success: true }); }
      catch (error) { res.status(error instanceof UsageTipDismissalConflict ? 409 : 503).json({ error: 'Dismissal was not saved; retry with the same eventId' }); }
    },
  };
}
