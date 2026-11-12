import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import { isTerminalStatus } from '../../webhook/statusMachine.js';
import { epicQueueJournalRef, setEpicQueueBlocked } from './epicQueueJournal.js';

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
type ActiveRow = Parameters<typeof epicQueueJournalRef>[1] & { parallel: boolean | number };

async function activeQueueFor(database: Knex, draftId: string, issueNumber: number): Promise<{ row: ActiveRow; guard: Record<string, unknown> } | null> {
  const row = await database('epic_execution_queues').where({ draft_id: draftId, status: 'active' })
    .first<ActiveRow | undefined>('execution_id', 'repository', 'issues', 'cursor', 'parallel', 'blocked_reason', 'updated_at');
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
  const reason = agentBlockedHeadReason(issueNumber);
  // In a parallel execution the blocked child, not the cursor, is the head the event names.
  const ref = { ...epicQueueJournalRef(draftId, active.row), ...(active.row.parallel ? { issues: [issueNumber], cursor: 0 } : {}) };
  // The cursor guard is the row's own, even when the event names a parallel child.
  return Boolean(await setEpicQueueBlocked(database, ref, reason,
    { timestamp: now(), guard: active.guard }));
}

function historyMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === 'object') return metadata as Record<string, unknown>;
  if (typeof metadata !== 'string' || !metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** True when the latest persisted state of the task is a completed run that stopped on a reported blocker. */
async function latestRunBlocked(database: Knex, taskId: string): Promise<boolean> {
  const latest = await database('task_history').where({ task_id: taskId }).orderBy('timestamp', 'desc').orderBy('history_id', 'desc')
    .first<{ state: string; metadata: unknown } | undefined>('state', 'metadata');
  if (!latest || latest.state !== 'completed') return false;
  const metadata = historyMetadata(latest.metadata);
  const prResult = metadata.prResult && typeof metadata.prResult === 'object' ? metadata.prResult as Record<string, unknown> : {};
  return metadata.terminalReason === 'blocked' || prResult.terminalReason === 'blocked';
}

/**
 * The first other child of a parallel execution (in queue order) that is still
 * in progress and whose latest run stopped on a reported blocker.
 */
async function siblingStillBlocked(database: Knex, draftId: string, issues: number[], issueNumber: number): Promise<number | null> {
  const others = issues.filter(issue => issue !== issueNumber);
  if (others.length === 0) return null;
  const rows = await database('plan_issues').where({ draft_id: draftId }).whereIn('issue_number', others)
    .select<Array<{ issue_number: number; status: string; task_id: string | null }>>('issue_number', 'status', 'task_id');
  for (const issue of others) {
    const row = rows.find(candidate => candidate.issue_number === issue);
    if (!row?.task_id || isTerminalStatus(row.status as never)) continue;
    if (await latestRunBlocked(database, row.task_id)) return issue;
  }
  return null;
}

/**
 * A later run for the issue settled without a blocker: drop this issue's
 * blocker explanation, leaving any other reason (a merge wait, a sibling's
 * blocker in a parallel execution) in place. In a parallel execution a
 * sibling whose latest run is still blocked takes over the explanation, since
 * only the most recent blocker's reason is stored. Returns true when this
 * issue's reason was replaced.
 */
export async function clearEpicQueueHeadBlocked({ draftId, issueNumber }: { draftId: string; issueNumber: number },
  { database = db, now = Date.now }: Deps = {}): Promise<boolean> {
  const active = await activeQueueFor(database, draftId, issueNumber);
  if (!active) return false;
  const sibling = active.row.parallel
    ? await siblingStillBlocked(database, draftId, JSON.parse(active.row.issues) as number[], issueNumber)
    : null;
  return Boolean(await database('epic_execution_queues')
    .where({ ...active.guard, blocked_reason: agentBlockedHeadReason(issueNumber) })
    .update({ blocked_reason: sibling === null ? null : agentBlockedHeadReason(sibling), updated_at: now() }));
}
