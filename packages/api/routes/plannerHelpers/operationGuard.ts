/**
 * Guards for planner operations that launch long-running agent containers.
 */

import type { Knex } from 'knex';
import { executeDockerCommand } from '@propr/core';

export const ACTIVE_DRAFT_OPERATION_STATUSES = ['generating', 'refining', 'executing'] as const;
export const REFINEMENT_STALE_AFTER_MS = 35 * 60 * 1000;

const STALE_REFINEMENT_ERROR = 'Refinement stopped before completion. Please try again.';

type PlannerExecutionType = 'plan-generation' | 'plan-refinement';
type PlannerPreparationType = 'context-preview' | 'plan-generation' | 'plan-refinement';
type DockerCommandRunner = typeof executeDockerCommand;

const draftPreparations = new Map<string, PlannerPreparationType>();

export function isDraftOperationActive(status: unknown): boolean {
  return typeof status === 'string' && ACTIVE_DRAFT_OPERATION_STATUSES.includes(
    status as typeof ACTIVE_DRAFT_OPERATION_STATUSES[number]
  );
}

/**
 * Coordinates the setup window before a database operation claim exists. This
 * is intentionally process-local: context previews themselves are process-local
 * background work and disappear on restart too.
 */
export function claimDraftPreparation(draftId: string, operation: PlannerPreparationType): boolean {
  if (draftPreparations.has(draftId)) return false;
  draftPreparations.set(draftId, operation);
  return true;
}

export function releaseDraftPreparation(draftId: string, operation: PlannerPreparationType): void {
  if (draftPreparations.get(draftId) === operation) draftPreparations.delete(draftId);
}

interface StaleRefinementOptions {
  now?: Date;
  staleAfterMs?: number;
}

function parseDatabaseTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return new Date(value).getTime();
  if (typeof value !== 'string') return Number.NaN;

  // SQLite CURRENT_TIMESTAMP is UTC but has no timezone suffix. JavaScript
  // otherwise interprets that form as local time, shifting the stale window on
  // non-UTC hosts.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return new Date(normalized).getTime();
}

/**
 * Releases a refinement claim whose background task can no longer report its
 * result. Refinement currently runs in the API process, so an API restart can
 * otherwise leave the draft permanently locked in `refining`.
 *
 * The compare-and-set on status and updated_at prevents a stale reader from
 * overwriting a refinement that completed or made progress concurrently.
 */
export async function recoverStaleRefinement(
  db: Knex,
  draft: Record<string, unknown>,
  options: StaleRefinementOptions = {}
): Promise<Record<string, unknown>> {
  if (draft.status !== 'refining') return draft;

  const updatedAt = draft.updated_at;
  const updatedAtMs = parseDatabaseTimestamp(updatedAt);
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? REFINEMENT_STALE_AFTER_MS;

  if (!Number.isFinite(updatedAtMs) || now.getTime() - updatedAtMs < staleAfterMs) {
    return draft;
  }

  const draftId = draft.draft_id;
  if (typeof draftId !== 'string' || !draftId) return draft;

  const recovered = await db('task_drafts')
    .where({ draft_id: draftId, status: 'refining' })
    .andWhere('updated_at', updatedAt as string | number | Date)
    .update({
      status: 'review',
      refinement_result: JSON.stringify({
        status: 'failed',
        error: STALE_REFINEMENT_ERROR,
        timestamp: now.toISOString()
      }),
      updated_at: db.fn.now()
    });

  if (recovered === 1) {
    console.warn(`[planner] Recovered stale refinement for draft ${draftId}`);
  }

  return await db('task_drafts').where({ draft_id: draftId }).first() ?? draft;
}

/**
 * Atomically claims a draft for a long-running operation. The conditional
 * update is the lock: only one of two concurrent requests can succeed.
 */
export async function claimDraftOperation(
  db: Knex,
  draftId: string,
  status: 'generating' | 'refining',
  updates: Record<string, unknown> = {}
): Promise<boolean> {
  const updated = await db('task_drafts')
    .where({ draft_id: draftId })
    .where((builder) => {
      builder
        .whereNotIn('status', ACTIVE_DRAFT_OPERATION_STATUSES)
        .orWhereNull('status');
    })
    .update({
      ...updates,
      status,
      updated_at: db.fn.now()
    });

  return updated === 1;
}

/**
 * The database status is authoritative for new runs, but older failures could
 * leave a live container behind after a duplicate request changed the status
 * to `failed`. Detect those containers as a compatibility/safety check.
 */
export async function hasRunningPlannerContainer(
  draftId: string,
  executionType: PlannerExecutionType,
  runDocker: DockerCommandRunner = executeDockerCommand
): Promise<boolean> {
  const shortDraftId = draftId.slice(-8);

  try {
    const result = await runDocker('docker', [
      'ps',
      '--filter', `name=${executionType}-${shortDraftId}`,
      '--format', '{{.ID}}'
    ], { timeout: 5000 });

    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch (error) {
    // A database compare-and-set still protects normal operation when Docker
    // cannot be queried (for example, during local API-only development).
    console.warn(`[planner] Could not inspect running ${executionType} containers:`, error);
    return false;
  }
}
