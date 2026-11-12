import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import { epicQueueIssue, getEpicExecutionQueue, isEpicQueueIssueInFlight, unblockQueueIssue, blockQueueIssue,
  type EpicExecutionQueue, type EpicQueueIssue } from './epicQueueState.js';

/**
 * An issue run that ended with the `blocked` outcome (`on_blocker: report`)
 * leaves its plan issue in progress: it is neither merged nor closed, so the
 * queue never advances past it. The reason explains why the epic stands still
 * and survives recovery passes until a later run for the issue settles normally.
 */
const BLOCKED_HEAD_PATTERN = /^Issue #\d+ stopped on a blocker reported by the agent;/;

export function agentBlockedHeadReason(issueNumber: number): string {
  return `Issue #${issueNumber} stopped on a blocker reported by the agent; resolve the blocker and request processing again to continue this epic.`;
}

export function isAgentBlockedReason(reason: string | null | undefined): boolean {
  return Boolean(reason && BLOCKED_HEAD_PATTERN.test(reason));
}

type Deps = { database?: Knex; now?: () => number };

/** The active execution in which this issue is in flight (its sequential head, or an unsettled parallel child), with the observed occurrence. */
async function activeQueueFor(database: Knex, draftId: string, issueNumber: number): Promise<{ queue: EpicExecutionQueue; item: EpicQueueIssue } | null> {
  const queue = await getEpicExecutionQueue(draftId, { database });
  const item = epicQueueIssue(queue, issueNumber);
  return queue && item && isEpicQueueIssueInFlight(queue, issueNumber) ? { queue, item } : null;
}

/**
 * Records that the run for this queued issue stopped on a reported blocker.
 * Returns true when an active execution containing the issue (as its
 * sequential head, or as a parallel child) was marked.
 */
export async function markEpicQueueHeadBlocked({ draftId, issueNumber }: { draftId: string; issueNumber: number },
  { database = db, now = Date.now }: Deps = {}): Promise<boolean> {
  const active = await activeQueueFor(database, draftId, issueNumber);
  if (!active) return false;
  // Guarded like every other queue write: a newer execution, a settled issue or a requeued occurrence wins.
  return blockQueueIssue(database, active.queue, active.item, { kind: 'agent_blocked', reason: agentBlockedHeadReason(issueNumber), timestamp: now() });
}

/**
 * A later run for the issue settled without a blocker: drop this issue's
 * blocker, leaving any other reason (a merge wait) in place. Other children of
 * a parallel execution keep their own blockers, so the latest one still blocked
 * explains the execution. Returns true when this issue's blocker was cleared.
 */
export async function clearEpicQueueHeadBlocked({ draftId, issueNumber }: { draftId: string; issueNumber: number },
  { database = db, now = Date.now }: Deps = {}): Promise<boolean> {
  const active = await activeQueueFor(database, draftId, issueNumber);
  if (!active) return false;
  return unblockQueueIssue(database, active.queue, active.item, { timestamp: now(), kinds: ['agent_blocked'] });
}
