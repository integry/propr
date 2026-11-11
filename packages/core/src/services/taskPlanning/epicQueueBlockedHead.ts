import type { Knex } from 'knex';
import { db } from '../../db/connection.js';

/**
 * An issue run that ended with the `blocked` outcome (`on_blocker: report`)
 * leaves its plan issue in progress: it is neither merged nor closed, so the
 * queue never advances past it. The reason explains why the epic stands still
 * and survives recovery passes until a later run for the issue settles normally.
 */
const BLOCKED_HEAD_PATTERN = /^Issue #\d+ stopped on a blocker reported by the agent;/;
/** SQL LIKE form of the pattern, for guards evaluated in the same statement as a write. */
export const AGENT_BLOCKED_REASON_LIKE = 'Issue #% stopped on a blocker reported by the agent;%';

export function agentBlockedHeadReason(issueNumber: number): string {
  return `Issue #${issueNumber} stopped on a blocker reported by the agent; resolve the blocker and request processing again to continue this epic.`;
}

export function isAgentBlockedReason(reason: string | null | undefined): boolean {
  return Boolean(reason && BLOCKED_HEAD_PATTERN.test(reason));
}

type Deps = { database?: Knex; now?: () => number };
type ActiveRow = { execution_id: string; issues: string; cursor: number; parallel: boolean | number };

async function activeQueueFor(database: Knex, draftId: string, issueNumber: number): Promise<{ row: ActiveRow; guard: Record<string, unknown> } | null> {
  const row = await database('epic_execution_queues').where({ draft_id: draftId, status: 'active' })
    .first<ActiveRow | undefined>('execution_id', 'issues', 'cursor', 'parallel');
  if (!row) return null;
  const issues = JSON.parse(row.issues) as number[];
  // A parallel execution runs every child at once; a sequential one only its head.
  if (row.parallel ? !issues.includes(issueNumber) : issues[row.cursor] !== issueNumber) return null;
  // Guarded like every other queue write: a newer execution or a moved cursor wins.
  return { row, guard: { draft_id: draftId, execution_id: row.execution_id, status: 'active', cursor: row.cursor } };
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
  return Boolean(await database('epic_execution_queues').where(active.guard)
    .update({ blocked_reason: agentBlockedHeadReason(issueNumber), updated_at: now() }));
}

/**
 * A later run for the issue settled without a blocker: drop this issue's
 * blocker explanation, leaving any other reason (a merge wait, a sibling's
 * blocker in a parallel execution) in place. Returns true when it was cleared.
 */
export async function clearEpicQueueHeadBlocked({ draftId, issueNumber }: { draftId: string; issueNumber: number },
  { database = db, now = Date.now }: Deps = {}): Promise<boolean> {
  const active = await activeQueueFor(database, draftId, issueNumber);
  if (!active) return false;
  return Boolean(await database('epic_execution_queues')
    .where({ ...active.guard, blocked_reason: agentBlockedHeadReason(issueNumber) })
    .update({ blocked_reason: null, updated_at: now() }));
}
