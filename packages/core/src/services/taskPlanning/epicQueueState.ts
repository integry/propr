import type { Knex } from 'knex';
import { db } from '../../db/connection.js';

export type EpicAdvancePolicy = 'merged' | 'terminal';
export type EpicQueueStatus = 'active' | 'completed' | 'cancelled';
/** Lifecycle of one issue in an execution. `dispatched` is the queue's own claim, not `plan_issues.status`. */
export type EpicQueueIssueState = 'pending' | 'dispatched' | 'done' | 'blocked' | 'skipped';
/** Why a blocked issue holds its execution. */
export type EpicQueueBlockedKind =
  | 'closed_unmerged' // closed without merge under the merged advance policy
  | 'missing_from_plan'
  | 'dispatch_failed'
  | 'agent_blocked' // the run stopped on a blocker reported by the agent; never re-dispatched by recovery
  | 'awaiting_human_merge'
  | 'label_handoff' // processing labels are not released yet
  | 'setup_not_ready'; // initial model and branch selectors are not synchronized

export interface EpicQueueIssue {
  issueNumber: number;
  position: number;
  state: EpicQueueIssueState;
  /** The issue's own dispatch claim; kept while blocked so the retry window still applies. */
  dispatchedAt: number | null;
  blockedKind: EpicQueueBlockedKind | null;
  blockedReason: string | null;
  blockedAt: number | null;
  updatedAt: number;
}

export interface EpicExecutionQueue {
  draftId: string;
  executionId: string;
  repository: string;
  /** Issue numbers in queue order. */
  issues: number[];
  /** Per-issue state in queue order. */
  items: EpicQueueIssue[];
  /** Derived: index of the sequential head (issues.length once completed; 0 for an unfinished parallel execution). */
  cursor: number;
  status: EpicQueueStatus;
  advanceOn: EpicAdvancePolicy;
  /** Derived: the head's (or, in parallel, the latest blocked child's) reason, or an execution-wide note. */
  blockedReason: string | null;
  /** The cancelled execution never dispatched its head, so implementation may be requested again. */
  unstarted: boolean;
  autoMerge: boolean;
  /** Non-epic auto-merge queues start successors without the plan's epic branch label. */
  useEpic: boolean;
  /** Parallel epics dispatch every child up front; the row only owes epic finalization. */
  parallel: boolean;
  /** Durable initial dispatch intent; plan_issues retains the old model for label removal. */
  headSelection: { agent_alias: string; model_name: string } | null;
  /** Outstanding epic completion labeling, independent of the current children's branch. */
  owesEpicFinalization: boolean;
  ready: boolean;
  /** Derived: the sequential head's dispatch claim. */
  headStartedAt: number | null;
  createdAt: number;
  updatedAt: number;
  finalizedAt: number | null;
  finalizationStartedAt: number | null;
}

export const EPIC_QUEUE_ISSUES = 'epic_execution_queue_issues';
export const SETTLED_STATES: EpicQueueIssueState[] = ['done', 'skipped'];
export const UNSTARTED_EPIC_REASON = 'Initial queue head never started; implementation may be requested again.';
export const SETUP_PENDING_REASON = 'Preparing queued issue model and epic branch labels.';

type QueueRow = {
  draft_id: string; execution_id: string; repository: string; issues: string; cursor: number;
  status: EpicQueueStatus; advance_on: EpicAdvancePolicy; blocked_reason: string | null;
  auto_merge: boolean | number; use_epic: boolean | number; parallel: boolean | number; ready: boolean | number;
  head_selection: string | null; owes_epic_finalization: boolean | number;
  created_at: number; updated_at: number; finalized_at: number | null; finalization_started_at: number | null;
};
type IssueRow = {
  issue_number: number; position: number; state: EpicQueueIssueState; dispatched_at: number | string | null;
  blocked_kind: EpicQueueBlockedKind | null; blocked_reason: string | null; blocked_at: number | string | null; updated_at: number | string;
};

const toNumber = (value: number | string | null): number | null => value === null || value === undefined ? null : Number(value);

export function isSettled(item: EpicQueueIssue): boolean {
  return SETTLED_STATES.includes(item.state);
}

function fromRows(row: QueueRow, rows: IssueRow[]): EpicExecutionQueue {
  const items = rows.map(item => ({
    issueNumber: item.issue_number, position: item.position, state: item.state, dispatchedAt: toNumber(item.dispatched_at),
    blockedKind: item.blocked_kind, blockedReason: item.blocked_reason, blockedAt: toNumber(item.blocked_at), updatedAt: Number(item.updated_at),
  }));
  const parallel = Boolean(row.parallel);
  const completed = row.status === 'completed';
  const headIndex = parallel || completed ? -1 : items.findIndex(item => !isSettled(item));
  const head = headIndex === -1 ? undefined : items[headIndex];
  const cursor = completed ? items.length : parallel ? 0 : headIndex === -1 ? items.length : headIndex;
  const issueReason = parallel ? latestBlocked(items)?.blockedReason : head?.state === 'blocked' ? head.blockedReason : null;
  return {
    draftId: row.draft_id, executionId: row.execution_id, repository: row.repository,
    issues: items.map(item => item.issueNumber), items, cursor, status: row.status, advanceOn: row.advance_on,
    blockedReason: row.blocked_reason ?? issueReason ?? null,
    unstarted: row.status === 'cancelled' && row.blocked_reason === UNSTARTED_EPIC_REASON,
    autoMerge: Boolean(row.auto_merge), useEpic: Boolean(row.use_epic), parallel, ready: Boolean(row.ready),
    headSelection: row.head_selection ? JSON.parse(row.head_selection) : null,
    owesEpicFinalization: Boolean(row.owes_epic_finalization),
    headStartedAt: head?.dispatchedAt ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
    finalizedAt: row.finalized_at, finalizationStartedAt: row.finalization_started_at,
  };
}

/** The most recently blocked issue; a parallel execution explains itself with its latest blocker. */
function latestBlocked(items: EpicQueueIssue[]): EpicQueueIssue | undefined {
  return items.filter(item => item.state === 'blocked')
    .sort((left, right) => (right.blockedAt ?? 0) - (left.blockedAt ?? 0) || right.position - left.position)[0];
}

export async function getEpicExecutionQueue(draftId: string, { database = db }: { database?: Knex } = {}): Promise<EpicExecutionQueue | null> {
  const row = await database('epic_execution_queues').where({ draft_id: draftId }).first<QueueRow | undefined>();
  if (!row) return null;
  const items = await database(EPIC_QUEUE_ISSUES).where({ draft_id: draftId, execution_id: row.execution_id })
    .orderBy('position').select<IssueRow[]>('issue_number', 'position', 'state', 'dispatched_at', 'blocked_kind', 'blocked_reason', 'blocked_at', 'updated_at');
  return fromRows(row, items);
}

/** The issue a sequential execution is working on: its first issue that is neither done nor skipped. */
export function epicQueueHead(queue: EpicExecutionQueue | null): EpicQueueIssue | null {
  if (!queue || queue.parallel || queue.status === 'completed') return null;
  return queue.items.find(item => !isSettled(item)) ?? null;
}

export function epicQueueIssue(queue: EpicExecutionQueue | null, issueNumber: number): EpicQueueIssue | null {
  return queue?.items.find(item => item.issueNumber === issueNumber) ?? null;
}

/** Whether the issue is in flight in an active execution: its sequential head, or an unsettled parallel child. */
export function isEpicQueueIssueInFlight(queue: EpicExecutionQueue | null, issueNumber: number): boolean {
  if (queue?.status !== 'active') return false;
  if (!queue.parallel) return epicQueueHead(queue)?.issueNumber === issueNumber;
  const item = epicQueueIssue(queue, issueNumber);
  return Boolean(item && !isSettled(item));
}

export function summarizeEpicQueue(queue: EpicExecutionQueue | null) {
  if (!queue) return null;
  return { issues: queue.issues, cursor: queue.cursor, head: queue.parallel ? null : queue.issues[queue.cursor] ?? null,
    status: queue.status, advanceOn: queue.advanceOn, blockedReason: queue.blockedReason,
    issueStates: queue.items.map(item => ({ issue: item.issueNumber, state: item.state,
      blockedKind: item.state === 'blocked' ? item.blockedKind : null, blockedReason: item.state === 'blocked' ? item.blockedReason : null })),
    ...(queue.parallel ? { executionMode: 'parallel' as const } : {}) };
}

/** Initial per-issue rows: a parallel execution dispatched every child at request time. */
export function initialIssueRows(input: { draftId: string; executionId: string; issues: number[]; parallel: boolean;
  ready: boolean; headStartedAt: number | null; timestamp: number }) {
  return input.issues.map((issueNumber, position) => {
    const dispatchedAt = input.parallel ? input.timestamp : position === 0 ? input.headStartedAt : null;
    const setup = !input.ready && !input.parallel && position === 0;
    return {
      draft_id: input.draftId, execution_id: input.executionId, issue_number: issueNumber, position,
      state: setup ? 'blocked' : dispatchedAt === null ? 'pending' : 'dispatched', dispatched_at: dispatchedAt,
      blocked_kind: setup ? 'setup_not_ready' : null, blocked_reason: setup ? SETUP_PENDING_REASON : null,
      blocked_at: setup ? input.timestamp : null, created_at: input.timestamp, updated_at: input.timestamp,
    };
  });
}

type Owner = { draftId: string; executionId: string };

/**
 * One issue's row, while its execution is still the plan's active one (plus any further
 * queue conditions). Every per-issue write starts here, so a stale execution never writes.
 */
export function ownedIssue(database: Knex, owner: Owner, issueNumber: number, queueWhere: Record<string, unknown> = {}): Knex.QueryBuilder {
  return database(EPIC_QUEUE_ISSUES).where({ draft_id: owner.draftId, execution_id: owner.executionId, issue_number: issueNumber })
    .whereExists(database('epic_execution_queues').select('draft_id')
      .where({ draft_id: owner.draftId, execution_id: owner.executionId, status: 'active', ...queueWhere }));
}

/** Blocks an unsettled issue with a structured reason; the dispatch claim is kept. */
export async function blockQueueIssue(database: Knex, owner: Owner, issueNumber: number, blocked: {
  kind: EpicQueueBlockedKind; reason: string; timestamp: number; guard?: (query: Knex.QueryBuilder) => void;
}): Promise<boolean> {
  const query = ownedIssue(database, owner, issueNumber).whereNotIn('state', SETTLED_STATES);
  blocked.guard?.(query);
  return Boolean(await query.update({ state: 'blocked', blocked_kind: blocked.kind, blocked_reason: blocked.reason,
    blocked_at: blocked.timestamp, updated_at: blocked.timestamp }));
}

/** Drops a blocked issue's reason (only of the given kinds, when listed); it returns to dispatched while it holds a claim. */
export async function unblockQueueIssue(database: Knex, owner: Owner, issueNumber: number,
  { timestamp, kinds, queueWhere }: { timestamp: number; kinds?: EpicQueueBlockedKind[]; queueWhere?: Record<string, unknown> }): Promise<boolean> {
  const query = ownedIssue(database, owner, issueNumber, queueWhere).where({ state: 'blocked' });
  if (kinds) query.whereIn('blocked_kind', kinds);
  return Boolean(await query.update({ ...clearedBlock(database), updated_at: timestamp }));
}

export function clearedBlock(database: Knex) {
  return { state: database.raw('CASE WHEN dispatched_at IS NULL THEN ? ELSE ? END', ['pending', 'dispatched']),
    blocked_kind: null, blocked_reason: null, blocked_at: null };
}

/** Settles an issue as done. Only one observer wins; the others see zero changed rows. */
export async function markQueueIssueDone(database: Knex, owner: Owner, issueNumber: number, timestamp: number): Promise<boolean> {
  return Boolean(await ownedIssue(database, owner, issueNumber).whereNotIn('state', SETTLED_STATES)
    .update({ state: 'done', blocked_kind: null, blocked_reason: null, blocked_at: null, updated_at: timestamp }));
}

/** Completes the active execution once every issue is settled. Returns true for the single winner. */
export async function completeSettledExecution(database: Knex, owner: Owner, timestamp: number): Promise<boolean> {
  return Boolean(await database('epic_execution_queues')
    .where({ draft_id: owner.draftId, execution_id: owner.executionId, status: 'active' })
    .whereNotExists(database(EPIC_QUEUE_ISSUES).select('issue_number')
      .where({ draft_id: owner.draftId, execution_id: owner.executionId }).whereNotIn('state', SETTLED_STATES))
    .update({ status: 'completed', blocked_reason: null, updated_at: timestamp }));
}

/**
 * Appends pending issues to an active sequential execution, as long as it still holds exactly
 * the issues the caller read: a concurrent advance or completion is never overwritten. An issue
 * that already settled in this execution is requeued: its row is reset to pending at the tail.
 */
export async function appendEpicQueueIssues(queue: EpicExecutionQueue, issueNumbers: number[],
  { database = db, now = Date.now }: { database?: Knex; now?: () => number } = {}): Promise<boolean> {
  if (!issueNumbers.length || new Set(issueNumbers).size !== issueNumbers.length) return false;
  // Only settled issues may be requeued; an unsettled one is already owed by the execution.
  if (issueNumbers.some(issue => { const item = epicQueueIssue(queue, issue); return item && !isSettled(item); })) return false;
  const timestamp = now();
  const work = async (trx: Knex) => {
    const owned = { draft_id: queue.draftId, execution_id: queue.executionId };
    const current = await trx('epic_execution_queues').where({ ...owned, status: 'active' }).forUpdate().first('draft_id');
    if (!current) return false;
    const items = await trx(EPIC_QUEUE_ISSUES).where(owned).orderBy('position')
      .select<Array<{ issue_number: number; position: number; state: EpicQueueIssueState }>>('issue_number', 'position', 'state');
    if (items.length !== queue.items.length || items.some((item, index) => item.issue_number !== queue.items[index].issueNumber)) return false;
    // A requeued issue must still be settled; nothing but an append moves a settled row back.
    if (issueNumbers.some(issue => items.some(item => item.issue_number === issue && !SETTLED_STATES.includes(item.state)))) return false;
    let next = (items.at(-1)?.position ?? -1) + 1;
    const pending = { state: 'pending', dispatched_at: null, blocked_kind: null, blocked_reason: null, blocked_at: null, updated_at: timestamp };
    for (const issueNumber of issueNumbers) {
      const position = next++;
      if (!items.some(item => item.issue_number === issueNumber)) {
        await trx(EPIC_QUEUE_ISSUES).insert({ ...owned, issue_number: issueNumber, position, ...pending, created_at: timestamp });
        continue;
      }
      await trx(EPIC_QUEUE_ISSUES).where({ ...owned, issue_number: issueNumber }).whereIn('state', SETTLED_STATES)
        .update({ ...pending, position });
    }
    const order = await trx(EPIC_QUEUE_ISSUES).where(owned).orderBy('position').pluck('issue_number');
    await trx('epic_execution_queues').where(owned).update({ issues: JSON.stringify(order), updated_at: timestamp });
    return true;
  };
  return (database as Knex.Transaction).isTransaction ? work(database) : database.transaction(trx => work(trx));
}
