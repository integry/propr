/**
 * Plan revision history. The `task_drafts_plan_history` trigger records every
 * replaced plan; these helpers read those snapshots and restore one.
 */

import type { Knex } from 'knex';

/** Statuses in which a plan's content may be replaced by a restore. */
export const PLAN_RESTORABLE_STATUSES = ['draft', 'review', 'approved', 'failed'] as const;

/** Matches the cap enforced by the `task_drafts_plan_history` trigger. */
const MAX_REVISIONS_PER_DRAFT = 50;

export type PlanRevisionCause = 'generation' | 'refinement' | 'manual_edit' | 'restore' | 'rename' | 'unknown';

interface PlanRevisionRow {
  revision_id: number;
  draft_id: string;
  plan_json: string;
  draft_revision: number;
  status_before: string | null;
  status_after: string | null;
  cause: PlanRevisionCause | null;
  name_before: string | null;
  name_after: string | null;
  replaced_at: string;
}

export interface PlanRevisionSummary {
  revision_id: number;
  draft_revision: number;
  status_before: string | null;
  status_after: string | null;
  cause: PlanRevisionCause;
  nameBefore: string | null;
  nameAfter: string | null;
  currentCause: PlanRevisionCause;
  replaced_at: string;
  issue_count: number;
  titles: string[];
}

export type RestorePlanRevisionResult =
  | { restored: true; revision: number; plan: unknown[] }
  | { restored: false; reason: 'not_found' | 'conflict' };

function parsePlan(planJson: string): unknown[] {
  try {
    const parsed = JSON.parse(planJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeCause(cause: unknown): PlanRevisionCause {
  return cause === 'generation' || cause === 'refinement' || cause === 'manual_edit'
    || cause === 'restore' || cause === 'rename' ? cause : 'unknown';
}

export async function getCurrentPlanCause(db: Knex, draftId: string): Promise<PlanRevisionCause> {
  const draft = await db('task_drafts').where({ draft_id: draftId }).first('plan_cause') as
    { plan_cause: string | null } | undefined;
  return normalizeCause(draft?.plan_cause);
}

function summarize(row: PlanRevisionRow, currentCause: PlanRevisionCause): PlanRevisionSummary {
  const plan = parsePlan(row.plan_json);
  return {
    revision_id: row.revision_id,
    draft_revision: row.draft_revision,
    status_before: row.status_before,
    status_after: row.status_after,
    cause: normalizeCause(row.cause),
    nameBefore: row.name_before,
    nameAfter: row.name_after,
    currentCause,
    replaced_at: row.replaced_at,
    issue_count: plan.length,
    titles: plan.map(item => (item && typeof item === 'object' && typeof (item as { title?: unknown }).title === 'string')
      ? (item as { title: string }).title
      : ''),
  };
}

/** Newest first. */
export async function listPlanRevisions(db: Knex, draftId: string): Promise<PlanRevisionSummary[]> {
  const [rows, currentCause] = await Promise.all([
    db('task_draft_plan_revisions').where({ draft_id: draftId }).orderBy('revision_id', 'desc') as Promise<PlanRevisionRow[]>,
    getCurrentPlanCause(db, draftId),
  ]);
  return rows.map(row => summarize(row, currentCause));
}

export async function getPlanRevision(
  db: Knex,
  draftId: string,
  revisionId: number
): Promise<(PlanRevisionSummary & { plan: unknown[] }) | null> {
  const [row, currentCause] = await Promise.all([
    db('task_draft_plan_revisions').where({ draft_id: draftId, revision_id: revisionId }).first() as Promise<PlanRevisionRow | undefined>,
    getCurrentPlanCause(db, draftId),
  ]);
  if (!row) return null;
  return { ...summarize(row, currentCause), plan: parsePlan(row.plan_json) };
}

/**
 * Makes a stored plan current again. Restoring is refused while an operation
 * runs or after the plan was published, and, when `expectedRevision` is given,
 * if the draft changed since it was read.
 *
 * The plan being replaced is always kept, so a restore can itself be undone.
 * The history trigger coalesces bursts of manual edits and could skip it, so
 * it is recorded here; the trigger then skips its identical snapshot.
 */
export async function restorePlanRevision(
  db: Knex,
  draftId: string,
  revisionId: number,
  { expectedRevision }: { expectedRevision?: number } = {}
): Promise<RestorePlanRevisionResult> {
  return db.transaction(async tx => {
    const row = await tx('task_draft_plan_revisions')
      .where({ draft_id: draftId, revision_id: revisionId })
      .first('plan_json') as Pick<PlanRevisionRow, 'plan_json'> | undefined;
    if (!row) return { restored: false, reason: 'not_found' } as const;

    const restorable = () => tx('task_drafts')
      .where({ draft_id: draftId })
      .modify(query => { if (expectedRevision !== undefined) query.where('mcp_revision', expectedRevision); })
      .where(builder => { builder.whereIn('status', PLAN_RESTORABLE_STATUSES).orWhereNull('status'); });
    const draft = await restorable().first('plan_json', 'plan_cause', 'status', 'mcp_revision') as
      { plan_json: string | null; plan_cause: string | null; status: string | null; mcp_revision: number } | undefined;
    if (!draft) return { restored: false, reason: 'conflict' } as const;

    if (draft.plan_json !== null && draft.plan_json !== row.plan_json) {
      const latest = await tx('task_draft_plan_revisions').where({ draft_id: draftId })
        .orderBy('revision_id', 'desc').first('plan_json', 'cause') as Pick<PlanRevisionRow, 'plan_json' | 'cause'> | undefined;
      // A rename row describes the naming event, not the provenance of the
      // outgoing plan. Preserve that plan's cause separately before restore.
      if (latest?.plan_json !== draft.plan_json || normalizeCause(latest.cause) === 'rename') {
        await tx('task_draft_plan_revisions').insert({
          draft_id: draftId, plan_json: draft.plan_json, draft_revision: draft.mcp_revision,
          status_before: draft.status, status_after: 'review', cause: draft.plan_cause,
          replaced_at: tx.fn.now(),
        });
      }
    }

    // A restored plan needs review again, whatever state the replaced one was in.
    // Even if the outgoing plan was already the latest snapshot (or empty),
    // the next edit must preserve the restored content. Its original snapshot
    // may be removed by retention below.
    const boundary = await tx('task_draft_plan_revisions').where({ draft_id: draftId })
      .orderBy('revision_id', 'desc').first('revision_id') as Pick<PlanRevisionRow, 'revision_id'> | undefined;
    if (boundary) {
      await tx('task_draft_plan_revisions').where({ revision_id: boundary.revision_id }).update({ is_restore: true });
    }
    await restorable().update({ plan_json: row.plan_json, plan_cause: 'restore', status: 'review', updated_at: tx.fn.now() });

    const kept = tx('task_draft_plan_revisions').where({ draft_id: draftId })
      .orderBy('revision_id', 'desc').limit(MAX_REVISIONS_PER_DRAFT).select('revision_id');
    await tx('task_draft_plan_revisions').where({ draft_id: draftId }).whereNotIn('revision_id', kept).delete();

    const updated = await tx('task_drafts').where({ draft_id: draftId }).first('mcp_revision') as { mcp_revision: number };
    return { restored: true, revision: updated.mcp_revision, plan: parsePlan(row.plan_json) } as const;
  });
}
