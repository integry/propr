import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import { blockQueueIssue, epicQueueHead, epicQueueIssue, getEpicExecutionQueue, isEpicQueueIssueInFlight } from './epicQueueState.js';

export const AWAITING_HUMAN_MERGE_PREFIX = 'Waiting for human merge:';

export function isAwaitingHumanMergeReason(reason: string | null | undefined): boolean {
  return Boolean(reason?.startsWith(AWAITING_HUMAN_MERGE_PREFIX));
}

/**
 * ProPR declined to arm auto-merge for the head's PR. The queue keeps waiting
 * (it advances on the merge, not on arming) and explains that a person must merge.
 * Returns true when an active sequential queue headed by this issue, or a graph execution
 * with this issue in flight, was marked.
 */
export async function markEpicQueueAwaitingHumanMerge({ draftId, issueNumber, prNumber, reason }: {
  draftId: string; issueNumber: number; prNumber: number; reason: string;
}, { database = db, now = Date.now }: { database?: Knex; now?: () => number } = {}): Promise<boolean> {
  const queue = await getEpicExecutionQueue(draftId, { database });
  const head = queue?.mode === 'graph' && isEpicQueueIssueInFlight(queue, issueNumber) ? epicQueueIssue(queue, issueNumber) : epicQueueHead(queue);
  if (queue?.status !== 'active' || head?.issueNumber !== issueNumber) return false;
  return blockQueueIssue(database, queue, head, { kind: 'awaiting_human_merge', timestamp: now(),
    reason: `${AWAITING_HUMAN_MERGE_PREFIX} auto-merge was not armed for PR #${prNumber} (issue #${issueNumber}, ${reason}). The queue resumes once a person merges it.` });
}
