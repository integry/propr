import type { Knex } from 'knex';
import logger from '../../utils/logger.js';
import { PlanIssueStatus } from '../../config/planIssueManager.js';
import { latestBlockedEvent } from './epicQueueBlockedEvents.js';
import type { EpicExecutionQueue, EpicQueueIssue } from './epicQueueState.js';

/**
 * A parallel execution dispatches every child when it starts, so it has no scheduler pass that starts
 * pending issues. The one exception is a retry: it puts the child back to pending without a claim
 * (or, once dispatched, leaves its retried resolution as the latest event), and that dispatch stays
 * owed until it happens. Every pass over the execution (the retry itself, resume, the recovery sweep
 * and each child's status change) dispatches the owed children under the normal guards: a paused plan
 * holds them, and a claim lost after it was taken is retried after fifteen minutes, as for a chain head.
 */
export async function dispatchRetriedParallelChildren(queue: EpicExecutionQueue,
  children: Array<{ issue_number: number; status: PlanIssueStatus }>,
  { database, dispatch }: { database: Knex; dispatch: (item: EpicQueueIssue, contextConfig: unknown) => Promise<void> }): Promise<void> {
  if (!queue.ready) return;
  const candidates = queue.items.filter(item => (item.state === 'pending' || item.state === 'dispatched')
    && children.some(child => child.issue_number === item.issueNumber && child.status === PlanIssueStatus.PENDING));
  const owed: EpicQueueIssue[] = [];
  for (const item of candidates) {
    if (item.state === 'pending') { owed.push(item); continue; }
    const latest = await latestBlockedEvent(database, { draftId: queue.draftId, executionId: queue.executionId,
      issueNumber: item.issueNumber, position: item.position });
    if (latest?.type === 'resolved' && latest.resolution === 'retried') owed.push(item);
  }
  if (!owed.length) return;
  const draft = await database('task_drafts').where({ draft_id: queue.draftId }).first('paused', 'context_config');
  if (!draft || draft.paused) return;
  for (const item of owed) {
    // A failed start blocks only its own child (dispatch_failed); the other children still settle.
    try { await dispatch(item, draft.context_config); }
    catch (error) { logger.warn?.({ draftId: queue.draftId, issueNumber: item.issueNumber, error: (error as Error).message }, 'Could not dispatch a retried parallel epic issue'); }
  }
}
