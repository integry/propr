import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import { epicQueueJournalRef, setEpicQueueBlocked } from './epicQueueJournal.js';

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
    .first<(Parameters<typeof epicQueueJournalRef>[1] & { parallel: boolean | number }) | undefined>(
      'execution_id', 'repository', 'issues', 'cursor', 'parallel', 'blocked_reason', 'updated_at');
  if (!row || Boolean(row.parallel) || (JSON.parse(row.issues) as number[])[row.cursor] !== issueNumber) return false;
  return Boolean(await setEpicQueueBlocked(database, epicQueueJournalRef(draftId, row),
    `${AWAITING_HUMAN_MERGE_PREFIX} auto-merge was not armed for PR #${prNumber} (issue #${issueNumber}, ${reason}). The queue resumes once a person merges it.`,
    { timestamp: now() }));
}
