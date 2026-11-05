import type { Knex } from 'knex';
import { db } from '../../db/connection.js';

export const AWAITING_HUMAN_MERGE_PREFIX = 'Waiting for human merge:';

export function isAwaitingHumanMergeReason(reason: string | null | undefined): boolean {
  return Boolean(reason?.startsWith(AWAITING_HUMAN_MERGE_PREFIX));
}

/**
 * ProPR declined to arm auto-merge for the head's PR. The queue keeps waiting
 * (it advances on the merge, not on arming) and explains that a person must merge.
 * Returns true when an active sequential queue headed by this issue was marked.
 */
export async function markEpicQueueAwaitingHumanMerge({ draftId, issueNumber, prNumber, reason }: {
  draftId: string; issueNumber: number; prNumber: number; reason: string;
}, { database = db, now = Date.now }: { database?: Knex; now?: () => number } = {}): Promise<boolean> {
  const row = await database('epic_execution_queues').where({ draft_id: draftId, status: 'active' })
    .first<{ execution_id: string; issues: string; cursor: number; parallel: boolean | number } | undefined>('execution_id', 'issues', 'cursor', 'parallel');
  if (!row || Boolean(row.parallel) || (JSON.parse(row.issues) as number[])[row.cursor] !== issueNumber) return false;
  return Boolean(await database('epic_execution_queues')
    .where({ draft_id: draftId, execution_id: row.execution_id, status: 'active', cursor: row.cursor })
    .update({
      blocked_reason: `${AWAITING_HUMAN_MERGE_PREFIX} auto-merge was not armed for PR #${prNumber} (issue #${issueNumber}, ${reason}). The queue resumes once a person merges it.`,
      updated_at: now(),
    }));
}
