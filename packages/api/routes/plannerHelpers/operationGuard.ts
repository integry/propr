/**
 * Guards for planner operations that launch long-running agent containers.
 */

import type { Knex } from 'knex';
import { executeDockerCommand } from '@propr/core';

export const ACTIVE_DRAFT_OPERATION_STATUSES = ['generating', 'refining', 'executing'] as const;

type PlannerExecutionType = 'plan-generation' | 'plan-refinement';
type DockerCommandRunner = typeof executeDockerCommand;

export function isDraftOperationActive(status: unknown): boolean {
  return typeof status === 'string' && ACTIVE_DRAFT_OPERATION_STATUSES.includes(
    status as typeof ACTIVE_DRAFT_OPERATION_STATUSES[number]
  );
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
