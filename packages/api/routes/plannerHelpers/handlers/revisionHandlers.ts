/**
 * Plan revision history HTTP handlers.
 */

import type { Response } from 'express';
import type { Knex } from 'knex';
import type { FlatRequest as Request } from '../../../requestTypes.js';
import type { OwnershipResult } from '../types.js';
import { validateUUID } from '../../validation.js';
import { getCurrentPlanCause, getPlanRevision, listPlanRevisions, restorePlanRevision } from '../planRevisions.js';

interface RevisionHandlerDeps {
  db: Knex;
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

function parseRevisionId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function authorize(deps: RevisionHandlerDeps, req: Request, res: Response): Promise<boolean> {
  const idValidation = validateUUID(req.params.id, 'Draft ID');
  if (!idValidation.valid) { res.status(400).json({ error: idValidation.error }); return false; }
  const ownership = await deps.verifyOwnership(req.params.id, req.user!.id);
  if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return false; }
  return true;
}

export function createListPlanRevisionsHandler(deps: RevisionHandlerDeps) {
  return async function listPlanRevisionsHandler(req: Request, res: Response): Promise<void> {
    try {
      if (!await authorize(deps, req, res)) return;
      const revisions = await listPlanRevisions(deps.db, req.params.id);
      const currentCause = revisions[0]?.currentCause ?? await getCurrentPlanCause(deps.db, req.params.id);
      res.json({ currentCause, revisions });
    } catch (error) {
      console.error('List plan revisions error:', error);
      res.status(500).json({ error: 'Failed to fetch plan history' });
    }
  };
}

export function createGetPlanRevisionHandler(deps: RevisionHandlerDeps) {
  return async function getPlanRevisionHandler(req: Request, res: Response): Promise<void> {
    const revisionId = parseRevisionId(req.params.revisionId);
    if (revisionId === null) { res.status(400).json({ error: 'Invalid revision ID' }); return; }
    try {
      if (!await authorize(deps, req, res)) return;
      const revision = await getPlanRevision(deps.db, req.params.id, revisionId);
      if (!revision) { res.status(404).json({ error: 'Plan revision not found' }); return; }
      res.json(revision);
    } catch (error) {
      console.error('Get plan revision error:', error);
      res.status(500).json({ error: 'Failed to fetch plan revision' });
    }
  };
}

export function createRestorePlanRevisionHandler(deps: RevisionHandlerDeps) {
  return async function restorePlanRevisionHandler(req: Request, res: Response): Promise<void> {
    const revisionId = parseRevisionId(req.params.revisionId);
    if (revisionId === null) { res.status(400).json({ error: 'Invalid revision ID' }); return; }
    const expectedRevision = req.body?.expectedRevision;
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
      res.status(400).json({ error: 'expectedRevision must be a non-negative integer' });
      return;
    }
    try {
      if (!await authorize(deps, req, res)) return;
      const result = await restorePlanRevision(deps.db, req.params.id, revisionId, { expectedRevision });
      if (!result.restored) {
        if (result.reason === 'not_found') { res.status(404).json({ error: 'Plan revision not found' }); return; }
        res.status(409).json({ error: 'The plan cannot be restored while an operation is running, after it was published, or if it changed since it was loaded.' });
        return;
      }
      res.json({ success: true, plan_json: result.plan, status: 'review', mcp_revision: result.revision });
    } catch (error) {
      console.error('Restore plan revision error:', error);
      res.status(500).json({ error: 'Failed to restore plan revision' });
    }
  };
}
